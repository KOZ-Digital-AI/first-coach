#!/usr/bin/env bash
# apps/web/e2e/j4-progress.sh: slice gate fc-mol-xrj, journey J4 "a player sees measurable progress and retests skills".
# Integration proof on the REAL stack (real API process, real SQLite file with the real seed, the real built web app served by
# the API, a real browser; nothing mocked, no OpenAI key needed). It continues from a player who FINISHED ONE SESSION through
# the UI:
#   0. SETUP   a second visitor (API) onboards first, with numbers of its own, so "no other player's data" is a real check.
#   A. SESSION the player onboards in the browser (age 12, Basic, weak foot, "Ball + wall", yard, 3 days, 20 minutes; baseline
#              juggling 14, wall passing 30, ball mastery 40, weak foot 4; slalom pre-skipped), opens /train, marks every drill
#              done and presses Finish session.
#   B. MY JOURNEY (/progress) one API call (GET /api/player/journey) loads the dashboard; sessions completed 1, minutes trained > 0,
#              streak 1, the FIRST SESSION milestone; the skill tree shows Ball mastery nodes, states told apart by icon AND text.
#   C. RETEST  /progress/retest/juggling-max-touches: protocol, previous result 14, enter 21, "previous 14, today 21, +50%" and a
#              new personal best from ONE POST /api/player/test-results; the second test_result row; /progress shows the delta.
#   D. PLAN    /settings/plan: minutes per session 20 -> 30 (PATCH /api/player/profile) returns a rebuilt roadmap (a new roadmaps
#              row, 30 min/session), and the NEXT session (the next local day; today's finished one is never rewritten) totals
#              within 3 minutes of 30. "Redo baseline" (confirm) calls plan/reset and lands on the wizard's baseline step, the
#              history kept.
#   E. NO RANKING no screen and no answer names a ranking, and none shows the second visitor's data.
# Exit codes (lib.sh): 0 every check passed, 1 at least one FAIL, 3 nothing failed but a check was BLOCKED (no browser,
# E2E_WEB=off, no playwright-cli); E2E_ALLOW_BLOCKED=1 keeps a blocked-only run at 0. BLOCKED is never counted as a pass.
#
# Readings of the criteria where they are open (each is one line of the script):
#   * "the dashboard loads with 1 API call": every /api/* request the browser makes from the navigation to /progress until the
#     dashboard (its Skill tree heading) is on the page, except the Better Auth session READS (GET /api/auth/get-session: no
#     player data, they only read the cookie). J4_DASHBOARD_BUDGET / J4_RETEST_BUDGET below are constants of the criteria.
#   * "the next session's total is within 3 minutes of 30": today's session is FINISHED, and a plan change never rewrites a
#     finished session (PATCH drops only today's unfinished one), so the next session is the one of the next local day. The
#     script pins the browser to UTC-12 (TZ=Etc/GMT+12) and asks GET /api/player/today for the local day of UTC+14
#     (X-Timezone: Etc/GMT-14), which is a later calendar day at every hour of the real clock. That call is made from the
#     signed-in browser page (its own cookie).
#   * "mastered / training now / locked": a node is mastered only with >= 3 completed drills, which one session cannot give, so
#     what a player who has finished one session sees are the training and locked nodes; the distinction by icon and text is
#     asserted for every state that is on the page, and the mastered look is asserted where a mastered node exists (see below).
#   * "retest 1 call" (the contract's budget): what is asserted is ONE write (POST /api/player/test-results, the batch endpoint) and
#     at most one more call, the re-read of GET /api/player/journey the retest screen makes after the save; the comparison
#     itself is built from the POST's answer. A stricter "exactly 1 request in all" is not in this gate's criteria.
#   * "sees 'previous 14 -> today 21, +50%'": the screen shows the previous result, today's result and the signed percentage as
#     three labelled pieces; the script checks the pieces (and the API row) rather than one glued string.
#   * "no ranking": no screen text or API key names a ranking, a leaderboard or a percentile, and the second visitor's
#     numbers and id appear nowhere in this player's screens or answers.
# Fail-slow (no set -e): every step reports. Cleanup: e2e_defer (never `trap ... EXIT` after sourcing lib.sh).
# Ports: the API gets a free kernel-assigned port (lib.sh start_stack); nothing is ever bound to :4111 or :5173 and no
# process this script did not start is touched. The browser session name is unique per run (E2E_SESSION).
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$HERE/lib.sh"

J4_DASHBOARD_BUDGET=1
J4_RETEST_BUDGET=1
NBSP=$(printf '\xc2\xa0')   # innerText renders the spaces inside "4 weeks" etc. as no-break spaces
SPORT=football
NEXT_DAY_ZONE=Etc/GMT-14   # UTC+14: the next local day, whatever the hour
BROWSER_ZONE=Etc/GMT+12    # UTC-12: the earliest local day
unset SEED_DIR   # the API must start on the repo's default seed

scratch=$(mktemp -d "${TMPDIR:-/tmp}/j4-gate.XXXXXX") || exit 1
e2e_defer 'rm -rf -- "$scratch"'

