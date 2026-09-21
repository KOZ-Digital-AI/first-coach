import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../../app";
import { loadSeed } from "../../commons/seed-loader";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import type { PlayerProfile } from "../../shared/domain";
import { ENDPOINTS as ONBOARDING, StartResponse } from "../../shared/onboarding";
import type { BaselineResult, StartRequest } from "../../shared/onboarding";
import { PROBLEM_CONTENT_TYPE } from "../../shared/primitives";
import { ENDPOINTS, SessionEventsResponse, TodaySession } from "../../shared/session";
import type { SessionEvent } from "../../shared/session";

// Every test runs the real createApp on a fresh in-memory database migrated with the real migrations and
// loaded with the REAL seed (config/commons), with the REAL Better Auth handler and the REAL start and today
// routes mounted next to the route under test. Players are real anonymous sign-ins that onboard through
// POST /api/player/start and open their session through GET /api/player/today (the technique of
// player-today.routes.test.ts). No fake sessions, no mocked repository, no fixture data in the route.
//
// The outbox contract (apps/web/src/offline/outbox.ts) is asserted here from the server's side: a 4xx that is
// about ONE event of the batch must name it (errors[].pointer "/events/<index>", and its clientUuid in the
// detail), a 2xx must parse as SessionEventsResponse.

const SOURCE_DIR = resolve(import.meta.dir);
const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const ROUTE_FILES = ["player-events.routes.ts", "player-today.routes.ts", "player-start.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const EVENTS = ENDPOINTS.postSessionEvents.path;
const TODAY = ENDPOINTS.getToday.path;
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

let dir: string;
let db: Database;
let app: Hono;
const savedEnv: Record<string, string | undefined> = {};

/** A real createApp that mounts only the routes under test and the real Better Auth handler. */
async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of ROUTE_FILES) {
    writeFileSync(join(routesDir, file), `export { register } from ${JSON.stringify(join(SOURCE_DIR, file))};\n`);
  }
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "player-events-routes-"));
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
  app = await buildApp();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by the test
  }
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// --- real sessions and onboarding --------------------------------------------------------------

/** `name=value` pairs of every Set-Cookie header, joined for a Cookie request header. */
const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

type Player = { cookie: string; id: string };

async function signInPlayer(): Promise<Player> {
  const res = await app.request("/api/auth/sign-in/anonymous", {
    method: "POST",
    headers: { "content-type": "application/json", origin: DEV_ORIGIN },
    body: "{}",
  });
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

const PROFILE: PlayerProfile = {
  age: 12,
  level: "basic",
  goal: "dribbling",
  equipment: "ball",
  space: "yard",
  partner: false,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: "ru",
};

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Five real football tests; `first` keeps the client uuids of different players apart. */
const baseline = (first: number): BaselineResult[] => [
  { testSlug: "juggling-max-touches", value: 30, attempts: 3, clientUuid: uuid(first) },
  { testSlug: "wall-passing-60s", value: 20, clientUuid: uuid(first + 1) },
  { testSlug: "ball-mastery-30s", value: 95, clientUuid: uuid(first + 2) },
  { testSlug: "slalom-time", value: 9, errors: 1, clientUuid: uuid(first + 3) },
  { testSlug: "weak-foot-passes", value: 4, clientUuid: uuid(first + 4) },
];

let nextBaseline = 1;
let nextEvent = 1_000_000;
/** A fresh client uuid for an event (their own range, apart from the baselines'). */
const eventId = (): string => uuid(nextEvent++);

/** A signed-in player who has onboarded. */
async function onboardedPlayer(over: Partial<PlayerProfile> = {}): Promise<Player & { start: StartResponse }> {
  const player = await signInPlayer();
  const body: StartRequest = { profile: { ...PROFILE, ...over }, baseline: baseline(nextBaseline) };
  nextBaseline += 10;
  const res = await app.request(ONBOARDING.start.path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: player.cookie },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return { ...player, start: StartResponse.parse(await res.json()) };
}

// --- requests -----------------------------------------------------------------------------------

async function todayOk(player: Player): Promise<TodaySession> {
  const res = await app.request(TODAY, { headers: { cookie: player.cookie } });
  expect(res.status).toBe(200);
  return TodaySession.parse(await res.json());
}

type PostOptions = { cookie?: string; timeZone?: string; raw?: string };

const post = (body: unknown, options: PostOptions = {}) =>
  app.request(EVENTS, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.timeZone === undefined ? {} : { "x-timezone": options.timeZone }),
    },
    body: options.raw ?? JSON.stringify(body),
  });

