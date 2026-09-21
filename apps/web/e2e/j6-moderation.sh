#!/usr/bin/env bash
# apps/web/e2e/j6-moderation.sh: slice gate fc-mol-prj, journey J6 "an admin moderates contributions and curates trust in the commons".
# Integration proof on the REAL stack, nothing mocked: the real API process on a fresh temp SQLite DB with the real seed, serving the
# real production web build on the same origin, driven by real browsers (playwright-cli; one session for the coach, one for the admin,
# one for a player, so nobody is ever signed out to make room for somebody else). The API gets a free kernel-assigned port (lib.sh
# start_stack); :4111 and :5173 are neither used nor touched. Accounts: the admin is created with the real bootstrap CLI
# (apps/api/src/cli/admin.ts, ADMIN_PASSWORD from the environment); the coach signs up through the real sign-up screen; the players
# are anonymous. Real mp4 fixture generated here (ffmpeg; a minimal ftyp/isom byte sequence when ffmpeg is absent).
#
#   1. admin CLI    `admin.ts create` makes a user with role admin who can sign in over HTTP; the password is never echoed
#   2. player       an anonymous player onboards (POST /api/player/start) and DOWNLOADS today's session in the browser ('Available
#                   offline'); one of its drills (X) is unpublished at step 12
#   3. coach        signs up in the UI, is refused on /admin (the unauthorized page), submits a new method WITH a video through the
#                   real contribute form: contributions row pending + one video attachment stored byte for byte
#   4. RBAC         a contributor session, an anonymous player and no session against EVERY /api/admin route: 403 / 401, nothing changed
#   5. review       the admin signs in through the UI (from /admin), the queue lists the pending contribution (title, kind, submitter,
#                   files); its review screen shows the author and plays the private video (/api/media/:id: 200 for the admin, 404
#                   for an anonymous visitor); REJECT and REQUEST CHANGES need a note (no request without one: UI and API 422 /note);
#                   Request changes with a note is ONE call
#   6. coach again  My contributions shows 'Changes requested' and the note; /contribute/:id/edit shows the note on top, the form
#                   pre-filled; the coach edits and resubmits: pending again, the video kept
#   7. approve      the admin edits ONE field (duration) and approves in a SINGLE decision call (edits + status in one body). sqlite: a
#                   new drill with version 1.0.0 (immutable: an UPDATE is refused by the database), author = the coach, a reviews row
#                   with the admin as reviewer, the contribution approved with its resulting drill, the edit applied
#   8. library      the drill is in /commons as 'Community' (card, detail, API) and is a planner candidate (candidates() over the real DB:
#                   eligible for a fitting profile, not for one without a ball: the check can fail)
#   9. improvement  the coach improves a Genesis drill; the queue shows the field diff; approval creates version 1.1.0 whose parent is
#                   1.0.0, both in the drill's history (API + page), 1.0.0 byte-identical, current -> 1.1.0
#  10. trust        the admin marks the drill EXPERT VERIFIED with organisation 'FC Kairat Academy' (UI): the badge reads 'Verified by
#                   FC Kairat Academy' on the library card, the detail page and in the API; ACADEMY_VERIFIED without an organisation is 422
#  11. unpublish    the admin unpublishes drill X (a reason is required, behind a confirm dialog): gone from the library (API list, search,
#                   detail 404), out of the planner pool and of a NEW player's session, while the ALREADY-DOWNLOADED session of the
#                   player still works (server copy, /train, the drill player, and offline)
#  12. impact       /admin/impact numbers equal independent sqlite counts (baselines, retests, median, sessions, hours, contributors,
#                   verified coaches, open methodologies)
#  13. settings     under-10 minimum status -> REVIEWED persists across a reload (API + sqlite + page), the planner sees it at once
#  14. kk / ru      the admin screens in Kazakh and Russian carry the words of their messages bundles, no 'undefined'
#
# Readings of the criteria (where they were open; each is a line of this script, so a reviewer can disagree with it):
#   - "opens the review queue showing the coach's pending contribution with author and video": the queue row shows the title, kind,
#     'Sent by' (the submitter's account name) and 'Files: 1'; the review screen (the queue title links to it) shows the author and the video.
#   - "requests changes with a note ... the coach edits and resubmits": the resubmit is driven through the real route
#     /contribute/<id>/edit. The 'Edit and resubmit' link of My contributions is asserted separately as a NOTE (bug fc-c9l links to
#     /contribute?edit=<id> and is being fixed); it is not a failure here.
#   - "the admin edits one field and approves with a single API call": one POST /api/admin/contributions/:id/decision carrying
#     {action: approve, edits: {durationMin}, status} and no other mutation. The queue read that follows the answer is a GET, not a decision.
#   - The improvement is a Genesis drill improved through POST /api/contributions (kind improvement): the web app has no suggest-improvement
#     screen. Its approval runs through the admin review screen. 'Both visible in the drill's history': the API's history and the page's
#     'Version history' list 1.1.0 and 1.0.0 (the text of the old version is an API gap, fc-h2p: the immutable row is compared in sqlite).
#   - "eligible as a planner candidate": planner/candidates.ts run over the stack's real SQLite file with a profile that fits the drill.
#   - "an already-downloaded session still works": the player's stored session (GET /api/player/today) still lists the unpublished drill,
#     /train and the drill player still show it with all its text, also with the browser context OFFLINE (the service worker + device copy).
#   - "the impact page numbers match sqlite counts": every card is compared with an independent SQL count over the same file (the API's
#     ImpactMetrics is compared too); the headline is the median improvement computed from the raw test results with jq.
#   - "Community" badge: a contributed drill is COMMUNITY without the Genesis source, so its badge reads 'Community' (the Genesis seed reads
#     'Community Draft').
#   - Sign-in return path: the admin's sign-in from /admin must end on the queue (asserted, strict). The coach's sign-up from
#     /contribute is only a NOTE here (not a criterion of this gate); both use the same screen.
#
# Environment: playwright-cli or a browser missing, or E2E_WEB=off: the browser steps are BLOCKED (exit 3 unless E2E_ALLOW_BLOCKED=1),
# never a pass; the API-only steps (admin CLI, sign-in, RBAC) still run. Exit codes (lib.sh): 0 all passed, 1 a FAIL, 3 BLOCKED.
# Fail-slow (no set -e): every step reports. Cleanup: e2e_defer only (never `trap ... EXIT` after sourcing lib.sh).
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
: "${E2E_TEXT_TIMEOUT:=10}"
source "$HERE/lib.sh"
unset SEED_DIR # the API must start on the repo's default seed

ADMIN_EMAIL=admin@e2e.test ADMIN_NAME='Ada Admin' ADMIN_PASS='e2e-admin-pass-9271'
COACH_EMAIL=coach@e2e.test COACH_NAME='Coach Kim' COACH_PASS='e2e-coach-pass-4408'
DRILL_NAME='Zigzag Gate Dribble' DRILL_SLUG=zigzag-gate-dribble
ORG='FC Kairat Academy'
CHANGES_NOTE='Please add a safety line about wearing shin guards.'
NBSP=$(printf '\xc2\xa0')
EMPTY_JSON={}

scratch=$(mktemp -d "${TMPDIR:-/tmp}/j6-gate.XXXXXX") || exit 1
e2e_defer 'rm -rf -- "$scratch"'

