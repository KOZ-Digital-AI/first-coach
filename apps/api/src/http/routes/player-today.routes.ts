// GET /api/player/today?locale (fc-mol-urn.4): the player's session for their local calendar day.
//
// Behind requirePlayer (anonymous players included). The player is always the session's (`c.var.playerId`);
// nothing in the request names another one (the query schema is strict, so a `playerId` key is a 400). Every
// response, the guard's 401 and the problems included, is `Cache-Control: no-store`: the answer is per player
// and changes as they train.
//
// What it does
//   1. answers the stored session of (player, local date) when there is one, else composes one with the
//      merged stack (getSettings -> candidates -> pickSession), stores it and answers it. A repeated call is
//      the same session, whatever the commons publish in between;
//   2. a player with no profile, or no roadmap, is a 404 "not onboarded" (GET /api/player/me's rule).
// Errors are RFC 9457 problems: 401 (the guard), 400 (a query the contract refuses), 404, 503 (the sport's
// skill graph is not seeded, so no session can be composed; nothing is written).
//
// Readings the criteria leave open (each pinned by player-today.routes.test.ts)
//   * LOCAL DATE = the X-Timezone header (an IANA name, checked with Intl); absent, blank or invalid means UTC and
//     is never an error (root decision). An offset such as "+14:00" is not an IANA name, so it means UTC too.
//     No contract or migration change: the zone is a request option, not stored.
//   * The stored session keeps only what must not drift: `items` holds, per item, {itemId, drillVersionId,
//     minutes, reason, done}. The drill VERSION id keeps resolving (versions are immutable and never deleted),
//     so the content, status and attribution are read from that version at every call: a newly published
//     version cannot change today's session, while a trust-status change of the version shows.
//   * TRACK AND LEVEL (fc-mol-urn.11): each item also carries `track` = the drill's primary skill slug (drill_skills
//     is_primary, read at every call: the link is not stored in the session) and `level` = the level of the stored
//     drill VERSION (immutable, so it cannot drift). Both are optional on the contract; a drill with no primary skill
//     linked has no `track` key. player-events.routes.ts and player-swap.routes.ts answer the same view (the latter
//     through this route's handler), so all three carry them identically.
//   * CONTENT: every locale the drill has is kept, and the requested locale's slot and `en` are filled
//     (requested -> ru -> en, as the commons' localisation) so the client can show either offline.
//   * Locale: ?locale, else the player's profile locale (as the journey route).
//   * HISTORY for the picker: the drills DONE (done = true) in the player's two latest sessions dated before
//     today; a drill only listed there, never done, is not "done in" it and is not deprioritised. A history
//     version id is resolved to its drill through drill_versions, so an older version still counts.
//   * SKILL TEST: sessions has no column for it and TodaySession.skillTest is not an item, so it is DERIVED,
//     not stored: the first test that is due as of the END OF THE SESSION'S DATE (buildJourney's retestsDue) and
//     that the player has the kit for (EQUIPMENT_OWNED). Deriving it from the date, not from the clock, keeps
//     a day's session stable; totalMinutes = the items' minutes + SKILL_TEST_MINUTES when there is one.
//     CONTRACT GAP: a persisted skill test (a nullable column in a later migration) would survive a stored
//     result; until then a test that is answered (a later bead stores it) stops being due and drops out.
//   * The sport is the player-data model's default (football), as the journey and start routes.
//   * itemIds are "item-1".."item-n" (unique within the session); the session id is a random UUID.
import type { Database } from "bun:sqlite";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { getSettings } from "../../admin/settings";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { getSkillGraph, getSkillTests, listPublishedVersions } from "../../commons/repo";
import { EQUIPMENT_OWNED, candidates } from "../../planner/candidates";
import { SKILL_TEST_MINUTES, pickSession } from "../../planner/session";
import type { HistoryEntry } from "../../planner/session";
import { DEFAULT_SPORT, buildJourney } from "../../player/journey";
import { getGraphVersion, getProfile, getRoadmap } from "../../player/profile-repo";
import type { Attribution, CalendarDate, PlayerProfileView, Roadmap, SkillTest } from "../../shared/domain";
import { pickLocalized } from "../../shared/primitives";
import type { DrillContent, ExperienceLevel, Locale, LocalizedText, TrustStatus } from "../../shared/primitives";
import { ENDPOINTS } from "../../shared/session";
import type { TodayItem, TodaySession } from "../../shared/session";
import { fromZodError, problem } from "../problem";

const NO_STORE = "no-store";

/** Every response of the route is never cached, whoever produced it (the guard included). */
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", NO_STORE);
};

// --- the player's local day ----------------------------------------------------------------------

