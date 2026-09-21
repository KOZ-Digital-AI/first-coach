import { ENDPOINTS, normalizeRecoveryCode } from '@api-types/privacy';
import { useMutation } from '@tanstack/react-query';
import { Check, CircleAlert, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Notice } from '../../../components/ui/notice';
import { api } from '../../../lib/api';
import { describeProblem, isApiProblem } from '../../../lib/problem';
// Registers the i18n instance before the first render (see the convention in lib/i18n.ts).
import '../../../lib/i18n';

/**
 * RECOVERY CODE PANEL: one panel of the privacy screen's `privacy-panel` slot (lib/slots.ts). It lives at
 * features/privacy/panels/recovery.panel.tsx and DEFAULT-EXPORTS one component, so routes/settings/privacy.tsx renders it next
 * to its sibling panels without being edited. It takes no props and needs nothing from the screen around it: an anonymous
 * guest is a player, so it asks nothing about a session or a plan before the one request.
 * Strings: recovery.messages.ts (namespace `recovery`).
 *
 * Flow. idle -> [Make my recovery code] -> POST /api/player/recovery-code (1 call, no body) -> the code, shown ONCE -> Copy code
 * (optional) and [I wrote it down] -> the code is dropped and only a note stays -> [Make a new code] starts again.
 *
 * THE CODE IS A SECRET AND LIVES ONLY IN THIS COMPONENT'S STATE (memory). Consequences:
 * - The mutation function keeps the code out of what it returns: React Query's mutation cache (which lives for minutes after a
 *   screen unmounts) and anything dehydrated from it never holds the code. The panel registers no query at all, so the persisted
 *   query allow-list (lib/query-persist.ts) has nothing of it to keep, and it must stay that way.
 * - Nothing here touches browser storage or the console. Leaving the screen drops the code (state goes with the component).
 * - The clipboard is the one place the code is sent to, and only when the player presses Copy code.
 *
 * Readings of the criteria where they are open:
 * - "Warns that a new code replaces the old one": the panel has no way to know whether a code exists (there is no read
 *   endpoint), so the warning is on screen BEFORE the button is pressed, again after the confirmation (next to "Make a new
 *   code"), and once more beside the code just made. It is a notice next to the button, not a confirmation dialog.
 * - "Large grouped characters": the four groups of four of the contract's canonical spelling, one element per group in a
 *   2x2 grid at 360px and one row from 600px, on the Ink surface at 28-32px. The response is normalised, so a code sent without
 *   hyphens is still shown (and copied) as ABCD-EFGH-IJKL-MNOP, which is what the restore screen accepts.
 * - "Shown once": after "I wrote it down" the code is gone from the page and from memory. A request that fails shows an alert
 *   in words and the button stays, so it can be tried again.
 * - Focus. The button that was pressed disappears (or is disabled while it runs), so focus moves to the code when it appears,
 *   to the "hidden" note after the confirmation and to the alert after a failure.
 * - States. loading = the button is disabled and busy and its words change ("Making your code"); error = an alert with the
 *   generic localised wording (a 404, no plan yet, is told to set the plan up first); success = the code; copied / could not
 *   copy = a status line in words with an icon, never colour alone.
 */

type CopyState = 'idle' | 'copied' | 'failed';

const H2 = 'm-0 text-[28px] leading-none font-bold tracking-[-.05em] wrap-break-word text-ink';
const H3 = 'm-0 text-xl leading-tight font-bold tracking-tight wrap-break-word text-ink';
const BODY = 'm-0 text-base leading-[1.45] text-ink wrap-anywhere';