# --- small helpers -------------------------------------------------------------------------------------------------------
# fetch <cookie | -> <METHOD> <path> [json body]: one request to the real API; sets F_CODE, F_BODY, F_HDRS (main shell).
fetch() {
  local cookie=$1 method=$2 path=$3 data=${4-} args
  args=(-s --max-time "$E2E_HTTP_TIMEOUT" -X "$method" -D "$scratch/f.hdr" -o "$scratch/f.body" -w '%{http_code}')
  args+=(-H "Origin: $API_URL")
  [ "$cookie" = - ] || args+=(-H "Cookie: $cookie")
  [ -z "$data" ] || args+=(-H 'content-type: application/json' -d "$data")
  F_CODE=$(curl "${args[@]}" "$API_URL$path" 2>/dev/null) || F_CODE=000
  F_BODY=$(cat "$scratch/f.body" 2>/dev/null)
  F_HDRS=$(tr -d '\r' <"$scratch/f.hdr" 2>/dev/null)
}
# chk <label> <status> <jq expression on F_BODY>
chk() {
  if [ "$F_CODE" != "$2" ]; then fail "$1" "  HTTP $F_CODE (wanted $2): ${F_BODY:0:800}"; return 1; fi
  if jq -e "$3" >/dev/null 2>&1 <<<"$F_BODY"; then pass "$1"; else fail "$1" "  jq -e '$3' was false or failed"$'\n'"  HTTP $F_CODE payload: ${F_BODY:0:1800}"; return 1; fi
}
# jchk <label> <json> <jq expression> [jq args...]: the expression is truthy on the JSON text.
jchk() {
  local label=$1 json=$2 filter=$3
  shift 3
  if jq -e "$@" "$filter" >/dev/null 2>&1 <<<"$json"; then pass "$label"; else fail "$label" "  jq -e '$filter' was false or failed on: ${json:0:1500}"; return 1; fi
}
# sqj <sql>: the rows of a read-only query on the stack's DB, as a JSON array. sq1 <sql>: the first column of the first row.
sqj() {
  [ -f "${DB_PATH-}" ] || { _e2e_err "sqj: no database (call start_stack first)"; return 2; }
  E2E_SQL=$1 E2E_DB=$DB_PATH bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.E2E_DB, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    console.log(JSON.stringify(db.query(process.env.E2E_SQL).all()));
  '
}
sq1() { sqj "$1" | jq -r '.[0] | if . == null then "" else (to_entries[0].value | tostring) end'; }
# db_refuses_update <version id>: an UPDATE of drill_versions.content, always rolled back; prints the database's error (or NO ERROR).
db_refuses_update() {
  E2E_DB=$DB_PATH VID=$1 bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.E2E_DB);
    db.run("PRAGMA busy_timeout = 5000");
    let msg = "NO ERROR";
    db.run("BEGIN");
    try { db.query("UPDATE drill_versions SET content = ? WHERE id = ?").run("{}", process.env.VID); } catch (e) { msg = String(e && e.message ? e.message : e); }
    db.run("ROLLBACK");
    console.log(msg);
  '
}
# candidate_slugs <age> <equipment> <space>: the slugs planner/candidates.ts offers to that profile over the stack's real DB (the real
# settings, the real published versions, the real skill graph; every track at level 1), as a JSON array.
candidate_slugs() {
  E2E_DB=$DB_PATH E2E_ROOT=$E2E_REPO_ROOT AGE=$1 EQUIP=$2 SPACE=$3 bun -e '
    import { Database } from "bun:sqlite";
    const src = process.env.E2E_ROOT + "/apps/api/src/";
    const { candidates } = await import(src + "planner/candidates.ts");
    const { getSettings } = await import(src + "admin/settings.ts");
    const { listPublishedVersions, getSkillGraph } = await import(src + "commons/repo.ts");
    const db = new Database(process.env.E2E_DB, { readonly: true });
    const graph = getSkillGraph(db, "football", "en");
    const profile = { age: Number(process.env.AGE), equipment: process.env.EQUIP, space: process.env.SPACE, partner: false };
    const pool = candidates(profile, {}, getSettings(db), listPublishedVersions(db, { sport: "football" }), graph);
    console.log(JSON.stringify(pool.map((v) => v.slug)));
  '
}
uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || bun -e 'console.log(crypto.randomUUID())'; }   # a random v4 uuid (client_uuid is unique across players)
# session_cookie <email> <password>: the Better Auth session cookie of a real email sign-in (main shell; sets V_COOKIE).
session_cookie() {
  fetch - POST /api/auth/sign-in/email "$(jq -nc --arg e "$1" --arg p "$2" '{email: $e, password: $p}')"
  V_COOKIE=$(grep -i '^set-cookie: *[^;]*session_token=' <<<"$F_HDRS" | head -n1 | sed -E 's/^[^:]*: *//; s/;.*//')
  [ "$F_CODE" = 200 ] && [ -n "$V_COOKIE" ]
}
# anon_player <label> <age...>: an anonymous visitor (sets V_COOKIE) who onboards with the J2 payload; the plan is GET /api/player/today.
anon_player() {
  V_COOKIE=""
  fetch - POST /api/auth/sign-in/anonymous '{}'
  V_COOKIE=$(grep -i '^set-cookie: *[^;]*session_token=' <<<"$F_HDRS" | head -n1 | sed -E 's/^[^:]*: *//; s/;.*//')
  [ -n "$V_COOKIE" ] || { fail "$1: anonymous sign-in gives a session cookie" "  HTTP $F_CODE ${F_BODY:0:300}"; return 1; }
  fetch "$V_COOKIE" POST /api/player/start "$(player_start_body "${2:-}")"
  chk "$1: POST /api/player/start onboards the player" 200 '(.roadmap | type) == "object"'
}
# player_start_body <slalom: measured|skipped>: age 12, ball + wall, a yard; four measured tests (+ slalom measured at 30 s or skipped).
player_start_body() {
  local slalom
  if [ "${1:-skipped}" = measured ]; then slalom='{testSlug: "slalom-time", value: 30, clientUuid: $u5}'; else slalom='{testSlug: "slalom-time", value: 0, skipped: true, clientUuid: $u5}'; fi
  jq -nc --arg u1 "$(uuid)" --arg u2 "$(uuid)" --arg u3 "$(uuid)" --arg u4 "$(uuid)" --arg u5 "$(uuid)" "{
    profile: {age: 12, level: \"basic\", goal: \"weakfoot\", equipment: \"ball_wall\", space: \"yard\", partner: false, daysPerWeek: 3, minutesPerSession: 20, locale: \"en\"},
    baseline: [
      {testSlug: \"juggling-max-touches\", value: 15, clientUuid: \$u1},
      {testSlug: \"wall-passing-60s\", value: 30, clientUuid: \$u2},
      {testSlug: \"ball-mastery-30s\", value: 40, clientUuid: \$u3},
      {testSlug: \"weak-foot-passes\", value: 4, clientUuid: \$u4},
      $slalom]}"
}
# post_contribution <cookie> <payload json> [video file]: ONE multipart POST /api/contributions (sets F_CODE, F_BODY).
post_contribution() {
  local args
  printf '%s' "$2" >"$scratch/payload.json"
  args=(-s --max-time 30 -o "$scratch/f.body" -w '%{http_code}' -X POST -H "Origin: $API_URL" -H "Cookie: $1" -F "payload=<$scratch/payload.json;type=application/json")
  [ -z "${3:-}" ] || args+=(-F "video=@$3;type=video/mp4")
  F_CODE=$(curl "${args[@]}" "$API_URL/api/contributions" 2>/dev/null) || F_CODE=000
  F_BODY=$(cat "$scratch/f.body" 2>/dev/null)
}
# make_clip <path>: a small REAL mp4 (ffmpeg: H.264, else VP9), else a minimal ftyp/isom byte sequence (the server judges magic bytes).
CLIP_REAL=0
make_clip() {
  if command -v ffmpeg >/dev/null 2>&1; then
    local codec
    for codec in libx264 libvpx-vp9; do
      if ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc=size=160x120:rate=5:duration=1 -c:v "$codec" -pix_fmt yuv420p -movflags +faststart "$1" 2>/dev/null && [ -s "$1" ]; then CLIP_REAL=1; return 0; fi
    done
  fi
  printf '\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isommp41\x00\x00\x00\x08free' >"$1"
}

# --- browser helpers (playwright-cli through lib.sh's pw; the visible words are the English ones) ---------------------------
BROWSER=0
COACH_S="$E2E_SESSION-coach" ADMIN_S="$E2E_SESSION-admin" PLAYER_S="$E2E_SESSION-player"
use_browser() { case $1 in coach) E2E_SESSION=$COACH_S ;; admin) E2E_SESSION=$ADMIN_S ;; player) E2E_SESSION=$PLAYER_S ;; esac; }
close_browsers() {
  local s
  for s in "$COACH_S" "$ADMIN_S" "$PLAYER_S"; do (cd "$E2E_TMP/pw" 2>/dev/null && playwright-cli -s="$s" close) >/dev/null 2>&1 || true; done
}
e2e_defer 'close_browsers'
# open_browser <coach|admin|player> <path>: a new browser session (Chromium in UTC and en-US) on STACK_URL<path>.
open_browser() {
  local who=$1 out
  use_browser "$who"
  if out=$(pw open "$STACK_URL$2" --config="$scratch/pw.json" 2>&1); then pass "browser ($who): opened $2"; pw resize 1280 1800 >/dev/null
  elif grep -qiE 'not installed|Executable doesn.t exist' <<<"$out"; then blocked "browser ($who): open $2" "no usable browser: $(grep -iE 'not installed|Executable' <<<"$out" | head -n1)"; return 1
  else fail "browser ($who): open $2" "$out"; return 1; fi
}
JS_PRELUDE='
const origin = () => page.url().replace(/^(https?:\/\/[^\/]+).*$/, "$1");
const path = () => page.url().replace(/^https?:\/\/[^\/]+/, "").split(/[?#]/)[0];
const norm = (s) => String(s).replace(/[\s ]+/g, " ").trim();
const goOffline = async () => { await page.context().setOffline(true); await page.waitForFunction(() => navigator.onLine === false, null, { timeout: 8000 }); };
const goOnline = async () => { await page.context().setOffline(false); await page.waitForFunction(() => navigator.onLine === true, null, { timeout: 8000 }); };
const mainText = async () => norm(await page.locator("main").innerText());
const findRow = async (slug) => {
  const row = page.locator("main ul[aria-label] > li").filter({ has: page.locator("a[href=\"/commons/" + slug + "\"]") });
  for (let i = 0; i < 8; i++) {
    if ((await row.count()) > 0) return row.first();
    const more = page.getByRole("button", { name: "Show more drills", exact: true });
    if ((await more.count()) === 0) break;
    await more.click();
    await page.waitForTimeout(800);
  }
  return row.first();
};
'
# pw_js <label> <args json> <js: async (page, A) => ...> [timeout ms]: runs a Playwright snippet in the current browser session; the
# returned string is left in PW_OUT (parsed JSON text). Silent on success, FAIL with the error otherwise.
pw_js() {
  local label=$1 args=$2 code=$3 tmo=${4:-10000} out
  PW_OUT=""
  out=$(pw run-code "async page => { page.setDefaultTimeout($tmo); ${JS_PRELUDE} const A = ${args}; const run = ${code}; return await run(page, A); }") || {
    fail "$label" "  $(jq -r '.error // .' <<<"$out" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | head -n 12)"; return 1; }
  PW_OUT=$(jq -r '.result | (try fromjson catch .) | if type == "string" then . else tojson end' <<<"$out")
}
# api_calls <since-index>: the /api requests of the current browser session after request number <since-index>, one
# "INDEX METHOD path status" per line (playwright-cli lists "N. [METHOD] url => [status] text"); the session READS are left out.
api_calls() {
  pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[([A-Z]+)\] https?:\/\/[^\/]+(\/api\/[^ ?]*)[^ ]* => \[([^]]+)\].*/\1 \2 \3 \4/p' |
    awk -v since="$1" '$1 > since && $3 != "/api/auth/get-session" { print }'
}
last_request_index() { local n; n=$(pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[.*/\1/p' | sort -n | tail -n1); echo "${n:-0}"; }
# ui_auth <label> <signIn|signUp> <email> <password> <destination heading> [display name]: on the sign-in screen, sign in (or create
# the coach account) and see whether the destination opens by itself (PW_OUT.bounced = false) or the visitor is left on the sign-in
# screen ('You are already signed in', Continue: the app's own way out, taken here so the journey can go on).
ui_auth() {
  local args tab button
  args=$(jq -nc --arg m "$2" --arg e "$3" --arg p "$4" --arg h "$5" --arg n "${6:-}" '{mode: $m, email: $e, password: $p, heading: $h, name: $n}')
  pw_js "$1" "$args" 'async (page, A) => {
    const up = A.mode === "signUp";
    const label = up ? "Create coach account" : "Sign in";
    await page.getByRole("tab", { name: label, exact: true }).click();
    if (up) await page.getByLabel("Display name").fill(A.name);
    await page.getByLabel("Email").fill(A.email);
    await page.getByLabel("Password").fill(A.password);
    await page.getByRole("button", { name: label, exact: true }).click();
    const dest = page.getByRole("heading", { name: A.heading, exact: true, level: 1 });
    const stuck = page.getByRole("button", { name: "Continue", exact: true });
    await dest.or(stuck).first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(2500);
    const bounced = path().startsWith("/account/sign-in");
    const leftAt = page.url().replace(/^https?:\/\/[^\/]+/, "");
    const text = bounced ? await mainText() : "";
    if (bounced) await stuck.click();
    await dest.waitFor({ timeout: 20000 });
    return JSON.stringify({ bounced, leftAt, stuckText: text, url: path() }); }' 60000
}

# ============================================================================================================================
make_clip "$scratch/gate-drill.mp4"
CLIP_BYTES=$(wc -c <"$scratch/gate-drill.mp4" | tr -d ' ')
CLIP_SUM=$(sha256sum "$scratch/gate-drill.mp4" | cut -d' ' -f1)
if [ "$CLIP_REAL" = 1 ]; then pass "fixture: a real $CLIP_BYTES-byte mp4 generated with ffmpeg"; else echo "NOTE     ffmpeg is absent: the fixture is a minimal ftyp/isom byte sequence (accepted by magic bytes, not decodable): the playback check is skipped"; fi
printf '{"browser":{"contextOptions":{"timezoneId":"UTC","locale":"en-US"}}}\n' >"$scratch/pw.json"

start_stack || exit 1
assert_api /health '.ok == true and .database == "ok"' -l "stack: /health ok on the temp DB (port $E2E_API_PORT_USED, own media dir)"
DRILLS0=$(sqlite_count drills 'unpublished_at IS NULL AND current_version_id IS NOT NULL')
assert_eq "$DRILLS0" 60 "start state: 60 published seed drills, no contribution"
assert_eq "$(sqlite_count contributions)" 0 "start state: no contribution yet"
if [ "$E2E_WEB" = off ]; then BROWSER=0; elif ! pw_available; then BROWSER=0; else BROWSER=1; fi

# --- 1. the admin bootstrap CLI --------------------------------------------------------------------------------------------
CLI_OUT=$(ADMIN_PASSWORD="$ADMIN_PASS" NODE_ENV=development APP_DB_PATH="$DB_PATH" bun "$E2E_REPO_ROOT/apps/api/src/cli/admin.ts" create --email "$ADMIN_EMAIL" --name "$ADMIN_NAME" 2>&1)
CLI_RC=$?
assert_eq "$CLI_RC" 0 "admin CLI: 'admin.ts create --email --name' exits 0 (output: $CLI_OUT)"
case $CLI_OUT in *"$ADMIN_PASS"*) fail "admin CLI: the password is never echoed" "  the output contains the password" ;; *) pass "admin CLI: the password is never echoed" ;; esac
assert_eq "$(sqlite_count user "email = '$ADMIN_EMAIL' AND role = 'admin'")" 1 "admin CLI: sqlite has the user with role 'admin'"
ADMIN_ID=$(sq1 "SELECT id FROM \"user\" WHERE email = '$ADMIN_EMAIL'")
if session_cookie "$ADMIN_EMAIL" "$ADMIN_PASS"; then ADMIN_COOKIE=$V_COOKIE; pass "admin CLI: the admin signs in over HTTP (email + password) and gets a session cookie"
else ADMIN_COOKIE=""; fail "admin CLI: the admin signs in over HTTP (email + password)" "  HTTP $F_CODE ${F_BODY:0:300}"; fi
fetch "$ADMIN_COOKIE" GET /api/admin/contributions
chk "admin CLI: the admin's session is accepted by GET /api/admin/contributions (empty queue)" 200 'type == "array" and length == 0'

# --- 2. a player onboards and DOWNLOADS today's session (drill X will be unpublished at step 11) ------------------------------
PLAYER_COOKIE="" SESSION_ID="" X_SLUG="" X_TITLE="" X_VID="" ND=0
if [ "$BROWSER" = 1 ] && open_browser player /; then
  pw_js "player: anonymous sign-in and POST /api/player/start (the real endpoints, called from the page)" "$(jq -nc --argjson b "$(player_start_body skipped)" '{body: $b}')" 'async (page, A) => {
      await page.waitForTimeout(1500);
      const post = (p, b) => page.evaluate(async ([p, b]) => { const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return r.status; }, [p, b]);
      const a = await post("/api/auth/sign-in/anonymous", {});
      const s = await post("/api/player/start", A.body);
      return JSON.stringify({ signIn: a, start: s }); }' && jchk "player: POST /api/player/start answers 200 for the onboarded player" "$PW_OUT" '.start == 200'
  PLAYER_COOKIE=$(pw cookie-list | jq -r '.result // ""' | sed -nE 's/^(better-auth\.session_token=[^ ]+) .*/\1/p' | head -n1)
  if [ -n "$PLAYER_COOKIE" ]; then pass "player: the browser holds the player's session cookie"; else fail "player: the browser holds the player's session cookie"; fi
  fetch "$PLAYER_COOKIE" GET '/api/player/today?locale=en'
  TODAY=$F_BODY
  chk "player: GET /api/player/today composes today's session" 200 '(.items | length) >= 2 and .planner == "rules"'
  SESSION_ID=$(jq -r '.id // ""' <<<"$TODAY")
  ND=$(jq -r '.items | length' <<<"$TODAY" 2>/dev/null || echo 0)
  X_VID=$(jq -r '.items[0].drillVersionId // ""' <<<"$TODAY")
  X_TITLE=$(jq -r '.items[0].content.title.en // ""' <<<"$TODAY")
  X_SLUG=$(sq1 "SELECT drill_id FROM drill_versions WHERE id = '$X_VID'")
  [ -n "$X_SLUG" ] && pass "player: today's first drill (X) is '$X_TITLE' ($X_SLUG), version $X_VID" || fail "player: today's first drill resolves to a drill slug" "  version '$X_VID'"
  pw_js "player: /train lists today's drills and 'Download today's session' saves them ('Available offline')" "{}" 'async (page) => {
      await page.goto(origin() + "/train");
      await page.locator("main ol > li").first().waitFor();
      const btn = page.getByRole("button", { name: "Download today\x27s session" });
      await btn.click();
      await page.getByText("Available offline").waitFor();
      return JSON.stringify({ rows: await page.locator("main ol > li").count(), text: await mainText() }); }' 20000 &&
    jchk "player: /train shows the $ND drills of the server's session, and the session is now 'Available offline'" "$PW_OUT" ".rows == $ND and (.text | contains(\"Available offline\")) and (.text | contains(\$t))" --arg t "$X_TITLE"
  POOL_X_BEFORE=$(candidate_slugs 12 ball_wall yard)
  jchk "planner: X is in the candidate pool of the player's profile (age 12, ball + wall, a yard) before it is unpublished" "$POOL_X_BEFORE" 'index($x) != null' --arg x "$X_SLUG"
else
  blocked "player: onboard and download today's session in the browser" "no browser (E2E_WEB=$E2E_WEB, playwright-cli $(pw_available && echo present || echo absent))"
fi
# the Genesis drill G the coach will improve (a dribbling drill that is not in the player's session), and its current version's row
LIST=$(api_get '/api/commons/drills?locale=en&limit=100') || LIST=""
G_SLUG=$(jq -r --arg x "$X_SLUG" '[.items[] | select(.track == "dribbling" and .slug != $x and .ageMin != null and .ageMax != null)][0].slug // ""' <<<"${LIST:-null}" 2>/dev/null)
G_ITEM=$(jq -c --arg g "$G_SLUG" '.items[] | select(.slug == $g)' <<<"${LIST:-null}" 2>/dev/null)
[ -n "$G_SLUG" ] && pass "the Genesis drill G to improve is '$G_SLUG'" || { fail "a Genesis dribbling drill exists to be improved"; G_SLUG=none; }
G_V1=$(sq1 "SELECT current_version_id FROM drills WHERE slug = '$G_SLUG'")
G_V1_CONTENT=$(sq1 "SELECT content FROM drill_versions WHERE id = '$G_V1'")
G_DETAIL0=$(api_get "/api/commons/drills/$G_SLUG?locale=en") || G_DETAIL0=""

