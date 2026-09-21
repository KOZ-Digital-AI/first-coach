// The AI call log writer (fc-mol-zo6.6): one ai_calls row (008_ai_calls.sql) per AI request.
//
//   logAiCall(db, entry, log?) -> true when the row was written, false when it was not
//
// The table is an operational log (which model, how long, how many tokens, did the validator accept
// the answer, why did it fall back), NOT a transcript. The table's CHECKs cannot tell an id from a
// person's words spelt as several short id-shaped elements, so THIS WRITER IS THE SOLE GUARD FOR FREE
// TEXT. It takes ids, a hash and short codes, and it never stores a prompt, a model answer, the
// player's note, a profile or an image: every text field is clamped or replaced before the insert.
//
// It never throws into the caller's request path: a failed log write must not fail the AI call. Every
// failure (a closed or throwing database, a foreign-key refusal, an entry that cannot be read, a
// refused kind) is caught, reported as ONE error line to `log` (default: console.error, JSON) that
// carries only the error's class name and SQLite code, never the entry or the error message, and
// answered with false.
//
// Readings of the criteria (decisions, not in the bead text):
//   - the entry carries the profile HASH (sha-256 hex, computed by the caller); anything else in that
//     slot is stored as NULL, never as text. A row without a player also gets a NULL hash: such a row
//     belongs to nobody and is never erased by a cascade, so it holds nothing derived from a profile.
//   - `kind` and `fallbackCode` say what happened; a wrong value would misreport it, so a value outside
//     the vocabulary REFUSES the row (false + a log line) instead of being coerced. Fields that could
//     carry personal text are made safe instead, so the row is still written.
//   - `model` and `validatorResult` are short codes, not text: after trimming they must be made of
//     [A-Za-z0-9._:/@+=,;|-] (no spaces). Otherwise `model` is stored as "unknown" and
//     `validatorResult` as "invalid_format". Blank: "unknown" / NULL (no validator ran). Both are cut
//     to 200 characters.
//   - `candidateIds` are the ids the server offered, `chosenIds` the ids the AI picked and validation
//     kept. Elements that are not an EntityId (shared/primitives: A-Za-z0-9._- , 1..128) are dropped;
//     chosen ids the server never offered are dropped; a fallback row has NO chosen ids. A list longer
//     than 8192 characters as JSON keeps the longest prefix that fits (chosen is filtered against the
//     FULL offered set before it is cut, so after a cut it may name an id whose candidate entry was cut).
//   - latency is rounded to whole milliseconds and never negative (NaN: 0); a token count the provider
//     did not report, or an impossible one (negative, NaN), is NULL.
//   - a player with no profile row fails the foreign key: the row is not written and the failure is
//     logged (it also covers a player erased while the call was in flight).
import type { Database } from "bun:sqlite";
import { AI_FALLBACK_CODES } from "../shared/ai";
import type { AiFallbackCode } from "../shared/ai";
import { EntityId } from "../shared/primitives";

export const AI_CALL_KINDS = ["plan", "explain", "video"] as const;
export type AiCallKind = (typeof AI_CALL_KINDS)[number];

/** One AI request, as the caller knows it. Everything here is metadata, ids and codes. */
export interface AiCallEntry {
  /** The auth user id, or null for a call that belongs to no player. */
  playerId: string | null;
  kind: AiCallKind;
  /** The provider's model id as configured, e.g. "openai/gpt-4o-mini". */
  model: string;
  /** sha-256 hex of the canonical profile that was sent, or null. Never the profile itself. */
  profileHash: string | null;
  /** The ids the server offered (the approved drill versions). */
  candidateIds: readonly string[];
  /** The ids the AI picked and validation kept. Ignored (stored empty) when fallbackCode is set. */
  chosenIds: readonly string[];
  /** A short outcome code of the server-side validation, or null when no validator ran. */
  validatorResult: string | null;
  /** Why the deterministic session was served instead, or null when the AI answer was served. */
  fallbackCode: AiFallbackCode | null;
  latencyMs: number;
  /** The provider's usage counts, or null when it did not report them. */
  tokensIn: number | null;
  tokensOut: number | null;
}

