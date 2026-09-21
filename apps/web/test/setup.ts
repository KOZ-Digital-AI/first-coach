import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Order matters. happy-dom must be registered BEFORE @testing-library/react is
// loaded: a static import would evaluate Testing Library against a missing
// `document` and break `screen` permanently, so it is imported dynamically below.
GlobalRegistrator.register({ url: "http://localhost/" });

// Testing Library auto-registers its own afterEach cleanup unless told not to.
// Disable that (before the import reads it) so the explicit afterEach below is
// the only cleanup and the smoke test genuinely proves cleanup happens.
process.env.RTL_SKIP_AUTO_CLEANUP = "true";
const { cleanup } = await import("@testing-library/react");

/*
 * Cross-file hygiene (fc-mol-eay.15). bun runs every test file of the web package in ONE process with ONE happy-dom window. happy-dom
 * records every element query it has answered (each `querySelectorAll` behind a Testing Library query) in bookkeeping lists on the
 * document, <html> and <body> (`affectsCache`, `affectsComputedStyleCache`) and in the window's `querySelectorCache`, and never
 * trims them. Heavy files (wizard, legal, library, impact, account, journey, forms) leave 6k-22k entries there; a LATER file's
 * failing `expect(element)` (bun pretty-prints the element together with those caches) then takes seconds and blows its timeout
 * (offline-reload.test.tsx "a session that arrives later ..." at 5+ s). After every test the DOM is empty, so the lists are
 * emptied the way happy-dom empties them when a node changes: every recorded result is invalidated first, then the list is cleared.
 * Written against happy-dom 20.x symbols by description; a version without them makes this a no-op.
 */
function resetHappyDomCaches(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const targets: object[] = [document, document.documentElement, document.body, window].filter(
    (target): target is NonNullable<typeof target> => target != null,
  );
  for (const target of targets) {
    for (const symbol of Object.getOwnPropertySymbols(target)) {
      const value: unknown = (target as Record<symbol, unknown>)[symbol];
      if ((symbol.description === "affectsCache" || symbol.description === "affectsComputedStyleCache") && Array.isArray(value)) {
        for (const item of value) if (typeof item === "object" && item !== null) (item as { result: unknown }).result = null;
        value.length = 0;
      } else if (symbol.description === "querySelectorCache" && value instanceof Map) {
        value.clear();
      }
    }
  }
}

afterEach(() => {
  cleanup();
  resetHappyDomCaches();
});