# --- 3. the coach: sign-up, /admin refused, the contribute form with a video ---------------------------------------------------
COACH_ID="" CID="" ATT_ID="" COACH_COOKIE=""
if [ "$BROWSER" = 1 ] && open_browser coach '/account/sign-in?redirect=%2Fcontribute'; then
  if ui_auth "coach: create the coach account on the sign-up screen (from /contribute)" signUp "$COACH_EMAIL" "$COACH_PASS" 'Contribute a method' "$COACH_NAME"; then
    pass "coach: the account is created and the contribute form opens"
    if [ "$(jq -r .bounced <<<"$PW_OUT")" = true ]; then
      echo "NOTE     PRODUCT BUG (outside this gate's criteria): after creating the account from /account/sign-in?redirect=/contribute the app navigated to /contribute and was sent BACK to the sign-in screen, which says 'You are already signed in' + Continue; pressing Continue opened the form. Stale session state right after sign-up." >&2
    fi
  fi
  COACH_ID=$(sq1 "SELECT id FROM \"user\" WHERE email = '$COACH_EMAIL'")
  assert_eq "$(sq1 "SELECT role FROM \"user\" WHERE email = '$COACH_EMAIL'")" contributor "coach: the new account has role 'contributor' (not admin)"
  if session_cookie "$COACH_EMAIL" "$COACH_PASS"; then COACH_COOKIE=$V_COOKIE; pass "coach: the coach's session cookie (for the API cross-checks)"; else fail "coach: email sign-in over HTTP" "  HTTP $F_CODE ${F_BODY:0:300}"; fi

  # a contributor is refused on every /admin page: the unauthorized page (the UI guard; the server enforces the roles at step 4)
  pw_js "coach: /admin shows the unauthorized page" "{}" 'async (page) => {
      const out = {};
      for (const where of ["/admin", "/admin/settings", "/admin/drills"]) {
        await page.goto(origin() + where);
        await page.getByRole("heading", { name: "This area is for administrators", level: 1 }).waitFor();
        out[where] = { url: path(), nav: await page.getByRole("navigation", { name: "Admin sections" }).count(), text: await mainText() };
      }
      return JSON.stringify(out); }' 20000 &&
    jchk "coach: /admin, /admin/settings and /admin/drills stay on their URL and show 'This area is for administrators' with no admin navigation" "$PW_OUT" \
      'all(.[]; .nav == 0 and (.text | contains("Your account does not have access here"))) and .["/admin"].url == "/admin" and .["/admin/settings"].url == "/admin/settings"'

  # the real contribute form, with a video
  DRILL_ARGS=$(jq -nc --arg name "$DRILL_NAME" --arg clip "$scratch/gate-drill.mp4" --arg author "$COACH_NAME" '{name: $name, clip: $clip, author: $author}')
  pw_js "coach: fill in and send the contribute form with a video (Send for review)" "$DRILL_ARGS" 'async (page, A) => {
      await page.goto(origin() + "/contribute");
      await page.getByLabel("Name of the method").waitFor();
      await page.getByLabel("Name of the method").fill(A.name);
      await page.getByLabel("Sport").selectOption("football");
      await page.getByLabel("Skill", { exact: true }).selectOption("dribbling");
      await page.getByLabel("Age from (years)").fill("8");
      await page.getByLabel("Age to (years)").fill("14");
      await page.getByLabel("Difficulty").selectOption("basic");
      await page.getByLabel("Goal").selectOption("dribbling");
      await page.getByLabel("Duration (minutes)").fill("10");
      await page.getByLabel("Equipment").selectOption("ball");
      await page.getByLabel("Instructions").fill("1. Set two cones one metre apart.\n2. Dribble through the gate with the inside of your foot.\n3. Repeat ten times.");
      await page.getByLabel("Common mistakes").fill("Kicking the ball too far ahead");
      await page.getByLabel("Progression").fill("Use the weaker foot");
      await page.getByLabel("Regression").fill("Make the gate wider");
      await page.getByLabel("Safety").fill("Clear the area of obstacles");
      await page.locator("input[type=file]").setInputFiles(A.clip);
      await page.getByLabel("Source").fill("Coach Kim academy notes");
      await page.getByLabel("Author").fill(A.author);
      await page.getByLabel("I made this method").check();
      await page.getByLabel("This is not FIFA").check();
      await page.getByRole("button", { name: "Send for review" }).click();
      await page.getByText("Thank you.").waitFor();
      return JSON.stringify({ text: await mainText() }); }' 30000 &&
    jchk "coach: the form ends on 'Thank you.' with 'Waiting for review'" "$PW_OUT" '.text | contains("Thank you.") and contains("Waiting for review")'
else
  blocked "coach: sign up and submit a method with a video in the browser" "no browser (E2E_WEB=$E2E_WEB, playwright-cli $(pw_available && echo present || echo absent))"
fi
CID=$(sq1 "SELECT id FROM contributions ORDER BY created_at LIMIT 1")
if [ -z "$CID" ]; then
  # no browser: the same submission over the API (the same real endpoint the form calls), so the API-level steps still run
  session_cookie "$COACH_EMAIL" "$COACH_PASS" || {
    fetch - POST /api/auth/sign-up/email "$(jq -nc --arg e "$COACH_EMAIL" --arg p "$COACH_PASS" --arg n "$COACH_NAME" '{email: $e, password: $p, name: $n}')"
    session_cookie "$COACH_EMAIL" "$COACH_PASS"; }
  COACH_COOKIE=$V_COOKIE
  COACH_ID=$(sq1 "SELECT id FROM \"user\" WHERE email = '$COACH_EMAIL'")
  if [ "$BROWSER" = 0 ]; then
    post_contribution "$COACH_COOKIE" "$(jq -nc --arg n "$DRILL_NAME" --arg a "$COACH_NAME" '{kind: "new", locale: "en", name: $n, sport: "football", skill: "dribbling", ageMin: 8, ageMax: 14, level: "basic", goal: "dribbling",
      instructions: "1. Set two cones one metre apart.\n2. Dribble through the gate with the inside of your foot.\n3. Repeat ten times.", durationMin: 10, equipment: "ball",
      mistakes: "Kicking the ball too far ahead", progression: "Use the weaker foot", regression: "Make the gate wider", safety: "Clear the area of obstacles",
      source: "Coach Kim academy notes", author: $a, rightsAttested: true, noCommercialContent: true}')" "$scratch/gate-drill.mp4"
    chk "coach (API, no browser): POST /api/contributions with a video answers 201 pending" 201 '.state == "pending"'
    CID=$(sq1 "SELECT id FROM contributions ORDER BY created_at LIMIT 1")
  fi
fi
CONTRIB=$(sqj "SELECT id, kind, state, submitter_user_id, payload FROM contributions")
jchk "coach: exactly one contribution: new, pending, submitted by the coach, named '$DRILL_NAME', by author '$COACH_NAME'" "$CONTRIB" \
  '(length == 1) and .[0].kind == "new" and .[0].state == "pending" and .[0].submitter_user_id == $c and (.[0].payload | fromjson | .name == $n and .author == $a and .locale == "en" and .skill == "dribbling")' \
  --arg c "$COACH_ID" --arg n "$DRILL_NAME" --arg a "$COACH_NAME"
ATTS=$(sqj "SELECT id, kind, mime, bytes, original_name, stored_path FROM contribution_attachments")
jchk "coach: one attachment row: a video/mp4 of $CLIP_BYTES bytes" "$ATTS" '(length == 1) and .[0].kind == "video" and .[0].mime == "video/mp4" and .[0].bytes == ($b | tonumber)' --arg b "$CLIP_BYTES"
ATT_ID=$(jq -r '.[0].id // ""' <<<"$ATTS")
STORED=$(jq -r '.[0].stored_path // ""' <<<"$ATTS")
if [ -n "$STORED" ] && [ "$(sha256sum "$MEDIA_DIR/$STORED" 2>/dev/null | cut -d' ' -f1)" = "$CLIP_SUM" ]; then pass "coach: the stored file in MEDIA_DIR is the uploaded video, byte for byte (sha256)"
else fail "coach: the stored file in MEDIA_DIR is the uploaded video, byte for byte (sha256)" "  stored_path '$STORED'"; fi

# --- 4. RBAC: every /api/admin route refuses everyone but an admin ---------------------------------------------------------------
RBAC_SLUG=${X_SLUG:-$G_SLUG}
snapshot() { sqj "SELECT (SELECT count(*) FROM reviews) AS reviews, (SELECT count(*) FROM drills WHERE unpublished_at IS NOT NULL) AS unpublished,
  (SELECT coalesce(group_concat(key || '=' || value), '') FROM settings) AS settings, (SELECT coalesce(group_concat(state), '') FROM contributions) AS states,
  (SELECT group_concat(status) FROM drill_versions) AS statuses, (SELECT count(*) FROM drill_versions) AS versions"; }
rbac_routes() {
  printf '%s\n' \
    'GET|/api/admin/contributions|' \
    "POST|/api/admin/contributions/$CID/decision|{\"action\":\"approve\"}" \
    "POST|/api/admin/drills/$RBAC_SLUG/status|{\"toStatus\":\"REVIEWED\",\"note\":\"probe\"}" \
    "POST|/api/admin/drills/$RBAC_SLUG/unpublish|{\"reason\":\"probe\"}" \
    'GET|/api/admin/impact|' \
    'GET|/api/admin/settings|' \
    'PUT|/api/admin/settings|{"uploadMaxMb":1}'
}
# rbac_check <label> <cookie | -> <status>: every route above answers <status> to that caller.
rbac_check() {
  local label=$1 cookie=$2 want=$3 method path body bad="" n=0
  while IFS='|' read -r method path body; do
    fetch "$cookie" "$method" "$path" "$body"
    n=$((n + 1))
    [ "$F_CODE" = "$want" ] || bad+="  $method $path -> HTTP $F_CODE (wanted $want): ${F_BODY:0:160}"$'\n'
  done < <(rbac_routes)
  if [ -z "$bad" ] && [ "$n" = 7 ]; then pass "$label: all $n /api/admin routes answer $want"; else fail "$label: all 7 /api/admin routes answer $want" "$bad"; fi
}
SNAP0=$(snapshot)
rbac_check "RBAC: a contributor session (the coach)" "${COACH_COOKIE:-x=y}" 403
if [ -n "$PLAYER_COOKIE" ]; then rbac_check "RBAC: an anonymous player session" "$PLAYER_COOKIE" 403; else
  anon_player "RBAC visitor" skipped && rbac_check "RBAC: an anonymous player session" "$V_COOKIE" 403; fi
rbac_check "RBAC: no session at all" - 401
SNAP1=$(snapshot)
assert_eq "$SNAP1" "$SNAP0" "RBAC: the refused calls changed nothing (reviews, unpublished drills, settings, contribution states, versions)"
fetch "${COACH_COOKIE:-x=y}" GET /api/admin/impact
chk "RBAC: the 403 for a contributor is a problem+json body" 403 '.status == 403'

if [ "$BROWSER" = 0 ]; then
  blocked "the moderation journey in the browser (sign-in from /admin, queue, review screen, decisions, library, trust badge, unpublish, impact, settings)" \
    "E2E_WEB=$E2E_WEB, playwright-cli $(pw_available && echo present || echo absent): no browser to drive"
  exit 0
fi

# --- 5. the admin reviews: sign-in, the queue, the review screen, the note rules ---------------------------------------------------
STEP5=0
if [ "$BROWSER" = 1 ] && open_browser admin /admin; then
  STEP5=1
  pw_js "admin: /admin without a session goes to the sign-in screen, with the return path" "{}" 'async (page) => {
      await page.getByRole("heading", { name: "Coach account", level: 1 }).waitFor();
      return JSON.stringify({ url: page.url().replace(/^https?:\/\/[^\/]+/, "") }); }' 20000 &&
    jchk "admin: /admin (signed out) becomes /account/sign-in?redirect=%2Fadmin" "$PW_OUT" '.url == "/account/sign-in?redirect=%2Fadmin"'
  if ui_auth "admin: sign in on the sign-in screen with the CLI's account" signIn "$ADMIN_EMAIL" "$ADMIN_PASS" 'Review queue'; then
    jchk "admin: after signing in from /admin the review queue opens by itself (not the 'You are already signed in' dead end of the sign-in screen)" "$PW_OUT" \
      '.bounced == false and .url == "/admin"'
  fi
else
  blocked "admin: sign in and review in the browser (queue, review screen, note rules, decisions, drills, impact, settings)" "no browser (E2E_WEB=$E2E_WEB, playwright-cli $(pw_available && echo present || echo absent))"
