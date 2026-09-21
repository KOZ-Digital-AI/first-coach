#!/usr/bin/env bash
# apps/web/e2e/j2-onboarding.sh: slice gate fc-mol-8he, journey J2 "a player onboards without signup, takes baseline
# skill tests and gets a roadmap". Integration proof on the REAL stack (real API process, real SQLite file with the real
# seed, the real built web app served by the API, a real browser; nothing mocked, no OpenAI key needed):
#   A. WEB   a fresh visitor (no cookie) presses START TRAINING on the landing page and answers the wizard in the browser:
#            age 12, level, goal "weak foot", equipment "Ball + wall", space "yard", no partner, 3 days, 20 minutes; baseline
#            numbers for juggling, wall passing, ball mastery and weak foot; slalom is skipped (no cones, pre-skipped by the
#            wizard). MY ROADMAP must show a level per track, the goal, "4 weeks · 3 sessions/week · 20 min/session" and 2-3
#            focus skills with reasons, the weak foot first. The /api calls from START to the roadmap are counted against
#            the contract budget (<= 3: anonymous sign-in, options, start). Then sqlite_count: 1 player profile, 4 measured
#            test results (+ the 1 skipped slalom row the wizard sends), 1 roadmap, 1 anonymous user and no other account,
#            and the profile table has no name/email/birth-date column. Reloading /train and /train/roadmap shows the plan
#            again from the API (GET /api/player/today, GET /api/player/me).
#   B. API   a second visitor drives the same journey with curl: no cookie is 401, anonymous sign-in, GET options (public),
#            POST /api/player/start, GET /api/player/me, GET /api/player/today, GET /api/player/journey; the replay of the
#            start is idempotent (no new row); age 3 is a 422 problem+json with the pointer /profile/age and writes nothing;
#            an unknown `name` key is refused (the profile has no name).
#   C. RUN 2 age 7, "Ball only", "home 3x3", 15 minutes yields a roadmap too (through the browser, and through the API).
# Exit codes (lib.sh): 0 every check passed, 1 at least one FAIL, 3 nothing failed but a check was BLOCKED (no browser,
# E2E_WEB=off, no playwright-cli); E2E_ALLOW_BLOCKED=1 keeps a blocked-only run at 0. BLOCKED is never counted as a pass.
#
# Readings of the criteria where they are open (each is one line of the script):
#   * "4 test results": the wizard sends the skipped slalom test too, and the API stores a skipped result (value 0,
#     skipped = 1), so the table holds 5 rows for the player: 4 measured (skipped = 0) + 1 skipped. Both are asserted.
#   * "<= 3 /api calls": every /api/* request the browser makes between the START click and the roadmap heading, except the
#     Better Auth session READS (GET /api/auth/get-session: no player data, they only read the cookie). The requests are
#     listed in the failure detail. Budget: J2_CALL_BUDGET below is a constant of the criterion, not a knob.
#   * "submitting age 3 shows a field error from the problem details": the wizard's own inline validation refuses age 3
#     before anything is sent (Continue stays disabled), so the browser check is the inline error; the problem-details
#     field error (422, pointer /profile/age) is asserted against the API.
# Fail-slow (no set -e): every step reports. Cleanup: e2e_defer (never `trap ... EXIT` after sourcing lib.sh).
# Ports: the API gets a free kernel-assigned port (lib.sh start_stack); nothing is ever bound to :4111 or :5173 and no
# process this script did not start is touched.
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$HERE/lib.sh"

J2_CALL_BUDGET=3
NBSP=$(printf '\xc2\xa0')   # innerText renders the spaces inside "4 weeks" etc. as no-break spaces
SPORT=football
unset SEED_DIR   # the API must start on the repo's default seed

