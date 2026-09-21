/**
 * Offline session store: today's training session kept on the device so a player can train
 * without a network.
 *
 *   await downloadToday(playerId, 'kk');           // GET /api/player/today, stored as an OfflineSession
 *   const offline = getOffline(playerId, date);    // read back, no network; undefined when there is none
 *   applyLocalEvent(event);                        // drill_done / drill_undone flip the item's `done` flag
 *   status();                                      // { available, downloadedAt }
 *
 * Storage goes through the `KeyValueStore` seam of ./types (a `Storage` satisfies it; tests inject a
 * Map-backed fake), keys are namespaced by player id, and every read is parsed with Zod: a corrupted
 * record is reset (removed) and reads as "nothing downloaded", never a crash. No service worker, no
 * React, no LLM; the only network call is the download itself, through the typed client.
 *
 * A downloaded session is a snapshot. Nothing here refreshes it from newer commons versions:
 * `getOffline` never touches the network, `applyLocalEvent` only flips `done` flags, and
 * downloading again while the stored session has the same `session.id` keeps the stored one (its
 * content, drill versions, `downloadedAt` and any progress made offline). Only a session with a
 * different id (a new day's plan) replaces it.
 *
 * Readings of the bead where it is ambiguous:
 * - `applyLocalEvent(event)` and `status()` take no player id, so the store keeps an "active player":
 *   the id last passed to `downloadToday` or `getOffline` (in memory, so a restarted app re-selects it
 *   by reading first). Both also accept an explicit trailing `playerId`, which wins over the active one.
 * - `available` means a valid session is stored for that player, whatever its date; callers that need
 *   today's session use `getOffline(playerId, date)`.
 * - A write that fails (quota, blocked storage) throws: silently losing a download or a tick would be
 *   worse than a visible error. "Nothing to apply" (no session, other session, unknown item, a
 *   malformed event) is not an error: `applyLocalEvent` returns undefined and writes nothing.
 * - This bead does not touch the outbox: queuing the event for replay belongs to the outbox bead.
 */
import { type Api, api as defaultApi } from '../lib/api';
import { SessionEvent, TodaySession } from '@api-types/session';
import type { Locale } from '@api-types/primitives';
import { getDefaultStore, type KeyValueStore, type OfflineSession, readOfflineSession, writeOfflineSession } from './types';

export interface SessionStoreDeps {
  /** Device storage. Default: localStorage when there is one. `null` means "this device has no storage". */
  store?: KeyValueStore | null;
  /** The typed client used for the download. Default: the app-wide client. */
  api?: Pick<Api, 'get'>;
  /** The clock stamped into `downloadedAt`. Default: the system clock. */
  now?: () => Date;
}

export interface SessionStatus {
  available: boolean;
  /** ISO timestamp of the download, null when nothing valid is stored. */
  downloadedAt: string | null;
}

export interface SessionStore {
  downloadToday(playerId: string, locale: Locale): Promise<OfflineSession>;
  getOffline(playerId: string, date: string): OfflineSession | undefined;
  applyLocalEvent(event: SessionEvent, playerId?: string): OfflineSession | undefined;
  status(playerId?: string): SessionStatus;
}

const TODAY_PATH = '/api/player/today';

export function createSessionStore(deps: SessionStoreDeps = {}): SessionStore {
  const client = deps.api ?? defaultApi;
  const now = deps.now ?? (() => new Date());
  // Looked up per call: reading localStorage can throw or change (private mode, cleared site data).
  const storage = (): KeyValueStore | undefined => (deps.store === undefined ? getDefaultStore() : (deps.store ?? undefined));
  let active: string | undefined;

  function persist(store: KeyValueStore, playerId: string, offline: OfflineSession): void {
    if (!writeOfflineSession(store, playerId, offline)) {
      throw new Error('session-store: the offline session could not be saved on this device');
    }
  }

  return {
    async downloadToday(playerId, locale) {
      active = playerId;
      const store = storage();
      if (store === undefined) throw new Error('session-store: this device has no storage for offline sessions');

      const session = await client.get(`${TODAY_PATH}?locale=${encodeURIComponent(locale)}`, { schema: TodaySession });

      // Same session already on the device: keep it exactly as downloaded (see the module note).
      const existing = readOfflineSession(store, playerId);
      if (existing !== undefined && existing.session.id === session.id) return existing;

      const offline: OfflineSession = { playerId, session, downloadedAt: now().toISOString(), locale };
      persist(store, playerId, offline);
      return offline;
    },

    getOffline(playerId, date) {
      active = playerId;
      const store = storage();
      if (store === undefined) return undefined;
      const offline = readOfflineSession(store, playerId);
      return offline !== undefined && offline.session.date === date ? offline : undefined;
    },

    applyLocalEvent(event, playerId = active) {
      const parsed = SessionEvent.safeParse(event);
      if (!parsed.success || playerId === undefined) return undefined;
      const { type, sessionId, itemId } = parsed.data;
      const done = type === 'drill_done' ? true : type === 'drill_undone' ? false : undefined;
      if (done === undefined || itemId === undefined) return undefined;

      const store = storage();
      if (store === undefined) return undefined;
      const offline = readOfflineSession(store, playerId);
      if (offline === undefined || offline.session.id !== sessionId) return undefined;
      const item = offline.session.items.find((candidate) => candidate.itemId === itemId);
      if (item === undefined) return undefined;
      if (item.done === done) return offline;

      const updated: OfflineSession = {
        ...offline,
        session: {
          ...offline.session,
          items: offline.session.items.map((candidate) => (candidate.itemId === itemId ? { ...candidate, done } : candidate)),
        },
      };
      persist(store, playerId, updated);
      return updated;
    },

    status(playerId = active) {
      const store = storage();
      const offline = store === undefined || playerId === undefined ? undefined : readOfflineSession(store, playerId);
      return offline === undefined ? { available: false, downloadedAt: null } : { available: true, downloadedAt: offline.downloadedAt };
    },
  };
}

/** The device-wide store: real client, the device's localStorage, the system clock. */
const deviceStore = createSessionStore();

export const downloadToday = (playerId: string, locale: Locale): Promise<OfflineSession> => deviceStore.downloadToday(playerId, locale);
export const getOffline = (playerId: string, date: string): OfflineSession | undefined => deviceStore.getOffline(playerId, date);
export const applyLocalEvent = (event: SessionEvent, playerId?: string): OfflineSession | undefined => deviceStore.applyLocalEvent(event, playerId);
export const status = (playerId?: string): SessionStatus => deviceStore.status(playerId);