/** An IANA zone name: "UTC", "Europe/Kyiv", "America/Argentina/Buenos_Aires", "Etc/GMT+5"; never an offset. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** The IANA zone named by the X-Timezone header, or undefined (= UTC) when it is absent or not a zone. */
function timeZoneOf(header: string | undefined): string | undefined {
  const zone = header?.trim();
  if (zone === undefined || zone === "" || !ZONE_SHAPE.test(zone)) return undefined;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The calendar day (YYYY-MM-DD) `instant` falls on in `timeZone` (UTC when undefined). */
function localDate(instant: Date, timeZone: string | undefined): CalendarDate {
  if (timeZone === undefined) return instant.toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// --- content -------------------------------------------------------------------------------------

/** Keeps every stored locale and fills the requested locale's slot and `en` (requested -> ru -> en). */
function fill(text: LocalizedText, locale: Locale): LocalizedText {
  const requested = pickLocalized(text, locale);
  const en = pickLocalized(text, "en");
  return { ...text, ...(requested === undefined ? {} : { [locale]: requested }), ...(en === undefined ? {} : { en }) };
}

const fillAll = (texts: LocalizedText[], locale: Locale): LocalizedText[] => texts.map((text) => fill(text, locale));

function localizeContent(content: DrillContent, locale: Locale): DrillContent {
  return {
    ...content,
    ...(content.title === undefined ? {} : { title: fill(content.title, locale) }),
    goal: fill(content.goal, locale),
    instructions: fill(content.instructions, locale),
    mistakes: fillAll(content.mistakes, locale),
    progressions: fillAll(content.progressions, locale),
    regressions: fillAll(content.regressions, locale),
    safety: fillAll(content.safety, locale),
    media: content.media.map((media) => (media.caption === undefined ? media : { ...media, caption: fill(media.caption, locale) })),
  };
}

// --- stored session ------------------------------------------------------------------------------

/** One entry of sessions.items: no content, only what must not drift. */
interface StoredItem {
  itemId: string;
  drillVersionId: string;
  minutes: number;
  reason?: string;
  done: boolean;
  regressionOf?: string;
  progressionOf?: string;
}

interface SessionRow {
  id: string;
  date: string;
  planner: "rules" | "ai";
  graph_version: string;
  items: string;
}

function findSession(db: Database, playerId: string, date: CalendarDate): SessionRow | null {
  return db
    .query<SessionRow, [string, string]>("SELECT id, date, planner, graph_version, items FROM sessions WHERE player_id = ?1 AND date = ?2")
    .get(playerId, date);
}

interface VersionRow {
  content: string;
  level: ExperienceLevel;
  track: string | null;
  status: TrustStatus;
  semver: string;
  license: Attribution["license"];
  author_name: string;
  source: string;
  source_url: string | null;
  created_at: string;
}

/** The item as the contract's TodayItem: its drill VERSION's content (in the locale and en), status and attribution. */
function toItem(db: Database, stored: StoredItem, locale: Locale): TodayItem {
  const version = db
    .query<VersionRow, [string]>(
      `SELECT v.content, v.level, v.status, v.semver, v.license, v.author_name, v.source, v.source_url, v.created_at,
              (SELECT s.slug FROM drill_skills ds JOIN skills s ON s.id = ds.skill_id WHERE ds.drill_id = v.drill_id AND ds.is_primary = 1) AS track
         FROM drill_versions v WHERE v.id = ?1`,
    )
    .get(stored.drillVersionId);
  // A version is never deleted and the writer validated the id: a miss is a corrupt database, so it is a 500.
  if (version === null) throw new Error(`Session item ${stored.itemId} names an unknown drill version`);
  return {
    itemId: stored.itemId,
    drillVersionId: stored.drillVersionId,
    minutes: stored.minutes,
    ...(stored.reason === undefined ? {} : { reason: stored.reason }),
    done: stored.done === true,
    content: localizeContent(JSON.parse(version.content) as DrillContent, locale),
    status: version.status,
    ...(version.track === null ? {} : { track: version.track }),
    level: version.level,
    attribution: {
      author: version.author_name,
      source: version.source,
      ...(version.source_url === null ? {} : { sourceUrl: version.source_url }),
      license: version.license,
      createdAt: version.created_at,
      semver: version.semver,
    },
    ...(stored.regressionOf === undefined ? {} : { regressionOf: stored.regressionOf }),
    ...(stored.progressionOf === undefined ? {} : { progressionOf: stored.progressionOf }),
  };
}

function toSession(db: Database, row: SessionRow, roadmap: Roadmap, locale: Locale, skillTest: SkillTest | undefined): TodaySession {
  const stored = JSON.parse(row.items) as StoredItem[];
  const items = stored.map((item) => toItem(db, item, locale));
  return {
    id: row.id,
    date: row.date,
    planner: row.planner,
    totalMinutes: items.reduce((sum, item) => sum + item.minutes, 0) + (skillTest === undefined ? 0 : SKILL_TEST_MINUTES),
    graphVersion: row.graph_version,
    items,
    roadmapSummary: {
      currentLevelLabel: roadmap.currentLevelLabel,
      focus: roadmap.focus,
      sessionsPerWeek: roadmap.sessionsPerWeek,
      minutesPerSession: roadmap.minutesPerSession,
    },
    ...(skillTest === undefined ? {} : { skillTest }),
  };
}

// --- composing -----------------------------------------------------------------------------------

/** The first skill test that is due as of the end of `date` and that the player has the kit for (see the header). */
function dueSkillTest(db: Database, playerId: string, profile: PlayerProfileView, locale: Locale, date: CalendarDate, timeZone: string | undefined): SkillTest | undefined {
  const asOf = new Date(`${date}T23:59:59.999Z`);
  const { retestsDue } = buildJourney(db, playerId, locale, asOf, timeZone === undefined ? {} : { timeZone });
  if (retestsDue.length === 0) return undefined;
  const owned = EQUIPMENT_OWNED[profile.equipment];
  const test = getSkillTests(db, DEFAULT_SPORT, locale).find((t) => retestsDue.includes(t.slug) && owned.includes(t.equipment));
  if (test === undefined) return undefined;
  return { slug: test.slug, skill: test.skill, metric: test.metric, unit: test.unit, direction: test.direction, protocol: test.protocol, equipment: test.equipment };
}

/** The drills DONE in the two latest sessions before `date`, by drill id (an older version still counts). */
function historyBefore(db: Database, playerId: string, date: CalendarDate): HistoryEntry[] {
  const rows = db
    .query<{ date: string; items: string }, [string, string]>("SELECT date, items FROM sessions WHERE player_id = ?1 AND date < ?2 ORDER BY date DESC LIMIT 2")
    .all(playerId, date);
  const drillOf = db.query<{ drill_id: string }, [string]>("SELECT drill_id FROM drill_versions WHERE id = ?1");
  return rows.map((row) => ({
    date: row.date,
    drillIds: (JSON.parse(row.items) as StoredItem[])
      .filter((item) => item.done === true)
      .flatMap((item) => {
        const version = drillOf.get(item.drillVersionId);
        return version === null ? [] : [version.drill_id];
      }),
  }));
}

/**
 * Composes and stores the session of (player, date) unless one is stored by now. Returns false when the sport's
 * skill graph is not seeded (nothing is written). Runs in ONE immediate transaction, so two concurrent first
 * calls cannot store two sessions; the insert also never replaces (ON CONFLICT DO NOTHING).
 */
function createSession(
  db: Database,
  playerId: string,
  profile: PlayerProfileView,
  roadmap: Roadmap,
  locale: Locale,
  date: CalendarDate,
  timeZone: string | undefined,
): boolean {
  return db
    .transaction((): boolean => {
      if (findSession(db, playerId, date) !== null) return true;
      const graphVersion = getGraphVersion(db, DEFAULT_SPORT);
      const graph = getSkillGraph(db, DEFAULT_SPORT, locale);
      if (graphVersion === null || graph === null) return false;

      const levels = Object.fromEntries(roadmap.tracks.map((track) => [track.skill, track.level]));
      const pool = candidates(profile, levels, getSettings(db), listPublishedVersions(db, { sport: DEFAULT_SPORT }), graph);
      const skillTest = dueSkillTest(db, playerId, profile, locale, date, timeZone);
      const picked = pickSession(profile, roadmap, pool, historyBefore(db, playerId, date), {
        playerId,
        date,
        ...(skillTest === undefined ? {} : { retestDue: [skillTest] }),
      });

      const items: StoredItem[] = picked.items.map((item, index) => ({
        itemId: `item-${index + 1}`,
        drillVersionId: item.drillVersionId,
        minutes: item.minutes,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
        done: false,
      }));
      db.query(
        `INSERT INTO sessions (id, player_id, date, planner, graph_version, items)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (player_id, date) DO NOTHING`,
      ).run(crypto.randomUUID(), playerId, date, picked.planner, graphVersion, JSON.stringify(items));
      return true;
    })
    .immediate();
}

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this holds
  // whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const { db } = deps;
  const spec = ENDPOINTS.getToday;

  app.get(spec.path, noStore, requirePlayer(deps), (c: Context<{ Variables: AuthVariables }>) => {
    const query = spec.query.safeParse(c.req.query());
    if (!query.success) return problem(400, "Bad Request", "Invalid request parameters.", fromZodError(query.error));

    const playerId = c.var.playerId;
    const profile = getProfile(db, playerId);
    const roadmap = getRoadmap(db, playerId);
    if (profile === null || roadmap === null) return problem(404, "Not Found", "The player is not onboarded.");

    const locale = query.data.locale ?? profile.locale;
    const timeZone = timeZoneOf(c.req.header("x-timezone"));
    const date = localDate(new Date(), timeZone);

    if (findSession(db, playerId, date) === null && !createSession(db, playerId, profile, roadmap, locale, date, timeZone)) {
      return problem(503, "Service Unavailable", `The ${DEFAULT_SPORT} skill graph is not loaded yet.`);
    }
    const row = findSession(db, playerId, date);
    if (row === null) throw new Error("The session that was just stored is missing");

    return c.json(toSession(db, row, roadmap, locale, dueSkillTest(db, playerId, profile, locale, date, timeZone)), 200);
  });
}