scratch=$(mktemp -d "${TMPDIR:-/tmp}/j2-gate.XXXXXX") || exit 1
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
  if jq -e "$3" >/dev/null 2>&1 <<<"$F_BODY"; then pass "$1"; else fail "$1" "  jq -e '$3' was false or failed"$'\n'"  HTTP $F_CODE payload: ${F_BODY:0:1800}"; fi
}
# sign_in: an anonymous visitor (sets V_COOKIE); the first call of every visitor, no account is made by hand.
sign_in() {
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
# sqlite_scalar <sql>: the first column of the first row of a read-only query on the stack's DB.
sqlite_scalar() {
  [ -f "${DB_PATH-}" ] || { _e2e_err "sqlite_scalar: no database (call start_stack first)"; return 2; }
  E2E_SQL=$1 E2E_DB=$DB_PATH bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.E2E_DB, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    const row = db.query(process.env.E2E_SQL).get();
    console.log(row === null ? "" : Object.values(row)[0]);
  '
}
# sqlite_columns <table>: the column names of a table, space separated.
sqlite_columns() {
  [[ $1 =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { _e2e_err "sqlite_columns: invalid table name '$1'"; return 2; }
  E2E_T=$1 E2E_DB=$DB_PATH bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.E2E_DB, { readonly: true });
    console.log(db.query(`PRAGMA table_info("${process.env.E2E_T}")`).all().map((c) => c.name).join(" "));
  '
}
uuid() { printf '%s' "$1$1$1$1$1$1$1$1-$1$1$1$1-4$1$1$1-8$1$1$1-$1$1$1$1$1$1$1$1$1$1$1$1"; }   # a valid v4 uuid from one hex digit

# --- the two payloads of the criteria (API form) ----------------------------------------------------------------------------
# Run 1: age 12, level basic, goal weak foot, Ball + wall, yard, no partner, 3 days, 20 min; slalom skipped.
run1_body() {
  jq -nc --arg u1 "$(uuid 1)" --arg u2 "$(uuid 2)" --arg u3 "$(uuid 3)" --arg u4 "$(uuid 4)" --arg u5 "$(uuid 5)" '{
    profile: {age: 12, level: "basic", goal: "weakfoot", equipment: "ball_wall", space: "yard", partner: false, daysPerWeek: 3, minutesPerSession: 20, locale: "en"},
    baseline: [
      {testSlug: "juggling-max-touches", value: 15, clientUuid: $u1},
      {testSlug: "wall-passing-60s", value: 30, clientUuid: $u2},
      {testSlug: "ball-mastery-30s", value: 40, clientUuid: $u3},
      {testSlug: "weak-foot-passes", value: 4, clientUuid: $u4},
      {testSlug: "slalom-time", value: 0, skipped: true, clientUuid: $u5}]}'
}
# Run 2: age 7, Ball only, home 3x3, 15 min. Without a wall or cones only ball mastery and juggling can be measured.
run2_body() {
  jq -nc --arg u6 "$(uuid a)" --arg u7 "$(uuid b)" --arg u8 "$(uuid c)" --arg u9 "$(uuid d)" --arg u0 "$(uuid e)" '{
    profile: {age: 7, level: "beginner", goal: "control", equipment: "ball", space: "home_3x3", partner: false, daysPerWeek: 2, minutesPerSession: 15, locale: "en"},
    baseline: [
      {testSlug: "ball-mastery-30s", value: 20, clientUuid: $u6},
      {testSlug: "juggling-max-touches", value: 3, clientUuid: $u7},
      {testSlug: "wall-passing-60s", value: 0, skipped: true, clientUuid: $u8},
      {testSlug: "slalom-time", value: 0, skipped: true, clientUuid: $u9},
      {testSlug: "weak-foot-passes", value: 0, skipped: true, clientUuid: $u0}]}'
}

