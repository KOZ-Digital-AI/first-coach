// POST /api/player/session-events (fc-mol-urn.5): the player's session events (drill done / undone, a result,
// session finished), in one batch, idempotent by clientUuid. Serves the session screen, the drill player and the
// offline outbox (apps/web/src/offline/outbox.ts).
//
// Behind requirePlayer (anonymous players included), which runs BEFORE the body is read: no session is a 401
// whatever the body holds. The player is always the session's (`c.var.playerId`); nothing in the body can name a
// player (the schemas are strict). Every response, the guard's 401 and the problems included, is
// `Cache-Control: no-store`.
//
// What it does
//   1. a body over MAX_BODY_BYTES is a 413; one that is not a JSON object is a 400; a batch over MAX_EVENTS
//      events, an empty batch or an event the contract's SessionEventsRequest refuses is a 422. The body is
//      validated with the contract schema BEFORE ingestEvents, so a database CHECK is never what refuses it;
//   2. ingestEvents (../../player/events.ts) writes the batch in ONE transaction, all or nothing, and returns the
//      progress; a replay (same clientUuids) changes nothing and answers the same;
//   3. the answer is 200 {session, progress, nextSessionDate}: the updated session as GET /api/player/today has it,
//      the progress summary and the date of the next session.
//
// The outbox's rule (it sends its whole queue as one batch and drops an event ONLY when a 4xx names it): every
// 4xx that is about an event names it, by errors[].pointer "/events/<index>" into the batch as sent, and by its
// clientUuid in errors[].detail. That is the 404 (an event's session is not the player's) and the 422s (a
// contract violation, an event outside the time window). A 2xx is always a SessionEventsResponse. The 400 and
// 413 are about the whole request, not an event, and name none.
//
// Readings the criteria leave open (each pinned by player-events.routes.test.ts)
//   * TIME ZONE = the X-Timezone header (an IANA name, checked with Intl); absent, blank or invalid means UTC and
//     is never an error (root decision). It is passed to ingestEvents (the streak) and decides "today" below.
//   * A session that is not the player's, foreign or unknown, is the SAME 404 (existence is not leaked): it names
//     the events of that session and never echoes the session id. A player with no profile or roadmap has no
//     session, so every event of the batch is named.
//   * A time-window rejection (older than 30 days, more than a day ahead) is a 422 naming that event.
//   * BOUNDS: MAX_EVENTS = 1000 (a month of offline training is about 600) and MAX_BODY_BYTES = 1 MiB (1000
//     events are about 250 KB). The contract says "no maximum"; this is the server's abuse bound. The events past
//     the bound are named, so the outbox drops them and delivers the first MAX_EVENTS on its next flush.
//   * The batch may name several sessions (an offline outbox after some days): the response's `session` is the
//     LATEST-DATED one the batch names; the contract has room for one.
//   * NEXT SESSION DATE = that session's date + the spacing of the player's profile.daysPerWeek, floor(7 / days)
//     days and at least 1 (1/wk: 7, 2/wk: 3, 3/wk: 2, 4-7/wk: 1: the weekly target stays reachable), but never
//     before the player's local today: a session reported late leaves the player due today, not in the past.
//   * The session is built as GET /api/player/today builds it (drill VERSION content in the profile's locale and
//     en, status, attribution, the skill test that is due as of the end of the session's date), so what the
//     client caches from this response is what GET would answer. There is no ?locale here (the contract has no
//     query on this endpoint): the profile's locale is used.
//   * CONTRACT/OWNERSHIP GAP: the session builders live, unexported, in player-today.routes.ts, which this bead
//     does not own; the block "the session as GET /api/player/today has it" below is a copy of them and must
//     follow them until both routes import one shared module.
import type { Database } from "bun:sqlite";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { getSkillTests } from "../../commons/repo";
import { EQUIPMENT_OWNED } from "../../planner/candidates";
import { SKILL_TEST_MINUTES } from "../../planner/session";
import { EventTimeError, SessionNotFoundError, ingestEvents } from "../../player/events";
import { DEFAULT_SPORT, buildJourney } from "../../player/journey";
import { getProfile, getRoadmap } from "../../player/profile-repo";
import type { Attribution, CalendarDate, PlayerProfileView, Roadmap, SkillTest } from "../../shared/domain";
import { pickLocalized } from "../../shared/primitives";
import type { DrillContent, Locale, LocalizedText, ProblemError, TrustStatus } from "../../shared/primitives";
import { ENDPOINTS } from "../../shared/session";
import type { SessionEvent, SessionEventsResponse, TodayItem, TodaySession } from "../../shared/session";
import { fromZodError, problem } from "../problem";

/** The most events one request may carry. */
export const MAX_EVENTS = 1000;
/** The largest request body, in bytes. */
export const MAX_BODY_BYTES = 1024 * 1024;

const DAY_MS = 86_400_000;

/** Every response of the route is never cached, whoever produced it (the guard included). */
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
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

/** `date` plus `days` calendar days, by date arithmetic (a day is a label here, not 24 hours of a zone). */
const addDays = (date: CalendarDate, days: number): CalendarDate => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Days between two sessions: the weekly target spread over the week, rounded down so it stays reachable; at least 1. */
export const spacingDays = (daysPerWeek: number): number => Math.max(1, Math.floor(7 / daysPerWeek));

// --- the session as GET /api/player/today has it (a copy of player-today.routes.ts, see the header) ---------

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