async function postOk(player: Player, events: unknown[], timeZone?: string): Promise<SessionEventsResponse> {
  const res = await post({ events }, { cookie: player.cookie, ...(timeZone === undefined ? {} : { timeZone }) });
  expect(res.status).toBe(200);
  return SessionEventsResponse.parse(await res.json());
}

type Problem = { type: string; title: string; status: number; detail?: string; errors?: { pointer: string; detail: string }[] };

const expectProblem = async (res: Response, status: number): Promise<Problem> => {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as Problem;
  expect(body.status).toBe(status);
  return body;
};

const pointers = (body: Problem): string[] => (body.errors ?? []).map((e) => e.pointer);
/** Every text of the problem the outbox reads for a clientUuid. */
const texts = (body: Problem): string => [body.title, body.detail ?? "", ...(body.errors ?? []).map((e) => e.detail)].join("\n");

const iso = (ms: number): string => new Date(ms).toISOString();

function event(sessionId: string, type: SessionEvent["type"], fields: { itemId?: string; value?: number; at?: string; clientUuid?: string } = {}): SessionEvent {
  return {
    clientUuid: fields.clientUuid ?? eventId(),
    sessionId,
    type,
    ...(fields.itemId === undefined ? {} : { itemId: fields.itemId }),
    ...(fields.value === undefined ? {} : { value: fields.value }),
    at: fields.at ?? iso(Date.now()),
  };
}

/** Every drill of the session done, then the session finished. */
const finishEvents = (session: TodaySession): SessionEvent[] => [
  ...session.items.map((item) => event(session.id, "drill_done", { itemId: item.itemId })),
  event(session.id, "session_finished"),
];

// --- db and date helpers ------------------------------------------------------------------------

const eventCount = (playerId: string): number => (db.query("SELECT count(*) AS n FROM session_events WHERE player_id = ?").get(playerId) as { n: number }).n;

const sessionRow = (sessionId: string) =>
  db.query("SELECT id, date, items, finished_at FROM sessions WHERE id = ?").get(sessionId) as { id: string; date: string; items: string; finished_at: string | null };

/** The calendar day at `ms` in a fixed zone `hours` ahead of UTC. */
const dayAt = (hours: number, ms: number = Date.now()): string => iso(ms + hours * HOUR_MS).slice(0, 10);