# --- browser helpers (playwright-cli through lib.sh's pw; the visible words are the English ones) ----------------------------
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
# text_has <label> <haystack> <needle>: case-insensitive containment (the page upper-cases some eyebrows); no-break spaces are spaces.
text_has() {
  local hay=${2//$NBSP/ } needle=$3
  if [[ ${hay,,} == *"${needle,,}"* ]]; then pass "$1"; else fail "$1" "  needle: $3"$'\n'"  saw: ${hay:0:1500}"; fi
}
# api_calls <since-index>: the /api requests of the browser session after request number <since-index> (playwright-cli lists
# "N. [METHOD] url => [status] text"); one "METHOD path status" per line, the Better Auth session READS left out.
api_calls() {
  pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[([A-Z]+)\] https?:\/\/[^\/]+(\/api\/[^ ?]*)[^ ]* => \[([0-9]+)\].*/\1 \2 \3 \4/p' |
    awk -v since="$1" '$1 > since && $3 != "/api/auth/get-session" { print $2, $3, $4 }'
}
last_request_index() { pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[.*/\1/p' | sort -n | tail -n1; }
# fill_wizard_step1: age, level, goal on the first wizard step; then Continue.
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
# test_region_js <slug>: the JS expression of the wizard card of a skill test, found by the test's own metric text
# (real data: the metric comes from GET /api/onboarding, the way the wizard shows it).
test_region() { local m; m=$(jq -r --arg s "$1" '.tests[] | select(.slug == $s) | .metric' <<<"$OPTIONS"); printf 'page.getByRole("region", { name: %s, exact: true })' "$(jq -Rn --arg m "$m" '$m')"; }
enter_result() { # <slug> <value>
  pw_run "wizard step 3: enter $2 for $1" "(async page => { await $(test_region "$1").getByRole('textbox').first().fill('$2'); return 'ok'; })"
}
region_text() { # <slug>: the text of the card
  pw_run "wizard step 3: the card of $1 is on the page" "(async page => await $(test_region "$1").innerText())"
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
chk "options (public, no cookie): every enum the wizard shows and the 5 seeded tests" 200 \
  '(.levels | length) == 3 and (.goals | index("weakfoot")) != null and (.equipment | index("ball_wall")) != null and (.spaces | index("yard")) != null
   and .partner == [false, true] and .daysPerWeek == [2,3,4,5,6] and .minutesPerSession == [10,15,20,30,45]
   and (.tests | map(.slug) | sort) == ["ball-mastery-30s","juggling-max-touches","slalom-time","wall-passing-60s","weak-foot-passes"]
   and all(.tests[]; (.protocol.en | length) > 0)'

# --- A. the web journey ---------------------------------------------------------------------------------------------------
WEB_ON=0
if [ "$E2E_WEB" != api ]; then
  blocked "web journey (landing, wizard, roadmap, reload)" "E2E_WEB=$E2E_WEB: the web app is not served"
elif ! pw_available; then
  blocked "web journey (landing, wizard, roadmap, reload)" "playwright-cli is not installed"
elif pw_open /; then
  WEB_ON=1
fi   # pw_open itself recorded BLOCKED (no usable browser) or FAIL

if [ "$WEB_ON" = 1 ]; then
  WEB_OK=1
  pw resize 1280 1800 >/dev/null   # tall: nothing needs scrolling under the sticky header
  assert_text 'id="root"' url:/train/roadmap
  if [ "$(pw cookie-list | jq -r '.result // ""' | grep -c 'better-auth')" = 0 ]; then pass "the visitor starts with no session cookie"
  else fail "the visitor starts with no session cookie"; fi

  # press START TRAINING; the calls are counted from here
  since=$(last_request_index); since=${since:-0}
  pw_run "landing: the visitor presses START TRAINING and lands on the onboarding wizard" '(async page => {
    await page.getByRole("link", { name: "Start training" }).first().click();
    await page.waitForURL("**/train/onboarding");
    await page.getByRole("heading", { name: "A few questions to get started" }).waitFor();
    return page.url(); })'
  if [ "$WEB_OK" = 1 ]; then
    pw_run "wizard step 1: age 3 shows the inline field error and Continue stays disabled" '(async page => {
      await page.getByRole("spinbutton", { name: "Age" }).fill("3");
      await page.getByText("Basic", { exact: true }).click();
      await page.getByText("Improve my weaker foot", { exact: true }).click();
      const error = await page.getByText("Enter your age as a whole number from 5 to 99.").first().innerText();
      const disabled = await page.getByRole("button", { name: "Continue" }).isDisabled();
      if (!disabled) throw new Error("Continue is enabled for age 3");
      return error; })'
    text_has "the age-3 error text names the bounds" "$PW_OUT" "5 to 99"
    run_wizard 12 Basic "Improve my weaker foot" "Ball + wall" "Yard" "No" 3 "20 min"
  fi
  if [ "$WEB_OK" = 1 ]; then
    region_text slalom-time
    text_has "slalom is pre-skipped for a player without cones (no input to fill)" "$PW_OUT" "this test needs cones"
    enter_result juggling-max-touches 15
    enter_result wall-passing-60s 30
    enter_result ball-mastery-30s 40
    enter_result weak-foot-passes 4
    pw_run "wizard step 3: Done 5 of 5 (4 results + the skipped slalom), Continue creates the plan and opens MY ROADMAP" '(async page => {
      await page.getByText("Done: 5 of 5").waitFor();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForURL("**/train/roadmap");
      await page.getByRole("heading", { name: "Your focus skills" }).waitFor();
      return await page.locator("main").innerText(); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    ROADMAP_TEXT=$PW_OUT
    text_has "roadmap screen: the title MY ROADMAP" "$ROADMAP_TEXT" "My roadmap"
    text_has "roadmap screen: the goal 'Improve my weaker foot'" "$ROADMAP_TEXT" "Your goal"$'\n\n'"Improve my weaker foot"
    text_has "roadmap screen: '4 weeks · 3 sessions/week · 20 min/session'" "$ROADMAP_TEXT" "4 weeks · 3 sessions/week · 20 min/session"
    text_has "roadmap screen: the current level label" "$ROADMAP_TEXT" "Your level now"$'\n\n'"Basic"
    levels=$(grep -cE '^Level [1-5] / 5$' <<<"${ROADMAP_TEXT//$NBSP/ }")
    assert_eq "$levels" 5 "roadmap screen: a level (n / 5) for each of the 5 tracks"
    for track in "Ball mastery" "Juggling and coordination" "Dribbling" "Passing and first touch" "Weaker foot"; do
      text_has "roadmap screen: track '$track'" "$ROADMAP_TEXT" "$track"$'\n'"Level "
    done
    text_has "roadmap screen: a track from the test and a track from the player's own estimate (slalom skipped)" "$ROADMAP_TEXT" "Your own estimate"
    text_has "roadmap screen: the button to today's training" "$ROADMAP_TEXT" "Open today's training"
    pw_run "roadmap screen: the focus skills, in order, with their reasons" '(async page => JSON.stringify(await page.getByRole("list", { name: "Focus skills" }).getByRole("listitem").allInnerTexts()))'
    if [ "$WEB_OK" = 1 ]; then
      FOCUS=$PW_OUT
      n=$(jq 'length' <<<"$FOCUS"); if [ "$n" -ge 2 ] && [ "$n" -le 3 ]; then pass "roadmap screen: $n focus skills (2-3)"; else fail "roadmap screen: 2-3 focus skills" "  got $n: ${FOCUS:0:600}"; fi
      if jq -e '.[0] | contains("Weaker foot") and contains("This is the skill you chose as your goal.")' >/dev/null <<<"$FOCUS"; then pass "roadmap screen: the weak foot is the FIRST focus skill, with the reason 'your stated goal'"
      else fail "roadmap screen: the weak foot is the FIRST focus skill, with the reason 'your stated goal'" "  focus: ${FOCUS:0:800}"; fi
      if jq -e 'all(.[]; test("Level [0-9] → [0-9]") and (test("This is the skill you chose as your goal\\.|A good place to grow"))) and (.[1:] | all(.[]; contains("A good place to grow")))' >/dev/null <<<"$FOCUS"; then pass "roadmap screen: every focus skill shows current → target level and a worded reason (goal, then weakest areas)"
      else fail "roadmap screen: every focus skill shows current → target level and a worded reason" "  focus: ${FOCUS:0:800}"; fi
    fi

    # the call budget: press START -> roadmap
    calls=$(api_calls "$since")
    ncalls=$(grep -c . <<<"$calls")
    summary=$(tr '\n' ';' <<<"$calls" | sed 's/;/; /g')
    if grep -q '^POST /api/auth/sign-in/anonymous 200' <<<"$calls" && grep -q '^GET /api/onboarding/football 200' <<<"$calls" && grep -q '^POST /api/player/start 200' <<<"$calls"; then
      pass "call budget: the journey does call the anonymous sign-in, the options and the start endpoints (observed: $summary)"
    else fail "call budget: the journey calls anonymous sign-in, options and start" "  observed /api calls: ${summary:-none}"; fi
    if [ "$ncalls" -le "$J2_CALL_BUDGET" ] && [ "$ncalls" -ge 1 ]; then pass "call budget: $ncalls /api calls from START TRAINING to MY ROADMAP (<= $J2_CALL_BUDGET)"
    else fail "call budget: <= $J2_CALL_BUDGET /api calls from START TRAINING to MY ROADMAP (anonymous sign-in, options, start), got $ncalls" \
      "  observed (Better Auth get-session reads not counted): ${summary:-none}"; fi

    # the database
    assert_eq "$(sqlite_count player_profiles)" 1 "db: 1 player profile"
    assert_eq "$(sqlite_count test_results "skipped = 0")" 4 "db: 4 test results (measured: juggling, wall passing, ball mastery, weak foot)"
    assert_eq "$(sqlite_count test_results "skipped = 1 AND test_slug = 'slalom-time'")" 1 "db: the skipped slalom is stored as skipped (value 0), not as a measurement"
    assert_eq "$(sqlite_count test_results)" 5 "db: 5 test result rows in all (4 measured + 1 skipped)"
    assert_eq "$(sqlite_count roadmaps)" 1 "db: 1 roadmap"
    assert_eq "$(sqlite_count user)" 1 "db: exactly 1 user (the anonymous visitor); no account made by hand"
    assert_eq "$(sqlite_count user '"isAnonymous" = 1')" 1 "db: that user is anonymous"
    cols=$(sqlite_columns player_profiles)
    if grep -qwiE 'name|email|birth[a-z_]*|dob|date_of_birth' <<<"$cols"; then fail "db: player_profiles has no name/email/birth-date column" "  columns: $cols"
    else pass "db: player_profiles has no name/email/birth-date column ($cols)"; fi
    assert_eq "$(sqlite_scalar "SELECT json_extract(json, '\$.focus[0].skill') FROM roadmaps")" weak-foot "db: the stored roadmap puts weak-foot first"
    assert_eq "$(sqlite_scalar "SELECT age || '/' || equipment || '/' || space || '/' || partner || '/' || days_per_week || '/' || minutes_per_session || '/' || goal FROM player_profiles")" \
      "12/ball_wall/yard/0/3/20/weakfoot" "db: the profile holds exactly what the wizard collected"

    # reload: the plan comes back from the API
    pw goto "$STACK_URL/train" >/dev/null
    pw_run "reload /train: today's session and the roadmap focus are shown again" '(async page => {
      await page.getByRole("heading", { name: "Your focus" }).waitFor();
      return await page.locator("main").innerText(); })'
    if [ "$WEB_OK" = 1 ]; then
      text_has "reload /train: the focus panel names the goal skill first ('Weak foot', level 2 to 3)" "$PW_OUT" "Weak foot"$'\n'"Level 2 to 3"$'\n'"Your chosen goal"
      text_has "reload /train: the current level is still Basic and the plan is 3 sessions of 20 min" "$PW_OUT" "Current level"$'\n'"Basic"$'\n'"Sessions per week"$'\n'"3"$'\n'"Minutes per session"$'\n'"20"
      if api_calls 0 | grep -q '^GET /api/player/today 200'; then pass "reload /train: the plan came from GET /api/player/today (200)"
      else fail "reload /train: the plan came from GET /api/player/today (200)" "  observed: $(api_calls 0 | tr '\n' ';')"; fi
    fi
    pw goto "$STACK_URL/train/roadmap" >/dev/null
    pw_run "reload /train/roadmap: MY ROADMAP is shown again" '(async page => {
      await page.getByRole("heading", { name: "Your focus skills" }).waitFor();
      return await page.locator("main").innerText(); })'
    if [ "$WEB_OK" = 1 ]; then
      text_has "reload /train/roadmap: same plan (4 weeks · 3 sessions/week · 20 min/session, goal weak foot)" "$PW_OUT" "4 weeks · 3 sessions/week · 20 min/session"
      if api_calls 0 | grep -q '^GET /api/player/me 200'; then pass "reload /train/roadmap: the plan came from GET /api/player/me (200)"
      else fail "reload /train/roadmap: the plan came from GET /api/player/me (200)" "  observed: $(api_calls 0 | tr '\n' ';')"; fi
    fi
    assert_eq "$(sqlite_count player_profiles)" 1 "db after the reloads: still 1 player profile (the cookie is reused, no new visitor)"
    assert_eq "$(sqlite_count roadmaps)" 1 "db after the reloads: still 1 roadmap"
  fi