export default function RecoveryPanel() {
  const { t } = useTranslation('recovery');
  const headingId = useId();
  const codeTitleId = useId();

  // The canonical code ("ABCD-EFGH-IJKL-MNOP") while it is on screen; null before it is made and after it is confirmed.
  const [code, setCode] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const codeRef = useRef<HTMLDivElement>(null);
  const hiddenRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  // The code goes to state and is NOT returned: the mutation (and so the mutation cache) never holds it.
  const create = useMutation<void, unknown, void>({
    mutationFn: async () => {
      const issued = await api.post(ENDPOINTS.createRecoveryCode.path, { schema: ENDPOINTS.createRecoveryCode.response });
      const canonical = normalizeRecoveryCode(issued.code);
      if (canonical === '') throw new Error('empty recovery code');
      setCode(canonical);
      setCopyState('idle');
      setConfirmed(false);
    },
  });

  const pending = create.isPending;
  const failed = create.isError;
  const noPlan = failed && isApiProblem(create.error) && create.error.kind === 'not_found';
  const failureText = failed ? (noPlan ? t('needsPlan') : describeProblem(create.error, (key) => t(key)).formMessage) : '';

  const showsCode = code !== null;
  useEffect(() => {
    if (showsCode) codeRef.current?.focus();
  }, [showsCode]);
  useEffect(() => {
    if (confirmed) hiddenRef.current?.focus();
  }, [confirmed]);
  useEffect(() => {
    if (failed) alertRef.current?.focus();
  }, [failed]);

  async function copy(): Promise<void> {
    if (code === null) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopyState('copied');
    } catch {
      // Refused, or no clipboard in this browser: the code stays on screen, selectable, and the words say so.
      setCopyState('failed');
    }
  }

  function confirmWritten(): void {
    setCode(null);
    setConfirmed(true);
  }

  return (
    <section aria-labelledby={headingId}>
      <Card className="grid gap-4">
        <h2 id={headingId} className={H2}>
          {t('title')}
        </h2>

        {code !== null ? (
          <div
            ref={codeRef}
            role="group"
            aria-labelledby={codeTitleId}
            tabIndex={-1}
            className="grid gap-4 rounded-card outline-offset-4"
          >
            <h3 id={codeTitleId} className={H3}>
              {t('codeTitle')}
            </h3>
            {/* Tap or click selects the whole code (select-all), the fallback when Copy is not available. */}
            <p
              data-slot="recovery-code"
              className="m-0 grid grid-cols-2 gap-x-4 gap-y-3 rounded-card bg-ink p-5 text-[28px] leading-none font-extrabold tracking-[.08em] text-white tabular-nums select-all sm:grid-cols-4 sm:text-[32px]"
            >
              {code.split('-').map((group, position) => (
                <span key={position} data-slot="recovery-code-group">
                  {group}
                </span>
              ))}
            </p>
            <Notice tone="warn" role="note">
              {t('writeDown')}
            </Notice>
            <p className={BODY}>{t('replaces')}</p>
            <div role="status" className="min-h-6 text-base font-bold text-ink">
              {copyState === 'copied' ? (
                <span className="flex items-start gap-2">
                  <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                  <span className="min-w-0 wrap-anywhere">{t('copied')}</span>
                </span>
              ) : copyState === 'failed' ? (
                <span className="flex items-start gap-2">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                  <span className="min-w-0 wrap-anywhere">{t('copyFailed')}</span>
                </span>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Button variant="secondary" onClick={() => void copy()}>
                <Copy aria-hidden="true" className="size-5 shrink-0" />
                {t('copy')}
              </Button>
              <Button onClick={confirmWritten}>{t('confirm')}</Button>
            </div>
          </div>
        ) : (
          <>
            {confirmed ? (
              <div ref={hiddenRef} role="status" tabIndex={-1} className="flex items-start gap-2 rounded-control text-base font-bold text-ink">
                <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                <span className="min-w-0 wrap-anywhere">{t('hidden')}</span>
              </div>
            ) : (
              <p className={BODY}>{t('lead')}</p>
            )}
            <Notice tone="warn" role="note">
              {t('replaceWarning')}
            </Notice>
            {failed ? (
              <div
                ref={alertRef}
                role="alert"
                tabIndex={-1}
                className="grid gap-1 rounded-control border border-danger bg-danger-tint p-3.5 text-ink"
              >
                <p className="m-0 flex items-start gap-2 font-bold">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                  <span className="min-w-0 wrap-anywhere">{t('failed')}</span>
                </p>
                <p className="m-0 text-base wrap-anywhere">{failureText}</p>
              </div>
            ) : null}
            <Button loading={pending} onClick={() => create.mutate()}>
              {pending ? t('making') : confirmed ? t('makeAgain') : t('make')}
            </Button>
          </>
        )}
      </Card>
    </section>
  );
}