fi
if [ "$STEP5" = 1 ]; then
  pw_js "admin: the queue lists the contributions of the Pending tab" "{}" 'async (page) => {
      const sel = "main ul[aria-label=\"Contributions\"] > li";
      await page.locator(sel).first().waitFor();
      const rows = await page.locator(sel).evaluateAll((els) => els.map((li) => ({ text: li.innerText.replace(/\s+/g, " ").trim(), href: li.querySelector("h2 a") && li.querySelector("h2 a").getAttribute("href") })));
      const tabs = await page.getByRole("tab").evaluateAll((els) => els.map((e) => [e.innerText.trim(), e.getAttribute("aria-selected")]));
      return JSON.stringify({ rows, tabs, nav: await page.getByRole("navigation", { name: "Admin sections" }).innerText() }); }' 20000 &&
    {
      jchk "admin: the queue has one row: '$DRILL_NAME', New method, Sent by: $COACH_NAME, Files: 1, linked to its review screen" "$PW_OUT" \
        '(.rows | length) == 1 and (.rows[0].text | contains($n) and contains("New method") and contains("Sent by: " + $c) and contains("Files: 1")) and .rows[0].href == ("/admin/contributions/" + $id)' \
        --arg n "$DRILL_NAME" --arg c "$COACH_NAME" --arg id "$CID"
      jchk "admin: the tabs are Pending (selected), Changes requested, Approved, Rejected, and the sub-navigation has Review queue, Drills, Impact, Settings" "$PW_OUT" \
        '.tabs == [["Pending","true"],["Changes requested","false"],["Approved","false"],["Rejected","false"]] and (.nav | contains("Review queue") and contains("Drills") and contains("Impact") and contains("Settings"))'
    }
  fetch "$ADMIN_COOKIE" GET '/api/admin/contributions?state=pending'
  chk "API: GET /api/admin/contributions?state=pending has the contribution with its submitter, the author and the video attachment" 200 \
    "length == 1 and .[0].contribution.id == \"$CID\" and .[0].submitter.name == \"$COACH_NAME\" and .[0].contribution.payload.author == \"$COACH_NAME\" and .[0].contribution.attachments[0].kind == \"video\" and .[0].contribution.attachments[0].id == \"$ATT_ID\""

  # the review screen (the queue title is a link to it): the author, the private video
  pw_js "admin: open the review screen from the queue title" "$(jq -nc --arg n "$DRILL_NAME" '{name: $n}')" 'async (page, A) => {
      await page.getByRole("link", { name: A.name, exact: true }).click();
      await page.getByRole("heading", { name: A.name, exact: true, level: 1 }).waitFor();
      await page.waitForFunction(() => { const v = document.querySelector("video"); return v && (v.readyState >= 1 || v.error); }, null, { timeout: 15000 });
      const v = await page.evaluate(() => { const v = document.querySelector("video"); return { src: v.getAttribute("src"), rs: v.readyState, w: v.videoWidth, dur: v.duration, err: v.error ? v.error.code : null, controls: v.controls }; });
      return JSON.stringify({ url: path(), text: await mainText(), v }); }' 30000 &&
    {
      jchk "admin: the review screen (/admin/contributions/<id>) shows the title, Pending, New method, Sent by $COACH_NAME and the author $COACH_NAME" "$PW_OUT" \
        '.url == ("/admin/contributions/" + $id) and (.text | contains("Pending") and contains("New method") and contains("Sent by " + $c) and contains("Author " + $c))' --arg id "$CID" --arg c "$COACH_NAME"
      jchk "admin: the review screen has a <video controls> that plays the private media route /api/media/<attachment id>" "$PW_OUT" \
        '.v.src == ("/api/media/" + $att) and .v.controls == true' --arg att "$ATT_ID"
      if [ "$CLIP_REAL" = 1 ]; then jchk "admin: the video decodes in the browser (metadata loaded, a frame width > 0, no media error)" "$PW_OUT" '.v.err == null and .v.w > 0 and .v.dur > 0'
      else echo "NOTE     the fixture is not a decodable video (no ffmpeg): playback is not asserted" >&2; fi
    }
  code=$(curl -s -o "$scratch/media.admin" -w '%{http_code} %{content_type}' --max-time "$E2E_HTTP_TIMEOUT" -H "Cookie: $ADMIN_COOKIE" "$API_URL/api/media/$ATT_ID")
  assert_eq "$code" "200 video/mp4" "API: GET /api/media/<id> as the admin: 200 video/mp4"
  if cmp -s "$scratch/media.admin" "$scratch/gate-drill.mp4"; then pass "API: the admin receives the uploaded video byte for byte"; else fail "API: the admin receives the uploaded video byte for byte"; fi
  assert_eq "$(curl -s -o /dev/null -w '%{http_code}' --max-time "$E2E_HTTP_TIMEOUT" "$API_URL/api/media/$ATT_ID")" 404 "API: an anonymous visitor cannot read the unapproved video (404)"
  assert_eq "$(curl -s -o /dev/null -w '%{http_code}' --max-time "$E2E_HTTP_TIMEOUT" -H "Cookie: ${COACH_COOKIE:-x=y}" "$API_URL/api/media/$ATT_ID")" 200 "API: its owner, the coach, can read it (200)"

  # Reject and Request changes need a note: nothing is sent without one
  IDX=$(last_request_index)
  pw_js "admin: Reject and Request changes with an empty note" "{}" 'async (page) => {
      const msg = "A note is required for this decision. Tell the coach why.";
      await page.getByRole("button", { name: "Reject", exact: true }).click();
      await page.getByText(msg).waitFor();
      const afterReject = await page.getByText(msg).count();
      await page.getByRole("button", { name: "Request changes", exact: true }).click();
      await page.waitForTimeout(600);
      return JSON.stringify({ afterReject, afterChanges: await page.getByText(msg).count(), pending: (await mainText()).includes("Pending") }); }' 20000 &&
    jchk "admin: Reject and Request changes with no note show 'A note is required for this decision. Tell the coach why.' and the contribution stays Pending" "$PW_OUT" '.afterReject == 1 and .afterChanges == 1 and .pending == true'
  assert_eq "$(api_calls "$IDX" | awk '$2 == "POST"' | wc -l | tr -d ' ')" 0 "admin: no POST request was sent while the note was empty"
  fetch "$ADMIN_COOKIE" POST "/api/admin/contributions/$CID/decision" '{"action":"reject"}'
  chk "API: rejecting without a note is 422 with the pointer /note" 422 '.errors | any(.pointer == "/note")'
  fetch "$ADMIN_COOKIE" POST "/api/admin/contributions/$CID/decision" '{"action":"reject","note":"   "}'
  chk "API: rejecting with a blank note is 422 with the pointer /note" 422 '.errors | any(.pointer == "/note")'
  fetch "$ADMIN_COOKIE" POST "/api/admin/contributions/$CID/decision" '{"action":"request_changes"}'
  chk "API: requesting changes without a note is 422 with the pointer /note" 422 '.errors | any(.pointer == "/note")'
  assert_eq "$(sq1 "SELECT state FROM contributions WHERE id = '$CID'")" pending "sqlite: the refused decisions left the contribution pending"

  # Request changes with a note: ONE call
  IDX=$(last_request_index)
  pw_js "admin: Request changes with a note" "$(jq -nc --arg n "$CHANGES_NOTE" '{note: $n}')" 'async (page, A) => {
      await page.getByLabel("Note to the coach").fill(A.note);
      await page.getByRole("button", { name: "Request changes", exact: true }).click();
      await page.getByText("Sent back. The coach can now edit the method and send it again.").waitFor();
      return JSON.stringify({ text: await mainText() }); }' 20000 &&
    jchk "admin: the screen says 'Sent back. The coach can now edit the method and send it again.' and shows the state Changes requested" "$PW_OUT" '.text | contains("Sent back.") and contains("Changes requested")'
  CALLS=$(api_calls "$IDX")
  assert_eq "$(awk '$2 == "POST"' <<<"$CALLS" | wc -l | tr -d ' ')" 1 "admin: Request changes is ONE mutation call"
  N=$(awk -v p="/api/admin/contributions/$CID/decision" '$2 == "POST" && $3 == p && $4 == 200 { print $1 }' <<<"$CALLS" | head -n1)
  BODY=$([ -n "$N" ] && pw request-body "$N" | jq -r '.result // ""')
  jchk "admin: that one call is POST .../decision {action: request_changes, note}" "${BODY:-null}" '.action == "request_changes" and .note == $n' --arg n "$CHANGES_NOTE"
  jchk "sqlite: the contribution is changes_requested and stores the reviewer's note" "$(sqj "SELECT state, reviewer_note FROM contributions WHERE id = '$CID'")" \
    '.[0].state == "changes_requested" and .[0].reviewer_note == $n' --arg n "$CHANGES_NOTE"
  assert_eq "$(sqlite_count drills "slug = '$DRILL_SLUG'")" 0 "sqlite: requesting changes published nothing"
  fetch "$ADMIN_COOKIE" GET '/api/admin/contributions?state=changes_requested'
  chk "API: the Changes requested list has the contribution with the note" 200 "length == 1 and .[0].contribution.id == \"$CID\" and .[0].contribution.reviewerNote == \"$CHANGES_NOTE\""
fi

# --- 6. the coach sees the note, edits and resubmits ----------------------------------------------------------------------------
if [ "$BROWSER" = 1 ] && [ -n "$CID" ] && [ "$STEP5" = 1 ]; then
  use_browser coach
  pw_js "coach: My contributions" "$(jq -nc --arg n "$CHANGES_NOTE" '{note: $n}')" 'async (page, A) => {
      await page.goto(origin() + "/contribute/mine");
      await page.getByRole("heading", { name: "My contributions", exact: true, level: 1 }).waitFor();
      await page.getByText(A.note).waitFor();
      const links = await page.locator("main a").evaluateAll((els) => els.map((a) => [a.getAttribute("aria-label") || a.innerText.trim(), a.getAttribute("href")]));
      return JSON.stringify({ text: await mainText(), links }); }' 20000 &&
    jchk "coach: My contributions lists '$DRILL_NAME' as 'Changes requested' with the reviewer's note" "$PW_OUT" '.text | contains($n) and contains("Changes requested") and contains($note)' --arg n "$DRILL_NAME" --arg note "$CHANGES_NOTE"
  EDIT_HREF=$(jq -r '[.links[] | select(.[0] | startswith("Edit and resubmit")) | .[1]][0] // ""' <<<"$PW_OUT" 2>/dev/null)
  if [ "$EDIT_HREF" = "/contribute/$CID/edit" ]; then pass "coach: the 'Edit and resubmit' link of My contributions opens /contribute/<id>/edit"
  else echo "NOTE     the 'Edit and resubmit' link of My contributions points at '$EDIT_HREF', not /contribute/$CID/edit (known bug fc-c9l; not a failure of this gate). The resubmit below is driven through the real route." >&2; fi

  pw_js "coach: /contribute/<id>/edit, change the safety text as asked, resubmit" "$(jq -nc --arg id "$CID" --arg n "$CHANGES_NOTE" '{id: $id, note: $n}')" 'async (page, A) => {
      await page.goto(origin() + "/contribute/" + A.id + "/edit");
      await page.getByRole("heading", { name: "Edit and resubmit", exact: true, level: 1 }).waitFor();
      await page.getByLabel("Name of the method").waitFor();
      const before = {
        name: await page.getByLabel("Name of the method").inputValue(),
        safety: await page.getByLabel("Safety").inputValue(),
        duration: await page.getByLabel("Duration (minutes)").inputValue(),
        rights: await page.getByLabel("I made this method").isChecked(),
        commercial: await page.getByLabel("This is not FIFA").isChecked(),
        noteFirst: await page.evaluate((note) => { const t = document.querySelector("main").innerText; return t.indexOf(note) >= 0 && t.indexOf(note) < t.indexOf("Name of the method"); }, A.note),
        text: await mainText(),
      };
      await page.getByLabel("Safety").fill(before.safety + " Wear shin guards.");
      await page.getByLabel("I made this method").check();
      await page.getByLabel("This is not FIFA").check();
      await page.getByRole("button", { name: "Save and resubmit" }).click();
      await page.waitForURL(/\/contribute\/mine/);
      await page.getByRole("heading", { name: "My contributions", exact: true, level: 1 }).waitFor();
      await page.getByText("Pending", { exact: true }).first().waitFor();
      return JSON.stringify({ before, url: path(), after: await mainText() }); }' 30000 &&
    {
      jchk "coach: the edit screen shows the reviewer's note on top ('Note from the reviewer'), above the form" "$PW_OUT" '.before.noteFirst == true and (.before.text | contains("Note from the reviewer") and contains($note))' --arg note "$CHANGES_NOTE"
      jchk "coach: the edit form is pre-filled with what was sent (name, safety, duration), attestations asked again (unticked)" "$PW_OUT" \
        '.before.name == $n and .before.safety == "Clear the area of obstacles" and .before.duration == "10" and .before.rights == false and .before.commercial == false' --arg n "$DRILL_NAME"
      jchk "coach: after 'Save and resubmit' the coach is back on /contribute/mine and the contribution is Pending" "$PW_OUT" '.url == "/contribute/mine" and (.after | contains("Pending"))'
    }
  jchk "sqlite: the contribution is pending again, with the coach's new safety text" "$(sqj "SELECT state, payload FROM contributions WHERE id = '$CID'")" \
    '(length == 1) and .[0].state == "pending" and (.[0].payload | fromjson | .safety == "Clear the area of obstacles Wear shin guards.")'
  assert_eq "$(sqlite_count contributions)" 1 "sqlite: the resubmit edited the contribution in place (still one)"
  jchk "sqlite: the video attachment was kept by the resubmit (same attachment id)" "$(sqj "SELECT id FROM contribution_attachments WHERE contribution_id = '$CID'")" 'length == 1 and .[0].id == $a' --arg a "$ATT_ID"
  fetch "$COACH_COOKIE" GET /api/contributions/mine
  chk "API: GET /api/contributions/mine says pending" 200 "length == 1 and .[0].state == \"pending\" and .[0].id == \"$CID\""
fi