fi

# --- B. the API journey (a second visitor, curl) ----------------------------------------------------------------------------
profiles0=$(sqlite_count player_profiles)
fetch - GET /api/player/me
chk "api: a visitor with no cookie is refused (GET /api/player/me 401 problem+json)" 401 '.status == 401 and (.title | type == "string")'
fetch - POST /api/player/start "$(run1_body)"
chk "api: no cookie, no start (POST /api/player/start 401)" 401 '.status == 401'
sign_in "api visitor"
COOKIE=$V_COOKIE API_ID=$V_ID
if [ -n "$COOKIE" ]; then
  fetch "$COOKIE" GET /api/player/me
  chk "api: an anonymous player who did not onboard yet gets 404 'not onboarded'" 404 '.status == 404 and (.detail | test("not onboarded"))'

  fetch "$COOKIE" POST /api/player/start "$(run1_body)"
  START_BODY=$F_BODY
  chk "api: POST /api/player/start answers {profile, roadmap} (baseline with a skipped test)" 200 '
    (keys | sort) == ["profile","roadmap"]
    and .profile == {age:12, level:"basic", goal:"weakfoot", equipment:"ball_wall", space:"yard", partner:false, daysPerWeek:3, minutesPerSession:20, locale:"en"}
    and (.profile | keys | map(test("name|email|birth"; "i")) | any | not)'
  chk "api: the roadmap has a level per track (5), goal, 4 weeks, 3 sessions/week, 20 min" 200 '
    .roadmap | (.tracks | length) == 5 and (.tracks | all(.[]; .level >= 1 and .level <= 5))
      and (.tracks | map(select(.source == "test")) | length) == 4 and ([.tracks[] | select(.source == "self") | .skill] == ["dribbling"])
      and .goal == "weakfoot" and .weeks == 4 and .sessionsPerWeek == 3 and .minutesPerSession == 20
      and (.currentLevelLabel | IN("Foundation","Basic","Intermediate","Advanced"))'
  chk "api: 2-3 focus skills with reasons, weak foot first, target = level + 1 (cap 5)" 200 '
    .roadmap.focus | (length | . >= 2 and . <= 3) and .[0].skill == "weak-foot" and .[0].reason == "goal"
      and all(.[]; (.reason | IN("goal","weakest")) and .targetLevel == ([.level + 1, 5] | min))'
  fetch "$COOKIE" GET /api/player/me
  if [ "$(jq -S . <<<"$F_BODY")" = "$(jq -S . <<<"$START_BODY")" ] && [ "$F_CODE" = 200 ]; then pass "api: GET /api/player/me returns exactly the profile and roadmap that start created"
  else fail "api: GET /api/player/me returns exactly the profile and roadmap that start created" "  HTTP $F_CODE me: ${F_BODY:0:600}"$'\n'"  start: ${START_BODY:0:600}"; fi

  fetch "$COOKIE" GET '/api/player/today?locale=en'
  TODAY_BODY=$F_BODY
  chk "api: GET /api/player/today composes a session from the real drills for this roadmap" 200 '
    .planner == "rules" and (.items | length) >= 1 and .totalMinutes > 0
    and (.roadmapSummary.focus | map(.skill)) == ["weak-foot","ball-mastery","dribbling"]
    and .roadmapSummary.sessionsPerWeek == 3 and .roadmapSummary.minutesPerSession == 20
    and all(.items[]; (.content.conditions.equipment | IN("nothing","ball","ball_wall")) and .status == "COMMUNITY" and (.attribution.license | length) > 0 and (.content.goal.en | length) > 0)'
  if grep -qi '^cache-control: *no-store' <<<"$F_HDRS"; then pass "api: today is Cache-Control: no-store (per-player data)"; else fail "api: today is Cache-Control: no-store" "  headers: ${F_HDRS:0:300}"; fi
  fetch "$COOKIE" GET '/api/player/today?locale=en'
  if [ "$(jq -r .id <<<"$F_BODY")" = "$(jq -r .id <<<"$TODAY_BODY")" ] && [ "$F_CODE" = 200 ]; then pass "api: a second GET /api/player/today is the same session (stored, not recomposed)"
  else fail "api: a second GET /api/player/today is the same session" "  ids: $(jq -r .id <<<"$F_BODY") vs $(jq -r .id <<<"$TODAY_BODY")"; fi

  fetch "$COOKIE" GET '/api/player/journey?locale=en'
  chk "api: GET /api/player/journey shows the 4 baseline results as the first history, the skill tree and no fake activity" 200 '
    (keys | sort) == ["metrics","milestones","retestsDue","tests","tree"]
    and (.tests | map({(.testSlug): .latest}) | add) == {"ball-mastery-30s":40,"juggling-max-touches":15,"wall-passing-60s":30,"weak-foot-passes":4}
    and all(.tests[]; (.history | length) == 1 and .personalBest == .latest)
    and (.tree | length) == 5
    and .metrics == {sessionsCompleted:0, minutesTrained:0, streakDays:0, skillsImproving:0} and .retestsDue == []'

  # idempotent start: a second call replaces the plan, no new rows
  results_of() { sqlite_count test_results "player_id = '$API_ID'"; }
  before_results=$(results_of)
  fetch "$COOKIE" POST /api/player/start "$(run1_body)"
  chk "api: a replay of start (same clientUuids) is 200 and answers the same plan" 200 '.roadmap.focus[0].skill == "weak-foot" and .profile.age == 12 and .roadmap.focus[0].reason == "goal"'
  assert_eq "$(results_of)" "$before_results" "db: the replay stored no duplicate result rows (still $before_results for this player)"
  assert_eq "$before_results" 5 "db: the api player holds 5 result rows (4 measured + 1 skipped)"
  assert_eq "$(sqlite_count player_profiles)" "$((profiles0 + 1))" "db: the api visitor added exactly 1 profile"
  assert_eq "$(sqlite_count roadmaps "player_id = '$API_ID'")" 1 "db: the api visitor has exactly 1 roadmap (the replayed start added none: same plan)"

  # problem details with field pointers, and nothing written
  profiles1=$(sqlite_count player_profiles); results1=$(sqlite_count test_results); roadmaps1=$(sqlite_count roadmaps)
  fetch "$COOKIE" POST /api/player/start "$(run1_body | jq -c '.profile.age = 3')"
  chk "api: age 3 is a 422 problem+json with the field pointer /profile/age" 422 '.status == 422 and (.errors | map(.pointer) | index("/profile/age")) != null and (.errors[] | select(.pointer == "/profile/age") | .detail | length) > 0'
  if grep -qi '^content-type: *application/problem+json' <<<"$F_HDRS"; then pass "api: the age-3 answer is application/problem+json"; else fail "api: the age-3 answer is application/problem+json" "  headers: ${F_HDRS:0:300}"; fi
  fetch "$COOKIE" POST /api/player/start "$(run1_body | jq -c '.profile.age = 100')"
  chk "api: age 100 is a 422 with the pointer /profile/age too (upper bound)" 422 '(.errors | map(.pointer) | index("/profile/age")) != null'
  fetch "$COOKIE" POST /api/player/start "$(run1_body | jq -c '.profile.name = "Aidar"')"
  chk "api: a profile with a name is refused (422, pointer /profile/name): the profile has no name" 422 '(.errors | map(.pointer) | index("/profile/name")) != null'
  fetch "$COOKIE" POST /api/player/start "$(run1_body | jq -c '.baseline[0].testSlug = "no-such-test"')"
  chk "api: an unknown test slug is a 422 at /baseline/0/testSlug" 422 '(.errors | map(.pointer) | index("/baseline/0/testSlug")) != null'
  assert_eq "$(sqlite_count player_profiles),$(sqlite_count test_results),$(sqlite_count roadmaps)" "$profiles1,$results1,$roadmaps1" "db: none of the refused starts wrote a row"

  # the retest endpoint of the slice: the same player re-measures and gets journey + roadmap in one answer
  fetch "$COOKIE" POST /api/player/test-results "$(jq -nc --arg u "$(uuid f)" '{results: [{testSlug: "weak-foot-passes", value: 6, clientUuid: $u}]}')"
  chk "api: POST /api/player/test-results (a retest) answers {journey, roadmap} in one call" 200 '
    (keys | sort) == ["journey","roadmap"] and (.journey.tests | map(select(.testSlug == "weak-foot-passes") | .latest)) == [6]
    and (.journey.tests | map(select(.testSlug == "weak-foot-passes") | .personalBest)) == [6] and .roadmap.goal == "weakfoot"'
