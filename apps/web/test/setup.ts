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

afterEach(() => {
  cleanup();
});
