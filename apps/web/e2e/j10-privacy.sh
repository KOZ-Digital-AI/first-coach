#!/usr/bin/env bash
# apps/web/e2e/j10-privacy.sh: slice gate fc-mol-b96, journey J10 "the player controls their data and privacy".
# Integration proof on the REAL stack (real API process, real SQLite file with the real seed, the real built web app served by
# the API, a real browser; nothing mocked, no OpenAI key needed). One player's whole privacy journey, UI -> API -> DB:
#   0. SETUP    a second visitor (API) onboards, turns a consent on and makes a recovery code of its own, so "nothing about other
#               players" and "the restore moves only this player's rows" are real checks.
#   A. PLAYER   browser A: an onboarded player (age 12) with ONE finished session (wizard, every drill Done, Finish session).
#               The roadmap text and the journey numbers are captured for the later comparison.
#   B. PRIVACY  /settings/privacy: both consents are OFF by default (switches, words, GET /api/player/consents, no consents row);
#               the recovery panel makes a code with ONE button (POST /api/player/recovery-code), shows it once in four groups of
#               four, and "I wrote it down" removes it; the code is in no browser storage, no URL and no DB column in clear text.
#               The player turns Model improvement on (PUT /api/player/consents) so the export has a consents row.
#   C. LEGAL    /legal/privacy and /legal/terms render in kk, ru and en (h1 and every section heading of the message bundles).
#   D. NO SOCIAL  /u/x, /feed, /messages, /leaderboard are the app's 404 page (and /api/... of the same names are 404 problems).
#   E. RESTORE  browser B = a NEW playwright-cli session (clean profile, no cookie, no storage): the footer link "Restore my
#               progress", the code typed in small letters with spaces, lands on /train; the roadmap text, the journey numbers,
#               the roadmap row and the consent are the same as in A; the old session (A) no longer owns the data: GET
#               /api/player/me is 404 for it and no table with a player_id column holds a row of the old player id.
#   F. DOWNLOAD  browser B: "Download my data" saves first-coach-export-<date>.json with the profile, test results, sessions,
#               events and consents of THIS player, row counts equal to the DB, and nothing of the other visitor.
#   G. DELETE   browser B: "Delete my data" needs the typed word DELETE; after it the DB (sqlite_master introspection: every table
#               with a player_id column) holds ZERO rows of the player id, the user and its sessions are gone, and the app is on
#               the landing page as a fresh visitor (no session cookie, no fc:<player> storage, /api/player/me is 401).
#   H. NETWORK  every request of both browser contexts (a Playwright context 'request' listener, installed before the first
#               navigation of each browser and read before each closes: the pages, scripts, fonts, images, service worker and API
#               calls of all pages this script visited) goes to the stack's own origin: no analytics, no ads, no external fonts;
#               the built index.html and CSS name no foreign origin either.
#   I. API      adversarial checks the UI cannot make: no cookie is 401 on export, delete, consents and recover; export ignores a
#               ?playerId= of another player; a wrong recovery code is one generic 422 (no field errors, no hint); the under-13
#               rule of the consents (age 9: video analysis without guardianConfirmed is 422, with it 200; revoking is 200).
# Exit codes (lib.sh): 0 every check passed, 1 at least one FAIL, 3 nothing failed but a check was BLOCKED (no browser,
# E2E_WEB=off, no playwright-cli); E2E_ALLOW_BLOCKED=1 keeps a blocked-only run at 0. BLOCKED is never counted as a pass.
#
# Readings of the criteria where they are open (each is one line of the script):
#   * "the script asserts 404 for /u/x, /feed, /messages, /leaderboard": the API serves the SPA shell for every extension-less
#     path (http/static.ts, by design, tested in static.test.ts), so the HTTP status of the document is 200 and the 404 is the
#     APP's: the router has no such route and renders its localized 404 page ("We can't find that page", as j0-landing.sh asserts
#     for an unknown URL). The document status is printed as a NOTE, not asserted; the same four names under /api are asserted
#     as real HTTP 404 problems. No link to any of them is on the pages visited.
#   * "'Download my data' saves JSON": the browser's download event is captured (file name and content); the file is what the
#     button saved. "events" are the session_events rows, "sessions" the sessions rows, "test results" the test_results rows.
#   * "in a fresh browser profile": a second playwright-cli session (in-memory profile), asserted to start with no cookie and no
#     localStorage key of the first one.
#   * "the old session no longer owns the data": the old browser session's GET /api/player/me is a 404 and, by introspection, no
#     table with a player_id column holds a row of the old id. The consent and the roadmap row moved to the new owner.
#   * "the network log contains no request to a third-party origin": every http(s)/ws(s) request URL of both browser contexts must
#     have the origin of STACK_URL; data:/blob:/about: URLs are not network requests. The script asserts the log is not empty
#     (a listener that saw nothing would pass vacuously).
#   * "Delete my data leaves zero rows in every table that has a player_id column": the table list comes from sqlite_master and
#     pragma_table_info at check time; before the delete at least 5 of those tables held rows of the player (not vacuous).
#   * The Privacy settings page has no link to it anywhere in the app (shell, footer, roadmap, policy): the script opens it by
#     URL, as the plan-settings gate does. Printed as a NOTE.
# Fail-slow (no set -e): every step reports. Cleanup: e2e_defer (never `trap ... EXIT` after sourcing lib.sh).
# Ports: the API gets a free kernel-assigned port (lib.sh start_stack); nothing is ever bound to :4111 or :5173 and no process
# this script did not start is touched. The two browser sessions are named after E2E_SESSION (unique per run) and closed at exit.
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$HERE/lib.sh"

NBSP=$(printf '\xc2\xa0')   # innerText renders the spaces inside "4 weeks" etc. as no-break spaces
SPORT=football
unset SEED_DIR   # the API must start on the repo's default seed
EN_NOT_FOUND='We can'"'"'t find that page'
SESS_A=$E2E_SESSION            # the player's browser
SESS_B="$E2E_SESSION-fresh"    # the fresh browser profile
WEB_DIR="$(cd -- "$HERE/.." && pwd -P)"

scratch=$(mktemp -d "${TMPDIR:-/tmp}/j10-gate.XXXXXX") || exit 1
e2e_defer 'rm -rf -- "$scratch"'
# Both browser sessions are closed here (lib.sh only closes the one named in E2E_SESSION when it exits).
close_browsers() { local s; for s in "$SESS_B" "$SESS_A"; do E2E_SESSION=$s pw close >/dev/null 2>&1 || true; done; E2E_SESSION=$SESS_A; }
e2e_defer 'close_browsers'
use_browser() { if [ "$1" = B ]; then E2E_SESSION=$SESS_B; else E2E_SESSION=$SESS_A; fi; }