# --- 7. the admin edits ONE field and approves in ONE call --------------------------------------------------------------------
V1="$DRILL_SLUG-v1.0.0"
if [ "$STEP5" = 1 ] && [ -n "$CID" ]; then
  use_browser admin
  IDX=$(last_request_index)
  pw_js "admin: review the resubmitted contribution, edit ONE field (duration 10 -> 12), tick the checklist, Approve" "$(jq -nc --arg id "$CID" --arg n "$DRILL_NAME" '{id: $id, name: $n}')" 'async (page, A) => {
      await page.goto(origin() + "/admin/contributions/" + A.id);
      await page.getByRole("heading", { name: A.name, exact: true, level: 1 }).waitFor();
      const before = { pending: (await mainText()).includes("Pending"), duration: await page.locator("#review-edit-durationMin").inputValue(), safety: await page.locator("#review-edit-safety").inputValue() };
      await page.locator("#review-edit-durationMin").fill("12");
      for (const l of ["The content is original", "It is safe for children", "No identifiable child"]) await page.getByLabel(l).check();
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await page.getByText("Approved. The method is now in the commons.").waitFor();
      const link = await page.getByRole("link", { name: "Open the published drill" }).getAttribute("href");
      return JSON.stringify({ before, link, text: await mainText() }); }' 30000 &&
    {
      jchk "admin: the review screen shows the RESUBMITTED text (safety with 'shin guards'), Pending, duration 10 before the edit" "$PW_OUT" '.before.pending == true and .before.duration == "10" and (.before.safety | contains("shin guards"))'
      jchk "admin: the screen replaces its state from the answer: 'Approved. The method is now in the commons.' and links to /commons/$DRILL_SLUG" "$PW_OUT" '.link == ("/commons/" + $s) and (.text | contains("Approved"))' --arg s "$DRILL_SLUG"
    }
  CALLS=$(api_calls "$IDX")
  assert_eq "$(awk '$2 == "POST" || $2 == "PUT" || $2 == "PATCH" || $2 == "DELETE"' <<<"$CALLS" | wc -l | tr -d ' ')" 1 "admin: edit + approve is ONE mutation call (no separate edit or status call)"
  N=$(awk -v p="/api/admin/contributions/$CID/decision" '$2 == "POST" && $3 == p && $4 == 200 { print $1 }' <<<"$CALLS" | head -n1)
  BODY=$([ -n "$N" ] && pw request-body "$N" | jq -r '.result // ""')
  jchk "admin: that call is POST .../decision {action: approve, edits: {durationMin: 12} (only the field that was edited), status: COMMUNITY}" "${BODY:-null}" \
    '. == {"action": "approve", "edits": {"durationMin": 12}, "status": "COMMUNITY"}'

  # sqlite: the drill, its immutable version 1.0.0, the reviews row, the approved contribution
  jchk "sqlite: a new drill '$DRILL_SLUG' exists, published, its current version is $V1" "$(sqj "SELECT id, slug, current_version_id, unpublished_at FROM drills WHERE slug = '$DRILL_SLUG'")" \
    'length == 1 and .[0].current_version_id == $v and .[0].unpublished_at == null' --arg v "$V1"
  VERS=$(sqj "SELECT id, semver, parent_version_id, status, author_name, author_user_id, minutes, license, origin, source FROM drill_versions WHERE drill_id = '$DRILL_SLUG'")
  jchk "sqlite: exactly one version: 1.0.0, no parent, COMMUNITY, CC-BY-SA-4.0, origin 'contribution'" "$VERS" \
    'length == 1 and .[0].semver == "1.0.0" and .[0].parent_version_id == null and .[0].status == "COMMUNITY" and .[0].license == "CC-BY-SA-4.0" and .[0].origin == "contribution"'
  jchk "sqlite: the version's author is the coach ($COACH_NAME, user id of the coach), not the admin who edited and approved" "$VERS" \
    '.[0].author_name == $n and .[0].author_user_id == $c and .[0].author_user_id != $a' --arg n "$COACH_NAME" --arg c "$COACH_ID" --arg a "$ADMIN_ID"
  jchk "sqlite: the admin's one edit is in the version (duration 12 minutes), the coach's source is kept" "$VERS" '.[0].minutes == 12 and .[0].source == "Coach Kim academy notes"'
  REV=$(sqj "SELECT reviewer, reviewer_user_id, from_status, to_status, org_label FROM reviews WHERE drill_version_id = '$V1'")
  jchk "sqlite: one reviews row on $V1: reviewer '$ADMIN_NAME' (the admin's user id), COMMUNITY -> COMMUNITY" "$REV" \
    'length == 1 and .[0].reviewer == $n and .[0].reviewer_user_id == $a and .[0].from_status == "COMMUNITY" and .[0].to_status == "COMMUNITY"' --arg n "$ADMIN_NAME" --arg a "$ADMIN_ID"
  jchk "sqlite: the contribution is approved, its resulting drill is '$DRILL_SLUG', and it stores the edited payload (duration 12, safety with the coach's resubmit)" "$(sqj "SELECT state, resulting_drill_id, payload FROM contributions WHERE id = '$CID'")" \
    '.[0].state == "approved" and .[0].resulting_drill_id == $d and (.[0].payload | fromjson | .durationMin == 12 and (.safety | contains("shin guards")) and .author == $n)' --arg d "$DRILL_SLUG" --arg n "$COACH_NAME"
  jchk "sqlite: the drill is linked to the coach's skill (dribbling) as its primary skill" "$(sqj "SELECT s.slug AS skill, ds.is_primary AS p FROM drill_skills ds JOIN skills s ON s.id = ds.skill_id WHERE ds.drill_id = '$DRILL_SLUG'")" \
    'length == 1 and .[0].skill == "dribbling" and .[0].p == 1'
  MSG=$(db_refuses_update "$V1")
  case $MSG in *immutable*) pass "sqlite: version 1.0.0 is immutable: the database refuses an UPDATE of its content ($MSG)" ;; *) fail "sqlite: version 1.0.0 is immutable: the database refuses an UPDATE of its content" "  got: $MSG" ;; esac
  assert_eq "$(sqlite_count drills)" 61 "sqlite: 61 drills now (60 seed + the new one)"
  assert_eq "$(curl -s -o /dev/null -w '%{http_code}' --max-time "$E2E_HTTP_TIMEOUT" "$API_URL/api/media/$ATT_ID")" 200 "API: once approved and published, the video is public (anonymous GET /api/media/<id> is 200)"
  fetch - GET "/api/commons/drills/$DRILL_SLUG?locale=en"
  chk "API: GET /api/commons/drills/$DRILL_SLUG: author $COACH_NAME, version 1.0.0, the coach's video attached, one history entry, reviewed by $ADMIN_NAME" 200 \
    ".attribution.author == \"$COACH_NAME\" and .attribution.semver == \"1.0.0\" and (.content.media | length) == 1 and .content.media[0].kind == \"video\" and (.history | map(.semver)) == [\"1.0.0\"] and .reviews[0].reviewer == \"$ADMIN_NAME\""
fi

# --- 7b. a REJECT with a note is final -----------------------------------------------------------------------------------------------
REJECT_NOTE='This copies a commercial academy programme, so it cannot join the commons.'
B_CID=""
if [ -n "$COACH_COOKIE" ]; then
  post_contribution "$COACH_COOKIE" "$(jq -nc --arg a "$COACH_NAME" '{kind: "new", locale: "en", name: "Loose Cone Chase", sport: "football", skill: "ball-mastery", ageMin: 9, ageMax: 12, level: "beginner", goal: "control",
    instructions: "1. Spread six cones.\n2. Chase the ball to each cone.", durationMin: 6, equipment: "cones", mistakes: "", progression: "", regression: "", safety: "Watch for other players.",
    source: "A commercial academy programme", author: $a, rightsAttested: true, noCommercialContent: true}')"
  chk "coach (API): a second contribution 'Loose Cone Chase' is sent (201 pending)" 201 '.state == "pending"'
  B_CID=$(jq -r '.id // ""' <<<"$F_BODY")
fi
if [ "$STEP5" = 1 ] && [ -n "$B_CID" ]; then
  use_browser admin
  IDX=$(last_request_index)
  pw_js "admin: Reject with a note" "$(jq -nc --arg id "$B_CID" --arg n "$REJECT_NOTE" '{id: $id, note: $n}')" 'async (page, A) => {
      await page.goto(origin() + "/admin/contributions/" + A.id);
      await page.getByRole("heading", { name: "Loose Cone Chase", exact: true, level: 1 }).waitFor();
      await page.getByLabel("Note to the coach").fill(A.note);
      await page.getByRole("button", { name: "Reject", exact: true }).click();
      await page.getByText("Rejected. The coach can read your note.").waitFor();
      return JSON.stringify({ text: await mainText(), buttons: await page.getByRole("button", { name: /^(Approve|Reject|Request changes)$/ }).count() }); }' 30000 &&
    jchk "admin: the screen says 'Rejected. The coach can read your note.', shows the note, and offers no more decision buttons" "$PW_OUT" '(.text | contains("Rejected") and contains($n)) and .buttons == 0' --arg n "$REJECT_NOTE"
  CALLS=$(api_calls "$IDX")
  assert_eq "$(awk '$2 == "POST"' <<<"$CALLS" | wc -l | tr -d ' ')" 1 "admin: the rejection is ONE POST"
  jchk "sqlite: the contribution is rejected with the note, nothing was published (61 drills, no resulting drill)" \
    "$(sqj "SELECT state, reviewer_note, resulting_drill_id, (SELECT count(*) FROM drills) AS drills FROM contributions WHERE id = '$B_CID'")" \
    '.[0].state == "rejected" and .[0].reviewer_note == $n and .[0].resulting_drill_id == null and .[0].drills == 61' --arg n "$REJECT_NOTE"
  fetch "$ADMIN_COOKIE" POST "/api/admin/contributions/$B_CID/decision" '{"action":"approve"}'
  chk "API: a rejected contribution is final: approving it is 409" 409 '.status == 409'
  fetch "$COACH_COOKIE" GET /api/contributions/mine
  chk "API: the coach's list shows it as rejected with the reviewer's note" 200 ".[] | select(.id == \"$B_CID\") | .state == \"rejected\" and .reviewerNote == \"$REJECT_NOTE\""
  if [ "$BROWSER" = 1 ]; then
    use_browser coach
    pw_js "coach: the rejected contribution is read-only" "$(jq -nc --arg id "$B_CID" '{id: $id}')" 'async (page, A) => {
        await page.goto(origin() + "/contribute/" + A.id + "/edit");
        await page.getByRole("heading", { name: "Edit and resubmit", level: 1 }).waitFor();
        await page.getByText("It can no longer be edited.").first().waitFor();
        return JSON.stringify({ text: await mainText(), save: await page.getByRole("button", { name: "Save and resubmit" }).count() }); }' 25000 &&
      jchk "coach: /contribute/<id>/edit of a rejected contribution shows the reviewer's note, says it can no longer be edited, and has no 'Save and resubmit'" "$PW_OUT" '(.text | contains($n) and contains("can no longer be edited")) and .save == 0' --arg n "$REJECT_NOTE"
  fi
fi

# --- 8. the drill is in the library as 'Community' and is a planner candidate ---------------------------------------------------
LIB_SEL='main ul[aria-label] > li'
if [ "$BROWSER" = 1 ] && [ "$STEP5" = 1 ]; then
  use_browser coach
  pw_js "library: search for the new drill in /commons" "$(jq -nc --arg q 'Zigzag Gate' '{q: $q}')" 'async (page, A) => {
      await page.goto(origin() + "/commons?q=" + encodeURIComponent(A.q));
      await page.getByRole("heading", { name: "Sport knowledge as public infrastructure", level: 1 }).waitFor();
      await page.waitForFunction(() => /Showing 1 of 1/.test((document.querySelector("main p[aria-live]") || {}).innerText || ""), null, { timeout: 15000 });
      const cards = await page.locator("main ul[aria-label] > li").evaluateAll((els) => els.map((li) => { const b = li.querySelector("[data-status]:not(a)"); return { text: li.innerText.replace(/\s+/g, " ").trim(), href: li.querySelector("a") && li.querySelector("a").getAttribute("href"), badge: b ? b.innerText.trim() : null, status: b ? b.getAttribute("data-status") : null }; }));
      return JSON.stringify({ cards, summary: await page.locator("main p[aria-live]").innerText() }); }' 25000 &&
    {
      jchk "library: the search finds exactly the new drill: /commons/$DRILL_SLUG, badge 'Community' (COMMUNITY, not the Genesis 'Community Draft'), 12 min (the admin's edit)" "$PW_OUT" \
        '(.cards | length) == 1 and .cards[0].href == ("/commons/" + $s) and .cards[0].badge == "Community" and .cards[0].status == "COMMUNITY" and (.cards[0].text | contains("12 min"))' --arg s "$DRILL_SLUG"
      jchk "library: the card names its source 'Coach Kim academy notes' and the licence CC BY-SA 4.0" "$PW_OUT" '.cards[0].text | contains("Source: Coach Kim academy notes") and contains("Licence: CC BY-SA 4.0")'
    }
  pw_js "library: the whole library announces 61 drills" "{}" 'async (page) => {
      await page.goto(origin() + "/commons");
      await page.getByRole("heading", { name: "Sport knowledge as public infrastructure", level: 1 }).waitFor();
      await page.waitForFunction(() => /of 61$/.test((document.querySelector("main p[aria-live]") || {}).innerText || ""), null, { timeout: 15000 });
      return JSON.stringify({ summary: await page.locator("main p[aria-live]").innerText() }); }' 25000 &&
    jchk "library: /commons says 'Showing N of 61' (60 seed drills + the new one)" "$PW_OUT" '.summary | test("^Showing [0-9]+ of 61$")'
  pw_js "detail: /commons/$DRILL_SLUG" "$(jq -nc --arg s "$DRILL_SLUG" --arg n "$DRILL_NAME" '{slug: $s, name: $n}')" 'async (page, A) => {
      await page.goto(origin() + "/commons/" + A.slug);
      await page.getByRole("heading", { name: A.name, exact: true, level: 1 }).waitFor();
      await page.waitForTimeout(500);
      const badges = await page.locator("main [data-status]:not(a)").evaluateAll((els) => els.map((e) => e.innerText.trim()));
      const history = await page.locator("main section").evaluateAll((els) => { const s = els.find((x) => x.querySelector("h2") && x.querySelector("h2").innerText.trim() === "Version history"); return s ? [...s.querySelectorAll("li")].map((li) => li.innerText.replace(/\s+/g, " ").trim()) : []; });
      const video = await page.evaluate(() => { const v = document.querySelector("main video"); return v ? v.getAttribute("src") : null; });
      return JSON.stringify({ text: await mainText(), badges, history, video }); }' 25000 &&
    {
      jchk "detail: the badge reads 'Community', the author is $COACH_NAME, version 1.0.0, the admin's 12 minutes (720 s)" "$PW_OUT" \
        '.badges[0] == "Community" and (.text | contains("Author " + $c) and contains("Version 1.0.0") and contains("Time 720 s"))' --arg c "$COACH_NAME"
      jchk "detail: 'Who checked this drill' names the reviewer $ADMIN_NAME, and the Version history lists 1.0.0 as the current version" "$PW_OUT" \
        '(.text | contains("Who checked this drill") and contains($a)) and (.history | length) == 1 and (.history[0] | startswith("1.0.0 Current"))' --arg a "$ADMIN_NAME"
      VIDEO_SRC=$(jq -r '.video // ""' <<<"$PW_OUT")
      jchk "detail: the coach's video is on the page (a <video> with a source)" "$PW_OUT" '.video != null and (.video | length) > 0'
      if [ -n "$VIDEO_SRC" ]; then
        vct=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time "$E2E_HTTP_TIMEOUT" "$STACK_URL$VIDEO_SRC")
        case $vct in "200 video/"*) pass "detail: the video source $VIDEO_SRC is served as a video ($vct)" ;;
          *) echo "NOTE     the public detail page's video points at '$VIDEO_SRC', which answers '$vct' (not a video): the /uploads route is not served yet (backlog fc-bdi). Not a criterion of this gate." >&2 ;; esac
      fi
    }
fi
fetch - GET '/api/commons/drills?locale=en&q=Zigzag%20Gate'
chk "API: the library list finds the new drill as COMMUNITY (a contributed drill has no 'Genesis draft' source)" 200 ".total == 1 and .items[0].slug == \"$DRILL_SLUG\" and .items[0].status == \"COMMUNITY\" and .items[0].minutes == 12"
POOL_NEW=$(candidate_slugs 10 ball home_3x3)
jchk "planner: the new drill is a candidate for a 10-year-old with a ball at home (planner/candidates.ts over the stack's real DB)" "$POOL_NEW" 'index($s) != null' --arg s "$DRILL_SLUG"
jchk "planner: control, it is NOT offered to a player with no equipment (the drill needs a ball)" "$(candidate_slugs 10 nothing home_3x3)" 'index($s) == null and length > 0' --arg s "$DRILL_SLUG"
jchk "planner: control, it is NOT offered to a 7-year-old (the drill is for ages 8-14)" "$(candidate_slugs 7 ball home_3x3)" 'index($s) == null and length > 0' --arg s "$DRILL_SLUG"

