// The video coach's store and helpers (fc-mol-8nt.5): what POST/GET /api/player/video-analyses need besides HTTP.
//
//   insertAnalysis(db, row)          one video_analyses row (009_video.sql), idempotent by client_uuid; never a frame
//   findByClientUuid(db, uuid)       the row that owns a clientUuid, whoever owns it (the caller compares player_id)
//   listAnalyses(db, playerId, loc)  the player's history, newest first
//   toVideoAnalysis(row, locale)     the contract's VideoAnalysis for a stored row (POST and GET answer the same thing)
//   loadRubric(skill, locale)        the seed rubric of a skill with its text localised (the wire Rubric)
//   pickRecommended(...)             2-3 drills from the SERVER's candidate set, never text the model wrote
//   cleanText(text, max)             what the model wrote, made safe to store
//   jpegSize(bytes)                  the pixel size a JPEG declares in its own header
//
// PRIVACY: nothing in this module receives, stores or logs a keyframe. insertAnalysis takes the analysis (scores with
// notes, one focus, drills, and a compact numbers-only summary of the pose features); the table has no column for an
// image (009_video.sql), and cleanText refuses to store a run that could be one (a model that echoed a frame).
//
// Readings the criteria leave open (each pinned by player-video.routes.test.ts)
//   * A stored analysis is answered as VideoAnalysis. limitations are NOT stored (the table has no column): they are
//     fixed sentences derived from the stored confidence and the player's locale, so POST and GET agree.
//   * recommended: the candidates whose skills intersect the model's focusSkills, at most MAX_RECOMMENDED. When the
//     lowest score is <= LOW_SCORE the EASIEST drills come first (regressions: a level down rebuilds the basics),
//     otherwise the hardest (progressions); ties keep the candidates' own order (trust status, then slug). An empty
//     intersection recommends nothing: the model's words are never a recommendation.
//   * The rubric is read from the seed the way video-rubrics.routes.ts reads it (the seed loader only validates
//     rubrics.json and no exported function returns them), cached per seed directory.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveSeedDir } from "../boot/20-seed.boot";
import type { PublishedVersion } from "../commons/repo";
import { SeedRubricsFile } from "../commons/seed-schema";
import type { SeedRubric } from "../commons/seed-schema";
import { EXPERIENCE_NUMBER } from "../planner/candidates";
import { pickLocalized } from "../shared/primitives";
import type { Locale, LocalizedText } from "../shared/primitives";
import { CriterionScore, REPEAT_AFTER_SESSIONS, RecommendedDrill } from "../shared/video";
import type { Confidence, PoseFeatures, Rubric, VideoAnalysis } from "../shared/video";

/** Drills recommended after one analysis (the criteria: 2-3). */
export const MAX_RECOMMENDED = 3;
/** A lowest criterion score at or below this prefers easier drills (regressions). */
export const LOW_SCORE = 4;
/** History rows answered by GET: the newest ones, so the answer does not grow without limit. */
export const MAX_HISTORY = 100;

// --- the store ------------------------------------------------------------------------------------------

export interface StoredAnalysisRow {
  id: string;
  player_id: string;
  skill_slug: string;
  confidence: Confidence;
  scores: string;
  focus_next: string;
  recommended: string;
  created_at: string;
}

/** What is stored for one finished analysis. There is deliberately no field that could hold an image. */
export interface NewAnalysis {
  id: string;
  playerId: string;
  skillSlug: string;
  rubricVersion: number;
  confidence: Confidence;
  scores: CriterionScore[];
  focusNext: string;
  recommended: RecommendedDrill[];
  features: PoseFeatures;
  clientUuid: string;
}

/** The clientUuid is already stored for ANOTHER player: their analysis is never returned. */
export class ClientUuidTakenError extends Error {
  constructor() {
    super("The clientUuid belongs to another player.");
    this.name = "ClientUuidTakenError";
  }
}

