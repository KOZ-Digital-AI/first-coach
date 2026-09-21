/// <reference types="vite/client" />
/**
 * i18n: i18next + react-i18next fed by per-screen `*.messages.ts` files.
 *
 * Convention (nobody edits a central catalogue):
 * - A screen keeps its strings next to it in `<name>.messages.ts`, anywhere under
 *   src/. The file DEFAULT-EXPORTS `{ kk, ru, en }`, each a (nested) object of strings
 *   with the same keys in all three locales (`i18n.test.ts` fails when one is missing).
 * - The i18next namespace is the file's base name: `today.messages.ts` is namespace
 *   `today`. Names match /^[A-Za-z][A-Za-z0-9_-]*$/ and are unique; a clash throws.
 * - Screens call `useTranslation('today')` and `t('title')`. Every module that calls
 *   `useTranslation` MUST import something from this file, so the instance is registered
 *   before its first render (main.tsx importing it is a later bead's wiring).
 *
 * `i18n` (the module singleton) is registered as react-i18next's global instance, so no
 * <I18nextProvider> is needed in the app. Tests build isolated instances with `createI18n`.
 *
 * A key missing in the current language renders the next language of the fallback chain.
 * A key missing everywhere renders '' (never the raw key, never 'undefined'); in dev it is
 * also reported once with `console.warn`.
 */
import { createInstance, type i18n as I18nInstance, type Resource } from 'i18next';
import { setI18n } from 'react-i18next';
import type { Locale } from '@api-types/primitives';