# --- 9. an improvement of a Genesis drill: diff in the queue, approval makes 1.1.0 (parent 1.0.0) ----------------------------------
IMP_CID="" G_V2="$G_SLUG-v1.1.0"
SAFETY_LINE='Warm up your ankles for two minutes first.'
if [ -n "$COACH_COOKIE" ] && [ "$G_SLUG" != none ] && [ -n "$G_ITEM" ] && [ -n "$G_DETAIL0" ]; then
  IMP_PAYLOAD=$(jq -nc --argjson d "$G_DETAIL0" --argjson i "$G_ITEM" --arg a "$COACH_NAME" --arg line "$SAFETY_LINE" '
    def lines(k): [$d.content[k][]? | .en // empty] | join("\n");
    {kind: "improvement", targetDrillSlug: $i.slug, improvementKind: "safety", locale: "en", name: $d.content.title.en, sport: "football", skill: $i.track,
     ageMin: $i.ageMin, ageMax: $i.ageMax, level: $i.level, goal: "dribbling", instructions: $d.content.instructions.en, durationMin: $i.minutes, equipment: $i.equipment,
     mistakes: lines("mistakes"), progression: lines("progressions"), regression: lines("regressions"), safety: (lines("safety") + "\n" + $line),
     source: "Coach Kim academy notes", author: $a, rightsAttested: true, noCommercialContent: true}')
  post_contribution "$COACH_COOKIE" "$IMP_PAYLOAD"
  chk "coach (API; the web app has no suggest-improvement screen): POST /api/contributions kind improvement on '$G_SLUG' answers 201 pending" 201 '.state == "pending" and .payload.kind == "improvement"'
  IMP_CID=$(jq -r '.id // ""' <<<"$F_BODY")
fi
if [ -n "$IMP_CID" ]; then
  fetch "$ADMIN_COOKIE" GET '/api/admin/contributions?state=pending'
  chk "API: the queue's improvement row carries a field diff with the coach's new safety line, and lists no field that did not change" 200 \
    ".[] | select(.contribution.id == \"$IMP_CID\") | (.diff | length) > 0 and any(.diff[]; .field == \"safety.en\" and (.after | contains(\"$SAFETY_LINE\")) and ((.before // \"\") | contains(\"$SAFETY_LINE\") | not)) and all(.diff[]; .field | IN(\"safety.en\", \"source\", \"author\"))"
  if [ "$STEP5" = 1 ]; then
    use_browser admin
    pw_js "admin: the queue row of the improvement, and its inline review with 'What changes'" "{}" 'async (page) => {
        await page.goto(origin() + "/admin");
        await page.getByRole("heading", { name: "Review queue", level: 1 }).waitFor();
        await page.locator("main ul[aria-label=\"Contributions\"] > li").first().waitFor();
        const row = await page.locator("main ul[aria-label=\"Contributions\"] > li").first().innerText();
        await page.getByRole("button", { name: /^Review/ }).first().click();
        await page.getByText("What changes").first().waitFor();
        return JSON.stringify({ row: row.replace(/\s+/g, " ").trim(), text: await mainText() }); }' 25000 &&
      {
        jchk "admin: the queue row says Improvement, 'Improves: $G_SLUG', 'Change: Safety' and $COACH_NAME" "$PW_OUT" '.row | contains("Improvement") and contains("Improves: " + $g) and contains("Change: Safety") and contains("Sent by: " + $c)' --arg g "$G_SLUG" --arg c "$COACH_NAME"
        jchk "admin: the review shows 'What changes' with the new line after 'Before' / 'After'" "$PW_OUT" '.text | contains("What changes") and contains("Before") and contains("After") and contains($l)' --arg l "$SAFETY_LINE"
      }
    IDX=$(last_request_index)
    pw_js "admin: approve the improvement on its review screen" "$(jq -nc --arg id "$IMP_CID" '{id: $id}')" 'async (page, A) => {
        await page.goto(origin() + "/admin/contributions/" + A.id);
        await page.getByRole("heading", { level: 1 }).first().waitFor();
        await page.getByLabel("The content is original").waitFor();
        for (const l of ["The content is original", "It is safe for children", "No identifiable child"]) await page.getByLabel(l).check();
        await page.getByRole("button", { name: "Approve", exact: true }).click();
        await page.getByText("Approved. The method is now in the commons.").waitFor();
        return JSON.stringify({ link: await page.getByRole("link", { name: "Open the published drill" }).getAttribute("href") }); }' 30000 &&
      jchk "admin: the improvement is approved and links to /commons/$G_SLUG" "$PW_OUT" '.link == ("/commons/" + $g)' --arg g "$G_SLUG"
    CALLS=$(api_calls "$IDX")
    assert_eq "$(awk '$2 == "POST" || $2 == "PUT" || $2 == "PATCH" || $2 == "DELETE"' <<<"$CALLS" | wc -l | tr -d ' ')" 1 "admin: approving the improvement is ONE mutation call"
  else
    fetch "$ADMIN_COOKIE" POST "/api/admin/contributions/$IMP_CID/decision" '{"action":"approve"}'
    chk "admin (API, no browser): approving the improvement answers 200 with the improved drill" 200 '.drill.slug != null'
  fi
  GV=$(sqj "SELECT id, semver, parent_version_id, status, author_name, author_user_id, origin, change_summary FROM drill_versions WHERE drill_id = '$G_SLUG' ORDER BY semver")
  jchk "sqlite: '$G_SLUG' has two versions, 1.0.0 (seed, no parent) and 1.1.0 whose parent_version_id is the 1.0.0 version ($G_V1)" "$GV" \
    'length == 2 and .[0].semver == "1.0.0" and .[0].parent_version_id == null and .[0].origin == "seed" and .[1].semver == "1.1.0" and .[1].parent_version_id == $p and .[1].id == $v2 and .[0].id == $p' --arg p "$G_V1" --arg v2 "$G_V2"
  jchk "sqlite: version 1.1.0 is authored by the coach (user id), with a change summary; 1.0.0 keeps the Genesis author" "$GV" \
    '.[1].author_user_id == $c and .[1].author_name == $n and (.[1].change_summary | startswith("Improvement")) and .[0].author_name == "FIRST COACH Genesis"' --arg c "$COACH_ID" --arg n "$COACH_NAME"
  assert_eq "$(sq1 "SELECT current_version_id FROM drills WHERE slug = '$G_SLUG'")" "$G_V2" "sqlite: the drill's current version moved to 1.1.0"
  if [ "$(sq1 "SELECT content FROM drill_versions WHERE id = '$G_V1'")" = "$G_V1_CONTENT" ] && [ -n "$G_V1_CONTENT" ]; then pass "sqlite: version 1.0.0's content is byte-identical to before the improvement (immutable, still readable)"
  else fail "sqlite: version 1.0.0's content is byte-identical to before the improvement"; fi
  jchk "sqlite: a reviews row on 1.1.0 names the admin as reviewer; the improvement is approved with resulting drill '$G_SLUG'" \
    "$(sqj "SELECT (SELECT count(*) FROM reviews WHERE drill_version_id = '$G_V2' AND reviewer_user_id = '$ADMIN_ID' AND reviewer = '$ADMIN_NAME') AS r, (SELECT state || '|' || resulting_drill_id FROM contributions WHERE id = '$IMP_CID') AS c")" \
    '.[0].r == 1 and .[0].c == ("approved|" + $g)' --arg g "$G_SLUG"
  assert_eq "$(sqlite_count drills)" 61 "sqlite: an improvement adds a version, not a drill (still 61 drills)"
  fetch - GET "/api/commons/drills/$G_SLUG?locale=en"
  chk "API: the drill's history lists both versions 1.1.0 and 1.0.0; the current text has the coach's safety line and still has the Genesis kk/ru text" 200 \
    "(.history | map(.semver) | sort) == [\"1.0.0\", \"1.1.0\"] and .attribution.semver == \"1.1.0\" and (.content.safety | any(.en == \"$SAFETY_LINE\")) and (.content.title | has(\"kk\") and has(\"ru\") and has(\"en\"))"
  if [ "$BROWSER" = 1 ]; then
    use_browser coach
    pw_js "detail: $G_SLUG shows both versions in its Version history" "$(jq -nc --arg s "$G_SLUG" --arg n "$(jq -r '.content.title.en' <<<"$G_DETAIL0")" '{slug: $s, name: $n}')" 'async (page, A) => {
        await page.goto(origin() + "/commons/" + A.slug);
        await page.getByRole("heading", { name: A.name, exact: true, level: 1 }).waitFor();
        await page.waitForTimeout(500);
        const history = await page.locator("main section").evaluateAll((els) => { const s = els.find((x) => x.querySelector("h2") && x.querySelector("h2").innerText.trim() === "Version history"); return s ? [...s.querySelectorAll("li")].map((li) => li.innerText.replace(/\s+/g, " ").trim()) : []; });
        return JSON.stringify({ history, text: await mainText() }); }' 25000 &&
      jchk "detail: the page's Version history lists 1.1.0 (Current) and 1.0.0, and the text has the new safety line" "$PW_OUT" \
        '(.history | length) == 2 and (.history[0] | startswith("1.1.0 Current")) and (.history[1] | startswith("1.0.0")) and (.text | contains($l))' --arg l "$SAFETY_LINE"
  fi
else
  fail "an improvement contribution exists to approve" "  the coach or the Genesis drill was not available"
fi

# --- 10. the admin marks the drill EXPERT VERIFIED with an organisation label ---------------------------------------------------
BADGE_TEXT="Verified by $ORG"
if [ "$STEP5" = 1 ]; then
  use_browser admin
  IDX=$(last_request_index)
  pw_js "admin: /admin/drills, Change status: Academy verified without an organisation is refused, then Expert verified with '$ORG'" \
    "$(jq -nc --arg s "$DRILL_SLUG" --arg org "$ORG" --arg note 'Checked on the pitch by the academy coaches.' '{slug: $s, org: $org, note: $note}')" 'async (page, A) => {
      await page.goto(origin() + "/admin/drills");
      await page.getByRole("heading", { name: "Drills", exact: true, level: 1 }).waitFor();
      await page.locator("main ul[aria-label] > li").first().waitFor();
      const row = await findRow(A.slug);
      await row.getByRole("button", { name: "Change status", exact: true }).click();
      await row.getByRole("radio", { name: "Academy verified" }).check();
      await row.getByLabel("Reviewer note").fill(A.note);
      await row.getByRole("button", { name: "Save status" }).click();
      await row.getByText("Academy verified needs the name of the organisation.").waitFor();
      const refused = (await row.getByText("Academy verified needs the name of the organisation.").count()) === 1;
      await row.getByRole("radio", { name: "Expert verified" }).check();
      await row.getByLabel("Organisation").fill(A.org);
      await row.getByRole("button", { name: "Save status" }).click();
      await row.getByText("Status saved.").waitFor();
      return JSON.stringify({ refused, row: (await row.innerText()).replace(/\s+/g, " ").trim() }); }' 40000 &&
    {
      jchk "admin: Academy verified with no organisation shows 'Academy verified needs the name of the organisation.' (checked before any request)" "$PW_OUT" '.refused == true'
      jchk "admin: the row updates from the response: badge 'Verified by $ORG', 'Status saved.', Latest review (By $ADMIN_NAME, Community to Expert verified, Organisation: $ORG)" "$PW_OUT" \
        '.row | ascii_downcase | contains(($b | ascii_downcase)) and contains("status saved.") and contains("latest review") and contains("by " + ($a | ascii_downcase)) and contains("changed from community to expert verified") and contains("organisation: " + ($o | ascii_downcase))' --arg b "$BADGE_TEXT" --arg a "$ADMIN_NAME" --arg o "$ORG"
    }
  CALLS=$(api_calls "$IDX")
  assert_eq "$(awk '$2 == "POST"' <<<"$CALLS" | wc -l | tr -d ' ')" 1 "admin: the refused Academy attempt sent nothing; the whole status change is ONE POST"
  N=$(awk -v p="/api/admin/drills/$DRILL_SLUG/status" '$2 == "POST" && $3 == p && $4 == 200 { print $1 }' <<<"$CALLS" | head -n1)
  BODY=$([ -n "$N" ] && pw request-body "$N" | jq -r '.result // ""')
  jchk "admin: that call is POST /api/admin/drills/$DRILL_SLUG/status {toStatus: EXPERT_VERIFIED, orgLabel, note}" "${BODY:-null}" '.toStatus == "EXPERT_VERIFIED" and .orgLabel == $o and (.note | length) > 0' --arg o "$ORG"
else
  fetch "$ADMIN_COOKIE" POST "/api/admin/drills/$DRILL_SLUG/status" "$(jq -nc --arg o "$ORG" '{toStatus: "EXPERT_VERIFIED", orgLabel: $o, note: "Checked on the pitch by the academy coaches."}')"
  chk "admin (API, no browser): the status change answers 200" 200 '.reviews[0].to == "EXPERT_VERIFIED"'
fi
fetch "$ADMIN_COOKIE" POST "/api/admin/drills/$DRILL_SLUG/status" '{"toStatus":"ACADEMY_VERIFIED","note":"probe"}'
chk "API: ACADEMY_VERIFIED without an organisation label is 422 with the pointer /orgLabel" 422 '.errors | any(.pointer == "/orgLabel")'
fetch "$ADMIN_COOKIE" POST "/api/admin/drills/$DRILL_SLUG/status" '{"toStatus":"EXPERT_VERIFIED","note":"again"}'
chk "API: moving a drill to the status it already has is refused (422, pointer /toStatus)" 422 '.errors | any(.pointer == "/toStatus")'
fetch - GET "/api/commons/drills/$DRILL_SLUG?locale=en"
chk "API: the drill detail's reviews carry the new row: to EXPERT_VERIFIED, orgLabel '$ORG', reviewer '$ADMIN_NAME'" 200 \
  ".reviews | any(.to == \"EXPERT_VERIFIED\" and .from == \"COMMUNITY\" and .orgLabel == \"$ORG\" and .reviewer == \"$ADMIN_NAME\") and length == 2"
fetch - GET '/api/commons/drills?locale=en&status=EXPERT_VERIFIED'
chk "API: the library lists the drill as EXPERT_VERIFIED with orgLabel '$ORG' (the only one)" 200 ".total == 1 and .items[0].slug == \"$DRILL_SLUG\" and .items[0].status == \"EXPERT_VERIFIED\" and .items[0].orgLabel == \"$ORG\""
jchk "sqlite: the current version's status is EXPERT_VERIFIED and a reviews row records COMMUNITY -> EXPERT_VERIFIED, org '$ORG', by the admin's user id" \
  "$(sqj "SELECT (SELECT status FROM drill_versions WHERE id = '$V1') AS status, (SELECT count(*) FROM reviews WHERE drill_version_id = '$V1' AND from_status = 'COMMUNITY' AND to_status = 'EXPERT_VERIFIED' AND org_label = '$ORG' AND reviewer_user_id = '$ADMIN_ID') AS r")" \
  '.[0].status == "EXPERT_VERIFIED" and .[0].r == 1'