fi

# --- C. run 2: age 7, Ball only, home 3x3, 15 minutes ---------------------------------------------------------------------------
sign_in "run 2 (api)"
if [ -n "$V_COOKIE" ]; then
  fetch "$V_COOKIE" POST /api/player/start "$(run2_body)"
  chk "run 2 (api): age 7, Ball only, home 3x3, 15 min yields a roadmap: 5 tracks, 15 min/session, 2-3 focus skills" 200 '
    .profile.age == 7 and .profile.equipment == "ball" and .profile.space == "home_3x3" and .profile.minutesPerSession == 15
    and .roadmap.minutesPerSession == 15 and .roadmap.weeks == 4 and (.roadmap.tracks | length) == 5
    and (.roadmap.tracks | map(select(.source == "test")) | length) == 2 and (.roadmap.focus | length | . >= 2 and . <= 3)
    and .roadmap.goal == "control" and (.roadmap.focus | all(.[]; .reason | IN("goal","weakest")))'
  fetch "$V_COOKIE" GET '/api/player/today?locale=en'
  chk "run 2 (api): today's drills fit 'Ball only' (no wall drill, no cones, no full field)" 200 '
    (.items | length) >= 1 and all(.items[]; .content.conditions.equipment | IN("nothing","ball"))'
fi

