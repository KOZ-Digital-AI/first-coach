import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AI_UNAVAILABLE } from "../shared/ai";
import { PROBLEM_CONTENT_TYPE, ProblemDetails } from "../shared/primitives";
import { fromZodError, problem } from "./problem";

function failure(schema: z.ZodType, input: unknown): z.ZodError {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected the schema to reject the input");
  return result.error;
}

describe("fromZodError", () => {
  test("maps a nested field failure to a JSON pointer with a detail", () => {
    const schema = z.object({ profile: z.object({ age: z.number() }) });
    const errors = fromZodError(failure(schema, { profile: { age: "x" } }));

    const entry = errors.find((e) => e.pointer === "/profile/age");
    expect(entry).toBeDefined();
    expect(entry?.detail.length).toBeGreaterThan(0);
  });

  test("maps a root-level issue to the empty pointer", () => {
    const errors = fromZodError(failure(z.string(), 42));

    expect(errors.some((e) => e.pointer === "")).toBe(true);
  });

  test("renders array indexes as path segments", () => {
    const schema = z.object({ items: z.array(z.object({ name: z.string() })) });
    const errors = fromZodError(failure(schema, { items: [{ name: "ok" }, { name: 1 }] }));

    expect(errors.some((e) => e.pointer === "/items/1/name")).toBe(true);

    const first = fromZodError(failure(schema, { items: [{ name: 1 }] }));
    expect(first.some((e) => e.pointer === "/items/0/name")).toBe(true);
  });

  test("escapes '/' in a key as ~1", () => {
    const errors = fromZodError(failure(z.object({ "a/b": z.number() }), { "a/b": "x" }));

    expect(errors.some((e) => e.pointer === "/a~1b")).toBe(true);
  });

  test("escapes '~' in a key as ~0", () => {
    const errors = fromZodError(failure(z.object({ "a~b": z.number() }), { "a~b": "x" }));

    expect(errors.some((e) => e.pointer === "/a~0b")).toBe(true);
  });

  test("escapes '~' before '/' so '~/' becomes ~0~1", () => {
    const errors = fromZodError(failure(z.object({ "~/": z.number() }), { "~/": "x" }));

    expect(errors.some((e) => e.pointer === "/~0~1")).toBe(true);
  });
});

describe("problem", () => {
  test("builds an application/problem+json response with status and errors", async () => {
    const schema = z.object({ profile: z.object({ age: z.number() }) });
    const errors = fromZodError(failure(schema, { profile: { age: "x" } }));

    const response = problem(422, "Validation failed", "The request body is invalid", errors);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    expect(PROBLEM_CONTENT_TYPE).toBe("application/problem+json");

    const parsed = ProblemDetails.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.status).toBe(422);
    expect(parsed.data.title).toBe("Validation failed");
    expect(parsed.data.detail).toBe("The request body is invalid");
    expect(parsed.data.errors.some((e) => e.pointer === "/profile/age")).toBe(true);
  });

  test("works with no detail and no errors", async () => {
    const response = problem(404, "Not found");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);

    const parsed = ProblemDetails.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe("about:blank");
    expect(parsed.data.title).toBe("Not found");
    expect(parsed.data.status).toBe(404);
  });

  test("default output is unchanged: exact about:blank body with no extra keys", async () => {
    const response = problem(404, "Not Found", "No route matches GET /x");

    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "No route matches GET /x",
    });
  });

  test("a custom type is emitted instead of about:blank", async () => {
    const response = problem(503, "AI Coach is unavailable", undefined, undefined, {
      type: "https://example.com/probs/out-of-credit",
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.type).toBe("https://example.com/probs/out-of-credit");
    expect(body.type).not.toBe("about:blank");
  });

  test("the shared AI_UNAVAILABLE code round-trips through the ProblemDetails schema", async () => {
    const response = problem(503, "AI Coach is unavailable", "Try again later", undefined, {
      type: AI_UNAVAILABLE,
    });

    const parsed = ProblemDetails.parse(await response.json());
    expect(parsed.type).toBe(AI_UNAVAILABLE);
    expect(parsed.type).toBe("ai_unavailable");
    expect(parsed.status).toBe(503);
    expect(parsed.title).toBe("AI Coach is unavailable");
    expect(parsed.detail).toBe("Try again later");
  });

  test("a custom type still merges with detail and errors", async () => {
    const errors = [{ pointer: "/goal", detail: "Required" }];
    const response = problem(422, "Validation failed", "Bad body", errors, { type: "invalid_goal" });

    const parsed = ProblemDetails.parse(await response.json());
    expect(parsed.type).toBe("invalid_goal");
    expect(parsed.detail).toBe("Bad body");
    expect(parsed.errors).toEqual(errors);
  });

  test("options without a type keep the about:blank default", async () => {
    const response = problem(500, "Internal Server Error", undefined, undefined, {});

    const parsed = ProblemDetails.parse(await response.json());
    expect(parsed.type).toBe("about:blank");
  });

  test("an explicitly undefined type falls back to about:blank", async () => {
    const response = problem(500, "Internal Server Error", undefined, undefined, {
      type: undefined,
    });

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.type).toBe("about:blank");
  });
});