if [ "$BROWSER" = 1 ]; then
  use_browser coach
  pw_js "library: the card and the detail page show the organisation's badge" "$(jq -nc --arg q 'Zigzag Gate' --arg s "$DRILL_SLUG" --arg n "$DRILL_NAME" '{q: $q, slug: $s, name: $n}')" 'async (page, A) => {
      await page.goto(origin() + "/commons?q=" + encodeURIComponent(A.q));
      await page.waitForFunction(() => /Showing 1 of 1/.test((document.querySelector("main p[aria-live]") || {}).innerText || ""), null, { timeout: 15000 });
      const card = await page.locator("main ul[aria-label] > li").evaluateAll((els) => els.map((li) => { const b = li.querySelector("[data-status]:not(a)"); return { badge: b ? b.innerText.trim() : null, status: b ? b.getAttribute("data-status") : null }; }));
      await page.goto(origin() + "/commons/" + A.slug);
      await page.getByRole("heading", { name: A.name, exact: true, level: 1 }).waitFor();
      await page.waitForTimeout(500);
      const badges = await page.locator("main [data-status]:not(a)").evaluateAll((els) => els.map((e) => e.innerText.trim()));
      return JSON.stringify({ card, badges, text: await mainText() }); }' 30000 &&
    {
      jchk "library: the card's badge reads '$BADGE_TEXT' (EXPERT_VERIFIED)" "$PW_OUT" '.card | length == 1 and .[0].badge == $b and .[0].status == "EXPERT_VERIFIED"' --arg b "$BADGE_TEXT"
      jchk "detail: the drill's badge reads '$BADGE_TEXT', and its review list shows $ORG" "$PW_OUT" '.badges[0] == $b and (.text | contains("Who checked this drill") and contains($o))' --arg b "$BADGE_TEXT" --arg o "$ORG"
    }
fi

# --- 11. unpublish: gone from the library and from new sessions; the downloaded session still works ----------------------------
U_REASON='Rights complaint from the original author.'
if [ -n "$X_SLUG" ]; then
  X_VERSIONS0=$(sqlite_count drill_versions "drill_id = '$X_SLUG'")
  if [ "$STEP5" = 1 ]; then
    use_browser admin
    IDX=$(last_request_index)
    pw_js "admin: Unpublish '$X_TITLE' behind a confirm dialog that needs a reason" "$(jq -nc --arg s "$X_SLUG" --arg r "$U_REASON" '{slug: $s, reason: $r}')" 'async (page, A) => {
        await page.goto(origin() + "/admin/drills");
        await page.getByRole("heading", { name: "Drills", exact: true, level: 1 }).waitFor();
        await page.locator("main ul[aria-label] > li").first().waitFor();
        const row = await findRow(A.slug);
        await row.getByRole("button", { name: "Unpublish", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        const dialogText = norm(await dialog.innerText());
        await dialog.getByRole("button", { name: "Unpublish drill", exact: true }).click();
        await dialog.getByText("Write a reason to unpublish.").waitFor();
        await dialog.getByLabel("Reason").fill(A.reason);
        await dialog.getByRole("button", { name: "Unpublish drill", exact: true }).click();
        await page.getByText("was unpublished. Reason: " + A.reason).waitFor();
        const gone = (await page.locator("main a[href=\"/commons/" + A.slug + "\"]").count()) === 0;
        return JSON.stringify({ dialogText, gone, notice: await page.locator("main ul[role=list]").first().innerText() }); }' 40000 &&
      {
        jchk "admin: the confirm dialog says the drill leaves the library at once and its media stop being public; an empty reason shows 'Write a reason to unpublish.'" "$PW_OUT" \
          '.dialogText | contains("Unpublish") and contains("leaves the library for everyone right away") and contains("Reason")'
        jchk "admin: after confirming, the drill's row is gone from the list and a notice says '<title> was unpublished. Reason: ...'" "$PW_OUT" '.gone == true and (.notice | contains("was unpublished. Reason: " + $r))' --arg r "$U_REASON"
      }
    CALLS=$(api_calls "$IDX")
    assert_eq "$(awk '$2 == "POST"' <<<"$CALLS" | wc -l | tr -d ' ')" 1 "admin: the empty-reason attempt sent nothing; the takedown is ONE POST /api/admin/drills/$X_SLUG/unpublish"
  else
    fetch "$ADMIN_COOKIE" POST "/api/admin/drills/$X_SLUG/unpublish" "$(jq -nc --arg r "$U_REASON" '{reason: $r}')"
    chk "admin (API, no browser): the unpublish answers 200" 200 '.slug != null'
  fi
  fetch "$ADMIN_COOKIE" POST "/api/admin/drills/$G_SLUG/unpublish" '{"reason":"   "}'
  chk "API: unpublishing needs a non-blank reason (422)" 422 '.errors | any(.pointer == "/reason")'
  jchk "sqlite: X is unpublished (unpublished_at set), its versions are all kept, and a reviews row keeps the reason" \
    "$(sqj "SELECT (SELECT unpublished_at IS NOT NULL FROM drills WHERE slug = '$X_SLUG') AS off, (SELECT count(*) FROM drill_versions WHERE drill_id = '$X_SLUG') AS versions, (SELECT count(*) FROM reviews WHERE drill_version_id = '$X_VID' AND note = '$U_REASON' AND reviewer_user_id = '$ADMIN_ID') AS r")" \
    ".[0].off == 1 and .[0].versions == $X_VERSIONS0 and .[0].r == 1"
  assert_eq "$(sqlite_count drills 'unpublished_at IS NULL AND current_version_id IS NOT NULL')" 60 "sqlite: 60 published drills (61 - the unpublished one)"
  assert_eq "$(curl -s -o /dev/null -w '%{http_code}' --max-time "$E2E_HTTP_TIMEOUT" "$API_URL/api/commons/drills/$X_SLUG?locale=en")" 404 "API: GET /api/commons/drills/$X_SLUG is 404 (unpublished)"
  fetch - GET '/api/commons/drills?locale=en&limit=100'
  chk "API: the library list has 60 drills and X is not among them" 200 ".total == 60 and (.items | length) == 60 and ([.items[].slug] | index(\"$X_SLUG\")) == null"
  jchk "planner: X is no longer a candidate for the player's profile (before: in the pool), and the pool is not empty" "$(candidate_slugs 12 ball_wall yard)" 'index($x) == null and length > 0' --arg x "$X_SLUG"
  if [ "$BROWSER" = 1 ]; then
    use_browser coach
    pw_js "library: the visitor loads every page of /commons" "$(jq -nc --arg s "$X_SLUG" '{slug: $s}')" 'async (page, A) => {
        await page.goto(origin() + "/commons");
        await page.getByRole("heading", { name: "Sport knowledge as public infrastructure", level: 1 }).waitFor();
        await page.locator("main ul[aria-label] > li").first().waitFor();
        for (let i = 0; i < 8; i++) {
          const more = page.getByRole("button", { name: "Show more drills", exact: true });
          if ((await more.count()) === 0) break;
          const have = await page.locator("main ul[aria-label] > li").count();
          await more.click();
          await page.waitForFunction((n) => document.querySelectorAll("main ul[aria-label] > li").length > n, have, { timeout: 10000 }).catch(() => {});
        }
        const hrefs = await page.locator("main ul[aria-label] > li a").evaluateAll((els) => els.map((a) => a.getAttribute("href")));
        await page.goto(origin() + "/commons/" + A.slug);
        await page.getByText("We could not find this drill").waitFor();
        return JSON.stringify({ hrefs, summary: null, detail: await mainText() }); }' 60000 &&
      {
        jchk "library: 60 different drill cards once every page is loaded, and X is not one of them" "$PW_OUT" '(.hrefs | unique | length) == 60 and (.hrefs | index("/commons/" + $s)) == null' --arg s "$X_SLUG"
        jchk "detail: /commons/$X_SLUG now shows 'We could not find this drill'" "$PW_OUT" '.detail | contains("We could not find this drill")'
      }
  fi
  # a NEW player gets a session from the current pool: X is not in it
  anon_player "new player R (after the takedown)" skipped
  fetch "$V_COOKIE" GET '/api/player/today?locale=en'
  chk "new player R: today's session is composed from the pool without X ($X_VID is not in it)" 200 "(.items | length) >= 2 and ([.items[].drillVersionId] | index(\"$X_VID\")) == null"
  # the ALREADY-DOWNLOADED session of the first player still works
  if [ -n "$PLAYER_COOKIE" ]; then
    fetch "$PLAYER_COOKIE" GET '/api/player/today?locale=en'
    assert_eq "$F_CODE" 200 "player: GET /api/player/today after the takedown answers 200"
    jchk "player: the stored session is unchanged: same id, still $ND drills, X still in it with its full content" "$F_BODY" \
      '.id == $sid and (.items | length) == ($n | tonumber) and .items[0].drillVersionId == $v and .items[0].content.title.en == $t and (.items[0].content.instructions.en | length) > 0' --arg sid "$SESSION_ID" --arg n "$ND" --arg v "$X_VID" --arg t "$X_TITLE"
    ITEM_ID=$(jq -r '.items[0].itemId' <<<"$F_BODY")
    PHRASES=$(jq -c '[.items[0].content | (.title.en // empty), (.goal.en // empty), ((.instructions.en // "") | split("\n")[] | sub("^[0-9]+\\. *"; "") | select(length > 0)), ((.safety // [])[] | .en // empty)]' <<<"$F_BODY")
    if [ "$BROWSER" = 1 ]; then
      use_browser player
      pw_js "player: after the takedown /train and the drill player of X still work (online), and Done is accepted by the server" "$(jq -nc --arg id "$ITEM_ID" --arg t "$X_TITLE" --argjson p "$PHRASES" --argjson n "$ND" '{itemId: $id, title: $t, phrases: $p, n: $n}')" 'async (page, A) => {
          const missing = (text, phrases) => phrases.filter((p) => !norm(text).includes(norm(p)));
          await page.goto(origin() + "/train");
          await page.locator("main ol > li").first().waitFor();
          await page.getByText("Available offline").first().waitFor();
          const train = { rows: await page.locator("main ol > li").count(), text: await mainText() };
          await page.goto(origin() + "/train/drill/" + A.itemId);
          await page.getByText(A.title).first().waitFor();
          const drill = await mainText();
          await page.getByRole("button", { name: "Done", exact: true }).click();
          await page.getByRole("button", { name: "Undo" }).waitFor();
          return JSON.stringify({ rows: train.rows, listed: train.text.includes(A.title), badge: train.text.includes("Available offline"), missing: missing(drill, A.phrases) }); }' 40000 &&
        jchk "player: /train still lists all $ND drills including '$X_TITLE' ('Available offline'), and the drill player of X shows ALL of its text" "$PW_OUT" ".rows == $ND and .listed == true and .badge == true and (.missing | length) == 0"
      W=0; until [ "$(sqlite_count session_events "session_id = '$SESSION_ID' AND item_id = '$ITEM_ID' AND type = 'drill_done'")" = 1 ] || [ "$W" -ge 30 ]; do sleep 0.3; W=$((W + 1)); done
      assert_eq "$(sqlite_count session_events "session_id = '$SESSION_ID' AND item_id = '$ITEM_ID' AND type = 'drill_done'")" 1 "player: pressing Done on the unpublished drill X is accepted and stored by the server (one drill_done event)"
      pw_js "player: with the browser OFFLINE, /train and the drill player of X still render from the device copy" "$(jq -nc --arg id "$ITEM_ID" --arg t "$X_TITLE" --argjson p "$PHRASES" --argjson n "$ND" '{itemId: $id, title: $t, phrases: $p, n: $n}')" 'async (page, A) => {
          const missing = (text, phrases) => phrases.filter((p) => !norm(text).includes(norm(p)));
          await goOffline();
          let train, drill;
          try {
            await page.goto(origin() + "/train");
            await page.locator("main ol > li").first().waitFor();
            train = { rows: await page.locator("main ol > li").count(), text: await mainText() };
            await page.goto(origin() + "/train/drill/" + A.itemId);
            await page.getByText(A.title).first().waitFor();
            drill = await mainText();
          } finally { await goOnline(); }
          return JSON.stringify({ rows: train.rows, listed: train.text.includes(A.title), missing: missing(drill, A.phrases) }); }' 50000 &&
        jchk "player: offline, /train lists all $ND drills including X, and the drill player of X shows all its text" "$PW_OUT" ".rows == $ND and .listed == true and (.missing | length) == 0"
    fi
  fi
else
  fail "a drill from the player's downloaded session (X) exists to be unpublished" "  the player step did not run (no browser?)"
fi

# --- 12. the impact page: its numbers are the sqlite counts ------------------------------------------------------------------------
# One more player, Q: the baseline, a FINISHED session (every drill done) and a retest that improves three tests (juggling 15 -> 30 and
# ball mastery 40 -> 50, both higher-is-better; slalom 30 s -> 24 s, lower is better): +100 %, +25 %, +20 % -> median +25 %.
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
if anon_player "impact player Q" measured; then
  QC=$V_COOKIE
  fetch "$QC" GET '/api/player/today?locale=en'
  QSID=$(jq -r '.id' <<<"$F_BODY")
  EVENTS='['
  for iid in $(jq -r '.items[].itemId' <<<"$F_BODY"); do EVENTS+="{\"clientUuid\":\"$(uuid)\",\"sessionId\":\"$QSID\",\"type\":\"drill_done\",\"itemId\":\"$iid\",\"at\":\"$NOW_ISO\"},"; done
  EVENTS+="{\"clientUuid\":\"$(uuid)\",\"sessionId\":\"$QSID\",\"type\":\"session_finished\",\"at\":\"$NOW_ISO\"}]"
  fetch "$QC" POST /api/player/session-events "{\"events\":$EVENTS}"
  chk "impact player Q: every drill done and the session finished (one POST /api/player/session-events)" 200 '.progress.sessionsCompleted == 1'
  fetch "$QC" POST /api/player/test-results "$(jq -nc --arg a "$(uuid)" --arg b "$(uuid)" --arg c "$(uuid)" '{results: [
    {testSlug: "juggling-max-touches", value: 30, clientUuid: $a}, {testSlug: "ball-mastery-30s", value: 50, clientUuid: $b}, {testSlug: "slalom-time", value: 24, clientUuid: $c}]}')"
  chk "impact player Q: the retest batch (3 tests) is stored" 200 '.journey != null'
