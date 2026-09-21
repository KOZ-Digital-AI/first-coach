/**
 * Offline training contract (client side): what the app keeps on the device so a player
 * can train without a network, and how it reads that back safely.
 *
 * No new endpoints: the session is downloaded with GET /api/player/today and results are
 * replayed with the batch POST /api/player/session-events (N offline results, 1 call).
 * Replay happens on the `online` event and on app start; the Background Sync API is not
 * required. The deterministic offline path needs no LLM and no network, and no video is
 * precached.
 *
 * This module is deliberately DOM-free and framework-free: no service worker, no React,
 * no network, no IndexedDB. Storage goes through the small `KeyValueStore` seam (a
 * `Storage` satisfies it), so later beads inject a real one and tests inject a Map.
 *
 * Every key is namespaced by player id (`fc:<playerId>:<name>`) so two players on a shared
 * device never overwrite each other. Every read is parsed with Zod; a parse failure resets
 * that key (removes it) instead of crashing.
 *
 * The Zod schemas are imported at runtime (reads are parsed) through the @api-types alias.
 */
import { z } from 'zod';
import { Timestamp } from '@api-types/domain';
import { ClientUuid, Locale } from '@api-types/primitives';
import { SessionEvent, TodaySession } from '@api-types/session';

// --- Schemas ---------------------------------------------------------------------------------

/** Today's session as downloaded for one player, complete enough to train offline. */
export const OfflineSession = z.object({
  playerId: z.string().min(1),
  session: TodaySession,
  downloadedAt: Timestamp,
  locale: Locale,
});
export type OfflineSession = z.infer<typeof OfflineSession>;

/** One event waiting to be replayed; `attempts` counts failed sends, `lastError` the latest reason. */
export const OutboxEntry = z.object({
  clientUuid: ClientUuid,
  playerId: z.string().min(1),
  event: SessionEvent,
  createdAt: Timestamp,
  attempts: z.int().nonnegative(),
  lastError: z.string().optional(),
});
export type OutboxEntry = z.infer<typeof OutboxEntry>;

// --- Storage seam ------------------------------------------------------------------------------

/** The part of `Storage` this contract needs. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The browser's localStorage, or undefined when there is none (bun, private mode, blocked
 * storage: merely reading `localStorage` can throw). Never throws.
 */
export function getDefaultStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

// --- Key namespacing -----------------------------------------------------------------------------

export const OFFLINE_KEY_PREFIX = 'fc';
export const SESSION_KEY_NAME = 'session';
export const OUTBOX_KEY_NAME = 'outbox';

/**
 * `fc:<playerId>:<name>`. Neither part may be empty or contain ':', otherwise two players'
 * keys could collide (player 'a:b' + name 'c' and player 'a' + name 'b:c' would both be
 * 'fc:a:b:c').
 */
export function offlineKey(playerId: string, name: string): string {
  for (const [label, part] of [
    ['playerId', playerId],
    ['name', name],
  ] as const) {
    if (part === '') throw new TypeError(`offlineKey: ${label} must not be empty`);
    if (part.includes(':')) throw new TypeError(`offlineKey: ${label} must not contain ':' (got "${part}")`);
  }
  return `${OFFLINE_KEY_PREFIX}:${playerId}:${name}`;
}

/** The full storage keys one player uses. */
export function playerKeys(playerId: string): { session: string; outbox: string } {
  return {
    session: offlineKey(playerId, SESSION_KEY_NAME),
    outbox: offlineKey(playerId, OUTBOX_KEY_NAME),
  };
}

// --- Safe reads and writes ---------------------------------------------------------------------------

/** Removes a key, swallowing storage errors: a reset must never crash the caller. */
function reset(store: KeyValueStore, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    // Nothing more can be done for a store that refuses removal.
  }
}

/**
 * The JSON stored under `key`, or undefined when the key is missing (left alone) or holds
 * unparsable JSON (reset). JSON never parses to undefined, so undefined is unambiguous.
 */
function readJson(store: KeyValueStore, key: string): unknown {
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    reset(store, key);
    return undefined;
  }
}

/**
 * Reads and validates one key. Missing -> undefined (nothing removed). Corrupted JSON or a
 * schema failure -> the key is removed and undefined returned. Never throws.
 */
export function readParsed<T>(store: KeyValueStore, key: string, schema: z.ZodType<T>): T | undefined {
  const json = readJson(store, key);
  if (json === undefined) return undefined;
  const result = schema.safeParse(json);
  if (result.success) return result.data;
  reset(store, key);
  return undefined;
}

/** JSON-stringifies and stores a value. Returns false (never throws) on quota, security or serialisation errors. */
export function writeJson(store: KeyValueStore, key: string, value: unknown): boolean {
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readOfflineSession(store: KeyValueStore, playerId: string): OfflineSession | undefined {
  return readParsed(store, playerKeys(playerId).session, OfflineSession);
}

export function writeOfflineSession(store: KeyValueStore, playerId: string, session: OfflineSession): boolean {
  return writeJson(store, playerKeys(playerId).session, session);
}

/**
 * The player's outbox, [] when there is none. Entries are parsed one by one: a bad entry
 * is dropped and the key rewritten with the survivors, because each entry is an unsent
 * result and losing all of them for one bad row would lose player data. Unparsable JSON or
 * a stored value that is not an array is unrecoverable, so the key is reset.
 */
export function readOutbox(store: KeyValueStore, playerId: string): OutboxEntry[] {
  const key = playerKeys(playerId).outbox;
  const json = readJson(store, key);
  if (json === undefined) return [];
  if (!Array.isArray(json)) {
    reset(store, key);
    return [];
  }
  const entries: OutboxEntry[] = [];
  for (const candidate of json) {
    const result = OutboxEntry.safeParse(candidate);
    if (result.success) entries.push(result.data);
  }
  if (entries.length === json.length) return entries;
  if (entries.length === 0) reset(store, key);
  else writeJson(store, key, entries);
  return entries;
}

export function writeOutbox(store: KeyValueStore, playerId: string, entries: readonly OutboxEntry[]): boolean {
  return writeJson(store, playerKeys(playerId).outbox, entries);
}
