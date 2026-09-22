import { createFileRoute } from '@tanstack/react-router';
import { requireSession } from '../../features/account/route-guard';

/**
 * Layout for every /settings/* route (auth-gate spec §1–2, P1). Gate-only: no component, no UI, no copy, no message
 * file. `beforeLoad` redirects a visitor with no session (any session, anonymous player included) to the sign-in
 * gate before this route or any child loader runs. See features/account/route-guard.ts.
 */
export const Route = createFileRoute('/settings')({ beforeLoad: requireSession() });
