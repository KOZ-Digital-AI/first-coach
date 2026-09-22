import { createFileRoute } from '@tanstack/react-router';
import { requireAccount } from '../../features/account/route-guard';

/**
 * Layout for every /contribute/* route (auth-gate spec §1–2, P1). Gate-only: no component, no UI, no copy, no
 * message file. `beforeLoad` redirects a visitor without a real, non-anonymous account to the sign-in gate before
 * this route or any child loader runs — an anonymous player session is not enough: contributing needs an account.
 * The existing in-component redirect in routes/contribute/index.tsx is untouched: after this layout gate lands it
 * is unreachable on a first visit, and stays correct for a session that ends while the page is open. See
 * features/account/route-guard.ts.
 */
export const Route = createFileRoute('/contribute')({ beforeLoad: requireAccount() });
