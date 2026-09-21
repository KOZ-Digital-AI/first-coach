// Model configuration for the AI Coach (fc-mol-zo6.2).
//
// Mastra's model router takes ids of the form "<provider>/<model>"; ours are
// `openai/${OPENAI_MODEL}` (text) and `openai/${OPENAI_VISION_MODEL}` (vision).
// The router reads OPENAI_API_KEY from the environment itself, so this module
// only decides whether AI is available and which ids to hand over.
//
// Everything takes an env source (default: process.env, read at call time) so
// tests inject values and nothing is captured at import.
//
// Readings of the criteria (the env schema documents no defaults):
//   - an unset or blank OPENAI_MODEL falls back to DEFAULT_OPENAI_MODEL;
//   - an unset or blank OPENAI_VISION_MODEL falls back to the text model name
//     (a vision-capable default keeps one setting enough);
//   - blank values count as unset and are trimmed, as in ../env.

export type ModelEnv = Record<string, string | undefined>;

/** Text model used when OPENAI_MODEL is unset. */
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

const PROVIDER = "openai";

const read = (env: ModelEnv, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const textModelName = (env: ModelEnv): string => read(env, "OPENAI_MODEL") ?? DEFAULT_OPENAI_MODEL;

/** True when an OpenAI key is configured. Absence only disables AI; it never blocks boot. */
export function aiAvailable(env: ModelEnv = process.env): boolean {
  return read(env, "OPENAI_API_KEY") !== undefined;
}

/** Model router id of the text model: `openai/${OPENAI_MODEL}`. */
export function textModelId(env: ModelEnv = process.env): string {
  return `${PROVIDER}/${textModelName(env)}`;
}

/** Model router id of the vision model: `openai/${OPENAI_VISION_MODEL}`. */
export function visionModelId(env: ModelEnv = process.env): string {
  return `${PROVIDER}/${read(env, "OPENAI_VISION_MODEL") ?? textModelName(env)}`;
}