const COLUMNS = "id, player_id, skill_slug, confidence, scores, focus_next, recommended, created_at";

/** The numbers of the pose features, compactly (no spaces: 009_video.sql accepts only a JSON object of numbers). */
export function featuresSummary(features: PoseFeatures): string {
  const summary: Record<string, unknown> = {};
  if (features.cadencePerMin !== undefined) summary.cadencePerMin = features.cadencePerMin;
  if (features.leftRightBalance !== undefined) summary.leftRightBalance = features.leftRightBalance;
  if (features.kneeAngleStats !== undefined) summary.kneeAngleStats = features.kneeAngleStats;
  if (features.trunkLeanStats !== undefined) summary.trunkLeanStats = features.trunkLeanStats;
  summary.meanVisibility = features.meanVisibility;
  summary.framesAnalysed = features.framesAnalysed;
  return JSON.stringify(summary);
}

/** The row that owns `clientUuid`, whoever owns it. */
export function findByClientUuid(db: Database, clientUuid: string): StoredAnalysisRow | null {
  return db.query<StoredAnalysisRow, [string]>(`SELECT ${COLUMNS} FROM video_analyses WHERE client_uuid = ?`).get(clientUuid);
}

/**
 * Stores the analysis and returns the stored row. INSERT .. ON CONFLICT (client_uuid) DO NOTHING (never INSERT OR
 * REPLACE); when nothing was inserted the row that owns the uuid is read back and its player is compared: a uuid that
 * belongs to another player throws ClientUuidTakenError and returns nothing of theirs.
 */
export function insertAnalysis(db: Database, row: NewAnalysis): StoredAnalysisRow {
  db.query(
    `INSERT INTO video_analyses (id, player_id, skill_slug, rubric_version, confidence, scores, focus_next, recommended, features_summary, client_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (client_uuid) DO NOTHING`,
  ).run(
    row.id,
    row.playerId,
    row.skillSlug,
    row.rubricVersion,
    row.confidence,
    JSON.stringify(row.scores),
    row.focusNext,
    JSON.stringify(row.recommended),
    featuresSummary(row.features),
    row.clientUuid,
  );
  const stored = findByClientUuid(db, row.clientUuid);
  if (stored === null) throw new Error("The analysis that was just stored is missing");
  if (stored.player_id !== row.playerId) throw new ClientUuidTakenError();
  return stored;
}

