/// <reference types="vite/client" />
/**
 * Glob extension slots: later beads add UI to the app shell without editing
 * the shell (routes/__root.tsx) or the pages that host a slot.
 *
 * Convention for slot modules:
 * - A slot module lives at `features/<name>/<slot>-extra.tsx`
 *   (`root-extra`, `header-extra`, `today-extra`, `drill-extra`,
 *   `drill-detail-extra`), or, for the privacy panel slot, at
 *   `features/privacy/panels/<x>.panel.tsx`.
 * - It DEFAULT-EXPORTS ONE React component. Named exports are ignored, and so
 *   is a default export that is not a component.
 * - Components are rendered in ascending module-path order (plain `<`/`>`
 *   comparison, no locale), receiving the props declared in `SlotProps`.
 *   Extend a slot's props by declaration merging, without editing this file:
 *   add members to that slot's props interface (the specifier is relative to
 *   the file that declares it, so from `src/features/<name>/` it is):
 *       declare module '../../lib/slots' {
 *         interface TodaySlotProps { day: string }
 *       }
 *   (Redeclaring the `today` property of `SlotProps` itself does not work:
 *   TypeScript rejects a merged property with a different type.)
 *   Slots with no declared props receive `{}`; consumers then read TanStack
 *   Query / route params themselves.
 *
 * `useSlot` is a plain memoised lookup, NOT a React hook: the glob results are
 * static per bundle, so there is no state or subscription, and the same array
 * reference is returned on every call for a given slot name.
 */
import type { ComponentType } from 'react';

export const SLOT_NAMES = ['root', 'header', 'today', 'drill', 'drill-detail', 'privacy-panel'] as const;

export type SlotName = (typeof SLOT_NAMES)[number];

/**
 * Props each slot passes to its components. Each slot points at its own
 * (initially empty) interface because TypeScript only lets declaration merging
 * ADD members to an interface: redeclaring a `SlotProps` property with a new
 * type is an error, whereas adding members to `TodaySlotProps` is not.
 */
export interface RootSlotProps {}
export interface HeaderSlotProps {}
export interface TodaySlotProps {}
export interface DrillSlotProps {}
export interface DrillDetailSlotProps {}
export interface PrivacyPanelSlotProps {}

export interface SlotProps {
  root: RootSlotProps;
  header: HeaderSlotProps;
  today: TodaySlotProps;
  drill: DrillSlotProps;
  'drill-detail': DrillDetailSlotProps;
  'privacy-panel': PrivacyPanelSlotProps;
}

/** Module path -> module namespace, as produced by an eager `import.meta.glob`. */
export type SlotModules = Record<string, Record<string, unknown>>;
export type SlotRegistry = Partial<Record<SlotName, SlotModules>>;

function isComponent(value: unknown): value is ComponentType<never> {
  if (typeof value === 'function') return true;
  return typeof value === 'object' && value !== null && '$$typeof' in value;
}

/** Pure: the default-exported components of one slot, in ascending module-path order. */
export function collectSlot<N extends SlotName>(
  registry: SlotRegistry,
  name: N,
): readonly ComponentType<SlotProps[N]>[] {
  const modules: SlotModules = registry[name] ?? {};
  const paths = Object.keys(modules).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const components: ComponentType<SlotProps[N]>[] = [];
  for (const path of paths) {
    const candidate = modules[path]?.default;
    if (isComponent(candidate)) components.push(candidate as ComponentType<SlotProps[N]>);
  }
  return components;
}

/**
 * Vite requires literal arguments, hence six separate calls. Under `bun test`
 * `import.meta.glob` is not defined, so calling it throws a TypeError; that is
 * treated as "no modules". Any other error (e.g. thrown by a feature module
 * while it is eagerly evaluated) is rethrown.
 */
function globRegistry(): SlotRegistry {
  try {
    return {
      root: import.meta.glob<Record<string, unknown>>('../features/*/root-extra.tsx', { eager: true }),
      header: import.meta.glob<Record<string, unknown>>('../features/*/header-extra.tsx', { eager: true }),
      today: import.meta.glob<Record<string, unknown>>('../features/*/today-extra.tsx', { eager: true }),
      drill: import.meta.glob<Record<string, unknown>>('../features/*/drill-extra.tsx', { eager: true }),
      'drill-detail': import.meta.glob<Record<string, unknown>>('../features/*/drill-detail-extra.tsx', {
        eager: true,
      }),
      'privacy-panel': import.meta.glob<Record<string, unknown>>('../features/privacy/panels/*.panel.tsx', {
        eager: true,
      }),
    };
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('glob')) return {};
    throw error;
  }
}

let registry: SlotRegistry | undefined;
const cache = new Map<SlotName, readonly unknown[]>();

export function useSlot<N extends SlotName>(name: N): readonly ComponentType<SlotProps[N]>[] {
  registry ??= globRegistry();
  const cached = cache.get(name);
  if (cached !== undefined) return cached as readonly ComponentType<SlotProps[N]>[];
  const components = collectSlot(registry, name);
  cache.set(name, components);
  return components;
}