// Type-only on purpose: a runtime import of primitives.ts would pull zod into the entry
// bundle. i18n.test.ts pins this list to the runtime `Locale` options of primitives.
export const LOCALES = ['kk', 'ru', 'en'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'kk';
export const LANGUAGE_STORAGE_KEY = 'fc:lang';

/** Each language written in itself: never translated. */
export const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = {
  kk: 'Қазақша',
  ru: 'Русский',
  en: 'English',
};

/** kk falls back to ru then en; ru to en; en to ru then kk (nothing is blank while any locale has text). */
const FALLBACKS = {
  kk: ['ru', 'en'],
  ru: ['en'],
  en: ['ru', 'kk'],
  default: ['kk', 'ru', 'en'],
} satisfies Record<Locale | 'default', Locale[]>;

export type MessageTree = { [key: string]: string | MessageTree };
export type MessageBundle = Record<Locale, MessageTree>;
/** Module path -> module namespace, as produced by an eager `import.meta.glob`. */
export type MessageModules = Record<string, Record<string, unknown>>;

const NAMESPACE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MESSAGES_SUFFIX = '.messages.ts';

/** `../features/today/today.messages.ts` -> `today`. */
export function namespaceOf(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const name = file.endsWith(MESSAGES_SUFFIX) ? file.slice(0, -MESSAGES_SUFFIX.length) : file;
  if (!NAMESPACE_PATTERN.test(name)) {
    throw new Error(`i18n: "${path}" does not give a valid namespace (got "${name}")`);
  }
  return name;
}

/** Pure: modules map -> i18next resources `{ kk: { ns: tree }, ru: ..., en: ... }`. */
export function buildResources(modules: MessageModules): Resource {
  const resources: Record<string, Record<string, MessageTree>> = {};
  for (const locale of LOCALES) resources[locale] = {};
  const owners = new Map<string, string>();
  for (const path of Object.keys(modules).sort()) {
    const ns = namespaceOf(path);
    const previous = owners.get(ns);
    if (previous !== undefined) {
      throw new Error(`i18n: namespace "${ns}" is defined by both "${previous}" and "${path}"`);
    }
    owners.set(ns, path);
    const bundle = modules[path]?.default;
    if (typeof bundle !== 'object' || bundle === null) {
      throw new Error(`i18n: "${path}" must default-export { kk, ru, en }`);
    }
    for (const locale of LOCALES) {
      // A missing locale block stays empty so it falls back; the parity test reports it.
      (resources[locale] as Record<string, MessageTree>)[ns] = (bundle as Partial<MessageBundle>)[locale] ?? {};
    }
  }
  return resources;
}

/** `ru-RU` -> `ru`; anything that is not kk, ru or en -> undefined. */
export function toLocale(code: string | null | undefined): Locale | undefined {
  const primary = code?.trim().toLowerCase().split(/[-_]/)[0];
  return LOCALES.find((locale) => locale === primary);
}

/** Pure: the stored choice, else the first supported browser language, else kk. */
export function detectLanguage(input: { stored?: string | null; languages?: readonly string[] }): Locale {
  const stored = toLocale(input.stored);
  if (stored !== undefined) return stored;
  for (const language of input.languages ?? []) {
    const locale = toLocale(language);
    if (locale !== undefined) return locale;
  }
  return DEFAULT_LOCALE;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type RootLike = { lang: string };

export interface I18nOptions {
  /** Module path -> module, as from `import.meta.glob`. Defaults to none. */
  modules?: MessageModules;
  /** Defaults to globalThis.localStorage, read lazily and guarded (it can be absent or throw). */
  storage?: StorageLike;
  /** Browser languages in order of preference. Defaults to navigator.languages. */
  languages?: readonly string[];
  /** Receives the `lang` attribute. Defaults to document.documentElement. */
  root?: RootLike;
  /** Warn once per missing key. Defaults to `import.meta.env.DEV` (false under bun). */
  dev?: boolean;
}

function storageOf(injected: StorageLike | undefined): StorageLike | undefined {
  try {
    return injected ?? globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/** A fresh, initialised instance. Touches no global state apart from storage and `<html lang>`. */
export function createI18n(options: I18nOptions = {}): I18nInstance {
  const dev = options.dev ?? import.meta.env?.DEV === true;
  const resources = buildResources(options.modules ?? {});
  const read = (): string | null => {
    try {
      return storageOf(options.storage)?.getItem(LANGUAGE_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  };

  const reported = new Set<string>();
  const report = (key: string, what: string): '' => {
    if (dev && !reported.has(key)) {
      reported.add(key);
      const colon = key.indexOf(':');
      const where = colon === -1 ? '' : ` in namespace "${key.slice(0, colon)}"`;
      console.warn(`i18n: ${what} "${colon === -1 ? key : key.slice(colon + 1)}"${where}`);
    }
    return '';
  };

  const instance = createInstance();
  void instance.init({
    resources,
    lng: detectLanguage({ stored: read(), languages: options.languages ?? browserLanguages() }),
    fallbackLng: FALLBACKS,
    supportedLngs: [...LOCALES],
    ns: Object.keys(resources.kk ?? {}),
    defaultNS: false,
    initAsync: false,
    returnNull: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    appendNamespaceToMissingKey: true,
    parseMissingKeyHandler: (key: string) => report(key, 'missing key'),
    // A key that names a branch (an object) instead of text: never render i18next's diagnostic sentence.
    returnedObjectHandler: (key: string) => report(key, 'key names an object, not text:'),
  });

  const apply = (): void => {
    const root = options.root ?? (typeof document === 'undefined' ? undefined : document.documentElement);
    if (root !== undefined) root.lang = toLocale(instance.language) ?? DEFAULT_LOCALE;
  };
  apply();
  // Registered after init: only an explicit later change is a choice worth persisting.
  instance.on('languageChanged', () => {
    apply();
    try {
      storageOf(options.storage)?.setItem(LANGUAGE_STORAGE_KEY, toLocale(instance.language) ?? DEFAULT_LOCALE);
    } catch {
      // Storage full or blocked: the language still changes for this session.
    }
  });
  return instance;
}

/**
 * Vite requires literal arguments. Under `bun test` `import.meta.glob` is not defined, so
 * calling it throws a TypeError mentioning "glob", which means "no modules". Any other
 * error (e.g. thrown by a messages file while it is eagerly evaluated) is rethrown.
 * Same trick as lib/slots.ts.
 */
function globModules(): MessageModules {
  try {
    return import.meta.glob<Record<string, unknown>>('../**/*.messages.ts', { eager: true });
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('glob')) return {};
    throw error;
  }
}

export const i18n: I18nInstance = createI18n({ modules: globModules() });
setI18n(i18n);

const NUMBER_TAGS: Readonly<Record<Locale, string>> = { kk: 'kk-KZ', ru: 'ru-RU', en: 'en-US' };
const formatters = new Map<Locale, Intl.NumberFormat>();

/** Locale-aware number formatting; `locale` defaults to the current language. */
export function formatNumber(value: number, locale?: Locale): string {
  const chosen = locale ?? toLocale(i18n.language) ?? DEFAULT_LOCALE;
  let formatter = formatters.get(chosen);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(NUMBER_TAGS[chosen]);
    formatters.set(chosen, formatter);
  }
  return formatter.format(value);
}