interface VersionRow {
  content: string;
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
      "SELECT content, status, semver, license, author_name, source, source_url, created_at FROM drill_versions WHERE id = ?1",
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

/** The first skill test that is due as of the end of `date` and that the player has the kit for. */
function dueSkillTest(db: Database, playerId: string, profile: PlayerProfileView, locale: Locale, date: CalendarDate, timeZone: string | undefined): SkillTest | undefined {
  const asOf = new Date(`${date}T23:59:59.999Z`);
  const { retestsDue } = buildJourney(db, playerId, locale, asOf, timeZone === undefined ? {} : { timeZone });
  if (retestsDue.length === 0) return undefined;
  const owned = EQUIPMENT_OWNED[profile.equipment];
  const test = getSkillTests(db, DEFAULT_SPORT, locale).find((t) => retestsDue.includes(t.slug) && owned.includes(t.equipment));
  if (test === undefined) return undefined;
  return { slug: test.slug, skill: test.skill, metric: test.metric, unit: test.unit, direction: test.direction, protocol: test.protocol, equipment: test.equipment };
}

// --- problems that name events -------------------------------------------------------------------

/** The events named by `indexes`, as problem errors: pointer "/events/<index>" and the clientUuid in the detail. */
const namedErrors = (events: readonly { clientUuid: string }[], indexes: readonly number[], why: string): ProblemError[] =>
  indexes.map((index) => ({ pointer: `/events/${index}`, detail: `Event ${events[index]!.clientUuid}: ${why}` }));

/** The batch's indexes for which `pick` holds. */
const indexesWhere = (events: readonly SessionEvent[], pick: (event: SessionEvent) => boolean): number[] =>
  events.flatMap((event, index) => (pick(event) ? [index] : []));

const notFound = (events: readonly SessionEvent[], indexes: readonly number[]): Response =>
  problem(404, "Not Found", "A session of the batch was not found.", namedErrors(events, indexes, "session not found."));

// --- the route -----------------------------------------------------------------------------------

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this holds
  // whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const { db } = deps;
  const spec = ENDPOINTS.postSessionEvents;

  const tooLarge = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => problem(413, "Payload Too Large", `The request body may not exceed ${MAX_BODY_BYTES} bytes.`),
  });

  app.post(spec.path, noStore, requirePlayer(deps), tooLarge, async (c: Context<{ Variables: AuthVariables }>) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }

    // The bound comes first, so a huge array is never parsed; the events past it are named.
    const sent = (body as { events?: unknown }).events;
    if (Array.isArray(sent) && sent.length > MAX_EVENTS) {
      const past = sent.map((_, index) => index).filter((index) => index >= MAX_EVENTS);
      const errors = past.map((index): ProblemError => {
        const uuid = (sent[index] as { clientUuid?: unknown } | null)?.clientUuid;
        return { pointer: `/events/${index}`, detail: `${typeof uuid === "string" ? `Event ${uuid}: ` : ""}a request may carry at most ${MAX_EVENTS} events.` };
      });
      return problem(422, "Unprocessable Entity", `A request may carry at most ${MAX_EVENTS} events.`, errors);
    }

    const parsed = spec.request.safeParse(body);
    if (!parsed.success) return problem(422, "Unprocessable Entity", "The request is invalid.", fromZodError(parsed.error));
    const { events } = parsed.data;

    const playerId = c.var.playerId;
    const profile = getProfile(db, playerId);
    const roadmap = getRoadmap(db, playerId);
    // No profile or roadmap means no session of theirs can exist: every event is one for a session that is not theirs.
    if (profile === null || roadmap === null) return notFound(events, indexesWhere(events, () => true));

    const timeZone = timeZoneOf(c.req.header("x-timezone"));
    let progress;
    try {
      progress = ingestEvents(db, playerId, events, timeZone === undefined ? {} : { timeZone });
    } catch (error) {
      if (error instanceof SessionNotFoundError) return notFound(events, indexesWhere(events, (e) => e.sessionId === error.sessionId));
      if (error instanceof EventTimeError) {
        const indexes = indexesWhere(events, (e) => e.clientUuid === error.clientUuid);
        return problem(422, "Unprocessable Entity", "An event is outside the accepted time window.", indexes.map((index) => ({ pointer: `/events/${index}`, detail: error.message })));
      }
      throw error;
    }

    // The latest-dated session the batch names (ownership was checked by ingestEvents, re-read after its writes).
    const rows = [...new Set(events.map((e) => e.sessionId))].flatMap((id) => {
      const row = db
        .query<SessionRow, [string, string]>("SELECT id, date, planner, graph_version, items FROM sessions WHERE id = ?1 AND player_id = ?2")
        .get(id, playerId);
      return row === null ? [] : [row];
    });
    const row = rows.reduce<SessionRow | null>((latest, r) => (latest === null || r.date > latest.date ? r : latest), null);
    if (row === null) throw new Error("The session of a stored batch is missing");

    const session = toSession(db, row, roadmap, profile.locale, dueSkillTest(db, playerId, profile, profile.locale, row.date, timeZone));
    const today = localDate(new Date(), timeZone);
    const spaced = addDays(row.date, spacingDays(profile.daysPerWeek));
    const response: SessionEventsResponse = { session, progress, nextSessionDate: spaced < today ? today : spaced };
    return c.json(response, 200);
  });
}