const addDays = (date: string, days: number): string => iso(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Moves the session to `daysAgo` days before today (UTC): an old session an offline outbox may still report on. */
function backdate(sessionId: string, daysAgo: number): string {
  const date = dayAt(0, Date.now() - daysAgo * DAY_MS);
  db.query("UPDATE sessions SET date = ? WHERE id = ?").run(date, sessionId);
  return date;
}

// --- tests --------------------------------------------------------------------------------------

test("the route serves the contract's path with the contract's method", () => {
  expect(ENDPOINTS.postSessionEvents.method).toBe("POST");
  expect(EVENTS).toBe("/api/player/session-events");
});

describe("POST /api/player/session-events: access and the request body", () => {
  test("no cookie is a 401 problem, never cached, whatever the body holds", async () => {
    await expectProblem(await post({ events: [] }), 401);
    await expectProblem(await post(undefined, { raw: "not json" }), 401);
  });

  test("a player who has not onboarded has no session: a 404 problem that names the event, never cached", async () => {
    const player = await signInPlayer();
    const clientUuid = eventId();
    const res = await post({ events: [event("nope", "session_finished", { clientUuid })] }, { cookie: player.cookie });
    const body = await expectProblem(res, 404);
    expect(pointers(body)).toContain("/events/0");
    expect(texts(body)).toContain(clientUuid);
    expect(eventCount(player.id)).toBe(0);
  });

  test("a body that is not a JSON object is a 400 problem", async () => {
    const player = await onboardedPlayer();
    await expectProblem(await post(undefined, { cookie: player.cookie, raw: "{not json" }), 400);
    await expectProblem(await post([], { cookie: player.cookie }), 400);
    await expectProblem(await post("text", { cookie: player.cookie }), 400);
  });

  test("an empty batch is a 422 problem that points at /events, and nothing is written", async () => {
    const player = await onboardedPlayer();
    await todayOk(player);
    const body = await expectProblem(await post({ events: [] }, { cookie: player.cookie }), 422);
    expect(pointers(body)).toContain("/events");
    expect(eventCount(player.id)).toBe(0);
    await expectProblem(await post({}, { cookie: player.cookie }), 422);
  });

  test("an event the contract refuses is a 422 that names that event and its field; the valid ones are not written", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    const good = event(session.id, "drill_done", { itemId: session.items[0]!.itemId });

    const badType = await expectProblem(await post({ events: [good, { ...good, clientUuid: eventId(), type: "flip" }] }, { cookie: player.cookie }), 422);
    expect(pointers(badType)).toContain("/events/1/type");
    expect(pointers(badType).some((p) => p.startsWith("/events/0"))).toBe(false);

    const badItem = await expectProblem(await post({ events: [{ ...good, clientUuid: eventId(), itemId: "not an id!" }] }, { cookie: player.cookie }), 422);
    expect(pointers(badItem)).toContain("/events/0/itemId");

    const named = await expectProblem(await post({ events: [{ ...good, clientUuid: eventId(), playerId: "someone-else" }] }, { cookie: player.cookie }), 422);
    expect(pointers(named).some((p) => p.startsWith("/events/0"))).toBe(true);

    await expectProblem(await post({ events: [good], playerId: "someone-else" }, { cookie: player.cookie }), 422);
    expect(eventCount(player.id)).toBe(0);
    expect(sessionRow(session.id).items).not.toContain('"done":true');
  });

  test("the batch is bounded: 1000 events are accepted, 1001 are a 422 that names the events past the bound", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    const many = (n: number): SessionEvent[] => Array.from({ length: n }, () => event(session.id, "result", { value: 1 }));

    const over = await expectProblem(await post({ events: many(1001) }, { cookie: player.cookie }), 422);
    expect(pointers(over)).toContain("/events/1000");
    expect(pointers(over)).not.toContain("/events/999");
    expect(eventCount(player.id)).toBe(0);

    await postOk(player, many(1000));
    expect(eventCount(player.id)).toBe(1000);
  });

  test("the body is bounded: an oversized one is a 413 problem and nothing is written", async () => {
    const player = await onboardedPlayer();
    await todayOk(player);
    const raw = JSON.stringify({ events: [], filler: "x".repeat(2 * 1024 * 1024) });
    await expectProblem(await post(undefined, { cookie: player.cookie, raw }), 413);
    expect(eventCount(player.id)).toBe(0);
  });
});