# --- small helpers (the house helpers of j2-onboarding.sh) ------------------------------------------------------------------
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
# api_calls <since-index>: the /api requests of the browser session after request number <since-index>, one "METHOD path status"
# per line, the Better Auth session READS left out (they carry no player data).
api_calls() {
  pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[([A-Z]+)\] https?:\/\/[^\/]+(\/api\/[^ ?]*)[^ ]* => \[([0-9]+)\].*/\1 \2 \3 \4/p' |
    awk -v since="$1" '$1 > since && $3 != "/api/auth/get-session" { print $2, $3, $4 }'
}
last_request_index() { pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[.*/\1/p' | sort -n | tail -n1; }
page_text() { # <label>: the visible text of the page body, left in PW_OUT
  pw_run "$1" '(async page => await page.locator("body").innerText())'
}
page_json() { # <label> <path> [zone]: GET <path> from the signed-in browser page (its own cookie); PW_OUT = {"status":..,"body":..}
  pw_run "$1" '(async page => JSON.stringify(await page.evaluate(async ([path, zone]) => {
    const x = await fetch(path, { headers: zone ? { "X-Timezone": zone } : {} });
    return { status: x.status, body: await x.json() }; }, ["'"$2"'", "'"${3-}"'"])))'
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
# the ranking / other-player scan of one screen's text
RANKING_RE='\brank(ing|ings|ed|s)?\b|leaderboard|leader board|percentile|\btop [0-9]+\b|other players|other kids|other users|other athletes|players like you|of all players|better than [0-9]+ ?%'
no_ranking() { # <screen label> <text>
  local hay=${2//$NBSP/ }
  if grep -qiE "$RANKING_RE" <<<"$hay"; then fail "$1: no ranking, leaderboard or percentile" "  matched: $(grep -ioE "$RANKING_RE" <<<"$hay" | head -n3 | tr '\n' ' ')"
  else pass "$1: no ranking, leaderboard or percentile"; fi
  if grep -qE "(^|[^0-9])(63|97)([^0-9]|\$)" <<<"$hay" || grep -qF "$OTHER_ID" <<<"$hay"; then fail "$1: none of the other visitor's data (its 63 / 97 or its id)" "  saw: ${hay:0:600}"
  else pass "$1: none of the other visitor's data (its 63 / 97 or its id)"; fi
}

# ============================================================================================================================
start_stack || exit 1
assert_api /health '.ok == true and .database == "ok"' -l "stack: /health ok on the temp DB (port $E2E_API_PORT_USED, own media dir)"
assert_eq "$(sqlite_count sports "slug = '$SPORT'")" 1 "the real seed is loaded (sport $SPORT)"
assert_eq "$(sqlite_count skill_tests)" 5 "the real seed holds the 5 skill tests"
assert_eq "$(sqlite_count player_profiles)" 0 "start state: no player profile yet"
fetch - GET "/api/onboarding/$SPORT?locale=en"
OPTIONS=$F_BODY

# --- 0. the other visitor (API): its data must never reach the browser player ---------------------------------------------------
sign_in "other visitor"
OTHER_COOKIE=$V_COOKIE OTHER_ID=$V_ID
if [ -n "$OTHER_COOKIE" ]; then
  fetch "$OTHER_COOKIE" POST /api/player/start "$(other_body)"
  chk "setup: the other visitor onboards through the API (juggling 63, ball mastery 97)" 200 '.profile.age == 9 and (.roadmap.tracks | length) == 5'
fi
assert_eq "$(sqlite_count player_profiles)" 1 "setup: exactly the other visitor's profile exists before the browser player starts"

# --- A. the browser player onboards and finishes one session -------------------------------------------------------------------
WEB_ON=0
if [ "$E2E_WEB" != api ]; then
  blocked "web journey (onboarding, session, journey, retest, plan settings)" "E2E_WEB=$E2E_WEB: the web app is not served"
elif ! pw_available; then
  blocked "web journey (onboarding, session, journey, retest, plan settings)" "playwright-cli is not installed"
elif TZ=$BROWSER_ZONE pw_open /; then
  WEB_ON=1
fi   # pw_open itself recorded BLOCKED (no usable browser) or FAIL

if [ "$WEB_ON" = 1 ]; then
  WEB_OK=1
  pw resize 1280 1800 >/dev/null   # tall: nothing needs scrolling under the sticky header
  pw_run "the browser runs in the pinned time zone $BROWSER_ZONE" '(async page => await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone))'
  assert_eq "$PW_OUT" "$BROWSER_ZONE" "the browser's IANA zone is $BROWSER_ZONE (the API sees it in X-Timezone)"

  pw_run "landing: START TRAINING leads to the sign-in gate, and Start opens the wizard" '(async page => {
    await page.getByRole("link", { name: "Start training" }).first().click();
    await page.waitForURL("**/account/sign-in**");
    await page.getByRole("button", { name: "Start training" }).click();
    await page.waitForURL("**/train/onboarding");
    await page.getByRole("heading", { name: "A few questions to get started" }).waitFor();
    return page.url(); })'
  [ "$WEB_OK" = 1 ] && run_wizard 15 Intermediate "Control the ball with confidence" "Ball only" "Home 3×3 m" "No" 3 "20 min"
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
    PLAYER_ID=$(sqlite_scalar "SELECT player_id FROM player_profiles WHERE player_id <> '$OTHER_ID'")
    if [ -n "$PLAYER_ID" ]; then pass "the browser player has its own profile (a second one next to the other visitor's)"; else fail "the browser player has its own profile"; WEB_OK=0; fi
    assert_eq "$(sqlite_scalar "SELECT value FROM test_results WHERE player_id = '$PLAYER_ID' AND test_slug = 'juggling-max-touches'")" 14 "db: the juggling baseline entered in the wizard is stored as 14"
    assert_eq "$(sqlite_count test_results "player_id = '$PLAYER_ID' AND test_slug = 'juggling-max-touches'")" 1 "db: one juggling result so far (the baseline)"
    assert_eq "$(sqlite_count test_results "player_id = '$PLAYER_ID'")" 5 "db: 5 baseline rows (juggling 14, ball mastery 40, 3 skipped)"
    assert_eq "$(sqlite_scalar "SELECT json_extract(json, '\$.minutesPerSession') FROM roadmaps WHERE player_id = '$PLAYER_ID'")" 20 "db: the roadmap starts at 20 minutes per session"
  fi