fi
# the expectations: independent SQL over the same file (the spec's definitions), and the median computed from the raw results with jq
SQL_MIN=$(cat <<'SQL'
SELECT coalesce(sum(json_extract(i.value, '$.minutes')), 0) FROM sessions s, json_each(s.items) i WHERE s.finished_at IS NOT NULL AND json_extract(i.value, '$.done') = 1
SQL
)
E_BASE=$(sq1 "SELECT count(DISTINCT player_id) FROM test_results WHERE skipped = 0")
E_RET=$(sq1 "SELECT count(DISTINCT player_id) FROM (SELECT player_id, test_slug FROM test_results WHERE skipped = 0 GROUP BY player_id, test_slug HAVING count(*) >= 2)")
E_SESS=$(sq1 "SELECT count(*) FROM sessions WHERE finished_at IS NOT NULL")
E_MIN=$(sq1 "$SQL_MIN")
E_HOURS=$(jq -nr --argjson m "${E_MIN:-0}" '((($m / 60) * 10) | round) / 10 | tostring')
E_CONTRIB=$(sq1 "SELECT count(DISTINCT submitter_user_id) FROM contributions WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')")
E_COACHES=$(sq1 "SELECT count(DISTINCT coalesce(reviewer_user_id, reviewer)) FROM reviews WHERE to_status IN ('REVIEWED', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED')")
E_METH=$(sq1 "SELECT count(*) FROM drills WHERE unpublished_at IS NULL AND current_version_id IS NOT NULL")
RESULTS=$(sqj "SELECT r.player_id, r.test_slug, r.value, t.direction FROM test_results r LEFT JOIN skill_tests t ON t.slug = r.test_slug WHERE r.skipped = 0 ORDER BY r.player_id, r.test_slug, r.recorded_at, r.id")
E_MEDIAN=$(jq '[group_by([.player_id, .test_slug])[] | select(length >= 2) | {f: .[0].value, l: .[-1].value, d: .[0].direction} | select(.f != 0 and .d != null)
    | ((if .d == "higher" then (.l - .f) else (.f - .l) end) / (.f | fabs)) * 100] | sort
    | if length == 0 then 0 elif length % 2 == 1 then .[(length / 2) | floor] else (.[length / 2 - 1] + .[length / 2]) / 2 end' <<<"${RESULTS:-[]}")
E_HEAD=$(jq -nr --argjson m "${E_MEDIAN:-0}" '((($m * 10) | round) / 10) as $p | if $p > 0 then "+\($p)%" elif $p < 0 then "−\($p * -1)%" else "\($p)%" end')
echo "NOTE     expected from sqlite: baseline $E_BASE, retested $E_RET, sessions $E_SESS, hours $E_HOURS ($E_MIN min), contributors $E_CONTRIB, verified coaches $E_COACHES, methodologies $E_METH, median improvement $E_MEDIAN% (headline $E_HEAD)"
assert_eq "$E_RET-$E_SESS-$E_MEDIAN-$E_CONTRIB-$E_COACHES-$E_METH" "1-1-25-1-1-60" "impact data: the journey left exactly 1 retested player, 1 finished session, a +25 median, 1 contributor, 1 verified coach (the admin), 60 methodologies"
fetch "$ADMIN_COOKIE" GET /api/admin/impact
chk "API: GET /api/admin/impact equals the sqlite counts (baseline, retested, sessions, hours, contributors, verified coaches, methodologies, median) and its byWeek series has 12 weeks" 200 \
  ".playersWithBaseline == $E_BASE and .playersRetested == $E_RET and .sessionsCompleted == $E_SESS and (.trainingHours - $E_MIN / 60 | fabs) < 0.001 and .activeContributors == $E_CONTRIB and .verifiedCoaches == $E_COACHES and .openMethodologies == $E_METH and (.medianImprovementPct - $E_MEDIAN | fabs) < 0.01 and (.byWeek | length) == 12 and ([.byWeek[].sessionsCompleted] | add) == $E_SESS"
if [ "$STEP5" = 1 ]; then
  use_browser admin
  pw_js "admin: /admin/impact" "{}" 'async (page) => {
      await page.goto(origin() + "/admin/impact");
      await page.getByRole("heading", { name: "Are people getting better?", level: 1 }).waitFor();
      const head = page.getByRole("region", { name: "Median improvement" });
      await head.waitFor();
      const cards = await page.locator("main dl").evaluateAll((dls) => dls.flatMap((dl) => [...dl.children].map((c) => [c.querySelector("dt").innerText.trim(), c.querySelector("dd").innerText.trim()])));
      const weeks = await page.locator("ol[aria-labelledby=impact-weeks] > li").evaluateAll((els) => els.map((li) => li.innerText.replace(/\s+/g, " ").trim()));
      return JSON.stringify({ headline: norm(await head.innerText()), cards: Object.fromEntries(cards), weeks }); }' 25000 &&
    {
      jchk "impact page: the cards show the sqlite counts (baseline $E_BASE, retested $E_RET, sessions $E_SESS, hours $E_HOURS, contributors $E_CONTRIB, verified coaches $E_COACHES, methodologies $E_METH)" "$PW_OUT" \
        '.cards["Players with a baseline"] == $b and .cards["Players who retested"] == $r and .cards["Sessions completed"] == $s and .cards["Training hours"] == $h and .cards["Active contributors"] == $c and .cards["Verified coaches"] == $v and .cards["Open methodologies"] == $m' \
        --arg b "$E_BASE" --arg r "$E_RET" --arg s "$E_SESS" --arg h "$E_HOURS" --arg c "$E_CONTRIB" --arg v "$E_COACHES" --arg m "$E_METH"
      jchk "impact page: the headline is the median improvement $E_HEAD computed from the raw test results, with 'Players who retested: $E_RET'" "$PW_OUT" '.headline | contains($h) and contains("Players who retested: " + $r)' --arg h "$E_HEAD" --arg r "$E_RET"
      jchk "impact page: the weekly series is a CSS bar list of 12 weeks whose last (this) week shows $E_SESS session(s)" "$PW_OUT" '(.weeks | length) == 12 and (.weeks[-1] | endswith(" " + $s))' --arg s "$E_SESS"
    }
fi

# --- 13. settings: the under-10 minimum status persists across a reload, and the planner sees it at once -------------------------
SEED_PROBE=ball-mastery-foundation-touches
POOL_S_BEFORE=$(candidate_slugs 8 ball home_3x3)
jchk "planner (before): for an 8-year-old the pool holds the COMMUNITY seed drill $SEED_PROBE and the EXPERT_VERIFIED new drill" "$POOL_S_BEFORE" 'index($a) != null and index($b) != null' --arg a "$SEED_PROBE" --arg b "$DRILL_SLUG"
fetch "$ADMIN_COOKIE" GET /api/admin/settings
SETTINGS0=$F_BODY
chk "API: GET /api/admin/settings starts with every age band at COMMUNITY" 200 '.minStatusByAgeBand == {"u10": "COMMUNITY", "u14": "COMMUNITY", "adult": "COMMUNITY"}'
if [ "$STEP5" = 1 ]; then
  use_browser admin
  pw_js "admin: /admin/settings, raise 'Under 10' to Reviewed, save, reload" "{}" 'async (page) => {
      await page.goto(origin() + "/admin/settings");
      await page.getByRole("heading", { name: "Settings", exact: true, level: 1 }).waitFor();
      const under10 = page.getByLabel("Under 10", { exact: true });
      await under10.waitFor();
      const shown = async () => ({ u10: await page.getByLabel("Under 10", { exact: true }).evaluate((s) => s.options[s.selectedIndex].text), u14: await page.getByLabel("Ages 10 to 13", { exact: true }).evaluate((s) => s.options[s.selectedIndex].text), adult: await page.getByLabel("Age 14 and older", { exact: true }).evaluate((s) => s.options[s.selectedIndex].text) });
      const before = await shown();
      await under10.selectOption("REVIEWED");
      await page.getByText("Under 10: too few drills").waitFor();
      const warning = await page.getByText("Under 10: too few drills").locator("xpath=..").innerText();
      await page.getByRole("button", { name: "Save settings" }).click();
      await page.getByText("Settings saved. They apply right away.").waitFor();
      await page.reload();
      await page.getByRole("heading", { name: "Settings", exact: true, level: 1 }).waitFor();
      await page.getByLabel("Under 10", { exact: true }).waitFor();
      const after = await shown();
      return JSON.stringify({ before, warning: norm(warning), after, clean: (await mainText()).includes("No changes yet.") }); }' 40000 &&
    {
      jchk "settings: the screen starts at Community for every age band; raising Under 10 to Reviewed warns 'fewer than 20 drills'" "$PW_OUT" \
        '.before == {"u10": "Community", "u14": "Community", "adult": "Community"} and (.warning | contains("Under 10: too few drills") and contains("fewer than 20 drills"))'
      jchk "settings: after Save and a page RELOAD, Under 10 is still Reviewed, the other bands are unchanged, and there is nothing unsaved" "$PW_OUT" \
        '.after == {"u10": "Reviewed", "u14": "Community", "adult": "Community"} and .clean == true'
    }
else
  fetch "$ADMIN_COOKIE" PUT /api/admin/settings '{"minStatusByAgeBand":{"u10":"REVIEWED"}}'
  chk "admin (API, no browser): PUT settings answers 200" 200 '.minStatusByAgeBand.u10 == "REVIEWED"'
fi
fetch "$ADMIN_COOKIE" GET /api/admin/settings
chk "API: GET /api/admin/settings now says u10 REVIEWED (u14 and adult COMMUNITY); the other settings are untouched" 200 \
  ".minStatusByAgeBand == {\"u10\": \"REVIEWED\", \"u14\": \"COMMUNITY\", \"adult\": \"COMMUNITY\"} and (del(.minStatusByAgeBand) == ($SETTINGS0 | del(.minStatusByAgeBand)))"
jchk "sqlite: the settings table holds minStatusByAgeBand with u10 REVIEWED" "$(sqj "SELECT value FROM settings WHERE key = 'minStatusByAgeBand'")" '(length == 1) and (.[0].value | fromjson | .u10 == "REVIEWED" and .u14 == "COMMUNITY")'
POOL_S_AFTER=$(candidate_slugs 8 ball home_3x3)
jchk "planner (after, no restart): for an 8-year-old the COMMUNITY seed drill $SEED_PROBE is gone, the EXPERT_VERIFIED new drill stays" "$POOL_S_AFTER" 'index($a) == null and index($b) != null' --arg a "$SEED_PROBE" --arg b "$DRILL_SLUG"
jchk "planner: a 12-year-old (band u14, still Community) keeps the seed drill $SEED_PROBE" "$(candidate_slugs 12 ball home_3x3)" 'index($a) != null' --arg a "$SEED_PROBE"

# --- 14. Kazakh and Russian on the admin screens ---------------------------------------------------------------------------------
if [ "$STEP5" = 1 ]; then
  ADMIN_MSG=$(bun -e '
    const dir = process.argv[1] + "/apps/web/src/features/admin/";
    const load = async (f) => (await import(dir + f)).default;
    console.log(JSON.stringify({ layout: await load("admin-layout.messages.ts"), queue: await load("queue.messages.ts"), drills: await load("drills.messages.ts"), impact: await load("impact.messages.ts"), settings: await load("settings.messages.ts") }));
  ' "$E2E_REPO_ROOT" 2>"$scratch/msg.err") || ADMIN_MSG=""
  if jq -e '.queue.kk.title and .queue.ru.title and .drills.kk.title and .impact.ru.title and .settings.kk.title and .layout.ru.reviewQueue' >/dev/null 2>&1 <<<"${ADMIN_MSG:-null}"; then pass "the kk/ru/en messages bundles of the admin screens load"
  else fail "the kk/ru/en messages bundles of the admin screens load" "$(head -c 400 "$scratch/msg.err")"; ADMIN_MSG=null; fi
  use_browser admin
  for lc in kk ru; do
    LARGS=$(jq -nc --arg lc "$lc" --argjson m "${ADMIN_MSG:-null}" '{lc: $lc, checks: [
      {path: "/admin", h1: $m.queue[$lc].title}, {path: "/admin/drills", h1: $m.drills[$lc].title}, {path: "/admin/impact", h1: $m.impact[$lc].title}, {path: "/admin/settings", h1: $m.settings[$lc].title}]}')
    pw_js "admin ($lc): the four admin screens" "$LARGS" 'async (page, A) => {
        await page.goto(origin() + "/admin");
        await page.locator("button[lang=\"" + A.lc + "\"]").click();
        const out = [];
        for (const c of A.checks) {
          await page.goto(origin() + c.path);
          await page.waitForFunction((h) => { const e = document.querySelector("main h1"); return e && e.innerText.trim() === h; }, c.h1, { timeout: 15000 }).catch(() => {});
          out.push({ path: c.path, h1: ((await page.locator("main h1").first().innerText().catch(() => "")) || "").trim(), body: await page.locator("body").innerText() });
        }
        return JSON.stringify({ lang: await page.evaluate(() => document.documentElement.lang), nav: await page.getByRole("navigation").allInnerTexts(), out }); }' 90000 &&
      {
        jchk "admin ($lc): <html lang> follows the switch, each screen's heading is the messages bundle's title ($(jq -r ".queue.$lc.title" <<<"$ADMIN_MSG"), ...), and no page shows 'undefined'" "$PW_OUT" \
          ".lang == \$lc and all(.out[]; .h1 != \"\") and ([.out[] | .h1] == [\$m.queue[\$lc].title, \$m.drills[\$lc].title, \$m.impact[\$lc].title, \$m.settings[\$lc].title]) and all(.out[]; .body | contains(\"undefined\") | not)" --arg lc "$lc" --argjson m "${ADMIN_MSG:-null}"
        jchk "admin ($lc): the admin sub-navigation is in $lc (Review queue, Drills, Impact, Settings words of the bundle)" "$PW_OUT" \
          '(.nav | join(" ")) | contains($m.layout[$lc].reviewQueue) and contains($m.layout[$lc].drills) and contains($m.layout[$lc].impact) and contains($m.layout[$lc].settings)' --arg lc "$lc" --argjson m "${ADMIN_MSG:-null}"
      }
  done
  pw_js "admin: back to English" "{}" 'async (page) => { await page.locator("button[lang=\"en\"]").click(); return "ok"; }' >/dev/null
fi

# no explicit stop or summary: the EXIT handler stops the stack, prints the summary and sets the exit code
