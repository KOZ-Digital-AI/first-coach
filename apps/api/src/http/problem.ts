// RFC 9457 problem-details response helper. Imports only zod types and the
// shared ProblemDetails primitive; the app-level error handler is a later bead.
import type { ZodError } from "zod";
import { PROBLEM_CONTENT_TYPE } from "../shared/primitives";
import type { ProblemError } from "../shared/primitives";

/** Escapes one path segment per RFC 6901 ("~" first, then "/"). */
const escapeSegment = (segment: PropertyKey): string =>
  String(segment).replaceAll("~", "~0").replaceAll("/", "~1");

/** Root path -> "" (whole document); otherwise "/" + escaped segments. */
const toPointer = (path: readonly PropertyKey[]): string =>
  path.map((segment) => `/${escapeSegment(segment)}`).join("");

/** Maps Zod issues to problem-details `errors[]` with JSON Pointer locations. */
export function fromZodError(error: ZodError): ProblemError[] {
  return error.issues.map((issue) => ({
    pointer: toPointer(issue.path),
    detail: issue.message,
  }));
}

/** Builds an `application/problem+json` Response matching `ProblemDetails`. */
export function problem(
  status: number,
  title: string,
  detail?: string,
  errors?: ProblemError[],
): Response {
  const body = {
    type: "about:blank",
    title,
    status,
    ...(detail !== undefined && { detail }),
    ...(errors !== undefined && { errors }),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": PROBLEM_CONTENT_TYPE },
  });
}