/** The player's analyses, newest first (created_at, then id: the index of the table). */
export function listAnalyses(db: Database, playerId: string, locale: Locale): VideoAnalysis[] {
  return db
    .query<StoredAnalysisRow, [string, number]>(`SELECT ${COLUMNS} FROM video_analyses WHERE player_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(playerId, MAX_HISTORY)
    .map((row) => toVideoAnalysis(row, locale));
}

const LIMITATIONS: Readonly<Record<Locale, { beta: string; unsure: string }>> = {
  en: {
    beta: "This is a beta coach: it looks at a few still frames and some numbers, not at the whole movement.",
    unsure: "The coach was not sure about some of what it saw. Film again in good light with your whole body in view to get a firmer answer.",
  },
  ru: {
    beta: "Это бета-тренер: он смотрит на несколько кадров и на цифры, а не на всё движение целиком.",
    unsure: "Тренер не во всём уверен. Снимите ещё раз при хорошем свете, чтобы всё тело было в кадре, и ответ будет надёжнее.",
  },
  kk: {
    beta: "Бұл бета-жаттықтырушы: ол бүкіл қимылды емес, бірнеше кадр мен сандарды ғана қарайды.",
    unsure: "Жаттықтырушы көргенінің бәріне сенімді емес. Жарық жақсы жерде, бүкіл денең кадрда болатындай қайта түсір, сонда жауап сенімдірек болады.",
  },
};

/** The stored row as the contract's VideoAnalysis. A stored value that is not one is a corrupt row: it throws (a 500). */
export function toVideoAnalysis(row: StoredAnalysisRow, locale: Locale): VideoAnalysis {
  const texts = LIMITATIONS[locale];
  return {
    id: row.id,
    skillSlug: row.skill_slug,
    createdAt: row.created_at,
    beta: true,
    confidence: row.confidence,
    scores: z.array(CriterionScore).parse(JSON.parse(row.scores)),
    focusNext: row.focus_next,
    recommended: z.array(RecommendedDrill).parse(JSON.parse(row.recommended)),
    repeatAfterSessions: REPEAT_AFTER_SESSIONS,
    limitations: row.confidence === "low" ? [texts.beta, texts.unsure] : [texts.beta],
  };
}

// --- the rubric -------------------------------------------------------------------------------------------

const RUBRICS_FILE = "rubrics.json";

/** Every rubric of every sport folder of the seed, by skill slug. Throws on an invalid file (a 500, never a half answer). */
function readRubrics(seedDir: string): Map<string, SeedRubric> {
  const bySkill = new Map<string, SeedRubric>();
  if (!existsSync(seedDir) || !statSync(seedDir).isDirectory()) return bySkill;
  for (const sport of readdirSync(seedDir).filter((name) => !name.startsWith(".")).sort()) {
    const file = join(seedDir, sport, RUBRICS_FILE);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8").replace(/^﻿/, "");
    for (const rubric of SeedRubricsFile.parse(JSON.parse(text)).rubrics) bySkill.set(rubric.skill, rubric);
  }
  return bySkill;
}

const rubricCache = new Map<string, Map<string, SeedRubric>>();

/** The rubric of `skill` with every text in `locale` (requested -> ru -> en), or undefined when the skill has none. */
export function loadRubric(skill: string, locale: Locale, seedDir: string = resolveSeedDir()): Rubric | undefined {
  let rubrics = rubricCache.get(seedDir);
  if (rubrics === undefined) {
    rubrics = readRubrics(seedDir);
    rubricCache.set(seedDir, rubrics);
  }
  const rubric = rubrics.get(skill);
  if (rubric === undefined) return undefined;
  const text = (value: LocalizedText): string => pickLocalized(value, locale) ?? "";
  return {
    skill: rubric.skill,
    version: rubric.version,
    criteria: rubric.criteria.map((criterion) => ({
      key: criterion.key,
      label: text(criterion.label),
      description: text(criterion.description),
      lookFor: criterion.lookFor.map(text),
    })),
    recordingTips: rubric.recordingTips.map(text),
    minVisibility: rubric.minVisibility,
  };
}

// --- the model's words -------------------------------------------------------------------------------------

/** 009_video.sql refuses a run of 256 base64-alphabet characters; a real word is never this long, a frame always is. */
const LONG_RUN = /[A-Za-z0-9+/=\\]{120,}/g;
/** A UTF-16 half that has no partner: JSON.stringify spells it as the six characters `\udXXX`, which add up to a long run. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * What the model wrote, made safe to store: control characters (a newline included) become spaces (JSON spells a newline
 * as the two alphabet characters `\n`, which would join the words around it into one long run), a lone surrogate becomes
 * U+FFFD (JSON spells it as six alphabet characters), a run that could be
 * base64 (an echoed frame) is replaced (a backslash is doubled in JSON, so the run limit is under half of the table's
 * 256), the ends are trimmed, and the text is cut to `max` characters.
 */
export function cleanText(text: string, max: number): string {
  let clean = text.replace(CONTROL, " ").replace(LONE_SURROGATE, "\ufffd").replace(LONG_RUN, "…").trim();
  if (clean.length > max) {
    clean = clean.slice(0, max);
    const last = clean.charCodeAt(clean.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) clean = clean.slice(0, -1); // never end on half a surrogate pair
    clean = clean.trim();
  }
  return clean;
}

// --- recommendations ---------------------------------------------------------------------------------------------

const REASONS: Readonly<Record<"easier" | "harder", Record<Locale, string>>> = {
  easier: {
    en: "An easier drill to build the basics of this skill.",
    ru: "Более лёгкое упражнение, чтобы закрепить основы этого навыка.",
    kk: "Бұл дағдының негізін бекітуге арналған жеңілірек жаттығу.",
  },
  harder: {
    en: "A next step to keep this skill growing.",
    ru: "Следующий шаг, чтобы этот навык рос дальше.",
    kk: "Бұл дағдыны әрі қарай дамытуға арналған келесі қадам.",
  },
};

/**
 * Up to MAX_RECOMMENDED drills from `pool` (the server's candidate set) that train a skill in `focusSkills`.
 * `scores` are the criterion scores: the lowest one decides between easier and harder drills.
 */
export function pickRecommended(
  pool: readonly PublishedVersion[],
  focusSkills: readonly string[],
  scores: readonly number[],
  locale: Locale,
): RecommendedDrill[] {
  const focus = new Set(focusSkills);
  const easier = scores.length > 0 && Math.min(...scores) <= LOW_SCORE;
  return pool
    .map((version, order) => ({ version, order }))
    .filter(({ version }) => version.skills.some((skill) => focus.has(skill)))
    .sort((a, b) => {
      const levels = EXPERIENCE_NUMBER[a.version.level] - EXPERIENCE_NUMBER[b.version.level];
      return (easier ? levels : -levels) || a.order - b.order;
    })
    .slice(0, MAX_RECOMMENDED)
    .map(({ version }) => ({
      drillVersionId: version.versionId,
      slug: version.slug,
      title: pickLocalized(version.content.title ?? version.content.goal, locale) ?? version.slug,
      reason: REASONS[easier ? "easier" : "harder"][locale],
    }));
}

// --- JPEG ------------------------------------------------------------------------------------------------------------

/**
 * The width and height a JPEG declares in its own start-of-frame header, or undefined when the bytes are not a JPEG
 * with a readable one. A client's declared size is never trusted: it is compared with this.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] as number;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // end of image / start of scan: no frame header came first
    const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
    if (length < 2) return undefined;
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (length < 8 || at + 8 >= bytes.length) return undefined;
      const height = ((bytes[at + 5] as number) << 8) | (bytes[at + 6] as number);
      const width = ((bytes[at + 7] as number) << 8) | (bytes[at + 8] as number);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    at += 2 + length;
  }
  return undefined;
}

// --- the table's own limits ------------------------------------------------------------------------------------------

/** The table refuses a run of 256 of these (base64 plus backslash, which JSON doubles). */
const TABLE_RUN = /[A-Za-z0-9+/=\\]{256}/;
const MAX_JSON_COLUMN = 16384;
const MAX_FOCUS_COLUMN = 2000;

const jsonFits = (value: unknown): boolean => {
  const json = JSON.stringify(value);
  return json.length <= MAX_JSON_COLUMN && !TABLE_RUN.test(json);
};

/**
 * The last guard before the insert, run on what is actually stored (009_video.sql refuses a JSON column over 16384
 * characters or holding a run of 256 alphabet characters, and focus_next over 2000 or holding such a run). The model has
 * been paid for by then, so text that would not fit is DEGRADED instead of failing the request: every note is emptied,
 * the focus becomes `fallbackFocus`, the drills are dropped. Text that fits is returned as it is.
 */
export function fitForTable<T extends { scores: CriterionScore[]; focusNext: string; recommended: RecommendedDrill[] }>(
  row: T,
  fallbackFocus: string,
): T {
  return {
    ...row,
    scores: jsonFits(row.scores) ? row.scores : row.scores.map((score) => ({ ...score, note: "" })),
    focusNext: row.focusNext.length <= MAX_FOCUS_COLUMN && !TABLE_RUN.test(row.focusNext) && row.focusNext.trim() !== "" ? row.focusNext : fallbackFocus,
    recommended: jsonFits(row.recommended) ? row.recommended : [],
  };
}