describe("POST /api/player/session-events: finishing a session", () => {
  test("finishing a session takes ONE call: the updated session, the progress and the next session date", async () => {
    const player = await onboardedPlayer({ daysPerWeek: 3 });
    const session = await todayOk(player);
    const minutes = session.items.reduce((sum, item) => sum + item.minutes, 0);

    const res = await post({ events: finishEvents(session) }, { cookie: player.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = SessionEventsResponse.parse(await res.json());

    expect(body.session.id).toBe(session.id);
    expect(body.session.items.every((item) => item.done)).toBe(true);
    expect(body.progress).toEqual({ sessionsCompleted: 1, minutesTrained: minutes, streakDays: 1 });
    // 3 days a week: a session every 2 days.
    expect(body.nextSessionDate).toBe(addDays(session.date, 2));

    const row = sessionRow(session.id);
    expect(row.finished_at).not.toBeNull();
    expect(eventCount(player.id)).toBe(session.items.length + 1);
    // What the response says is what GET /api/player/today says.
    expect(await todayOk(player)).toEqual(body.session);
  });

  test("posting the same batch twice gives identical responses and row counts", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    const batch = finishEvents(session);

    const first = await post({ events: batch }, { cookie: player.cookie });
    const firstText = await first.text();
    const rows = eventCount(player.id);
    const stored = sessionRow(session.id);

    const second = await post({ events: batch }, { cookie: player.cookie });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstText);
    expect(eventCount(player.id)).toBe(rows);
    expect(rows).toBe(batch.length);
    expect(sessionRow(session.id)).toEqual(stored);
  });

  test("an undo after a done leaves the item not done and its minutes out of the progress", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    const [first, second] = session.items;
    const t = Date.now();

    const body = await postOk(player, [
      event(session.id, "drill_done", { itemId: first!.itemId, at: iso(t - 3000) }),
      event(session.id, "drill_done", { itemId: second!.itemId, at: iso(t - 2000) }),
      event(session.id, "drill_undone", { itemId: first!.itemId, at: iso(t - 1000) }),
    ]);
    expect(body.session.items.find((item) => item.itemId === first!.itemId)?.done).toBe(false);
    expect(body.session.items.find((item) => item.itemId === second!.itemId)?.done).toBe(true);
    expect(body.progress.minutesTrained).toBe(second!.minutes);
    expect(body.progress.sessionsCompleted).toBe(0);

    // The undo can also arrive in a later call.
    const later = await postOk(player, [event(session.id, "drill_undone", { itemId: second!.itemId })]);
    expect(later.session.items.some((item) => item.done)).toBe(false);
    expect(later.progress.minutesTrained).toBe(0);
  });

  test("the response's session is the latest one the batch names, with that session's own date", async () => {
    const player = await onboardedPlayer();
    const old = await todayOk(player);
    const oldDate = backdate(old.id, 2);
    const current = await todayOk(player);
    expect(current.id).not.toBe(old.id);

    const both = await postOk(player, [event(old.id, "session_finished"), event(current.id, "drill_done", { itemId: current.items[0]!.itemId })]);
    expect(both.session.id).toBe(current.id);
    expect(both.progress.sessionsCompleted).toBe(1);

    const onlyOld = await postOk(player, [event(old.id, "result", { value: 3 })]);
    expect(onlyOld.session.id).toBe(old.id);
    expect(onlyOld.session.date).toBe(oldDate);
  });

  test("a due skill test stays on the returned session, as GET /api/player/today has it", async () => {
    const player = await onboardedPlayer();
    db.query("UPDATE test_results SET recorded_at = ? WHERE player_id = ?").run(iso(Date.now() - 40 * DAY_MS), player.id);
    const session = await todayOk(player);
    expect(session.skillTest).toBeDefined();

    const body = await postOk(player, [event(session.id, "drill_done", { itemId: session.items[0]!.itemId })]);
    expect(body.session.skillTest).toEqual(session.skillTest);
    expect(body.session.totalMinutes).toBe(session.totalMinutes);
  });
});

describe("POST /api/player/session-events: the next session date", () => {
  // The profile's daysPerWeek is 2-6 (DAYS_PER_WEEK).
  test.each([
    [2, 3],
    [3, 2],
    [4, 1],
    [5, 1],
    [6, 1],
  ])("%i days a week: the next session is %i day(s) after the session", async (daysPerWeek, spacing) => {
    const player = await onboardedPlayer({ daysPerWeek: daysPerWeek as PlayerProfile["daysPerWeek"] });
    const session = await todayOk(player);
    const body = await postOk(player, [event(session.id, "session_finished")]);
    expect(body.nextSessionDate).toBe(addDays(session.date, spacing));
  });

  test.each([
    ["Etc/GMT-14", 14],
    ["Etc/GMT+11", -11],
    ["Mars/Olympus", 0],
    ["+14:00", 0],
    [undefined, 0],
  ])("a session reported after its spacing has passed is due today, on the day of the X-Timezone %p", async (zone, hours) => {
    const player = await onboardedPlayer({ daysPerWeek: 3 });
    const session = await todayOk(player);
    backdate(session.id, 10);
    const body = await postOk(player, [event(session.id, "session_finished")], zone);
    expect(body.nextSessionDate).toBe(dayAt(hours));
  });
});

