// GET and PUT /api/admin/settings (fc-mol-0v3.7): the admin settings screen's two calls.
//
// Both sit behind requireAdmin, which runs BEFORE the body is read: a request without a session is
// a 401 and a signed-in non-admin a 403 whatever the body holds, and neither can reach the store.
//
// GET answers the full typed settings (`getSettings`). PUT takes a patch of any subset of them:
//   - a body that is not a JSON object is a 400;
//   - a patch the typed schema refuses (an invalid value, an unknown key at any depth) is a 422
//     with `errors: [{ pointer, detail }]`, JSON Pointers as in problem.ts ("/uploadMaxMb",
//     "/minStatusByAgeBand/u10", "/theme" for an unknown key), and NOTHING is written;
//   - otherwise `updateSettings` writes the patch in one transaction (nested `minStatusByAgeBand`
//     merges per band, as the store decides) and the response is the FULL updated object.
//
// Nothing is kept in this module: every request reads the database, so a change is what the next
// reader (the planner's candidate filter calls `getSettings` too) sees, with no restart.
import type { Hono } from "hono";
import { ZodError } from "zod";
import type { AppDeps } from "../../app";
import { getSettings, SettingsPatch, updateSettings } from "../../admin/settings";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requireAdmin } from "../../auth/middleware";
import { ENDPOINTS } from "../../shared/admin";
import { fromZodError, problem } from "../problem";

/** One issue per unknown key, at that key's own path, so its pointer names the key. */
function expandUnknownKeys(error: ZodError): ZodError {
  return new ZodError(
    error.issues.flatMap((issue): typeof error.issues =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => ({ ...issue, keys: [key], path: [...issue.path, key] }))
        : [issue],
    ),
  );
}

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this
  // holds whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const admin = requireAdmin(deps);

  app.get(ENDPOINTS.getSettings.path, admin, (c) => c.json(getSettings(deps.db), 200));

  app.put(ENDPOINTS.putSettings.path, admin, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }

    const parsed = SettingsPatch.safeParse(body);
    if (!parsed.success) {
      return problem(
        422,
        "Unprocessable Entity",
        "The settings were not saved: some values are invalid.",
        fromZodError(expandUnknownKeys(parsed.error)),
      );
    }

    return c.json(updateSettings(deps.db, parsed.data), 200);
  });
}