export type AiLogSink = (line: object) => void;

/** Length limits mirrored from 008_ai_calls.sql. */
const MAX_TEXT = 200;
const MAX_IDS_JSON = 8192;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CODE_LIKE = /^[A-Za-z0-9._:/@+=,;|-]+$/;

const INSERT_SQL = `INSERT INTO ai_calls
  (player_id, kind, model, profile_hash, candidate_ids, chosen_ids, validator_result, fallback_code, latency_ms, tokens_in, tokens_out)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** An entry the writer refuses to store; `field` is a fixed literal, never a value of the entry. */
class AiLogRefusal extends Error {
  constructor(readonly field: "player_id" | "kind" | "fallback_code") {
    super("ai_calls: entry refused");
    this.name = "AiLogRefusal";
  }
}

const defaultSink: AiLogSink = (line) => console.error(JSON.stringify(line));

function cleanModel(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return CODE_LIKE.test(text) ? text.slice(0, MAX_TEXT) : "unknown";
}

function cleanValidatorResult(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" && typeof value === "string") return null;
  return CODE_LIKE.test(text) ? text.slice(0, MAX_TEXT) : "invalid_format";
}

function cleanHash(value: unknown): string | null {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  return SHA256_HEX.test(text) ? text : null;
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && EntityId.safeParse(id).success);
}

/** The longest prefix of `ids` whose compact JSON form fits the column's cap (ids are ASCII, so no escapes). */
function fit(ids: readonly string[]): string[] {
  let length = 2; // []
  const kept: string[] = [];
  for (const id of ids) {
    const next = length + id.length + 2 + (kept.length > 0 ? 1 : 0); // quotes, and a comma after the first
    if (next > MAX_IDS_JSON) break;
    length = next;
    kept.push(id);
  }
  return kept;
}

function cleanCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.round(value), Number.MAX_SAFE_INTEGER);
}

function cleanLatency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), Number.MAX_SAFE_INTEGER);
}

function cleanPlayerId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") throw new AiLogRefusal("player_id");
  return value;
}

/** The safe part of a failure: a class name and a SQLite code, never a message. */
function describeFailure(error: unknown): object {
  const line: Record<string, string> = { error: "Error" };
  if (error instanceof AiLogRefusal) return { error: error.name, refused: error.field };
  if (error instanceof Error && /^\w{1,64}$/.test(error.name)) line.error = error.name;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^\w{1,64}$/.test(code)) line.code = code;
  return line;
}

/**
 * Writes one ai_calls row. Returns true when it was written, false when it was not; never throws.
 * `log` receives one error line per failure (default: console.error).
 */
export function logAiCall(db: Database, entry: AiCallEntry, log: AiLogSink = defaultSink): boolean {
  try {
    const playerId = cleanPlayerId(entry.playerId);
    const kind = entry.kind;
    if (!(AI_CALL_KINDS as readonly string[]).includes(kind)) throw new AiLogRefusal("kind");
    const fallbackCode = entry.fallbackCode ?? null;
    if (fallbackCode !== null && !(AI_FALLBACK_CODES as readonly string[]).includes(fallbackCode)) {
      throw new AiLogRefusal("fallback_code");
    }

    const offered = idsOf(entry.candidateIds);
    const offeredSet = new Set(offered);
    const chosen = fallbackCode === null ? idsOf(entry.chosenIds).filter((id) => offeredSet.has(id)) : [];

    db.run(INSERT_SQL, [
      playerId,
      kind,
      cleanModel(entry.model),
      playerId === null ? null : cleanHash(entry.profileHash),
      JSON.stringify(fit(offered)),
      JSON.stringify(fit(chosen)),
      cleanValidatorResult(entry.validatorResult),
      fallbackCode,
      cleanLatency(entry.latencyMs),
      cleanCount(entry.tokensIn),
      cleanCount(entry.tokensOut),
    ]);
    return true;
  } catch (error) {
    try {
      log({ level: "error", msg: "ai_calls: log write failed", ...describeFailure(error) });
    } catch {
      // the log sink is not allowed to fail the AI call either
    }
    return false;
  }
}