describe("POST /api/player/session-events: the streak is counted in the X-Timezone's days", () => {
  // A session finished 36 hours ago is yesterday's in a zone where it is now 12:00 or later, and two days ago in the
  // others: the two zones below are 12 hours apart, so exactly one of them keeps the streak alive.
  const expected = (hours: number, finishedAt: number, now: number): number => (daysBetween(dayAt(hours, finishedAt), dayAt(hours, now)) <= 1 ? 1 : 0);

  test("the premise: the two zones disagree", () => {
    const now = Date.now();
    expect(new Set([expected(14, now - 36 * HOUR_MS, now), expected(2, now - 36 * HOUR_MS, now)]).size).toBe(2);
  });

  test.each([
    ["Etc/GMT-14", 14],
    ["Etc/GMT-2", 2],
  ])("%s", async (zone, hours) => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    const finishedAt = Date.now() - 36 * HOUR_MS;
    const body = await postOk(player, [event(session.id, "session_finished", { at: iso(finishedAt) })], zone);
    expect(body.progress.sessionsCompleted).toBe(1);
    expect(body.progress.streakDays).toBe(expected(hours, finishedAt, Date.now()));
  });
});

describe("POST /api/player/session-events: the offline window", () => {
  test("an event older than 30 days is a 422 that names it by pointer and clientUuid; the batch is not written", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    const stale = eventId();
    const batch = [
      event(session.id, "drill_done", { itemId: session.items[0]!.itemId }),
      event(session.id, "drill_done", { itemId: session.items[1]!.itemId, clientUuid: stale, at: iso(Date.now() - 31 * DAY_MS) }),
    ];
    const body = await expectProblem(await post({ events: batch }, { cookie: player.cookie }), 422);
    expect(pointers(body)).toContain("/events/1");
    expect(pointers(body)).not.toContain("/events/0");
    expect(texts(body)).toContain(stale);
    expect(texts(body)).not.toContain(batch[0]!.clientUuid);
    expect(eventCount(player.id)).toBe(0);
  });

  test("an event 29 days old is accepted (the offline outbox's window)", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    const body = await postOk(player, [event(session.id, "drill_done", { itemId: session.items[0]!.itemId, at: iso(Date.now() - 29 * DAY_MS) })]);
    expect(body.session.items[0]!.done).toBe(true);
    expect(eventCount(player.id)).toBe(1);
  });

  test("an event more than a day in the future is a 422 that names it", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    const future = eventId();
    const body = await expectProblem(
      await post({ events: [event(session.id, "session_finished", { clientUuid: future, at: iso(Date.now() + 3 * DAY_MS) })] }, { cookie: player.cookie }),
      422,
    );
    expect(pointers(body)).toContain("/events/0");
    expect(texts(body)).toContain(future);
    expect(eventCount(player.id)).toBe(0);
  });
});