if [ "$WEB_ON" = 1 ]; then
  # a brand-new visitor: a fresh browser (the previous one keeps the first plan in cookies and IndexedDB)
  pw close >/dev/null 2>&1 || true
  if pw_open /; then
    WEB_OK=1
    pw resize 1280 1800 >/dev/null
    profiles2=$(sqlite_count player_profiles) skipped2=$(sqlite_count test_results "skipped = 1") measured2=$(sqlite_count test_results "skipped = 0")
    pw_run "run 2 (web): a fresh visitor presses START TRAINING" '(async page => {
      await page.getByRole("link", { name: "Start training" }).first().click();
      await page.waitForURL("**/train/onboarding");
      await page.getByRole("heading", { name: "A few questions to get started" }).waitFor();
      return page.url(); })'
    [ "$WEB_OK" = 1 ] && run_wizard 7 Beginner "Control the ball with confidence" "Ball only" "Home 3×3 m" "No" 3 "15 min"
    if [ "$WEB_OK" = 1 ]; then
      region_text weak-foot-passes
      text_has "run 2 (web): the weak-foot test is pre-skipped for 'Ball only' (needs a ball and a wall)" "$PW_OUT" "this test needs a ball and a wall"
      region_text slalom-time
      text_has "run 2 (web): slalom is pre-skipped for 'Ball only' (needs cones)" "$PW_OUT" "this test needs cones"
      enter_result ball-mastery-30s 20
      enter_result juggling-max-touches 3
      pw_run "run 2 (web): Continue creates the plan and opens MY ROADMAP" '(async page => {
        await page.getByRole("button", { name: "Continue" }).click();
        await page.waitForURL("**/train/roadmap");
        await page.getByRole("heading", { name: "Your focus skills" }).waitFor();
        return await page.locator("main").innerText(); })'
    fi
    if [ "$WEB_OK" = 1 ]; then
      text_has "run 2 (web): MY ROADMAP shows '4 weeks · 3 sessions/week · 15 min/session'" "$PW_OUT" "4 weeks · 3 sessions/week · 15 min/session"
      text_has "run 2 (web): the goal 'Control the ball with confidence'" "$PW_OUT" "Your goal"$'\n\n'"Control the ball with confidence"
      levels=$(grep -cE '^Level [1-5] / 5$' <<<"${PW_OUT//$NBSP/ }")
      assert_eq "$levels" 5 "run 2 (web): a level for each of the 5 tracks"
      assert_eq "$(sqlite_count player_profiles)" "$((profiles2 + 1))" "run 2 (web): db has one more profile"
      assert_eq "$(sqlite_count test_results "skipped = 1")" "$((skipped2 + 3))" "run 2 (web): the 3 tests a 'Ball only' player cannot do are stored as skipped"
      assert_eq "$(sqlite_count test_results "skipped = 0")" "$((measured2 + 2))" "run 2 (web): the 2 measured results are stored (ball mastery, juggling)"
    fi
  fi
else
  blocked "run 2 through the browser (age 7, Ball only, home 3x3, 15 min)" "the web journey did not run (see above); run 2 was proven through the API only"
fi

if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 0 ]; then _e2e_err "NOTE: a browser step failed; the browser steps that depend on it were not run (the first FAIL above is the cause)"; fi

# no explicit stop or summary: the EXIT handler stops the stack, prints the summary, sets the exit code