fi

if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw goto "$STACK_URL/train" >/dev/null
  pw_run "session: /train lists today's drills" '(async page => {
    await page.getByRole("heading", { name: /min today/ }).waitFor();
    return await page.getByRole("list", { name: "Today'"'"'s drills" }).getByRole("listitem").count(); })'
  DRILLS=$PW_OUT
  if [ "$WEB_OK" = 1 ] && [ "${DRILLS:-0}" -ge 1 ] 2>/dev/null; then pass "session: $DRILLS drills in today's session"; else fail "session: at least one drill in today's session" "  count: ${DRILLS:-none}"; WEB_OK=0; fi
fi
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
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
  if [ "$WEB_OK" = 1 ]; then
    assert_eq "$(sqlite_count session_events "player_id = '$PLAYER_ID' AND type = 'drill_done'")" "$DRILLS" "db: one drill_done event per drill ($DRILLS)"
    pw_run "session: Finish session saves the session and opens the summary" '(async page => {
      await page.getByRole("button", { name: "Finish session" }).click();
      await page.waitForURL("**/train/summary");
      await page.getByRole("heading", { name: "Session complete" }).waitFor();
      return await page.locator("main").innerText(); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    assert_eq "$(sqlite_count sessions "player_id = '$PLAYER_ID' AND finished_at IS NOT NULL")" 1 "db: exactly one finished session for the player"
    assert_eq "$(sqlite_count session_events "player_id = '$PLAYER_ID' AND type = 'session_finished'")" 1 "db: one session_finished event"
    SUMMARY_TEXT=$PW_OUT
    SESSION_ID=$(sqlite_scalar "SELECT id FROM sessions WHERE player_id = '$PLAYER_ID'")
    SESSION_DATE=$(sqlite_scalar "SELECT date FROM sessions WHERE player_id = '$PLAYER_ID'")
    BM_DONE=$(sqlite_scalar "SELECT count(*) FROM sessions s, json_each(s.items) j JOIN drill_versions v ON v.id = json_extract(j.value, '\$.drillVersionId') JOIN drill_skills ds ON ds.drill_id = v.drill_id AND ds.is_primary = 1 JOIN skills sk ON sk.id = ds.skill_id WHERE s.player_id = '$PLAYER_ID' AND json_extract(j.value, '\$.done') = 1 AND sk.slug = 'ball-mastery'")
    if [ "${BM_DONE:-0}" -ge 3 ] 2>/dev/null; then pass "db: $BM_DONE Ball mastery drills finished in the session (a node needs 3 to be mastered)"
    else fail "db: at least 3 Ball mastery drills finished in the session (a node needs 3 to be mastered)" "  got: ${BM_DONE:-none}"; fi
  fi
fi

# --- B. MY JOURNEY ---------------------------------------------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw goto "$STACK_URL/progress" >/dev/null   # a full navigation: playwright-cli's request list restarts with it, so every request of the load is counted
  pw_run "journey: /progress shows MY JOURNEY with the skill tree" '(async page => {
    await page.getByRole("heading", { name: "My journey", level: 1 }).waitFor();
    await page.getByRole("heading", { name: "Skill tree" }).waitFor();
    await page.waitForLoadState("networkidle");
    return await page.locator("main").innerText(); })'
  if [ "$WEB_OK" = 1 ]; then
    JOURNEY_TEXT=$PW_OUT
    calls=$(api_calls 0); ncalls=$(grep -c . <<<"$calls"); summary=$(tr '\n' ';' <<<"$calls" | sed 's/;/; /g')
    if grep -q '^GET /api/player/journey 200' <<<"$calls"; then pass "call budget: the dashboard is fed by GET /api/player/journey (observed: $summary)"
    else fail "call budget: the dashboard is fed by GET /api/player/journey" "  observed /api calls: ${summary:-none}"; fi
    if [ "$ncalls" -eq "$J4_DASHBOARD_BUDGET" ]; then pass "call budget: the dashboard loads with $ncalls API call (= $J4_DASHBOARD_BUDGET; Better Auth session reads not counted)"
    else fail "call budget: the dashboard loads with $J4_DASHBOARD_BUDGET API call, got $ncalls" "  observed (Better Auth get-session reads not counted): ${summary:-none}"; fi
    session_reads=$(pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[([A-Z]+)\] https?:\/\/[^\/]+(\/api\/[^ ?]*)[^ ]* => \[([0-9]+)\].*/\2 \3 \4/p' | grep -c '^GET /api/auth/get-session ')
    if [ "$session_reads" -eq 1 ]; then pass "gate: /progress makes exactly 1 GET /api/auth/get-session (the gate reuses the shell's session read)"
    else fail "gate: /progress makes exactly 1 GET /api/auth/get-session (the gate reuses the shell's session read)" "  observed $session_reads session reads"; fi

    pw_run "journey: the four metric cards" '(async page => JSON.stringify(await page.evaluate(() => Object.fromEntries([...document.querySelector("main dl").children].map((d) => [d.querySelector("dt").innerText, d.querySelector("dd").innerText])))))'
    if [ "$WEB_OK" = 1 ]; then
      METRICS=$PW_OUT
      if jq -e '.["Sessions completed"] == "1"' >/dev/null <<<"$METRICS"; then pass "journey: sessions completed shows 1"; else fail "journey: sessions completed shows 1" "  metrics: $METRICS"; fi
      if jq -e '(.["Minutes trained"] | tonumber) > 0' >/dev/null <<<"$METRICS"; then pass "journey: minutes trained is above 0 ($(jq -r '.["Minutes trained"]' <<<"$METRICS"))"; else fail "journey: minutes trained is above 0" "  metrics: $METRICS"; fi
      if jq -e '.["Current streak (days)"] == "1"' >/dev/null <<<"$METRICS"; then pass "journey: current streak shows 1"; else fail "journey: current streak shows 1" "  metrics: $METRICS"; fi
    fi
    pw_run "journey: the milestone badges (achieved and upcoming)" '(async page => JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("section[aria-labelledby=journey-milestones] li[data-state]")].map((li) => ({ state: li.dataset.state, text: li.innerText.replace(/\s+/g, " ").trim() })))))'
    if [ "$WEB_OK" = 1 ]; then
      if jq -e 'map(select(.state == "achieved" and (.text | startswith("First session finished"))) ) | length == 1' >/dev/null <<<"$PW_OUT"; then pass "journey: the FIRST SESSION milestone is achieved ('First session finished', with its date)"
      else fail "journey: the FIRST SESSION milestone is achieved" "  badges: $PW_OUT"; fi
      if jq -e 'map(select(.state == "upcoming")) | length >= 1 and all(.[]; .text | contains("Coming up"))' >/dev/null <<<"$PW_OUT"; then pass "journey: the other milestones read 'Coming up' (achieved and upcoming told apart by words)"
      else fail "journey: the other milestones read 'Coming up'" "  badges: $PW_OUT"; fi
    fi
    pw_run "journey: the skill tree, node by node (state, icon, words)" '(async page => JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("section[aria-labelledby=journey-tree] > ul > li")].map((track) => ({
      track: track.querySelector("h3").innerText.trim(),
      nodes: [...track.querySelectorAll("ol > li")].map((li) => ({ state: li.dataset.state, text: li.innerText.replace(/\s+/g, " ").trim(), icon: li.querySelector("svg").innerHTML }))})))))'
    if [ "$WEB_OK" = 1 ]; then
      TREE=$PW_OUT
      if jq -e 'length == 5 and (map(.track) | index("Ball mastery")) != null' >/dev/null <<<"$TREE"; then pass "tree: 5 tracks, Ball mastery among them"; else fail "tree: 5 tracks, Ball mastery among them" "  tree: ${TREE:0:900}"; fi
      BM=$(jq -c '.[] | select(.track == "Ball mastery")' <<<"$TREE")
      if jq -e '.nodes | length >= 3' >/dev/null <<<"$BM"; then pass "tree: Ball mastery lists its nodes in order ($(jq -r '[.nodes[].text | sub(" (Mastered|Training now|Locked)$"; "")] | join(", ")' <<<"$BM"))"
      else fail "tree: Ball mastery lists at least 3 nodes" "  ball mastery: ${BM:0:900}"; fi
      if jq -e '[.nodes[].state] | unique == ["locked","mastered","training"]' >/dev/null <<<"$BM"; then pass "tree: Ball mastery shows all three states (mastered, training now, locked)"
      else fail "tree: Ball mastery shows all three states (mastered, training now, locked)" "  states: $(jq -c '[.nodes[].state]' <<<"$BM")"; fi
      if jq -e '[.nodes[].state] as $s | ($s | index("mastered")) < ($s | index("training")) and ($s | index("training")) < ($s | index("locked"))' >/dev/null <<<"$BM"; then pass "tree: in Ball mastery the mastered node comes first, then the one training now, then the locked ones"
      else fail "tree: mastered, then training now, then locked" "  states: $(jq -c '[.nodes[].state]' <<<"$BM")"; fi
      if jq -e 'all(.nodes[]; (.state == "mastered" and (.text | endswith(" Mastered"))) or (.state == "training" and (.text | endswith(" Training now"))) or (.state == "locked" and (.text | endswith(" Locked"))))' >/dev/null <<<"$BM"; then pass "tree: each node says its state in words (Mastered / Training now / Locked), not by colour alone"
      else fail "tree: each node says its state in words" "  nodes: ${BM:0:900}"; fi
      if jq -e '[.nodes | group_by(.state)[] | map(.icon) | unique] as $g | ($g | length) == 3 and all($g[]; length == 1) and ([$g[][0]] | unique | length) == 3 and (.nodes | all(.[]; .icon | length > 0))' >/dev/null <<<"$BM"; then pass "tree: the three states have three different icons (one icon per state, the same for every node of a state)"
      else fail "tree: the three states have three different icons" "  icons: $(jq -c '[.nodes[] | {state, icon}] | unique' <<<"$BM")"; fi
      if jq -e 'all(.[]; any(.nodes[]; .state == "training"))' >/dev/null <<<"$TREE"; then pass "tree: every track has a node training now (the next step is always visible)"
      else fail "tree: every track has a node training now" "  tree: ${TREE:0:900}"; fi
      page_json "journey: GET /api/player/journey answers the same tree the screen shows" "/api/player/journey?locale=en"
      if [ "$WEB_OK" = 1 ]; then
        API_TREE=$(jq -c '[.body.tree[].nodes[].state]' <<<"$PW_OUT") DOM_TREE=$(jq -c '[.[].nodes[].state]' <<<"$TREE")
        if [ "$API_TREE" = "$DOM_TREE" ] && [ "$(jq -r .status <<<"$PW_OUT")" = 200 ]; then pass "tree: the states on the screen are exactly the API's (mastered, training, locked per node)"
        else fail "tree: the states on the screen are exactly the API's" "  api: $API_TREE"$'\n'"  dom: $DOM_TREE"; fi
        if jq -e '.body.metrics.sessionsCompleted == 1 and .body.metrics.minutesTrained > 0 and .body.metrics.streakDays == 1 and ([.body.milestones[] | select(.key == "FIRST_SESSION" and .achievedAt != null)] | length) == 1' >/dev/null <<<"$PW_OUT"; then pass "api: the journey answer holds sessionsCompleted 1, minutesTrained > 0, streakDays 1 and FIRST_SESSION with its date"
        else fail "api: the journey answer holds sessionsCompleted 1, minutesTrained > 0, streakDays 1 and FIRST_SESSION" "  answer: ${PW_OUT:0:900}"; fi
      fi
    fi
    no_ranking "screen /progress" "$JOURNEY_TEXT"
    text_has "screen /progress: says the player is compared only with their own earlier results" "$JOURNEY_TEXT" "compared only with your own earlier results"
  fi
