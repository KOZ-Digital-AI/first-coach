import { createFileRoute } from '@tanstack/react-router';
import { requireSession } from '../../features/account/route-guard';

/**
 * Layout for every /train/* route (auth-gate spec §1–2, P1). Gate-only: no component (TanStack's default layout
 * component is `<Outlet />`), no UI, no copy, no message file.
 *
 * `beforeLoad` runs, and can throw a `redirect` to the sign-in gate, BEFORE this route (or any child route's own
 * beforeLoad/loader) starts — so a signed-out visitor never triggers a gated API call and never sees the page. "Any
 * session" is enough: an anonymous player session is a real player with real rows, so training needs no account.
 * See features/account/route-guard.ts for the guard itself.
 */
export const Route = createFileRoute('/train')({ beforeLoad: requireSession() });
