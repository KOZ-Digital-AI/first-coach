import { z } from "zod";

const DEFAULT_PORT = 4111;
const DEFAULT_DB_PATH = "./data/app.db";
const DEFAULT_WEB_DIST = "apps/web/dist";
const MIN_SECRET_LENGTH = 32;

/** An empty or whitespace-only value counts as unset. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const stringWithDefault = (fallback: string) =>
  z.preprocess(blankToUndefined, z.string().default(fallback));

const PORT_PHRASE = "must be an integer between 1 and 65535";

const shape = {
  PORT: z.preprocess(
    blankToUndefined,
    z
      .string()
      .default(String(DEFAULT_PORT))
      .refine((raw) => /^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 65535, PORT_PHRASE)
      .transform(Number),
  ),
  APP_DB_PATH: stringWithDefault(DEFAULT_DB_PATH),
  MEDIA_DIR: optionalString,
  MASTRA_DB_PATH: optionalString,
  BACKUP_DIR: optionalString,
  WEB_DIST: stringWithDefault(DEFAULT_WEB_DIST),
  BUILD_VERSION: optionalString,
  BETTER_AUTH_SECRET: optionalString,
  BETTER_AUTH_URL: optionalString,
  // Absent only disables AI; never required.
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
  OPENAI_VISION_MODEL: optionalString,
  VITE_CONTACT_EMAIL: optionalString,
};

const baseSchema = z.object(shape);

export type Env = z.output<typeof baseSchema>;

/** The names of every variable the schema validates (NODE_ENV only selects strictness and is not listed). */
export const ENV_VARIABLES: readonly string[] = Object.freeze(Object.keys(shape));

/**
 * Thrown for an invalid environment. The message is built only from variable
 * names and fixed phrases, never from received values.
 */
export class EnvError extends Error {
  readonly variables: string[];

  constructor(variables: string[], details: string[]) {
    super(`Invalid environment: ${details.join("; ")}`);
    this.name = "EnvError";
    this.variables = variables;
  }
}

/**
 * Validates `source` (default: process.env, read at call time). With
 * NODE_ENV=production BETTER_AUTH_SECRET (>= 32 characters) and BETTER_AUTH_URL
 * are required; otherwise they are optional.
 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const production = source.NODE_ENV === "production";

  const schema = baseSchema.superRefine((env, ctx) => {
    if (!production) return;
    const secret = env.BETTER_AUTH_SECRET;
    if (secret === undefined) {
      ctx.addIssue({ code: "custom", path: ["BETTER_AUTH_SECRET"], message: "required in production" });
    } else if (secret.length < MIN_SECRET_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_SECRET"],
        message: `must be at least ${MIN_SECRET_LENGTH} characters in production`,
      });
    }
    if (env.BETTER_AUTH_URL === undefined) {
      ctx.addIssue({ code: "custom", path: ["BETTER_AUTH_URL"], message: "required in production" });
    }
  });

  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const variables: string[] = [];
  const details: string[] = [];
  for (const issue of result.error.issues) {
    const name = String(issue.path[0] ?? "environment");
    if (!variables.includes(name)) variables.push(name);
    // Only our own custom phrases are trusted; Zod's built-in messages may echo input.
    details.push(`${name}: ${issue.code === "custom" ? issue.message : "is invalid"}`);
  }
  throw new EnvError(variables, details);
}