fi

# --- C. RETEST juggling: baseline 14 -> 21 ---------------------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw goto "$STACK_URL/progress/retest/juggling-max-touches" >/dev/null
  pw_run "retest: /progress/retest/juggling-max-touches shows the protocol and the previous result" '(async page => {
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.getByText("Your previous result:").waitFor();
    return JSON.stringify({ text: await page.locator("main").innerText(), steps: await page.locator("main ol li").count() }); })'
  if [ "$WEB_OK" = 1 ]; then
    RETEST_TEXT=$(jq -r .text <<<"$PW_OUT") STEPS=$(jq -r .steps <<<"$PW_OUT")
    text_has "retest: the screen is the skill check of this test (eyebrow 'Skill check')" "$RETEST_TEXT" "Skill check"
    text_has "retest: the protocol block ('How to do it')" "$RETEST_TEXT" "How to do it"
    if [ "$STEPS" -ge 1 ]; then pass "retest: the protocol lists $STEPS step(s)"; else fail "retest: the protocol lists at least 1 step" "  steps: $STEPS"; fi
    text_has "retest: the previous result is the baseline, 14" "$(tr -s '[:space:]' ' ' <<<"$RETEST_TEXT")" "Your previous result: 14"
    text_has "retest: names the numeric box" "$RETEST_TEXT" "Your result today"
    since=$(last_request_index); since=${since:-0}
    pw_run "retest: enter 21 and press Save result" '(async page => {
      await page.getByRole("textbox", { name: "Your result today" }).fill("21");
      await page.getByRole("button", { name: "Save result" }).click();
      await page.getByRole("heading", { name: "Your result is saved" }).waitFor();
      await page.waitForLoadState("networkidle");
      return await page.locator("main").innerText(); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    SAVED=${PW_OUT//$NBSP/ } SAVED_FLAT=$(tr -s '[:space:]' ' ' <<<"${PW_OUT//$NBSP/ }")
    text_has "retest: the comparison shows the previous result 14" "$SAVED_FLAT" "Your previous result: 14"
    text_has "retest: the comparison shows today's result 21" "$SAVED_FLAT" "Today: 21"
    text_has "retest: the comparison shows +50%" "$SAVED_FLAT" "+50%"
    text_has "retest: the change is worded, not only signed ('Better than last time')" "$SAVED_FLAT" "Better than last time"
    text_has "retest: a new personal best is announced (21)" "$SAVED_FLAT" "New personal best: 21"
    no_ranking "screen /progress/retest/juggling-max-touches" "$SAVED"
    calls=$(api_calls "$since"); ncalls=$(grep -c . <<<"$calls"); summary=$(tr '\n' ';' <<<"$calls" | sed 's/;/; /g')
    if grep -q '^POST /api/player/test-results 200' <<<"$calls"; then pass "call budget: the retest is sent with POST /api/player/test-results (observed: $summary)"
    else fail "call budget: the retest is sent with POST /api/player/test-results" "  observed /api calls: ${summary:-none}"; fi
    nwrites=$(grep -vc '^GET ' <<<"$calls")
    if [ "$nwrites" -eq "$J4_RETEST_BUDGET" ]; then pass "call budget: saving the retest is $nwrites write call (= $J4_RETEST_BUDGET, the batch endpoint, one request for the result)"
    else fail "call budget: saving the retest is $J4_RETEST_BUDGET write call, got $nwrites" "  observed (Better Auth get-session reads not counted): ${summary:-none}"; fi
    if [ "$ncalls" -le "$((J4_RETEST_BUDGET + 1))" ]; then pass "call budget: the whole save, comparison included, is at most $ncalls calls (one write + the journey re-read; nothing per result)"
    else fail "call budget: the save is one write plus at most one re-read of the journey, got $ncalls calls" "  observed (Better Auth get-session reads not counted): ${summary:-none}"; fi

    assert_eq "$(sqlite_count test_results "player_id = '$PLAYER_ID' AND test_slug = 'juggling-max-touches'")" 2 "db: sqlite_count shows the second juggling test_result"
    assert_eq "$(sqlite_scalar "SELECT group_concat(CAST(value AS INTEGER), ',') FROM (SELECT value FROM test_results WHERE player_id = '$PLAYER_ID' AND test_slug = 'juggling-max-touches' ORDER BY id)")" "14,21" "db: the two juggling rows are 14 (baseline) then 21 (retest)"
    assert_eq "$(sqlite_count test_results "player_id = '$PLAYER_ID' AND skipped = 0 AND test_slug = 'juggling-max-touches'")" 2 "db: both juggling rows are measurements (not skipped)"
    assert_eq "$(sqlite_count roadmaps "player_id = '$PLAYER_ID'")" 2 "db: the retest rebuilt and stored the roadmap (2 rows: baseline, retest)"
    page_json "retest: GET /api/player/journey after the retest" "/api/player/journey?locale=en"
    if [ "$WEB_OK" = 1 ]; then
      if jq -e '.status == 200 and ([.body.tests[] | select(.testSlug == "juggling-max-touches")] | .[0] | .previous == 14 and .latest == 21 and .changePct == 50 and .personalBest == 21 and (.history | map(.value)) == [14, 21])' >/dev/null <<<"$PW_OUT"; then pass "api: juggling shows previous 14, latest 21, changePct 50, personalBest 21, history [14, 21]"
      else fail "api: juggling shows previous 14, latest 21, changePct 50, personalBest 21" "  answer: ${PW_OUT:0:900}"; fi
      if jq -e '[.body | .. | objects | keys[]] | map(test("rank|leaderboard|percentile|position|peer|cohort|other|player"; "i")) | any | not' >/dev/null <<<"$PW_OUT"; then pass "api: the player's journey answer holds no ranking-like key (rank, leaderboard, percentile, peer, other players)"
      else fail "api: the player's journey answer holds no ranking-like key" "  answer: ${PW_OUT:0:900}"; fi
      if jq -e '([.body.milestones[] | select(.key == "FIRST_RETEST" and .achievedAt != null)] | length) == 1 and .body.metrics.skillsImproving >= 1' >/dev/null <<<"$PW_OUT"; then pass "api: the FIRST_RETEST milestone is achieved and a skill is improving"
      else fail "api: the FIRST_RETEST milestone is achieved and a skill is improving" "  answer: ${PW_OUT:0:900}"; fi
    fi
  fi
  if [ "$WEB_OK" = 1 ]; then
    pw goto "$STACK_URL/progress" >/dev/null
    pw_run "journey after the retest: the skill check shows the delta" '(async page => {
      await page.getByRole("heading", { name: "Skill checks" }).waitFor();
      await page.waitForLoadState("networkidle");
      return await page.locator("main").innerText(); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    AFTER_FLAT=$(tr -s '[:space:]' ' ' <<<"${PW_OUT//$NBSP/ }")
    text_has "journey after the retest: last time 14 touches" "$AFTER_FLAT" "Last time 14"
    text_has "journey after the retest: now 21 touches" "$AFTER_FLAT" "Now 21"
    text_has "journey after the retest: the signed percentage +50%" "$AFTER_FLAT" "+50% Better than last time"
    text_has "journey after the retest: the personal best 21" "$AFTER_FLAT" "Personal best 21"
    text_has "journey after the retest: the FIRST RETEST milestone shows as achieved" "$AFTER_FLAT" "First retest done Achieved"
    no_ranking "screen /progress after the retest" "$PW_OUT"
  fi
fi

# --- D. PLAN SETTINGS: minutes 20 -> 30, then Redo baseline ----------------------------------------------------------------------
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  ROADMAPS_BEFORE=$(sqlite_count roadmaps "player_id = '$PLAYER_ID'")
  pw goto "$STACK_URL/settings/plan" >/dev/null
  pw_run "plan settings: /settings/plan shows the current plan (20 minutes chosen)" '(async page => {
    await page.getByRole("heading", { name: "Plan settings", level: 1 }).waitFor();
    const group = page.getByRole("group", { name: "Minutes per session" });
    await group.waitFor();
    return JSON.stringify({ checked: await group.getByRole("radio", { checked: true }).evaluate((r) => r.closest("label").innerText.trim()), text: await page.locator("main").innerText() }); })'
  if [ "$WEB_OK" = 1 ]; then
    PLAN_TEXT=$(jq -r .text <<<"$PW_OUT")
    assert_eq "$(jq -r .checked <<<"$PW_OUT")" "20 min" "plan settings: 20 min is the chosen minutes per session"
    no_ranking "screen /settings/plan" "$PLAN_TEXT"
    pw_run "plan settings: choose 30 min and press Save changes" '(async page => {
      await page.getByRole("group", { name: "Minutes per session" }).getByText("30 min", { exact: true }).click();
      await page.getByRole("button", { name: "Save changes" }).click();
      await page.getByRole("heading", { name: "Plan updated" }).waitFor();
      await page.waitForLoadState("networkidle");
      return JSON.stringify({ text: await page.locator("main").innerText(), focus: await page.getByRole("list", { name: "Focus skills" }).getByRole("listitem").count() }); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    text_has "plan settings: 'Plan updated' with the rebuilt roadmap focus" "$(jq -r .text <<<"$PW_OUT")" "Your plan is rebuilt"
    FOCUS_N=$(jq -r .focus <<<"$PW_OUT"); if [ "$FOCUS_N" -ge 2 ] && [ "$FOCUS_N" -le 3 ]; then pass "plan settings: the rebuilt roadmap lists $FOCUS_N focus skills"; else fail "plan settings: the rebuilt roadmap lists 2-3 focus skills" "  got $FOCUS_N"; fi
    assert_eq "$(sqlite_scalar "SELECT minutes_per_session FROM player_profiles WHERE player_id = '$PLAYER_ID'")" 30 "db: the profile now holds 30 minutes per session"
    assert_eq "$(sqlite_scalar "SELECT age || '/' || equipment || '/' || space || '/' || partner || '/' || days_per_week || '/' || goal FROM player_profiles WHERE player_id = '$PLAYER_ID'")" "15/ball/home_3x3/0/3/control" "db: the other profile fields are untouched (only minutes changed)"
    assert_eq "$(sqlite_count roadmaps "player_id = '$PLAYER_ID'")" "$((ROADMAPS_BEFORE + 1))" "db: the change stored a rebuilt roadmap (one more row, history kept)"
    assert_eq "$(sqlite_scalar "SELECT json_extract(json, '\$.minutesPerSession') FROM roadmaps WHERE player_id = '$PLAYER_ID' ORDER BY created_at DESC, id DESC LIMIT 1")" 30 "db: the newest roadmap says 30 minutes per session"
    assert_eq "$(sqlite_count sessions "player_id = '$PLAYER_ID' AND finished_at IS NOT NULL AND id = '$SESSION_ID'")" 1 "db: the finished session is kept (only today's UNFINISHED session is ever dropped)"
    page_json "plan settings: the next session (next local day, $NEXT_DAY_ZONE) is composed from the rebuilt roadmap" "/api/player/today?locale=en" "$NEXT_DAY_ZONE"
  fi
  if [ "$WEB_OK" = 1 ]; then
    if jq -e '.status == 200 and .body.roadmapSummary.minutesPerSession == 30 and .body.id != "'"$SESSION_ID"'" and (.body.items | length) >= 1' >/dev/null <<<"$PW_OUT"; then pass "next session: a new session (not the finished one) built on the 30-minute roadmap"
    else fail "next session: a new session built on the 30-minute roadmap" "  answer: ${PW_OUT:0:900}"; fi
    TOTAL=$(jq -r '.body.totalMinutes // 0' <<<"$PW_OUT")
    if jq -e '.body.totalMinutes >= 27 and .body.totalMinutes <= 33' >/dev/null <<<"$PW_OUT"; then pass "next session: total $TOTAL minutes, within 3 of 30"
    else fail "next session: total within 3 minutes of 30" "  totalMinutes: $TOTAL"; fi
    page_json "plan settings: today (the browser's own day, $BROWSER_ZONE) still answers the finished session" "/api/player/today?locale=en" "$BROWSER_ZONE"
    if [ "$WEB_OK" = 1 ]; then
      if jq -e '.status == 200 and .body.id == "'"$SESSION_ID"'" and ([.body.items[] | select(.done)] | length) == ([.body.items[]] | length)' >/dev/null <<<"$PW_OUT"; then pass "today: the finished session is unchanged by the plan change (same id, every drill still done)"
      else fail "today: the finished session is unchanged by the plan change" "  answer: ${PW_OUT:0:700}"; fi
    fi
  fi

  # Redo baseline: the confirmation guards the reset
  if [ "$WEB_OK" = 1 ]; then
    TESTS_BEFORE=$(sqlite_count test_results "player_id = '$PLAYER_ID'") ROADMAPS_BEFORE=$(sqlite_count roadmaps "player_id = '$PLAYER_ID'")
    pw goto "$STACK_URL/settings/plan" >/dev/null
    pw_run "redo baseline: the button opens a confirmation, Keep my plan closes it, nothing is reset" '(async page => {
      await page.getByRole("button", { name: "Redo baseline" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Redo your baseline?").waitFor();
      const body = await dialog.innerText();
      await dialog.getByRole("button", { name: "Keep my plan" }).click();
      await dialog.waitFor({ state: "hidden" });
      return JSON.stringify({ body, url: page.url() }); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    text_has "redo baseline: the dialog says the plan is cleared and the earlier results stay" "$(jq -r .body <<<"$PW_OUT")" "Your earlier test results and history stay"
    assert_eq "$(sqlite_count roadmaps "player_id = '$PLAYER_ID'")" "$ROADMAPS_BEFORE" "db: cancelling the dialog reset nothing (roadmaps unchanged)"
    pw_run "redo baseline: confirm 'Yes, redo baseline' and land on the baseline step" '(async page => {
      await page.getByRole("button", { name: "Redo baseline" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Yes, redo baseline" }).click();
      await page.waitForURL("**/train/onboarding");
      await page.getByRole("heading", { name: "Quick skill tests" }).waitFor();
      return JSON.stringify({ url: page.url(), setupVisible: await page.getByRole("heading", { name: "Your training conditions" }).count(), firstStepVisible: await page.getByRole("spinbutton", { name: "Age" }).count(), text: await page.locator("main").innerText() }); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    if jq -e '(.url | endswith("/train/onboarding")) and .setupVisible == 0 and .firstStepVisible == 0' >/dev/null <<<"$PW_OUT"; then pass "redo baseline: the wizard opens on its baseline step (Quick skill tests), not on the first question"
    else fail "redo baseline: the wizard opens on its baseline step" "  answer: ${PW_OUT:0:700}"; fi
    assert_eq "$(sqlite_count roadmaps "player_id = '$PLAYER_ID'")" 0 "db: plan/reset cleared the player's roadmaps"
    assert_eq "$(sqlite_count test_results "player_id = '$PLAYER_ID'")" "$TESTS_BEFORE" "db: the test history is kept ($TESTS_BEFORE results)"
    assert_eq "$(sqlite_count sessions "player_id = '$PLAYER_ID' AND finished_at IS NOT NULL")" 1 "db: the finished session is kept"
    assert_eq "$(sqlite_count player_profiles "player_id = '$PLAYER_ID'")" 1 "db: the profile is kept"
  fi
fi

# --- E. no ranking, no other player's data ---------------------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ]; then
  no_ranking "screen /train/summary" "${SUMMARY_TEXT-}"
fi
if [ -n "$OTHER_COOKIE" ]; then
  fetch "$OTHER_COOKIE" GET '/api/player/journey?locale=en'
  chk "isolation: the other visitor still sees only its own journey (juggling 63, one result, no session)" 200 '
    ([.tests[] | select(.testSlug == "juggling-max-touches")] | .[0] | .latest == 63 and (.history | length) == 1 and .previous == null)
    and .metrics == {sessionsCompleted: 0, minutesTrained: 0, streakDays: 0, skillsImproving: 0}'
  chk "isolation: the journey answer holds no ranking-like key" 200 '[.. | objects | keys[]] | map(test("rank|leaderboard|percentile|position|peer|cohort|other|player"; "i")) | any | not'
  assert_eq "$(sqlite_count test_results "player_id = '$OTHER_ID'"),$(sqlite_count roadmaps "player_id = '$OTHER_ID'"),$(sqlite_count sessions "player_id = '$OTHER_ID'")" "5,1,0" "isolation: the other visitor's rows (5 results, 1 roadmap, 0 sessions) were not touched by the player's retest, plan change and reset"
  assert_eq "$(sqlite_scalar "SELECT minutes_per_session FROM player_profiles WHERE player_id = '$OTHER_ID'")" 20 "isolation: the other visitor's minutes per session is still 20"
fi

if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 0 ]; then _e2e_err "NOTE: a browser step failed; the browser steps that depend on it were not run (the first FAIL above is the cause)"; fi

# no explicit stop or summary: the EXIT handler stops the stack, prints the summary, sets the exit code
