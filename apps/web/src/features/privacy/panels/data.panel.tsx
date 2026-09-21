import { ENDPOINTS } from '@api-types/privacy';
import * as Dialog from '@radix-ui/react-dialog';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, CircleAlert, Download, Trash2 } from 'lucide-react';
import { del } from 'idb-keyval';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createLastPlayerStore, readLastPlayerId } from '../../../bootstrap';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Field } from '../../../components/ui/field';
import { api } from '../../../lib/api';
import { authClient, resetPlayerSession } from '../../../lib/auth';
import { describeProblem } from '../../../lib/problem';
import { queryCacheKey, type PersistStore } from '../../../lib/query-persist';
import { getDefaultStore, OFFLINE_KEY_PREFIX, playerKeys } from '../../../offline/types';
import { clearDrafts } from '../../account/session-expired';
// Registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../../lib/i18n';

/**
 * The DATA CONTROLS panel of /settings/privacy (bead fc-mol-bjm.8): "Download my data" and "Delete my data".
 *
 * SLOT. lib/slots.ts collects features/privacy/panels/*.panel.tsx (slot `privacy-panel`, no props) and the screen renders the
 * DEFAULT export, so this file needs nothing from routes/settings/privacy.tsx or lib/slots.ts. The default export is the
 * component with the real collaborators; `DataPanel` (a named export, ignored by the slot) takes them as props, for tests.
 * Every string is in features/privacy/data.messages.ts (namespace `data`).
 *
 * DOWNLOAD. GET /api/player/export through the typed client (the export is JSON; the wrapper cannot hand back a Blob or read
 * Content-Disposition), then the JSON is pretty-printed and saved as `first-coach-export-<date>.json`, the date being the
 * document's own `exportedAt` (the name the server proposes). The default saver is an object URL on a `download` link. The
 * button is disabled and busy while the file is prepared, a status says so, a failure is an alert (the same button retries),
 * and success is a status naming the file. Downloading never changes or clears anything.
 *
 * DELETE. The button only opens a modal dialog (Radix Dialog). It states the consequence in one sentence (the data and the
 * account are erased, it cannot be undone) and asks for the LOCALIZED word (en DELETE, ru УДАЛИТЬ, kk ЖОЮ, from the bundle) in a
 * labelled field; the confirm button stays off until the word matches, and so does Enter (the field is a form). Readings:
 *  - "matches": trimmed and case-insensitive. A phone keyboard capitalises or not at random, and a child must not be locked
 *    out of a deliberate action by the shift key. Only the word of the ACTIVE language is accepted (the label names it).
 *  - The safe button ("Keep my data") is first in the dialog and has the initial focus; the field is not auto-focused, so a
 *    phone keyboard does not cover the consequence sentence.
 *  - In flight: the confirm is busy and every control is disabled; Escape and an outside click do not close it; a ref refuses
 *    a second submit in the same tick.
 *  - Failure ("error keeps data"): the request is the FIRST step and nothing local is touched before it says 204, so an error
 *    (server, network) leaves the server data, the cache, the stores and the drafts exactly as they were. The dialog stays open
 *    with the typed word, says the data was not deleted, and the focus moves to that message (the disabled confirm dropped it).
 *  - Success (204; the server has already cleared the cookie): every local store of THIS player is cleared, then the app goes
 *    to the landing page with a FULL page load (`location.assign('/')`), so no in-memory state of the erased player (session
 *    atom, event wiring, persister) survives. Cleared, each step guarded so a failing one cannot keep the player on the page:
 *      1. saved drafts (`clearDrafts`: sessionStorage `fc:draft:*`) and the onboarding draft (`fc:onboarding-draft`, the wizard's
 *         own key, mirrored here as the plan screen mirrors it): a draft must never outlive the person who wrote it;
 *      2. the remembered player session (`resetPlayerSession`), so nothing hands the erased identity back;
 *      3. the in-memory React Query cache (`queryClient.clear()`);
 *      4. localStorage: the offline session and the outbox key of this player, every other `fc:<playerId>:*` key (a later bead's
 *         store is included without editing this file), and `fc:last-player` when it names this player. Another player of the
 *         same device is never touched;
 *      5. IndexedDB, through the `PersistStore` seam: the persisted query cache (`fc:<playerId>:query-cache`, lib/query-persist.ts)
 *         and the outbox (`fc:<playerId>:outbox`, offline/outbox.ts).
 *    A player whose id is unknown (no session, no remembered player) cannot be keyed: only steps 1 to 3 run and no IndexedDB
 *    key is guessed. Everything is gone BEFORE the navigation.
 *
 * CONTRACT GAPS found: (a) on a player route a 401 of DELETE /api/player is answered by the fetch wrapper's silent
 * re-establish and ONE retry (features/account/session-expired.ts): an expired session would then erase a brand-new empty
 * anonymous player, not the one the local data belonged to. It cannot be avoided from here (`skipUnauthorized` only skips the
 * notification). (b) The outbox module has no "clear" function; its IndexedDB key is removed directly.
 */