# --- small helpers (the house helpers of j4-progress.sh) -------------------------------------------------------------------
fetch() { # <cookie | -> <METHOD> <path> [json body]: one request to the real API; sets F_CODE, F_BODY, F_HDRS (main shell)
  local cookie=$1 method=$2 path=$3 data=${4-} args
  args=(-s --max-time "$E2E_HTTP_TIMEOUT" -X "$method" -D "$scratch/f.hdr" -o "$scratch/f.body" -w '%{http_code}')
  args+=(-H "Origin: $API_URL")
  [ "$cookie" = - ] || args+=(-H "Cookie: $cookie")
  [ -z "$data" ] || args+=(-H 'content-type: application/json' -d "$data")
  F_CODE=$(curl "${args[@]}" "$API_URL$path" 2>/dev/null) || F_CODE=000
  F_BODY=$(cat "$scratch/f.body" 2>/dev/null)
  F_HDRS=$(tr -d '\r' <"$scratch/f.hdr" 2>/dev/null)
}
chk() { # <label> <status> <jq expression on F_BODY>
  if [ "$F_CODE" != "$2" ]; then fail "$1" "  HTTP $F_CODE (wanted $2): ${F_BODY:0:800}"; return 1; fi
  if jq -e "$3" >/dev/null 2>&1 <<<"$F_BODY"; then pass "$1"; else fail "$1" "  jq -e '$3' was false or failed"$'\n'"  HTTP $F_CODE payload: ${F_BODY:0:1800}"; fi
}
chk_status() { # <label> <status>: only the status
  if [ "$F_CODE" = "$2" ]; then pass "$1"; else fail "$1" "  HTTP $F_CODE (wanted $2): ${F_BODY:0:800}"; fi
}
sign_in() { # <label>: an anonymous visitor (sets V_COOKIE, V_ID)
  local label=$1
  V_COOKIE="" V_ID=""
  fetch - POST /api/auth/sign-in/anonymous '{}'
  V_COOKIE=$(grep -i '^set-cookie: *[^;]*session_token=' <<<"$F_HDRS" | head -n1 | sed -E 's/^[^:]*: *//; s/;.*//')
  if [ "$F_CODE" = 200 ] && [ -n "$V_COOKIE" ] && jq -e '.user.isAnonymous == true and (.user.id | length) > 0' >/dev/null 2>&1 <<<"$F_BODY"; then
    V_ID=$(jq -r .user.id <<<"$F_BODY")
    pass "$label: anonymous sign-in answers 200 with a session cookie and an anonymous user"
  else
    V_COOKIE=""; fail "$label: anonymous sign-in answers 200 with a session cookie and an anonymous user" "  HTTP $F_CODE headers: ${F_HDRS:0:400} body: ${F_BODY:0:400}"
  fi
}
sqlite_scalar() { # <sql>: the first column of the first row of a read-only query on the stack's DB
  [ -f "${DB_PATH-}" ] || { _e2e_err "sqlite_scalar: no database (call start_stack first)"; return 2; }
  E2E_SQL=$1 E2E_DB=$DB_PATH bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.E2E_DB, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    const row = db.query(process.env.E2E_SQL).get();
    console.log(row === null ? "" : Object.values(row)[0]);
  '
}
# player_id_counts <player id>: one "<table> <rows of that player>" line per table that has a player_id column, found through
# sqlite_master + pragma_table_info (not a list written here), so a table added by a later slice is checked too.
player_id_counts() {
  [[ $1 =~ ^[A-Za-z0-9_-]+$ ]] || { _e2e_err "player_id_counts: invalid id '$1'"; return 2; }
  E2E_PID=$1 E2E_DB=$DB_PATH bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.E2E_DB, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    const tables = db.query("SELECT DISTINCT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = ? AND c.name = ? ORDER BY m.name").all("table", "player_id");
    for (const { name } of tables) {
      const n = db.query(`SELECT COUNT(*) AS n FROM "${name.replaceAll(`"`, `""`)}" WHERE player_id = ?`).get(process.env.E2E_PID).n;
      console.log(name + " " + n);
    }
  '
}
uuid() { printf '%s' "$1$1$1$1$1$1$1$1-$1$1$1$1-4$1$1$1-8$1$1$1-$1$1$1$1$1$1$1$1$1$1$1$1"; }   # a valid v4 uuid from one hex digit

# The second visitor: age 9, Ball + wall, yard, 20 min; numbers nobody else has (juggling 63, ball mastery 97).
other_body() {
  jq -nc --arg u1 "$(uuid a)" --arg u2 "$(uuid b)" --arg u3 "$(uuid c)" --arg u4 "$(uuid d)" --arg u5 "$(uuid e)" '{
    profile: {age: 9, level: "beginner", goal: "control", equipment: "ball_wall", space: "yard", partner: false, daysPerWeek: 2, minutesPerSession: 20, locale: "en"},
    baseline: [
      {testSlug: "juggling-max-touches", value: 63, clientUuid: $u1},
      {testSlug: "wall-passing-60s", value: 71, clientUuid: $u2},
      {testSlug: "ball-mastery-30s", value: 97, clientUuid: $u3},
      {testSlug: "weak-foot-passes", value: 13, clientUuid: $u4},
      {testSlug: "slalom-time", value: 0, skipped: true, clientUuid: $u5}]}'
}

# --- browser helpers ---------------------------------------------------------------------------------------------------------
WEB_OK=0
# pw_run <label> <js: async page => ...>: runs a Playwright snippet in the page; PASS when it completes, FAIL with the error
# otherwise; the returned value (a string, or JSON text) is left in PW_OUT. Every action times out after 10 s.
pw_run() {
  local label=$1 code=$2 out
  PW_OUT=""
  out=$(pw run-code "async page => { page.setDefaultTimeout(10000); const run = ${code}; return await run(page); }") || {
    fail "$label" "  $(jq -r '.error // .' <<<"$out" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | head -n 12)"; WEB_OK=0; return 1; }
  PW_OUT=$(jq -r '.result | (try fromjson catch .) | if type == "string" then . else tojson end' <<<"$out")
  pass "$label"
}
text_has() { # <label> <haystack> <needle>: case-insensitive containment; no-break spaces are spaces
  local hay=${2//$NBSP/ } needle=$3
  if [[ ${hay,,} == *"${needle,,}"* ]]; then pass "$1"; else fail "$1" "  needle: $3"$'\n'"  saw: ${hay:0:1500}"; fi
}
text_lacks() { # <label> <haystack> <needle>
  local hay=${2//$NBSP/ } needle=$3
  if [[ ${hay,,} != *"${needle,,}"* ]]; then pass "$1"; else fail "$1" "  must not contain: $3"$'\n'"  saw: ${hay:0:1500}"; fi
}
page_text() { # <label> [selector]: the visible text of the page (or an element), left in PW_OUT
  pw_run "$1" '(async page => await page.locator("'"${2:-body}"'").innerText())'
}
page_json() { # <label> <path>: GET <path> from the browser page (its own cookie); PW_OUT = {"status":..,"body":..}
  pw_run "$1" '(async page => JSON.stringify(await page.evaluate(async (path) => {
    const x = await fetch(path);
    let body = null; try { body = await x.json(); } catch (e) {}
    return { status: x.status, body }; }, "'"$2"'")))'
}
# open_hooked: opens the CURRENT browser session on about:blank and installs a context-level 'request' listener (kept on the
# context object; a run-code call has no other shared state) BEFORE the first navigation, so every request of every page is logged.
open_hooked() { # <label>
  local out
  if ! pw_available; then blocked "browser: open $1" "playwright-cli is not installed"; return 1; fi
  if out=$(pw open about:blank 2>&1); then :
  elif grep -qiE 'not installed|Executable doesn.t exist' <<<"$out"; then blocked "browser: open $1" "no usable browser: $(grep -iE 'not installed|Executable' <<<"$out" | head -n1)"; return 1
  else fail "browser: open $1" "$out"; return 1; fi
  pw resize 1280 1800 >/dev/null   # tall: nothing needs scrolling under the sticky header
  pw_run "browser $1: a request listener is installed on the browser context before the first navigation" '(async page => {
    const ctx = page.context(); ctx.__reqs = []; ctx.on("request", (r) => ctx.__reqs.push(r.url())); return "ok"; })' || return 1
  pw goto "$STACK_URL/" >/dev/null && pass "browser $1: opened $STACK_URL/" || { fail "browser $1: open $STACK_URL/"; return 1; }
}
# net_harvest <label>: appends the request URLs the current session's context saw to $scratch/net.log (one per line, prefixed
# with the label) and counts them. Read BEFORE the browser closes.
net_harvest() {
  pw_run "network log: read the requests of browser $1" '(async page => JSON.stringify(page.context().__reqs ?? null))' || return 1
  if jq -e 'type == "array"' >/dev/null 2>&1 <<<"$PW_OUT"; then
    jq -r --arg l "$1" '.[] | $l + " " + .' <<<"$PW_OUT" >>"$scratch/net.log"
    pass "network log: browser $1 saw $(jq length <<<"$PW_OUT") requests"
  else fail "network log: browser $1 has no request log" "  got: ${PW_OUT:0:200}"; fi
}
run_wizard() { # <age> <level label> <goal label> <equipment label> <space label> <partner label> <days> <minutes label>
  pw_run "wizard step 1: age $1, level '$2', goal '$3'" '(async page => {
    await page.getByRole("spinbutton", { name: "Age" }).fill("'"$1"'");
    await page.getByText("'"$2"'", { exact: true }).click();
    await page.getByText("'"$3"'", { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Your training conditions" }).waitFor();
    return "ok"; })' || return 1
  pw_run "wizard step 2: '$4', '$5', partner '$6', $7 days, '$8'" '(async page => {
    await page.getByText("'"$4"'", { exact: true }).click();
    await page.getByText("'"$5"'", { exact: true }).click();
    await page.getByRole("group", { name: "Is there someone to train with?" }).getByText("'"$6"'", { exact: true }).click();
    await page.getByRole("group", { name: "Days per week" }).getByText("'"$7"'", { exact: true }).click();
    await page.getByText("'"$8"'", { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Quick skill tests" }).waitFor();
    return "ok"; })' || return 1
}
test_region() { local m; m=$(jq -r --arg s "$1" '.tests[] | select(.slug == $s) | .metric' <<<"$OPTIONS"); printf 'page.getByRole("region", { name: %s, exact: true })' "$(jq -Rn --arg m "$m" '$m')"; }
enter_result() { # <slug> <value>: the wizard's baseline step
  pw_run "wizard step 3: enter $2 for $1" "(async page => { await $(test_region "$1").getByRole('textbox').first().fill('$2'); return 'ok'; })"
}
# roadmap_text / journey_numbers: what the player sees on /train/roadmap and /progress (main text; the four metric cards + milestones).
roadmap_text() { # <label>
  pw goto "$STACK_URL/train/roadmap" >/dev/null
  pw_run "$1: /train/roadmap shows the roadmap" '(async page => {
    await page.getByRole("heading", { name: "Your focus skills" }).waitFor();
    await page.waitForLoadState("networkidle");
    return await page.locator("main").innerText(); })'
}
journey_numbers() { # <label>: PW_OUT = {"metrics":{label:value},"milestones":[text]}
  pw goto "$STACK_URL/progress" >/dev/null
  pw_run "$1: /progress shows MY JOURNEY" '(async page => {
    await page.getByRole("heading", { name: "My journey", level: 1 }).waitFor();
    await page.getByRole("heading", { name: "Skill tree" }).waitFor();
    await page.waitForLoadState("networkidle");
    return JSON.stringify(await page.evaluate(() => ({
      metrics: Object.fromEntries([...document.querySelector("main dl").children].map((d) => [d.querySelector("dt").innerText, d.querySelector("dd").innerText])),
      milestones: [...document.querySelectorAll("section[aria-labelledby=journey-milestones] li[data-state]")].map((li) => li.dataset.state + ": " + li.innerText.replace(/\s+/g, " ").trim())}))); })'
}

# ============================================================================================================================
start_stack || exit 1
assert_api /health '.ok == true and .database == "ok"' -l "stack: /health ok on the temp DB (port $E2E_API_PORT_USED, own media dir)"
assert_eq "$(sqlite_count sports "slug = '$SPORT'")" 1 "the real seed is loaded (sport $SPORT)"
assert_eq "$(sqlite_count skill_tests)" 5 "the real seed holds the 5 skill tests"
assert_eq "$(sqlite_count player_profiles)" 0 "start state: no player profile yet"
assert_eq "$(sqlite_count user)" 0 "start state: no account at all (nothing created by hand)"
fetch - GET "/api/onboarding/$SPORT?locale=en"
OPTIONS=$F_BODY
[ "$F_CODE" = 200 ] || fail "options: GET /api/onboarding/$SPORT answers 200" "  HTTP $F_CODE: ${F_BODY:0:400}"

# --- 0. the other visitor (API): its data must never reach the browser player ---------------------------------------------------
sign_in "other visitor"
OTHER_COOKIE=$V_COOKIE OTHER_ID=$V_ID
OTHER_CODE=""
if [ -n "$OTHER_COOKIE" ]; then
  fetch "$OTHER_COOKIE" POST /api/player/start "$(other_body)"
  chk "setup: the other visitor onboards through the API (age 9; juggling 63, ball mastery 97)" 200 '.profile.age == 9 and (.roadmap.tracks | length) == 5'
  fetch "$OTHER_COOKIE" PUT /api/player/consents '{"modelImprovement":true}'
  chk "setup: the other visitor turns Model improvement on" 200 '.modelImprovement.granted == true and .videoAnalysis.granted == false'
  fetch "$OTHER_COOKIE" POST /api/player/recovery-code
  chk "setup: the other visitor makes a recovery code of its own" 200 '(.code | length) > 0'
  OTHER_CODE=$(jq -r '.code // ""' <<<"$F_BODY")
fi
assert_eq "$(sqlite_count player_profiles)" 1 "setup: exactly the other visitor's profile exists before the browser player starts"

# --- I. API adversarial checks (the other visitor is the subject; the browser player is untouched) -------------------------------
fetch - GET /api/player/export;               chk_status "api: GET /api/player/export without a session is 401" 401
fetch - DELETE /api/player;                   chk_status "api: DELETE /api/player without a session is 401" 401
fetch - GET /api/player/consents;             chk_status "api: GET /api/player/consents without a session is 401" 401
fetch - POST /api/player/recover '{"code":"AAAA-AAAA-AAAA-AAAA"}'; chk_status "api: POST /api/player/recover without a session is 401" 401
assert_eq "$(sqlite_count player_profiles "player_id = '$OTHER_ID'")" 1 "api: the unauthenticated DELETE did not touch the other visitor"
if [ -n "$OTHER_COOKIE" ]; then
  fetch "$OTHER_COOKIE" GET "/api/player/export?playerId=nobody-else&player_id=nobody-else"
  chk "api: the export is the session's own player (a ?playerId= in the query changes nothing), a JSON attachment with a README" 200 \
    ".playerId == \"$OTHER_ID\" and (.readme.about | length) > 0 and (.tables.player_profiles | length) == 1 and (.tables.consents | length) >= 1"
  if grep -qi '^content-disposition: *attachment; *filename="first-coach-export-[0-9-]*\.json"' <<<"$F_HDRS"; then pass "api: the export is an attachment named first-coach-export-<date>.json"
  else fail "api: the export is an attachment named first-coach-export-<date>.json" "  headers: ${F_HDRS:0:500}"; fi
  fetch "$OTHER_COOKIE" PUT /api/player/consents '{"videoAnalysis":true}'
  chk "api: under 13 (age 9), video analysis without guardianConfirmed is a 422 pointing at /guardianConfirmed" 422 '.errors | any(.pointer == "/guardianConfirmed")'
  fetch "$OTHER_COOKIE" GET /api/player/consents
  chk "api: the refused grant wrote nothing (video analysis still off)" 200 '.videoAnalysis.granted == false'
  fetch "$OTHER_COOKIE" PUT /api/player/consents '{"videoAnalysis":true,"guardianConfirmed":true}'
  chk "api: under 13 with guardianConfirmed: true the grant is 200 and shows the guardian" 200 '.videoAnalysis.granted == true and .videoAnalysis.guardianConfirmed == true'
  fetch "$OTHER_COOKIE" PUT /api/player/consents '{"videoAnalysis":false}'
  chk "api: revoking is always allowed (no guardian needed)" 200 '.videoAnalysis.granted == false'
  sign_in "wrong-code visitor"
  if [ -n "$V_COOKIE" ]; then
    fetch "$V_COOKIE" POST /api/player/recover '{"code":"ZZZZ-ZZZZ-ZZZZ-ZZZZ"}'
    chk "api: a wrong recovery code is one generic 422 problem (no field errors, no hint whether a code exists)" 422 '.status == 422 and (has("errors") | not)'
    WRONG_BODY=$F_BODY
    fetch "$V_COOKIE" POST /api/player/recover '{"code":"nonsense"}'
    chk "api: a malformed recovery code is the same generic 422 (the shape is not revealed either)" 422 '.status == 422 and (has("errors") | not)'
    if [ "$(jq -cS 'del(.instance)' <<<"$WRONG_BODY")" = "$(jq -cS 'del(.instance)' <<<"$F_BODY")" ]; then pass "api: unknown code and malformed code answer the identical problem body"
    else fail "api: unknown code and malformed code answer the identical problem body" "  unknown: ${WRONG_BODY:0:300}"$'\n'"  malformed: ${F_BODY:0:300}"; fi
  fi
fi

# --- A. the browser player onboards and finishes one session -------------------------------------------------------------------
WEB_ON=0
if [ "$E2E_WEB" != api ]; then
  blocked "web journey (player, privacy settings, restore, download, delete, legal, network)" "E2E_WEB=$E2E_WEB: the web app is not served"
elif ! pw_available; then
  blocked "web journey (player, privacy settings, restore, download, delete, legal, network)" "playwright-cli is not installed"
else
  use_browser A
  if open_hooked "A (the player)"; then WEB_ON=1; fi   # open_hooked itself recorded BLOCKED (no usable browser) or FAIL
fi

if [ "$WEB_ON" = 1 ]; then
  WEB_OK=1
  if [ "$(pw cookie-list | jq -r '.result // ""' | grep -c 'better-auth')" = 0 ]; then pass "browser A starts with no session cookie"; else fail "browser A starts with no session cookie"; fi
  pw_run "landing: START TRAINING leads to the wizard" '(async page => {
    await page.getByRole("link", { name: "Start training" }).first().click();
    await page.waitForURL("**/train/onboarding");
    await page.getByRole("heading", { name: "A few questions to get started" }).waitFor();
    return page.url(); })'
  [ "$WEB_OK" = 1 ] && run_wizard 12 Intermediate "Control the ball with confidence" "Ball only" "Home 3×3 m" "No" 3 "20 min"
  if [ "$WEB_OK" = 1 ]; then
    enter_result juggling-max-touches 14
    enter_result ball-mastery-30s 40
    pw_run "wizard step 3: Done 5 of 5 (2 results + the 3 tests that need more than a ball, skipped), Continue creates the plan and opens MY ROADMAP" '(async page => {
      await page.getByText("Done: 5 of 5").waitFor();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForURL("**/train/roadmap");
      await page.getByRole("heading", { name: "Your focus skills" }).waitFor();
      return await page.locator("main").innerText(); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    OLD_ID=$(sqlite_scalar "SELECT player_id FROM player_profiles WHERE player_id <> '$OTHER_ID'")
    if [ -n "$OLD_ID" ]; then pass "the browser player has its own profile (a second one next to the other visitor's)"; else fail "the browser player has its own profile"; WEB_OK=0; fi
    assert_eq "$(sqlite_scalar "SELECT age FROM player_profiles WHERE player_id = '$OLD_ID'")" 12 "db: the player is 12 (under 13: the guardian rule applies to this player)"
  fi
  if [ "$WEB_OK" = 1 ]; then
    pw goto "$STACK_URL/train" >/dev/null
    pw_run "session: /train lists today's drills" '(async page => {
      await page.getByRole("heading", { name: /min today/ }).waitFor();
      return await page.getByRole("list", { name: "Today'"'"'s drills" }).getByRole("listitem").count(); })'
    DRILLS=$PW_OUT
    if [ "$WEB_OK" = 1 ] && [ "${DRILLS:-0}" -ge 1 ] 2>/dev/null; then pass "session: $DRILLS drills in today's session"; else fail "session: at least one drill in today's session" "  count: ${DRILLS:-none}"; WEB_OK=0; fi
  fi
  if [ "$WEB_OK" = 1 ]; then
    pw_run "session: every drill is opened and marked Done" '(async page => {
      const list = page.getByRole("list", { name: "Today'"'"'s drills" });
      const total = await list.getByRole("listitem").count();
      await list.getByRole("link").first().click();
      for (let i = 0; i < total; i++) {
        await page.getByRole("button", { name: "Done", exact: true }).click();
        await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
        await page.getByRole("link", { name: /Next drill|Back to today.s session/ }).first().click();
      }
      await page.waitForURL((url) => url.pathname === "/train");
      return total; })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    pw_run "session: Finish session saves the session and opens the summary" '(async page => {
      await page.getByRole("button", { name: "Finish session" }).click();
      await page.waitForURL("**/train/summary");
      await page.getByRole("heading", { name: "Session complete" }).waitFor();
      return await page.locator("main").innerText(); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    assert_eq "$(sqlite_count sessions "player_id = '$OLD_ID' AND finished_at IS NOT NULL")" 1 "db: exactly one finished session for the player"
    assert_eq "$(sqlite_count test_results "player_id = '$OLD_ID'")" 5 "db: 5 baseline rows for the player (2 measured, 3 skipped)"
    assert_eq "$(sqlite_count roadmaps "player_id = '$OLD_ID'")" 1 "db: one roadmap for the player"
    OLD_ROADMAP_ID=$(sqlite_scalar "SELECT id FROM roadmaps WHERE player_id = '$OLD_ID'")
    OLD_ROADMAP_JSON=$(sqlite_scalar "SELECT json FROM roadmaps WHERE player_id = '$OLD_ID'")
    roadmap_text "player (before)"
  fi
  if [ "$WEB_OK" = 1 ]; then
    ROADMAP_A=${PW_OUT//$NBSP/ }
    journey_numbers "player (before)"
  fi
  if [ "$WEB_OK" = 1 ]; then
    JOURNEY_A=$PW_OUT
    if jq -e '.metrics["Sessions completed"] == "1" and (.metrics["Minutes trained"] | tonumber) > 0 and .metrics["Current streak (days)"] == "1"' >/dev/null <<<"$JOURNEY_A"; then
      pass "journey (before): sessions completed 1, minutes trained above 0, streak 1 ($(jq -c .metrics <<<"$JOURNEY_A"))"
    else fail "journey (before): sessions completed 1, minutes trained above 0, streak 1" "  journey: ${JOURNEY_A:0:800}"; fi
  fi
fi

# --- B. PRIVACY SETTINGS in browser A -------------------------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  echo "NOTE     no link to /settings/privacy exists in the app (shell, footer, roadmap, policy): the script opens it by URL"
  assert_eq "$(sqlite_count consents "player_id = '$OLD_ID'")" 0 "db: no consents row for the player before it chooses anything"
  pw goto "$STACK_URL/settings/privacy" >/dev/null
  pw_run "privacy settings: /settings/privacy shows the screen with both consent switches" '(async page => {
    await page.getByRole("heading", { name: "Your privacy", level: 1 }).waitFor();
    await page.getByRole("switch", { name: "Video analysis" }).waitFor();
    await page.getByRole("switch", { name: "Model improvement" }).waitFor();
    return JSON.stringify(await page.evaluate(() => ({
      text: document.querySelector("main").innerText,
      switches: [...document.querySelectorAll("input[role=switch]")].map((s) => ({ name: s.closest("label").querySelector("span").innerText, checked: s.checked, word: s.closest("label").querySelector("span[aria-hidden=true] span").innerText })),
      headings: [...document.querySelectorAll("main h2")].map((h) => h.innerText.trim()) }))); })'
  if [ "$WEB_OK" = 1 ]; then
    PRIV=$PW_OUT
    if jq -e '.switches | length == 2 and all(.[]; .checked == false and .word == "Off")' >/dev/null <<<"$PRIV"; then pass "privacy settings: BOTH consents are off by default (two switches, unchecked, the word 'Off' beside each)"
    else fail "privacy settings: BOTH consents are off by default" "  switches: $(jq -c .switches <<<"$PRIV")"; fi
    if jq -e '.switches | map(.name) == ["Video analysis", "Model improvement"]' >/dev/null <<<"$PRIV"; then pass "privacy settings: the two switches are Video analysis and Model improvement"
    else fail "privacy settings: the two switches are Video analysis and Model improvement" "  switches: $(jq -c .switches <<<"$PRIV")"; fi
    PRIV_TEXT=$(jq -r .text <<<"$PRIV")
    text_has "privacy settings: says what is kept (age in years, training results)" "$PRIV_TEXT" "Your age in years"
    text_has "privacy settings: says there is no name and no email" "$PRIV_TEXT" "No name."
    text_has "privacy settings: never public profiles" "$PRIV_TEXT" "No public profiles"
    text_has "privacy settings: never messaging" "$PRIV_TEXT" "No messaging"
    text_has "privacy settings: never ads" "$PRIV_TEXT" "No ads"
    text_has "privacy settings: never global rankings" "$PRIV_TEXT" "No global rankings"
    text_has "privacy settings: video analysis discloses that still frames go to an AI provider" "$PRIV_TEXT" "a few still frames from it are sent to an AI provider"
    text_has "privacy settings: an under-13 player is asked for a guardian's confirmation" "$PRIV_TEXT" "A parent or guardian is with me and says yes"
    if jq -e '.headings | index("Recovery code") != null and index("Your data") != null' >/dev/null <<<"$PRIV"; then pass "privacy settings: the slot panels render (Recovery code, Your data)"
    else fail "privacy settings: the slot panels render (Recovery code, Your data)" "  headings: $(jq -c .headings <<<"$PRIV")"; fi
    page_json "privacy settings: GET /api/player/consents from the player's own session" "/api/player/consents"
  fi
  if [ "$WEB_OK" = 1 ]; then
    if jq -e '.status == 200 and .body.videoAnalysis.granted == false and .body.modelImprovement.granted == false' >/dev/null <<<"$PW_OUT"; then pass "api: both consents are off by default (GET /api/player/consents)"
    else fail "api: both consents are off by default (GET /api/player/consents)" "  answer: ${PW_OUT:0:500}"; fi
    assert_eq "$(sqlite_count consents "player_id = '$OLD_ID'")" 0 "db: opening the screen wrote no consents row"
  fi

  # --- the recovery code ---
  if [ "$WEB_OK" = 1 ]; then
    text_has "recovery panel: warns that a new code replaces the old one, before anything is made" "$PRIV_TEXT" "A new code replaces the old one."
    pw_run "recovery panel: ONE button makes the code and the code is shown in four groups" '(async page => {
      await page.getByRole("button", { name: "Make my recovery code" }).click();
      await page.getByRole("group", { name: "Your recovery code" }).waitFor();
      return JSON.stringify(await page.evaluate(() => ({
        groups: [...document.querySelectorAll("[data-slot=recovery-code-group]")].map((g) => g.textContent),
        text: document.querySelector("main").innerText }))); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    CODE_GROUPS=$(jq -r '.groups | join("-")' <<<"$PW_OUT") CODE_PAGE_TEXT=$(jq -r .text <<<"$PW_OUT")
    CODE=$CODE_GROUPS
    if [[ $CODE =~ ^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$ ]]; then pass "recovery panel: the code is 16 characters in 4 groups of 4 (ABCD-EFGH-IJKL-MNOP)"; else fail "recovery panel: the code is 16 characters in 4 groups of 4" "  code shape: ${CODE//[A-Z0-9]/x}"; CODE=""; fi
    text_has "recovery panel: 'shown once' warning ('Write it down now. It will not be shown again.')" "$CODE_PAGE_TEXT" "Write it down now. It will not be shown again."
    text_has "recovery panel: 'This code replaces any earlier code.'" "$CODE_PAGE_TEXT" "This code replaces any earlier code."
    text_has "recovery panel: a Copy code button" "$CODE_PAGE_TEXT" "Copy code"
    text_has "recovery panel: the 'I wrote it down' confirmation" "$CODE_PAGE_TEXT" "I wrote it down"
    assert_eq "$(sqlite_count recovery_codes "player_id = '$OLD_ID'")" 1 "db: one recovery_codes row for the player"
    CODE_BARE=${CODE//-/}
    HASH=$(sqlite_scalar "SELECT code_hash FROM recovery_codes WHERE player_id = '$OLD_ID'")
    if [ -n "$HASH" ] && [ "$HASH" != "$CODE" ] && [ "$HASH" != "$CODE_BARE" ] && [[ $HASH != *"$CODE_BARE"* ]]; then pass "db: only a hash of the code is stored (code_hash is ${#HASH} characters and is not the code)"
    else fail "db: only a hash of the code is stored" "  code_hash: ${HASH:0:80}"; fi
    if ! grep -aqF -e "$CODE_BARE" -e "$CODE" "$DB_PATH" "$DB_PATH-wal" 2>/dev/null; then pass "db: the code is nowhere in the database file in clear text"
    else fail "db: the code is nowhere in the database file in clear text" "  the code string was found in $DB_PATH"; fi
    pw_run "recovery panel: the code is in no browser storage (localStorage, sessionStorage, cookies, IndexedDB)" '(async page => JSON.stringify(await page.evaluate(async (code) => {
      const bare = code.replaceAll("-", ""); const hay = [];
      for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) hay.push(s.key(i) + "=" + s.getItem(s.key(i)));
      hay.push(document.cookie);
      const dbs = indexedDB.databases ? await indexedDB.databases() : [];
      for (const d of dbs) {
        await new Promise((done) => {
          const r = indexedDB.open(d.name);
          r.onerror = () => done();
          r.onsuccess = () => {
            const db = r.result; const names = [...db.objectStoreNames];
            if (names.length === 0) { db.close(); return done(); }
            const tx = db.transaction(names); let left = names.length;
            const fin = () => { if (--left === 0) { db.close(); done(); } };
            for (const n of names) { const g = tx.objectStore(n).getAll(); g.onsuccess = () => { try { hay.push(JSON.stringify(g.result)); } catch (e) {} fin(); }; g.onerror = fin; }
          };
        });
      }
      const all = hay.join("\n").toLowerCase();
      return { found: all.includes(code.toLowerCase()) || all.includes(bare.toLowerCase()), chars: all.length, idb: dbs.map((d) => d.name) }; }, "'"$CODE"'")))'
    if [ "$WEB_OK" = 1 ]; then
      if jq -e '.found == false and .chars > 0' >/dev/null <<<"$PW_OUT"; then pass "recovery panel: the code was found in NO browser storage ($(jq -c '{chars, idb}' <<<"$PW_OUT") scanned)"
      else fail "recovery panel: the code is in no browser storage" "  scan: $PW_OUT"; fi
    fi
    pw_run "recovery panel: 'I wrote it down' hides the code for good" '(async page => {
      await page.getByRole("button", { name: "I wrote it down" }).click();
      await page.getByText("Done. The code is hidden and will not be shown again.").waitFor();
      return JSON.stringify(await page.evaluate(() => ({ shown: document.querySelectorAll("[data-slot=recovery-code], [data-slot=recovery-code-group]").length, text: document.querySelector("main").innerText }))); })'
    if [ "$WEB_OK" = 1 ]; then
      RECOVERY_AFTER=$(jq -r .text <<<"$PW_OUT")
      if jq -e '.shown == 0' >/dev/null <<<"$PW_OUT"; then pass "recovery panel: after the confirmation no code element is left on the page"; else fail "recovery panel: after the confirmation no code element is left on the page" "  $PW_OUT"; fi
      for g in 0 5 10 15; do text_lacks "recovery panel: after the confirmation the group ${CODE:$g:4} is not on the page" "$RECOVERY_AFTER" "${CODE:$g:4}"; done
      text_has "recovery panel: 'Make a new code' is offered, with the replace warning" "$RECOVERY_AFTER" "Make a new code"
      text_has "recovery panel: the replace warning is shown again" "$RECOVERY_AFTER" "A new code replaces the old one."
    fi
  fi

  # --- a consent on, so the export has a consents row ---
  if [ "$WEB_OK" = 1 ]; then
    pw_run "privacy settings: turning Model improvement on saves it ('Saved. Model improvement is on.')" '(async page => {
      await page.getByText("Model improvement", { exact: true }).click();   // the label, as a finger would
      await page.getByText("Saved. Model improvement is on.").waitFor();
      return await page.getByRole("switch", { name: "Model improvement" }).isChecked(); })'
    if [ "$WEB_OK" = 1 ]; then
      assert_eq "$PW_OUT" true "privacy settings: the Model improvement switch stays on after the save"
      assert_eq "$(sqlite_scalar "SELECT granted FROM consents WHERE player_id = '$OLD_ID' AND kind = 'modelImprovement' ORDER BY id DESC LIMIT 1")" 1 "db: a consents row says modelImprovement granted"
      assert_eq "$(sqlite_scalar "SELECT COUNT(*) FROM consents WHERE player_id = '$OLD_ID' AND kind = 'videoAnalysis' AND granted = 1")" 0 "db: video analysis was never granted"
    fi
  fi
  WEB_OK=1   # the privacy steps above must not stop the independent legal / 404 checks below
fi

# --- C. the legal pages in kk, ru and en (browser A) ---------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ]; then
  BUNDLES=$(bun -e '
    import privacy from "'"$WEB_DIR"'/src/features/legal/privacy.messages.ts";
    import terms from "'"$WEB_DIR"'/src/features/legal/terms.messages.ts";
    const out = {};
    for (const l of ["kk", "ru", "en"]) out[l] = {
      privacyH2: Object.values(privacy[l].sections).map((s) => s.title),
      termsH2: Object.values(terms[l].sections).map((s) => s.title) };
    console.log(JSON.stringify(out));' 2>"$scratch/bundles.err") || BUNDLES=""
  if jq -e '.kk.privacyH2 | length >= 8' >/dev/null 2>&1 <<<"$BUNDLES"; then pass "legal: the message bundles list the section headings of both pages in kk, ru and en"
  else fail "legal: the message bundles could be read" "  $(head -c 400 "$scratch/bundles.err")"; BUNDLES=""; fi
  declare -A H1=([privacy/kk]='Құпиялылық саясаты' [privacy/ru]='Политика конфиденциальности' [privacy/en]='Privacy policy'
                 [terms/kk]='Шарттар және мазмұн лицензиясы' [terms/ru]='Условия и лицензия на контент' [terms/en]='Terms and content licence')
  # legal_page <page> <lang>: the page in that language: <html lang>, the h1 and every section heading of the bundle
  legal_page() {
    local page=$1 lang=$2 key
    pw goto "$STACK_URL/legal/$page" >/dev/null
    pw_run "legal /legal/$page ($lang): switch the language and read the page" '(async page => {
      await page.locator("button[lang=\"'"$lang"'\"]").first().click();
      await page.waitForFunction((l) => document.documentElement.lang === l, "'"$lang"'");
      await page.getByRole("heading", { level: 1 }).waitFor();
      return JSON.stringify(await page.evaluate(() => ({
        lang: document.documentElement.lang,
        h1: document.querySelector("main h1").innerText.trim(),
        h2: [...document.querySelectorAll("main h2")].map((h) => h.innerText.trim()),
        note: !!document.querySelector("main [role=note]"),
        words: document.querySelector("main").innerText.split(/\s+/).length }))); })' || return 1
    if jq -e --arg l "$lang" --arg h "${H1[$page/$lang]}" '.lang == $l and .h1 == $h' >/dev/null <<<"$PW_OUT"; then pass "legal /legal/$page ($lang): <html lang> is $lang and the page title is '${H1[$page/$lang]}'"
    else fail "legal /legal/$page ($lang): <html lang> is $lang and the page title is '${H1[$page/$lang]}'" "  page: ${PW_OUT:0:400}"; fi
    if [ -n "$BUNDLES" ]; then
      key=$([ "$page" = privacy ] && echo privacyH2 || echo termsH2)
      if jq -e --argjson b "$BUNDLES" --arg l "$lang" --arg k "$key" '. as $p | ($b[$l][$k] | all(. as $t | $p.h2 | index($t) != null))' >/dev/null <<<"$PW_OUT"; then pass "legal /legal/$page ($lang): every one of the $(jq -r --arg l "$lang" --arg k "$key" '.[$l][$k] | length' <<<"$BUNDLES") sections is on the page in $lang"
      else fail "legal /legal/$page ($lang): every section heading of the $lang bundle is on the page" "  page h2: $(jq -c .h2 <<<"$PW_OUT")"$'\n'"  bundle:  $(jq -c --arg l "$lang" --arg k "$key" '.[$l][$k]' <<<"$BUNDLES")"; fi
    fi
    if [ "$page" = privacy ]; then
      if jq -e '.note == true' >/dev/null <<<"$PW_OUT"; then pass "legal /legal/privacy ($lang): marked as a plain-language policy pending legal review (a note)"
      else fail "legal /legal/privacy ($lang): marked as pending legal review (a note element)" "  page: ${PW_OUT:0:300}"; fi
    fi
    if jq -e '.words > 150' >/dev/null <<<"$PW_OUT"; then pass "legal /legal/$page ($lang): the page has real content ($(jq -r .words <<<"$PW_OUT") words)"
    else fail "legal /legal/$page ($lang): the page has real content" "  words: $(jq -r .words <<<"$PW_OUT")"; fi
  }
  for page in privacy terms; do
    for lang in kk ru en; do legal_page "$page" "$lang"; done
  done
  pw goto "$STACK_URL/legal/privacy" >/dev/null
  pw_run "legal: /legal/privacy in English states who runs the service and that there are no ads" '(async page => await page.locator("main").innerText())'
  if [ "$WEB_OK" = 1 ]; then
    text_has "legal: /legal/privacy names KOZ AI as the operator" "$PW_OUT" "KOZ AI"
    text_has "legal: /legal/privacy says the player video stays on the phone" "$PW_OUT" "Your video stays on your phone"
    text_has "legal: /legal/privacy says how to download or delete data" "$PW_OUT" "Download or delete your data"
  fi
  WEB_OK=1
fi

# --- D. no public profiles, feeds, messaging or leaderboards ---------------------------------------------------------------------
NOSOCIAL='/u/x /feed /messages /leaderboard'
for path in $NOSOCIAL; do
  # the document status is the SPA shell's (info); the same names under /api are real 404 problems
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$E2E_HTTP_TIMEOUT" "$STACK_URL$path") || code=000
  echo "NOTE     GET $path answers the SPA shell with HTTP $code (client routes fall back to index.html; the 404 is the app's page, asserted in the browser)"
  fetch - GET "/api$path"
  chk_status "api: GET /api$path is a 404" 404
done
if [ "$WEB_ON" = 1 ]; then
  for path in $NOSOCIAL; do
    pw goto "$STACK_URL$path" >/dev/null
    pw_run "no social ($path): the app renders its 404 page" '(async page => {
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      return JSON.stringify(await page.evaluate(() => ({ h1: document.querySelector("h1").innerText.trim(), path: location.pathname, main: document.querySelector("main")?.innerText ?? "" }))); })'
    if [ "$WEB_OK" = 1 ]; then
      if jq -e --arg h "$EN_NOT_FOUND" --arg p "$path" '.h1 == $h and .path == $p' >/dev/null <<<"$PW_OUT"; then pass "no social ($path): 404 page '$EN_NOT_FOUND', the URL stays $path (no route, no redirect)"
      else fail "no social ($path): 404 page '$EN_NOT_FOUND' at $path" "  page: ${PW_OUT:0:500}"; fi
    fi
    WEB_OK=1
  done
  pw goto "$STACK_URL/" >/dev/null
  pw_run "no social: the links of the landing page" '(async page => {
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    return JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")))); })'
  if [ "$WEB_OK" = 1 ]; then
    if jq -e 'length > 3 and (map(select(test("^/(u|feed|messages|leaderboard|profile|profiles|chat|rankings?)(/|$)"))) | length) == 0' >/dev/null <<<"$PW_OUT"; then pass "no social: no link to a public profile, feed, messages or leaderboard on the landing page ($(jq length <<<"$PW_OUT") links)"
    else fail "no social: no link to a public profile, feed, messages or leaderboard on the landing page" "  links: ${PW_OUT:0:500}"; fi
  fi
  WEB_OK=1
fi

# --- E. RESTORE in a fresh browser profile -------------------------------------------------------------------------------------
WEB_B=0
if [ "$WEB_ON" = 1 ] && [ -n "${CODE:-}" ] && [ -n "${OLD_ID:-}" ]; then
  pw goto "$STACK_URL/" >/dev/null
  pw_run "browser A: back to English" '(async page => { await page.locator("button[lang=\"en\"]").first().click(); await page.waitForFunction(() => document.documentElement.lang === "en"); return "ok"; })' >/dev/null
  WEB_OK=1
  use_browser B
  N_USERS=$(sqlite_count "user")
  if open_hooked "B (a fresh profile)"; then WEB_B=1; fi
  use_browser A
fi
if [ "$WEB_B" = 1 ]; then
  use_browser B
  WEB_OK=1
  if [ "$SESS_B" != "$SESS_A" ]; then pass "browser B is a NEW playwright-cli session ($SESS_B), not the player's ($SESS_A)"; else fail "browser B is a new session"; fi
  pw_run "fresh profile: cookies and storage keys of the new browser" '(async page => JSON.stringify({ cookies: await page.context().cookies(), ...(await page.evaluate(() => ({ local: Object.keys(localStorage).filter((k) => k.startsWith("fc:") && k !== "fc:lang"), session: Object.keys(sessionStorage) }))) }))'
  if [ "$WEB_OK" = 1 ]; then
    if jq -e '(.cookies | length) == 0 and (.local | length) == 0 and (.session | length) == 0' >/dev/null <<<"$PW_OUT"; then pass "fresh profile: clean (no cookie, no fc: storage key, no session storage) at the start"
    else fail "fresh profile: clean at the start" "  state: ${PW_OUT:0:500}"; fi
  fi
  pw_run "restore: the footer link 'Restore my progress' opens /recover" '(async page => {
    await page.getByRole("contentinfo").getByRole("link", { name: "Restore my progress" }).click();
    await page.waitForURL("**/recover");
    await page.getByRole("heading", { name: "Get your progress back" }).waitFor();
    return await page.locator("main").innerText(); })'
  if [ "$WEB_OK" = 1 ]; then
    text_has "restore: the screen says what to type (16 letters and numbers in 4 groups of 4)" "$PW_OUT" "16 letters and numbers in 4 groups of 4"
    assert_eq "$(sqlite_count "user")" "$N_USERS" "db: opening /recover created no session (still $N_USERS users: nothing is created just by opening the page)"
    LOWER=$(tr 'A-Z' 'a-z' <<<"$CODE")
    TYPED="${LOWER:0:4} ${LOWER:5:4}  ${LOWER:10:4} ${LOWER:15:4}"   # small letters, spaces instead of dashes
    pw_run "restore: the code typed in small letters with spaces ('$TYPED') and Restore my progress" '(async page => {
      await page.getByRole("textbox", { name: "Recovery code" }).fill("'"$TYPED"'");
      await page.getByRole("button", { name: "Restore my progress" }).click();
      await page.waitForURL("**/train**");
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      return page.url(); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    NEW_ID=$(sqlite_scalar "SELECT player_id FROM player_profiles WHERE player_id <> '$OTHER_ID'")
    if [ -n "$NEW_ID" ] && [ "$NEW_ID" != "$OLD_ID" ]; then pass "restore: the profile now belongs to the fresh browser's anonymous user (not the old player id)"
    else fail "restore: the profile belongs to the fresh browser's anonymous user" "  old: $OLD_ID  owner now: ${NEW_ID:-none}"; WEB_OK=0; fi
  fi
  if [ "$WEB_OK" = 1 ]; then
    roadmap_text "restored player"
  fi
  if [ "$WEB_OK" = 1 ]; then
    ROADMAP_B=${PW_OUT//$NBSP/ }
    if [ "$ROADMAP_A" = "$ROADMAP_B" ]; then pass "restore: /train/roadmap shows exactly the roadmap of the old session (${#ROADMAP_B} characters, identical)"
    else fail "restore: /train/roadmap shows exactly the roadmap of the old session" "  old: ${ROADMAP_A:0:600}"$'\n'"  new: ${ROADMAP_B:0:600}"; fi
    journey_numbers "restored player"
  fi
  if [ "$WEB_OK" = 1 ]; then
    JOURNEY_B=$PW_OUT
    if [ "$(jq -cS . <<<"$JOURNEY_A")" = "$(jq -cS . <<<"$JOURNEY_B")" ]; then pass "restore: the journey numbers and milestones are the same as before ($(jq -c .metrics <<<"$JOURNEY_B"))"
    else fail "restore: the journey numbers and milestones are the same as before" "  old: ${JOURNEY_A:0:500}"$'\n'"  new: ${JOURNEY_B:0:500}"; fi
  fi
  # what moved, by the database
  if [ -n "${NEW_ID:-}" ] && [ "$NEW_ID" != "$OLD_ID" ]; then
    assert_eq "$(sqlite_scalar "SELECT id FROM roadmaps WHERE player_id = '$NEW_ID'")" "$OLD_ROADMAP_ID" "db: the restored roadmap is the same roadmaps row (moved, not copied)"
    assert_eq "$(sqlite_scalar "SELECT json FROM roadmaps WHERE player_id = '$NEW_ID'")" "$OLD_ROADMAP_JSON" "db: the roadmap JSON is unchanged"
    assert_eq "$(sqlite_count test_results "player_id = '$NEW_ID'")" 5 "db: the 5 test results moved to the new owner"
    assert_eq "$(sqlite_count sessions "player_id = '$NEW_ID' AND finished_at IS NOT NULL")" 1 "db: the finished session moved to the new owner"
    assert_eq "$(sqlite_scalar "SELECT COUNT(*) FROM consents WHERE player_id = '$NEW_ID' AND kind = 'modelImprovement' AND granted = 1")" 1 "db: the consent moved to the new owner"
    OLD_COUNTS=$(player_id_counts "$OLD_ID")
    if [ -n "$OLD_COUNTS" ] && [ "$(awk '{s += $2} END {print s + 0}' <<<"$OLD_COUNTS")" = 0 ]; then pass "the old session no longer owns the data: 0 rows of the old player id in all $(grep -c . <<<"$OLD_COUNTS") tables that have a player_id column"
    else fail "the old session no longer owns the data: 0 rows of the old player id in every table with a player_id column" "  rows left: $(awk '$2 > 0 {printf "%s=%s ", $1, $2}' <<<"$OLD_COUNTS")"; fi
    OTHER_COUNTS=$(player_id_counts "$OTHER_ID")
    if [ "$(awk '$1 == "player_profiles" {print $2}' <<<"$OTHER_COUNTS")" = 1 ] && [ "$(awk '$1 == "test_results" {print $2}' <<<"$OTHER_COUNTS")" = 5 ]; then pass "restore: the other visitor's profile and 5 test results were not touched"
    else fail "restore: the other visitor's rows were not touched" "  $(tr '\n' ' ' <<<"$OTHER_COUNTS")"; fi
    assert_eq "$(sqlite_count recovery_codes "player_id = '$OTHER_ID'")" 1 "restore: the other visitor's recovery code is still its own"
  fi
  # the old session (browser A)
  use_browser A
  if [ -n "${NEW_ID:-}" ]; then
    page_json "old session: GET /api/player/me from the old browser session" "/api/player/me"
    if [ "$WEB_OK" = 1 ]; then
      if jq -e '.status == 404' >/dev/null <<<"$PW_OUT"; then pass "the old session no longer owns the data: GET /api/player/me is 404 (not onboarded) for it"
      else fail "the old session no longer owns the data: GET /api/player/me is 404 for the old session" "  answer: ${PW_OUT:0:500}"; fi
    fi
    page_json "old session: GET /api/player/export from the old browser session" "/api/player/export"
    if [ "$WEB_OK" = 1 ]; then
      if jq -e '.status == 200 and .body.playerId == "'"$OLD_ID"'" and ([.body.tables[] | length] | add) == 0' >/dev/null <<<"$PW_OUT"; then pass "the old session no longer owns the data: its export holds no rows at all"
      else fail "the old session no longer owns the data: its export holds no rows at all" "  answer: ${PW_OUT:0:700}"; fi
    fi
    WEB_OK=1
  fi
  use_browser B
fi

# --- F. DOWNLOAD MY DATA (browser B: the restored player) ----------------------------------------------------------------------
if [ "$WEB_B" = 1 ] && [ -n "${NEW_ID:-}" ] && [ "$NEW_ID" != "$OLD_ID" ]; then
  use_browser B
  WEB_OK=1
  pw goto "$STACK_URL/settings/privacy" >/dev/null
  pw_run "download: /settings/privacy of the restored player shows Model improvement on (the consent came with the data)" '(async page => {
    await page.getByRole("heading", { name: "Your privacy", level: 1 }).waitFor();
    const s = page.getByRole("switch", { name: "Model improvement" });
    await s.waitFor();
    return JSON.stringify({ model: await s.isChecked(), video: await page.getByRole("switch", { name: "Video analysis" }).isChecked() }); })'
  if [ "$WEB_OK" = 1 ]; then
    if jq -e '.model == true and .video == false' >/dev/null <<<"$PW_OUT"; then pass "download: the restored player's switches are Model improvement on, Video analysis off"
    else fail "download: the restored player's switches are Model improvement on, Video analysis off" "  switches: $PW_OUT"; fi
    rm -f "$scratch/export.json"
    pw_run "download: 'Download my data' saves a file" '(async page => {
      const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download my data" }).click()]);
      await dl.saveAs("'"$scratch"'/export.json");
      await page.getByText(/Your file .* was saved/).waitFor();
      return JSON.stringify({ name: dl.suggestedFilename(), status: await page.getByText(/Your file .* was saved/).innerText() }); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    EXPORT=$scratch/export.json
    if jq -e '.name | test("^first-coach-export-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.json$")' >/dev/null <<<"$PW_OUT"; then pass "download: the file is named $(jq -r .name <<<"$PW_OUT") and the page says it was saved"
    else fail "download: the file is named first-coach-export-<date>.json" "  saw: $PW_OUT"; fi
    if [ -s "$EXPORT" ] && jq -e . "$EXPORT" >/dev/null 2>&1; then pass "download: the saved file is valid JSON ($(wc -c <"$EXPORT") bytes)"
    else fail "download: the saved file is valid JSON" "  file: $(head -c 300 "$EXPORT" 2>&1)"; fi
    if jq -e --arg pid "$NEW_ID" '.playerId == $pid and (.tables.player_profiles | length) == 1 and .tables.player_profiles[0].age == 12' "$EXPORT" >/dev/null 2>&1; then pass "download: contains the profile of this player (age 12)"
    else fail "download: contains the profile of this player" "  profile section: $(jq -c '.tables.player_profiles' "$EXPORT" 2>&1 | head -c 400)"; fi
    if jq -e '(.tables.test_results | length) == 5 and ([.tables.test_results[] | select(.skipped == 0) | .test_slug] | sort) == ["ball-mastery-30s","juggling-max-touches"]' "$EXPORT" >/dev/null 2>&1; then pass "download: contains the 5 test results (ball mastery and juggling measured)"
    else fail "download: contains the 5 test results" "  test_results: $(jq -c '.tables.test_results | length' "$EXPORT" 2>&1)"; fi
    if jq -e '(.tables.sessions | length) == 1 and .tables.sessions[0].finished_at != null' "$EXPORT" >/dev/null 2>&1; then pass "download: contains the finished session"
    else fail "download: contains the finished session" "  sessions: $(jq -c '.tables.sessions | length' "$EXPORT" 2>&1)"; fi
    if jq -e '(.tables.session_events | length) >= 2 and ([.tables.session_events[].type] | index("drill_done") != null and index("session_finished") != null)' "$EXPORT" >/dev/null 2>&1; then pass "download: contains the events (drill_done, session_finished; $(jq '.tables.session_events | length' "$EXPORT") rows)"
    else fail "download: contains the events (drill_done, session_finished)" "  types: $(jq -c '[.tables.session_events[].type] | unique' "$EXPORT" 2>&1)"; fi
    if jq -e '(.tables.consents | length) >= 1 and ([.tables.consents[] | select(.kind == "modelImprovement" and .granted == 1)] | length) == 1' "$EXPORT" >/dev/null 2>&1; then pass "download: contains the consents (modelImprovement granted)"
    else fail "download: contains the consents (modelImprovement granted)" "  consents: $(jq -c '.tables.consents' "$EXPORT" 2>&1 | head -c 300)"; fi
    if jq -e '(.readme.about | length) > 0 and (.readme.sections | has("player_profiles") and has("test_results") and has("sessions") and has("session_events") and has("consents"))' "$EXPORT" >/dev/null 2>&1; then pass "download: a README explains each section"
    else fail "download: a README explains each section (profile, test results, sessions, events, consents)" "  readme sections: $(jq -c '.readme.sections | keys' "$EXPORT" 2>&1)"; fi
    # nothing about other players
    if jq -e --arg pid "$NEW_ID" '[.tables[][] | select(has("player_id")) | .player_id] | length > 0 and all(. == $pid)' "$EXPORT" >/dev/null 2>&1; then pass "download: every row that names a player names THIS player, nobody else"
    else fail "download: every row that names a player names this player" "  ids: $(jq -c '[.tables[][] | select(has("player_id")) | .player_id] | unique' "$EXPORT" 2>&1)"; fi
    LEAKS=""
    for needle in "$OTHER_ID" "$OLD_ID" "$(uuid a)" "$(uuid b)" "$(uuid c)" "$(uuid d)" "$(uuid e)" "$OTHER_CODE" "${OTHER_CODE//-/}" "$CODE" "${CODE//-/}" "$HASH"; do
      [ -n "$needle" ] || continue
      grep -qiF -- "$needle" "$EXPORT" && LEAKS+="${needle:0:12}… "
    done
    if [ -z "$LEAKS" ]; then pass "download: nothing about other players (their id, their result ids and recovery code) and no recovery code or hash is in the file"
    else fail "download: nothing about other players and no recovery code or hash" "  found: $LEAKS"; fi
    if ! jq -e '[.. | strings] | any(. == "63" or . == "97")' "$EXPORT" >/dev/null 2>&1 && ! jq -e '[.tables.test_results[].value] | any(. == 63 or . == 97)' "$EXPORT" >/dev/null 2>&1; then pass "download: the other visitor's numbers (63, 97) are not in the test results"
    else fail "download: the other visitor's numbers (63, 97) are not in the test results" "  values: $(jq -c '[.tables.test_results[].value]' "$EXPORT")"; fi
    # the file equals the database
    MISMATCH=""
    for table in player_profiles test_results roadmaps sessions session_events consents recovery_codes; do
      inexport=$(jq --arg t "$table" '.tables[$t] | length' "$EXPORT" 2>/dev/null) indb=$(sqlite_count "$table" "player_id = '$NEW_ID'")
      [ "$inexport" = "$indb" ] || MISMATCH+="$table: file $inexport, db $indb; "
    done
    if [ -z "$MISMATCH" ]; then pass "download: the row count of every section equals the database rows of the player (profile, results, roadmaps, sessions, events, consents, recovery code record)"
    else fail "download: the row count of every section equals the database" "  $MISMATCH"; fi
    PREHASH=$(sqlite_scalar "SELECT code_hash FROM recovery_codes WHERE player_id = '$NEW_ID'")
    if [ -n "$PREHASH" ] && ! grep -qF -- "$PREHASH" "$EXPORT"; then pass "download: the recovery code hash is left out of the file"; else fail "download: the recovery code hash is left out of the file" "  hash '${PREHASH:0:10}…' in file, or none stored"; fi
  fi
  WEB_OK=1
fi

# --- G. DELETE MY DATA (browser B) ----------------------------------------------------------------------------------------------
if [ "$WEB_B" = 1 ] && [ -n "${NEW_ID:-}" ] && [ "$NEW_ID" != "$OLD_ID" ]; then
  use_browser B
  WEB_OK=1
  BEFORE=$(player_id_counts "$NEW_ID")
  FILLED=$(awk '$2 > 0' <<<"$BEFORE" | grep -c .)
  if [ "$FILLED" -ge 5 ]; then pass "delete: before the delete $FILLED tables with a player_id column hold rows of the player ($(awk '$2 > 0 {printf "%s=%s ", $1, $2}' <<<"$BEFORE"))"
  else fail "delete: before the delete at least 5 tables hold rows of the player (the zero check is not vacuous)" "  tables: $(awk '{printf "%s=%s ", $1, $2}' <<<"$BEFORE")"; fi
  USER_BEFORE=$(sqlite_count "user" "id = '$NEW_ID'") SESSIONS_BEFORE=$(sqlite_count "session" "userId = '$NEW_ID'")
  if [ "$USER_BEFORE" = 1 ] && [ "$SESSIONS_BEFORE" -ge 1 ]; then pass "delete: before the delete the auth user and $SESSIONS_BEFORE session(s) exist"; else fail "delete: the auth user and a session exist before the delete" "  user rows $USER_BEFORE, session rows $SESSIONS_BEFORE"; fi
  pw_run "delete: 'Delete my data' opens a confirm dialog that needs the word DELETE" '(async page => {
    await page.getByRole("button", { name: "Delete my data" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const confirm = dialog.getByRole("button", { name: "Yes, delete my data" });
    const before = await confirm.isDisabled();
    await dialog.getByLabel("Type DELETE to confirm").fill("nope");
    const wrong = await confirm.isDisabled();
    return JSON.stringify({ title: await dialog.getByRole("heading").first().innerText(), disabledEmpty: before, disabledWrongWord: wrong }); })'
  if [ "$WEB_OK" = 1 ]; then
    if jq -e '.title == "Delete all my data?" and .disabledEmpty == true and .disabledWrongWord == true' >/dev/null <<<"$PW_OUT"; then pass "delete: the dialog asks 'Delete all my data?' and its confirm button stays disabled until the word DELETE is typed"
    else fail "delete: the dialog asks 'Delete all my data?' and its confirm button is disabled without the word DELETE" "  dialog: $PW_OUT"; fi
    assert_eq "$(sqlite_count player_profiles "player_id = '$NEW_ID'")" 1 "db: opening the dialog and typing a wrong word deleted nothing"
    pw_run "delete: type DELETE and confirm; the app leaves for the landing page" '(async page => {
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
      await dialog.getByRole("button", { name: "Yes, delete my data" }).click();
      await page.waitForURL((url) => url.pathname === "/");
      await page.getByRole("link", { name: "Start training" }).first().waitFor();
      return JSON.stringify(await page.evaluate(() => ({ path: location.pathname, h1: document.querySelector("h1")?.innerText ?? "" }))); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    pass "delete: the app is on the landing page ($(jq -r .path <<<"$PW_OUT"), headline '$(jq -r .h1 <<<"$PW_OUT")')"
    AFTER=$(player_id_counts "$NEW_ID")
    if [ -n "$AFTER" ] && [ "$(awk '{s += $2} END {print s + 0}' <<<"$AFTER")" = 0 ] && [ "$(grep -c . <<<"$AFTER")" = "$(grep -c . <<<"$BEFORE")" ]; then
      pass "delete: ZERO rows of the player id in all $(grep -c . <<<"$AFTER") tables that have a player_id column (introspected from sqlite_master)"
    else fail "delete: zero rows of the player id in every table that has a player_id column" "  rows left: $(awk '$2 > 0 {printf "%s=%s ", $1, $2}' <<<"$AFTER")"; fi
    assert_eq "$(sqlite_count "user" "id = '$NEW_ID'")" 0 "delete: the auth user of the player is gone"
    assert_eq "$(sqlite_count "session" "userId = '$NEW_ID'")" 0 "delete: the auth sessions of the player are gone"
    assert_eq "$(sqlite_count "user")" "$N_USERS" "delete: only the deleted player's user is gone (the other users are untouched, $N_USERS remain)"
    OTHER_AFTER=$(player_id_counts "$OTHER_ID")
    if [ "$(awk '$1 == "player_profiles" {print $2}' <<<"$OTHER_AFTER")" = 1 ] && [ "$(awk '$1 == "test_results" {print $2}' <<<"$OTHER_AFTER")" = 5 ] && [ "$(awk '$1 == "consents" {print $2}' <<<"$OTHER_AFTER")" -ge 1 ]; then pass "delete: the other visitor's data is untouched (profile, 5 test results, consents)"
    else fail "delete: the other visitor's data is untouched" "  $(tr '\n' ' ' <<<"$OTHER_AFTER")"; fi
    # a fresh visitor
    pw_run "fresh visitor: cookies, storage and the API after the delete" '(async page => JSON.stringify({
      cookies: (await page.context().cookies()).map((c) => c.name),
      keys: await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]),
      me: await page.evaluate(async () => (await fetch("/api/player/me")).status) }))'
    if [ "$WEB_OK" = 1 ]; then
      if jq -e '(.cookies | map(select(test("session_token"))) | length) == 0' >/dev/null <<<"$PW_OUT"; then pass "fresh visitor: no session cookie after the delete"
      else fail "fresh visitor: no session cookie after the delete" "  state: $PW_OUT"; fi
      if jq -e --arg p "$NEW_ID" '[.keys[] | select(contains($p) or startswith("fc:draft") or . == "fc:onboarding-draft" or . == "fc:last-player")] | length == 0' >/dev/null <<<"$PW_OUT"; then pass "fresh visitor: no local storage of the deleted player is left (no fc:<player>:*, no drafts, no last-player)"
      else fail "fresh visitor: no local storage of the deleted player is left" "  keys: $(jq -c .keys <<<"$PW_OUT")"; fi
      if jq -e '.me == 401' >/dev/null <<<"$PW_OUT"; then pass "fresh visitor: GET /api/player/me is 401 (no identity)"
      else fail "fresh visitor: GET /api/player/me is 401 (no identity)" "  status: $(jq -r .me <<<"$PW_OUT")"; fi
      assert_eq "$(sqlite_count "user")" "$N_USERS" "fresh visitor: loading the landing page created no new user"
    fi
    pw_run "fresh visitor: the deleted player's export is gone (DELETE answered, the session ended)" '(async page => JSON.stringify(await page.evaluate(async () => (await fetch("/api/player/export")).status)))'
    if [ "$WEB_OK" = 1 ]; then assert_eq "$PW_OUT" 401 "fresh visitor: GET /api/player/export is 401 (the session ended)"; fi
  fi
  WEB_OK=1
fi

# --- H. NETWORK: every request of every page visited went to this stack's origin ------------------------------------------------
if [ "$WEB_ON" = 1 ]; then
  : >"$scratch/net.log"
  use_browser A; net_harvest A
  if [ "$WEB_B" = 1 ]; then use_browser B; net_harvest B; fi
  use_browser A
  ORIGIN=$STACK_URL
  TOTAL=$(grep -c . "$scratch/net.log")
  if [ "$TOTAL" -ge 50 ]; then pass "network: the log holds $TOTAL requests (pages, scripts, styles, images, API calls) across the pages this script visited"
  else fail "network: the log holds enough requests to mean something (>= 50)" "  only $TOTAL"; fi
  HTTPISH=$(awk '{print $2}' "$scratch/net.log" | grep -Ec '^(https?|wss?)://' || true)
  FOREIGN=$(awk '{print $2}' "$scratch/net.log" | grep -E '^(https?|wss?)://' | grep -v -E "^https?://127\.0\.0\.1:${E2E_API_PORT_USED}(/|\$|\?)" | grep -v -E "^wss?://127\.0\.0\.1:${E2E_API_PORT_USED}(/|\$|\?)" || true)
  if [ -z "$FOREIGN" ]; then pass "network: no request to a third-party origin: all $HTTPISH http(s)/ws(s) requests of both browsers went to $ORIGIN"
  else fail "network: no request to a third-party origin (no analytics, no ads, no external fonts)" "  third-party requests: $(sort -u <<<"$FOREIGN" | head -n 12 | tr '\n' ' ')"; fi
  FONTS=$(awk '{print $2}' "$scratch/net.log" | grep -cE '\.woff2?(\?|$)' || true)
  if [ "${FONTS:-0}" -ge 1 ]; then pass "network: the fonts are self-hosted ($FONTS font file requests, all to $ORIGIN: no external font)"
  else fail "network: the log shows the app's fonts loading from its own origin" "  no .woff2 request in the log (a listener that misses font requests proves nothing about external fonts)"; fi
  for page in /legal/privacy /legal/terms /settings/privacy /train/roadmap /progress /feed /api/player/recovery-code /api/player/consents /api/player/export /api/player/me; do
    if grep -qE "^[AB] ${ORIGIN//./\\.}${page}\$" "$scratch/net.log"; then pass "network: the log covers $page"; else fail "network: the log covers $page" "  the page or call was made but is not in the request log"; fi
  done
  if grep -qE "^B ${ORIGIN//./\\.}/api/player/recover\$" "$scratch/net.log"; then pass "network: the log covers the restore call (browser B, /api/player/recover)"; else fail "network: the log covers the restore call" "  POST /api/player/recover is not in the request log of browser B"; fi
  # the code is never in a URL
  if [ -n "${CODE:-}" ] && grep -qiE -e "${CODE//-/}" -e "${CODE}" "$scratch/net.log"; then fail "network: the recovery code is in no request URL" "  found in the log"; else pass "network: the recovery code is in no request URL"; fi
  # the built app itself
  DIST=$E2E_WEB_DIST_USED
  # comments are not requests (the CSS banner names tailwindcss.com); everything else that looks like an origin is
  EXT=$(cat "$DIST/index.html" "$DIST"/assets/*.css 2>/dev/null | perl -0pe 's{/\*.*?\*/}{}gs; s{<!--.*?-->}{}gs' | grep -oE '(https?:)?//[A-Za-z0-9.-]+\.[a-z]{2,}[^"'"'"' )>]*' | grep -vE '^(https?:)?//(www\.)?w3\.org' | sort -u | head -n 10 || true)
  if [ -z "$EXT" ]; then pass "network: the built index.html and CSS name no foreign origin (no external font, script or stylesheet)"
  else fail "network: the built index.html and CSS name no foreign origin" "  found: $(tr '\n' ' ' <<<"$EXT")"; fi
  HOSTS='fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit|google-analytics|googletagmanager|doubleclick|googlesyndication|connect\.facebook|facebook\.net|plausible\.io|posthog|sentry\.io|hotjar|segment\.(io|com)|mixpanel|amplitude\.com|clarity\.ms|yandex\.ru/metrika|mc\.yandex|vk\.com/rtrg'
  TRACK=$(grep -rlE "$HOSTS" "$DIST" 2>/dev/null | head -n 5 || true)
  if [ -z "$TRACK" ]; then pass "network: no analytics, ad or font-CDN host is in the built app"
  else fail "network: no analytics, ad or font-CDN host is in the built app" "  files: $(tr '\n' ' ' <<<"$TRACK")"; fi
fi

# no explicit stop or summary: the EXIT handler stops the stack, prints the summary and sets the exit code