describe("POST /api/player/session-events: only the player's own sessions", () => {
  test("another player's session is a 404 that is indistinguishable from an unknown one, and it names the event", async () => {
    const owner = await onboardedPlayer();
    const ownerSession = await todayOk(owner);
    const intruder = await onboardedPlayer();
    await todayOk(intruder);
    const clientUuid = eventId();
    const finish = (sessionId: string) => ({ events: [event(sessionId, "session_finished", { clientUuid })] });

    const foreign = await post(finish(ownerSession.id), { cookie: intruder.cookie });
    const foreignBody = await expectProblem(foreign, 404);
    const unknown = await post(finish("no-such-session"), { cookie: intruder.cookie });
    const unknownBody = await expectProblem(unknown, 404);

    expect(foreignBody).toEqual(unknownBody);
    expect(pointers(foreignBody)).toContain("/events/0");
    expect(texts(foreignBody)).toContain(clientUuid);
    expect(JSON.stringify(foreignBody)).not.toContain(ownerSession.id);
    // Nothing was written, and the owner's session is untouched.
    expect(eventCount(intruder.id)).toBe(0);
    expect(eventCount(owner.id)).toBe(0);
    expect(sessionRow(ownerSession.id).finished_at).toBeNull();
  });

  test("in a mixed batch only the events of the session that is not theirs are named, and nothing is written", async () => {
    const owner = await onboardedPlayer();
    const ownerSession = await todayOk(owner);
    const player = await onboardedPlayer();
    const own = await todayOk(player);
    const foreignUuid = eventId();
    const batch = [
      event(own.id, "drill_done", { itemId: own.items[0]!.itemId }),
      event(ownerSession.id, "drill_done", { itemId: ownerSession.items[0]!.itemId, clientUuid: foreignUuid }),
    ];
    const body = await expectProblem(await post({ events: batch }, { cookie: player.cookie }), 404);
    expect(pointers(body)).toContain("/events/1");
    expect(pointers(body)).not.toContain("/events/0");
    expect(texts(body)).toContain(foreignUuid);
    expect(texts(body)).not.toContain(batch[0]!.clientUuid);
    expect(eventCount(player.id)).toBe(0);
    expect(eventCount(owner.id)).toBe(0);
    expect(sessionRow(own.id).items).not.toContain('"done":true');
  });
});

describe("POST /api/player/session-events: what is not an event's fault", () => {
  test("a player whose roadmap is gone has no session to report on: a 404 that names the event, and nothing is written", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    db.query("DELETE FROM roadmaps WHERE player_id = ?").run(player.id);
    const clientUuid = eventId();
    const body = await expectProblem(await post({ events: [event(session.id, "session_finished", { clientUuid })] }, { cookie: player.cookie }), 404);
    expect(pointers(body)).toContain("/events/0");
    expect(texts(body)).toContain(clientUuid);
    expect(eventCount(player.id)).toBe(0);
    expect(sessionRow(session.id).finished_at).toBeNull();
  });

  test("an unexpected failure is a 500 problem that names no event (the outbox would drop a named one)", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    db.run("DROP TABLE session_events");
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = await expectProblem(await post({ events: [event(session.id, "session_finished")] }, { cookie: player.cookie }), 500);
      expect(body.errors).toBeUndefined();
    } finally {
      quiet.mockRestore();
    }
  });

  test("the returned session fills a text that lacks the profile's locale, as GET /api/player/today does", async () => {
    const player = await onboardedPlayer({ locale: "kk" });
    const first = await todayOk(player);
    const old = db.query("SELECT id FROM drill_versions WHERE id = ?").get(first.items[0]!.drillVersionId) as { id: string };
    // A version of that drill whose goal exists in ru only, and the session pointed at it.
    db.query(
      `INSERT INTO drill_versions (id, drill_id, semver, parent_version_id, status, content, equipment, space, partner, age_min, age_max,
                                   level, minutes, license, author_name, author_user_id, source, source_url, origin, change_summary, created_at)
       SELECT 'ru-only-version', drill_id, '8.8.8', id, status, json_remove(content, '$.goal.kk', '$.goal.en'),
              equipment, space, partner, age_min, age_max, level, minutes, license, author_name, author_user_id, source, source_url,
              'seed', NULL, created_at
         FROM drill_versions WHERE id = ?`,
    ).run(old.id);
    db.query("UPDATE sessions SET items = json_set(items, '$[0].drillVersionId', 'ru-only-version') WHERE player_id = ?").run(player.id);

    const body = await postOk(player, [event(first.id, "drill_done", { itemId: first.items[0]!.itemId })]);
    const goal = body.session.items[0]!.content.goal;
    expect(goal.ru).toBeDefined();
    expect(goal.kk).toBe(goal.ru!);
    expect(goal.en).toBe(goal.ru!);
    expect(body.session.items[0]!.done).toBe(true);
  });
});
