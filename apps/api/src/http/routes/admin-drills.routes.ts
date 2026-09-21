// POST /api/admin/drills/:slug/status and POST /api/admin/drills/:slug/unpublish (fc-mol-0v3.5): the
// admin's two drill actions, thin wrappers over the moderation service (contributions/moderation).
//
// AUTHORITY (the service checks none of it: it trusts the Admin it is handed)
//   Both routes sit behind requireAdmin, which runs BEFORE the slug, the body or the store is looked
//   at: no session is a 401; a signed-in non-admin (anonymous, contributor, banned, a role that only
//   resembles admin) a 403, whatever the request holds. The Admin handed to the service is built from
//   the SESSION user only (`c.var.user`: id and name). Nothing else in the request names an admin: the
//   body schemas are STRICT objects, so a body that tries to (`reviewer`, `admin`, `role`, ...) is a 422
//   and nothing is written, and headers are never read.
//
// ERRORS (RFC 9457 problem details, `errors[]` with JSON Pointers as in problem.ts)
//   - 401 / 403: the guard.
//   - 400: a slug the contract refuses (pointer /slug), or a body that is not a JSON object.
//   - 422: a body the contract's strict schema refuses (blank or missing note / reason, unknown
//     toStatus, an unknown key at its own pointer) or a moderation rule the service refuses (a status
//     the drill already has -> /toStatus; ACADEMY_VERIFIED without an orgLabel -> /orgLabel). Nothing is
//     written: the service runs each action in one transaction.
//   - 404: no PUBLISHED drill has this slug (unknown, or already unpublished).
//   - anything else propagates to the app's error handler (500); it is never swallowed.
//
// RESPONSES: 200 with the updated DrillDetail, its `reviews` including the row this call wrote. The
// unpublish answer is the detail as it was published, plus its new row (the drill is a 404 in the
// commons routes from then on; DrillDetail has no unpublished marker).
//
// MEDIA: unpublishing purges the drill's media from PUBLIC serving. GET /api/media/:id serves an
// attachment publicly only while its contribution is approved AND the resulting drill has
// `unpublished_at IS NULL`; the service sets `unpublished_at`, so from that moment the attachments are
// readable only by their submitter and an admin (404 for everyone else, cache `private, no-store`). The
// files themselves are KEPT, as versions are (evidence for a rights complaint); reading of "purges the
// drill's media from public serving": no file is deleted here.
import type { Context, Hono } from "hono";
import { ZodError } from "zod";
import type { ZodType } from "zod";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requireAdmin } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { DrillNotFoundError, ModerationRefusedError, setStatus, unpublish } from "../../contributions/moderation";
import type { ModerationRefusal } from "../../contributions/moderation";
import { ENDPOINTS } from "../../shared/admin";
import type { ProblemError } from "../../shared/primitives";
import { fromZodError, problem } from "../problem";

type AdminContext = Context<{ Variables: AuthVariables }>;

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

/** Where in the body each moderation refusal points; the others have no single field. */
const REFUSAL_POINTERS: Partial<Record<ModerationRefusal, string>> = {
  note_required: "/note",
  reason_required: "/reason",
  org_label_required: "/orgLabel",
  same_status: "/toStatus",
};

function refused(error: ModerationRefusedError): Response {
  const pointer = REFUSAL_POINTERS[error.reason];
  const errors: ProblemError[] | undefined = pointer === undefined ? undefined : [{ pointer, detail: error.message }];
  return problem(422, "Unprocessable Entity", error.message, errors);
}

const notFound = (): Response => problem(404, "Not Found", "No published drill has this slug.");

/** The slug (400 on a bad one) and the strict body (400 not an object, 422 refused), or the response to send. */
async function readRequest<T>(c: AdminContext, schema: ZodType<T>): Promise<{ slug: string; body: T } | Response> {
  const params = ENDPOINTS.setDrillStatus.params.safeParse(c.req.param());
  if (!params.success) return problem(400, "Bad Request", "Invalid request parameters.", fromZodError(params.error));

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return problem(400, "Bad Request", "The request body must be a JSON object.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return problem(400, "Bad Request", "The request body must be a JSON object.");
  }

  const body = schema.safeParse(raw);
  if (!body.success) {
    return problem(422, "Unprocessable Entity", "The request was refused: some values are invalid.", fromZodError(expandUnknownKeys(body.error)));
  }
  return { slug: params.data.slug, body: body.data };
}

/** The acting admin: the session's user, never anything the request says. */
const adminOf = (c: AdminContext) => {
  const user = c.get("user");
  return { id: user.id, name: user.name };
};

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this
  // holds whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const admin = requireAdmin(deps);

  app.post(ENDPOINTS.setDrillStatus.path, admin, async (c) => {
    const read = await readRequest(c, ENDPOINTS.setDrillStatus.request);
    if (read instanceof Response) return read;
    try {
      return c.json(setStatus(deps.db, adminOf(c), read.slug, read.body), 200);
    } catch (error) {
      if (error instanceof DrillNotFoundError) return notFound();
      if (error instanceof ModerationRefusedError) return refused(error);
      throw error;
    }
  });

  app.post(ENDPOINTS.unpublishDrill.path, admin, async (c) => {
    const read = await readRequest(c, ENDPOINTS.unpublishDrill.request);
    if (read instanceof Response) return read;
    try {
      return c.json(unpublish(deps.db, adminOf(c), read.slug, read.body), 200);
    } catch (error) {
      if (error instanceof DrillNotFoundError) return notFound();
      if (error instanceof ModerationRefusedError) return refused(error);
      throw error;
    }
  });
}