const ONBOARDING_DRAFT_KEY = 'fc:onboarding-draft';

/** What the panel needs besides the network. Defaults are the real browser pieces; tests inject stand-ins. */
export interface DataPanelDeps {
  /** Hands the export to the browser as a file. Default: an object URL on a `download` link. */
  saveFile(name: string, blob: Blob): void;
  /** Leaves for the landing page. Default: a full page load of `/`. */
  goHome(): void;
  /** Forgets the remembered player session (lib/auth). */
  resetSession(): void;
  /** IndexedDB (idb-keyval) as far as this panel needs it. */
  persistStore: Pick<PersistStore, 'del'>;
}

function saveViaLink(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has taken its own reference by now; a late revoke keeps slow engines from losing the file.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const DEFAULT_DEPS: DataPanelDeps = {
  saveFile: saveViaLink,
  goHome: () => globalThis.location.assign('/'),
  resetSession: resetPlayerSession,
  persistStore: { del: (key) => del(key) },
};

// --- the export file ----------------------------------------------------------------------------------------------------------

/** `first-coach-export-<YYYY-MM-DD>.json`, the date of the document's `exportedAt` (today's date when it has none). */
function exportFileName(doc: Record<string, unknown>): string {
  const stamp = typeof doc.exportedAt === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(doc.exportedAt)?.[0] : undefined;
  return `first-coach-export-${stamp ?? new Date().toISOString().slice(0, 10)}.json`;
}

// --- erasing what the device keeps --------------------------------------------------------------------------------------------

const quietly = (step: () => void): void => {
  try {
    step();
  } catch {
    // Best effort: one store that refuses must neither hide the others nor keep the player on the page.
  }
};

/** An id that can name a storage namespace (`fc:<playerId>:<name>`, so no ':'). */
const usableId = (id: string | undefined): id is string => id !== undefined && id.length > 0 && !id.includes(':');

/** Removes every localStorage key of this player, and the remembered last player when it is this one. */
function eraseLocalStorage(playerId: string): void {
  const store = getDefaultStore();
  if (store === undefined) return;
  const keys = new Set<string>([playerKeys(playerId).session, playerKeys(playerId).outbox]);
  // Keys a later bead added under the same namespace go too. `Storage` can be listed; a bare KeyValueStore cannot.
  const listable = store as Partial<Storage>;
  const prefix = `${OFFLINE_KEY_PREFIX}:${playerId}:`;
  quietly(() => {
    if (typeof listable.key !== 'function' || typeof listable.length !== 'number') return;
    for (let index = 0; index < listable.length; index += 1) {
      const name = listable.key(index);
      if (name !== null && name.startsWith(prefix)) keys.add(name);
    }
  });
  for (const key of keys) quietly(() => store.removeItem(key));
  quietly(() => {
    if (readLastPlayerId(store) === playerId) createLastPlayerStore(store).clear();
  });
}

async function eraseLocalData(playerId: string | undefined, queryClient: QueryClient, deps: DataPanelDeps): Promise<void> {
  quietly(() => clearDrafts());
  quietly(() => globalThis.sessionStorage.removeItem(ONBOARDING_DRAFT_KEY));
  quietly(() => deps.resetSession());
  quietly(() => queryClient.clear());
  if (!usableId(playerId)) return;
  quietly(() => eraseLocalStorage(playerId));
  const keys = [queryCacheKey(playerId), playerKeys(playerId).outbox];
  await Promise.allSettled(keys.map((key) => Promise.resolve().then(() => deps.persistStore.del(key))));
}

// --- styling ------------------------------------------------------------------------------------------------------------------

const H2 = 'm-0 text-[28px] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink';
const H3 = 'm-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink';
const BODY = 'm-0 text-base leading-[1.45] wrap-break-word text-ink';

/** Same word, same rule for every locale: trimmed, case-insensitive. */
const sameWord = (typed: string, word: string): boolean => typed.trim().toUpperCase() === word.trim().toUpperCase();

// --- the panel ----------------------------------------------------------------------------------------------------------------

export interface DataPanelProps {
  /** Whose local data goes on deletion; undefined when the player could not be identified. */
  playerId: string | undefined;
  deps?: Partial<DataPanelDeps>;
}

export function DataPanel({ playerId, deps }: DataPanelProps) {
  const { t } = useTranslation('data');
  const queryClient = useQueryClient();
  const headingId = useId();
  const resolved: DataPanelDeps = { ...DEFAULT_DEPS, ...deps };

  // --- download ---
  const downloading = useRef(false);
  const download = useMutation({
    mutationFn: async (): Promise<string> => {
      const doc = await api.get(ENDPOINTS.exportPlayer.path, { schema: ENDPOINTS.exportPlayer.response });
      const name = exportFileName(doc);
      resolved.saveFile(name, new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
      return name;
    },
    onSettled: () => {
      downloading.current = false;
    },
  });
  const downloadFailure = download.isError ? describeProblem(download.error, (key) => t(key)) : null;

  function startDownload(): void {
    if (downloading.current) return;
    downloading.current = true;
    download.mutate();
  }

  // --- delete ---
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState('');
  const erasing = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const erase = useMutation({
    mutationFn: async (): Promise<void> => {
      // The request comes FIRST: nothing local is touched unless the server says 204.
      await api.delete(ENDPOINTS.deletePlayer.path, { schema: 'none' });
      await eraseLocalData(playerId, queryClient, resolved);
    },
    onSuccess: () => {
      resolved.goHome();
    },
    onSettled: () => {
      erasing.current = false;
    },
  });
  const deleting = erase.isPending;
  const gone = erase.isSuccess;
  const locked = deleting || gone;
  const confirmWord = t('dialog.word');
  const wordMatches = sameWord(word, confirmWord);
  const eraseFailure = erase.isError ? describeProblem(erase.error, (key) => t(key)) : null;

  // The disabled confirm button dropped the keyboard focus: after a failure it goes to the message.
  useEffect(() => {
    if (erase.isError) alertRef.current?.focus();
  }, [erase.isError]);

  function confirm(event?: FormEvent): void {
    event?.preventDefault();
    if (erasing.current || locked || !wordMatches) return;
    erasing.current = true;
    erase.mutate();
  }

  function openDialog(): void {
    erase.reset();
    setWord('');
    setOpen(true);
  }

  const savedName = download.isSuccess ? download.data : '';

  return (
    <section aria-labelledby={headingId}>
      <Card className="grid gap-5">
        <h2 id={headingId} className={H2}>
          {t('title')}
        </h2>

        <div className="grid gap-3">
          <h3 className={H3}>{t('download.title')}</h3>
          <p className={BODY}>{t('download.hint')}</p>
          <Button variant="secondary" loading={download.isPending} onClick={startDownload} className="w-full sm:w-auto sm:self-start">
            {download.isPending ? null : <Download aria-hidden="true" className="size-5 shrink-0" />}
            {t('download.button')}
          </Button>
          {download.isPending ? (
            <p role="status" className="m-0 text-base font-bold text-ink">
              {t('download.working')}
            </p>
          ) : downloadFailure !== null ? (
            <div role="alert" className="grid gap-1 rounded-control border border-danger bg-danger-tint p-3.5 text-ink">
              <p className="m-0 flex items-start gap-2 font-bold">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                <span className="min-w-0 wrap-anywhere">{t('download.failed.title')}</span>
              </p>
              <p className="m-0 text-base wrap-anywhere">{downloadFailure.formMessage}</p>
              <p className="m-0 text-base wrap-anywhere">{t('download.failed.hint')}</p>
            </div>
          ) : download.isSuccess ? (
            <p role="status" className="m-0 flex items-start gap-2 text-base font-bold text-ink">
              <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
              <span className="min-w-0 wrap-anywhere">{t('download.saved', { name: savedName })}</span>
            </p>
          ) : null}
        </div>

        <div className="grid gap-3 border-t border-line pt-5">
          <h3 className={H3}>{t('delete.title')}</h3>
          <p className={BODY}>{t('delete.hint')}</p>
          <Button variant="danger" onClick={openDialog} className="w-full sm:w-auto sm:self-start">
            <Trash2 aria-hidden="true" className="size-5 shrink-0" />
            {t('delete.button')}
          </Button>
        </div>
      </Card>

      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          // The request cannot be taken back: the dialog stays until it has answered.
          if (!next && locked) return;
          setOpen(next);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
          <Dialog.Content
            onOpenAutoFocus={(event) => {
              // The safe button first: a focused field would raise a phone keyboard over the sentence that matters.
              event.preventDefault();
              cancelRef.current?.focus();
            }}
            className={clsx(
              'fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-md -translate-x-1/2 -translate-y-1/2',
              'overflow-y-auto rounded-card border border-line bg-paper p-5.5 text-ink shadow-soft',
            )}
          >
            <form onSubmit={confirm} className="grid gap-4">
              <Dialog.Title className={H3}>{t('dialog.title')}</Dialog.Title>
              <Dialog.Description className={BODY}>{t('dialog.body')}</Dialog.Description>
              <Field label={t('dialog.label', { word: confirmWord })} hint={t('dialog.wordHint')}>
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    value={word}
                    disabled={locked}
                    autoComplete="off"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) => setWord(event.currentTarget.value)}
                  />
                )}
              </Field>
              {deleting ? (
                <p role="status" className="m-0 text-base font-bold text-ink">
                  {t('dialog.deleting')}
                </p>
              ) : gone ? (
                <p role="status" className="m-0 flex items-start gap-2 text-base font-bold text-ink">
                  <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                  <span className="min-w-0 wrap-anywhere">{t('dialog.done')}</span>
                </p>
              ) : null}
              {eraseFailure === null ? null : (
                <div
                  ref={alertRef}
                  role="alert"
                  tabIndex={-1}
                  className="grid gap-1 rounded-control border border-danger bg-danger-tint p-3.5 text-ink"
                >
                  <p className="m-0 flex items-start gap-2 font-bold">
                    <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                    <span className="min-w-0 wrap-anywhere">{t('dialog.failed.title')}</span>
                  </p>
                  <p className="m-0 text-base wrap-anywhere">{eraseFailure.formMessage}</p>
                  <p className="m-0 text-base wrap-anywhere">{t('dialog.failed.hint')}</p>
                </div>
              )}
              <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                <Button ref={cancelRef} variant="secondary" disabled={locked} onClick={() => setOpen(false)}>
                  {t('dialog.cancel')}
                </Button>
                <Button type="submit" variant="danger" loading={locked} disabled={!wordMatches}>
                  {locked ? null : <Trash2 aria-hidden="true" className="size-5 shrink-0" />}
                  {t('dialog.confirm')}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

/** The slot component: the real collaborators, and the player from the auth session (the last player of this device offline). */
export default function DataPanelSlot() {
  const session = authClient.useSession();
  return <DataPanel playerId={session.data?.user.id || readLastPlayerId()} />;
}
