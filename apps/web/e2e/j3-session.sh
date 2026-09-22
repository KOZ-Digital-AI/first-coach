#!/usr/bin/env bash
# apps/web/e2e/j3-session.sh: slice gate fc-mol-m5m, journey J3 "a player trains today's session and records results".
# Integration proof on the REAL stack (real API process, real SQLite file with the real seed, the real built web app served by
# the API, a real browser; nothing mocked, no OpenAI key needed). The journey starts from an ONBOARDED player made through the
# UI (the J2 wizard, run 1: age 12, Basic, weak foot, "Ball + wall", yard, no partner, 3 days, 20 min) and then:
#   A. OPEN     "Open today's training" opens /train: 1 API call (GET /api/player/today). The drill minutes sum to within 3 of
#               the 20-minute budget; every drill matches the player's equipment, space, partner and age (the real drill
#               conditions, read from the API); the UI list is the API's session; Finish is disabled until every drill is done.
#   B. DRILLS   every drill is opened from the list / "Next drill" and shows what the API holds for it: the written instructions
#               (the seeded drills carry no video: the criterion says video-or-text), goal, reps/sets/time with a timer,
#               common mistakes, "make it easier" (regression), "make it harder" (progression), the conditions and the safety
#               notice. On one drill "Too hard" swaps it for its regression WITHOUT a page reload (a window marker survives; the
#               request is 1 POST /api/player/today/swap); the new drill is a listed regression, the item keeps its place, and
#               the new drill's own page shows its own content. Every drill is marked Done (1 POST each), one result is saved.
#   C. FINISH   "Finish session" costs 1 API call (POST /api/player/session-events) and lands on /train/summary: "Session
#               complete", drills completed n of n, the minutes trained (= the minutes of the done drills, which counts the
#               swapped-in drill), streak 1, sessions finished 1, the next session date (session date + floor(7/3) = 2 days, the
#               spacing of 3 sessions a week), and the links My Journey and Back home.
#   D. DB       sqlite_count: 1 session (finished, every item done, the swapped drill stored), the expected session_events
#               (n drill_done + 1 result + 1 session_finished), no duplicate client_uuid, then the script re-posts the SAME batch
#               with curl (built from the stored rows): 200, the same progress, no new row, the session row untouched.
#   E. RELOAD   with the browser's local cache cleared, reloading /train shows every drill Done ("n/n completed") from
#               GET /api/player/today; /train/summary without a finished session in this page's memory redirects to /train.
#   F. LATER    the next visit on a later simulated date: a new session (see DATE below) that is not the first one, is a
#               different drill set from day 1, fits the budget and the player's kit, and is all to do. The DB then holds 2
#               sessions of the player and the same events. The done-history rule is judged as a whole, see HISTORY below.
#   G. API      the same player over curl: no cookie is 401, a visitor that never onboarded gets 404 "not onboarded", an empty
#               batch is a 422 with a pointer, swapping a finished drill is a 409, a foreign/unknown session is a 404 that
#               names the event.
#   H. COHORT   5 other players over curl (ages 7-16, budgets 10-45 min): kit fit, minutes within 3 of their own budget, exact
#               progress, a different drill set on day 2, and the HISTORY ratio over all players.
# Exit codes (lib.sh): 0 every check passed, 1 at least one FAIL, 3 nothing failed but a check was BLOCKED (no browser,
# E2E_WEB=off, no playwright-cli); E2E_ALLOW_BLOCKED=1 keeps a blocked-only run at 0. BLOCKED is never counted as a pass.
#
# DATE (the "later simulated date"). The API's "today" is the player's LOCAL calendar day: the X-Timezone request header, an IANA
# zone that the app sends from the device (Intl.DateTimeFormat().resolvedOptions().timeZone). That is the one real mechanism for
# "another day" the product has, and it needs no product change, no clock fake and no database edit: the browser is opened
# twice on ONE persistent profile (same cookies, same local cache) with a different device time zone, through playwright's own
# `timezoneId` context option. Day 1 = Etc/GMT+12 (UTC-12, the last place on earth to reach a date), day 2 = Pacific/Kiritimati
# (UTC+14, the first): whatever the time of the run, their calendar days are 1 or 2 days apart, day 2 later. The expected
# dates are computed here with `date` (not read back from the product) and compared with the sessions table.
#
# Readings of the criteria where they are open (each is one line of the script):
#   * "opening the session costs 1 API call" / "finishing costs 1": every /api/* request the browser makes from the click on
#     "Open today's training" until the list is on screen / from the click on "Finish session" until "Session complete",
#     except the Better Auth session READS (GET /api/auth/get-session: no player data, they only read the cookie), exactly as
#     J2 counts. Marking a drill Done, saving a result and a swap are 1 request each and are asserted as such.
#   * "drill minutes sum to within 3 minutes of the 20-minute budget": |sum - 20| <= 3, read from the rows on screen and compared
#     with the API's session. The 2-minute skill test (when one is due) is not a drill; on day 1 none is due.
#   * "every drill matching the player's equipment and space": the drill's conditions (API) against the player's kit: equipment
#     in the kit the preset owns (ball_wall owns nothing/ball/ball_wall), its SMALLEST space no larger than a yard (the
#     planner's rule: a drill listing several spaces fits when one of them does), no partner needed, age 12 inside its range.
#   * "video-or-text": a drill with a video shows a Play control, one without shows its written instructions; the written
#     instructions are asserted for every drill, the Play control only when the drill has a video (none of the seed's does).
#   * "a result": the drill player's numeric result box is saved on the first drill (event type `result` with the itemId).
#   * "reflects the recorded results": the recorded state that the picker reads is the done-history (previous 2 sessions'
#     DONE drills are DEPRIORITISED, not banned). The result NUMBER is stored but the picker does not read it (skill-test
#     results are a separate flow). HISTORY: per player the later session is a different drill SET from day 1, and over the
#     browser player plus the 5-player cohort repeated drills / later-session drills stays under 40 % (numbers printed). A
#     per-player "no repeat at all" is NOT asserted: at short budgets the seed pool is small (backlog fc-9li) and the player id
#     seeds the tie-break, so a legitimate repeat would make the gate flaky.
# Fail-slow (no set -e): every step reports. Cleanup: e2e_defer (never `trap ... EXIT` after sourcing lib.sh).
# Ports: the API gets a free kernel-assigned port (lib.sh start_stack); nothing is ever bound to :4111 or :5173 and no process
# this script did not start is touched. The browser session name is unique per run (E2E_SESSION).
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$HERE/lib.sh"

BUDGET=20            # the player's minutes per session (wizard: "20 min")
BUDGET_TOLERANCE=3   # "within 3 minutes of the 20-minute budget"
DAYS_PER_WEEK=3
SPACING_DAYS=$((7 / DAYS_PER_WEEK))   # 2: the next session is this many days after the session (3 sessions a week)
PLAYER_AGE=12
TZ_DAY1=Etc/GMT+12
TZ_DAY2=Pacific/Kiritimati
SPORT=football
NBSP=$(printf '\xc2\xa0')
unset SEED_DIR   # the API must start on the repo's default seed

scratch=$(mktemp -d "${TMPDIR:-/tmp}/j3-gate.XXXXXX") || exit 1
# the browser is closed BEFORE the scratch dir (its persistent profile) is removed: a browser still running would recreate it
e2e_defer 'pw close >/dev/null 2>&1; rm -rf -- "$scratch"'

# --- small helpers (the J2 ones) ---------------------------------------------------------------------------------------------
# fetch <cookie | -> <METHOD> <path> [json body] [extra curl args...]: one request to the real API; sets F_CODE, F_BODY, F_HDRS.
fetch() {
  local cookie=$1 method=$2 path=$3 data=${4-} args
  shift 3; [ "$#" -eq 0 ] || shift
  args=(-s --max-time "$E2E_HTTP_TIMEOUT" -X "$method" -D "$scratch/f.hdr" -o "$scratch/f.body" -w '%{http_code}')
  args+=(-H "Origin: $API_URL")
  [ "$cookie" = - ] || args+=(-H "Cookie: $cookie")
  [ -z "$data" ] || args+=(-H 'content-type: application/json' -d "$data")
  args+=("$@")
  F_CODE=$(curl "${args[@]}" "$API_URL$path" 2>/dev/null) || F_CODE=000
  F_BODY=$(cat "$scratch/f.body" 2>/dev/null)
  F_HDRS=$(tr -d '\r' <"$scratch/f.hdr" 2>/dev/null)
}
# chk <label> <status> <jq expression on F_BODY>
chk() {
  if [ "$F_CODE" != "$2" ]; then fail "$1" "  HTTP $F_CODE (wanted $2): ${F_BODY:0:800}"; return 1; fi
  if jq -e "$3" >/dev/null 2>&1 <<<"$F_BODY"; then pass "$1"; else fail "$1" "  jq -e '$3' was false or failed"$'\n'"  HTTP $F_CODE payload: ${F_BODY:0:1800}"; fi
}
sign_in() { # the first call of an API-only visitor (no account is made by hand); sets V_COOKIE
  V_COOKIE=""
  fetch - POST /api/auth/sign-in/anonymous '{}'
  V_COOKIE=$(grep -i '^set-cookie: *[^;]*session_token=' <<<"$F_HDRS" | head -n1 | sed -E 's/^[^:]*: *//; s/;.*//')
  if [ "$F_CODE" = 200 ] && [ -n "$V_COOKIE" ]; then pass "$1: anonymous sign-in answers 200 with a session cookie"
  else V_COOKIE=""; fail "$1: anonymous sign-in answers 200 with a session cookie" "  HTTP $F_CODE headers: ${F_HDRS:0:400} body: ${F_BODY:0:400}"; fi
}
sqlite_scalar() { # <sql>: the first column of the first row, read-only
  [ -f "${DB_PATH-}" ] || { _e2e_err "sqlite_scalar: no database (call start_stack first)"; return 2; }
  E2E_SQL=$1 E2E_DB=$DB_PATH bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.E2E_DB, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    const row = db.query(process.env.E2E_SQL).get();
    console.log(row === null ? "" : Object.values(row)[0]);
  '
}
sqlite_json() { # <sql>: every row as a JSON array of objects, read-only
  [ -f "${DB_PATH-}" ] || { _e2e_err "sqlite_json: no database (call start_stack first)"; return 2; }
  E2E_SQL=$1 E2E_DB=$DB_PATH bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.E2E_DB, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    console.log(JSON.stringify(db.query(process.env.E2E_SQL).all()));
  '
}
uuid() { printf '%s' "$1$1$1$1$1$1$1$1-$1$1$1$1-4$1$1$1-8$1$1$1-$1$1$1$1$1$1$1$1$1$1$1$1"; }
js() { jq -Rn --arg s "$1" '$s'; }   # a string as a JSON (= JavaScript) literal
norm() { tr -s '[:space:]' ' ' <<<"${1//$NBSP/ }" | sed -E 's/^ //; s/ $//'; }   # one line, single spaces, no no-break spaces
# has <label> <haystack> <needle>: case-insensitive containment on whitespace-normalised text.
has() {
  local hay needle
  hay=$(norm "$2"); needle=$(norm "$3")
  if [[ ${hay,,} == *"${needle,,}"* ]]; then pass "$1"; else fail "$1" "  needle: $needle"$'\n'"  saw: ${hay:0:1200}"; fi
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
# pw_quiet <js>: like pw_run but records nothing on success (a FAIL on error); for steps whose result is asserted after.
pw_quiet() {
  local label=$1 code=$2 out
  PW_OUT=""
  out=$(pw run-code "async page => { page.setDefaultTimeout(10000); const run = ${code}; return await run(page); }") || {
    fail "$label" "  $(jq -r '.error // .' <<<"$out" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | head -n 12)"; WEB_OK=0; return 1; }
  PW_OUT=$(jq -r '.result | (try fromjson catch .) | if type == "string" then . else tojson end' <<<"$out")
}
# api_calls <since-index>: the /api requests of the browser session after request number <since-index> (playwright-cli lists
# "N. [METHOD] url => [status] text"); one "METHOD path status" per line, the Better Auth session READS left out.
api_calls() {
  pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[([A-Z]+)\] https?:\/\/[^\/]+(\/api\/[^ ?]*)[^ ]* => \[([0-9]+)\].*/\1 \2 \3 \4/p' |
    awk -v since="$1" '$1 > since && $3 != "/api/auth/get-session" { print $2, $3, $4 }'
}
last_request_index() { pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[.*/\1/p' | sort -n | tail -n1; }
# expect_calls <label> <since> <expected "METHOD path status" lines>: the calls since <since> are exactly these (order free)
expect_calls() {
  local got want
  got=$(api_calls "$2" | sort); want=$(printf '%s\n' "${@:3}" | sort)
  if [ "$got" = "$want" ]; then pass "$1 ($(tr '\n' ';' <<<"$got" | sed 's/;$//; s/;/; /g'))"
  else fail "$1" "  wanted: $(tr '\n' ';' <<<"$want")"$'\n'"  observed: $(tr '\n' ';' <<<"${got:-none}")"; fi
}
open_browser() { # <label> <time zone> <path>: a persistent profile, so a second open keeps the cookies and the local cache
  local tz=$2 out cfg="$scratch/pw-${2//[^A-Za-z0-9]/_}.json"
  if [ "$E2E_WEB" != api ]; then blocked "$1" "E2E_WEB=$E2E_WEB: the web app is not served"; return 1; fi
  if ! pw_available; then blocked "$1" "playwright-cli is not installed"; return 1; fi
  jq -nc --arg tz "$tz" '{browser: {contextOptions: {timezoneId: $tz}}}' >"$cfg"
  if out=$(pw open --config="$cfg" --persistent --profile="$scratch/profile" "$STACK_URL$3" 2>&1); then
    pass "$1"
  elif grep -qiE 'not installed|Executable doesn.t exist' <<<"$out"; then
    blocked "$1" "no usable browser: $(grep -iE 'not installed|Executable' <<<"$out" | head -n1)"; return 1
  else fail "$1" "$out"; return 1; fi
  pw resize 1280 2200 >/dev/null   # tall: nothing needs scrolling under the sticky header
  assert_eq "$(pw_eval 'Intl.DateTimeFormat().resolvedOptions().timeZone')" "$tz" "the device time zone of this visit is $tz (what the app sends as X-Timezone)"
}
# J2's wizard steps (run 1), English words
test_region() { local m; m=$(jq -r --arg s "$1" '.tests[] | select(.slug == $s) | .metric' <<<"$OPTIONS"); printf 'page.getByRole("region", { name: %s, exact: true })' "$(js "$m")"; }
enter_result() { pw_run "wizard step 3: enter $2 for $1" "(async page => { await $(test_region "$1").getByRole('textbox').first().fill('$2'); return 'ok'; })"; }
run_wizard() {
  pw_run "wizard step 1: age $PLAYER_AGE, level 'Basic', goal 'Improve my weaker foot'" '(async page => {
    await page.getByRole("spinbutton", { name: "Age" }).fill("'"$PLAYER_AGE"'");
    await page.getByText("Basic", { exact: true }).click();
    await page.getByText("Improve my weaker foot", { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Your training conditions" }).waitFor();
    return "ok"; })' || return 1
  pw_run "wizard step 2: 'Ball + wall', 'Yard', no partner, $DAYS_PER_WEEK days, '20 min'" '(async page => {
    await page.getByText("Ball + wall", { exact: true }).click();
    await page.getByText("Yard", { exact: true }).click();
    await page.getByRole("group", { name: "Is there someone to train with?" }).getByText("No", { exact: true }).click();
    await page.getByRole("group", { name: "Days per week" }).getByText("'"$DAYS_PER_WEEK"'", { exact: true }).click();
    await page.getByText("20 min", { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Quick skill tests" }).waitFor();
    return "ok"; })' || return 1
}

# --- "reflects the recorded results": the done-history rule ---------------------------------------------------------------------
# The planner DEPRIORITISES the drills done in a player's previous 2 sessions; it does not ban them ("used only when nothing else
# fits", session.ts rule 3), and the seed pool is small at short budgets (backlog fc-9li), so a repeat is legitimate and depends on
# the player id (it seeds the tie-break). A per-player "none repeat" would be a flaky gate. What the rule DOES guarantee, and what
# this gate asserts instead:
#   (a) per player: the later session is a different drill SET from day 1 (whenever day 1 had at least 2 drills);
#   (b) over every player the script measured (the browser player and the cohort): repeated drills / later-session drills stays
#       below REPEAT_RATIO_MAX_PCT percent. A planner that ignored the history repeats the day-1 focus drills and lands far above it.
# The observed numbers are printed in the PASS lines. Counters are summed by history_check and judged by history_aggregate.
REPEAT_RATIO_MAX_PCT=40
HIST_REPEATS=0 HIST_DAY2=0 HIST_PLAYERS=0
# history_check <label> <day-1 drill ids, one per line, sorted> <day-2 drill ids, one per line, sorted>
history_check() {
  local label=$1 d1=$2 d2=$3 n1 n2 reps
  n1=$(grep -c . <<<"$d1"); n2=$(grep -c . <<<"$d2")
  reps=$(comm -12 <(printf '%s\n' "$d1") <(printf '%s\n' "$d2") | grep -c .)
  HIST_REPEATS=$((HIST_REPEATS + reps)); HIST_DAY2=$((HIST_DAY2 + n2)); HIST_PLAYERS=$((HIST_PLAYERS + 1))
  if [ "$n1" -lt 2 ]; then pass "$label: day 1 had $n1 drill, the different-set rule needs 2 (repeats $reps of $n2)"
  elif [ "$d1" != "$d2" ]; then pass "$label: the later session is a different drill set from day 1 (repeated drills: $reps of $n2)"
  else fail "$label: the later session is a different drill set from day 1" "  the same $n1 drills: $(tr '\n' ' ' <<<"$d1")"; fi
}
history_aggregate() {
  if [ "$HIST_DAY2" -gt 0 ] && [ $((HIST_REPEATS * 100)) -lt $((REPEAT_RATIO_MAX_PCT * HIST_DAY2)) ]; then
    pass "history: over $HIST_PLAYERS players, $HIST_REPEATS of $HIST_DAY2 later-session drills were done the day before ($((HIST_REPEATS * 100 / HIST_DAY2))%, limit under ${REPEAT_RATIO_MAX_PCT}%): the done drills are deprioritised"
  else fail "history: repeated drills / later-session drills stays under ${REPEAT_RATIO_MAX_PCT}%" "  $HIST_REPEATS of $HIST_DAY2 over $HIST_PLAYERS players (the planner is not deprioritising the drills done in the previous sessions)"; fi
}

# --- the player's kit (the planner's own rule, candidates.ts): what a drill may need for THIS player -----------------------------
# equipment owned by the "Ball + wall" preset; space sizes (a yard = 2); partner false; age 12
FIT_JQ='def owned: ["nothing","ball","ball_wall"];
  def size: {"home_3x3":1,"yard":2,"gym":2,"field":3};
  .content.conditions as $c
  | ($c.equipment | IN(owned[])) and ([$c.spaces[] | size[.]] | min) <= 2 and ($c.partner == false)
    and ($c.ageMin == null or $c.ageMin <= $age) and ($c.ageMax == null or $c.ageMax >= $age)'
# fit_bad <session json> <age>: the titles of the drills that do NOT fit a "Ball + wall" / yard / no-partner player of that age
fit_bad() { jq -r --argjson age "$2" "[.items[] | select(($FIT_JQ) | not) | .content.title.en] | join(\", \")" <<<"$1"; }
# title of an item (en) and expected words
EQUIPMENT_WORDS='{"nothing":"No equipment","ball":"A ball","ball_wall":"A ball and a wall","cones":"Cones","full_field":"A full pitch"}'
SPACE_WORDS='{"home_3x3":"Home, about 3 by 3 metres","yard":"Yard","field":"Field","gym":"Gym"}'

# check_drill_page <item json>: the drill player's page (already open) shows everything the API holds for this drill
check_drill_page() {
  local item=$1 id title text n line label
  id=$(jq -r .itemId <<<"$item"); title=$(jq -r '.content.title.en' <<<"$item"); label="drill $id '$title'"
  pw_quiet "$label: read the drill player" '(async page => { await page.getByRole("heading", { level: 1 }).waitFor(); return await page.locator("main").innerText(); })' || return 1
  text=$PW_OUT
  has "$label: the title" "$text" "$title"
  has "$label: the goal" "$text" "$(jq -r '.content.goal.en' <<<"$item")"
  # video or text: a video (when the drill has one) is a Play control, the written instructions are always on the page
  if [ "$(jq '[.content.media[]? | select(.kind == "video")] | length' <<<"$item")" -gt 0 ]; then
    has "$label: video: the Play control" "$text" "Play video"
  fi
  while IFS= read -r line; do
    [ -n "$line" ] && has "$label: instructions: '${line:0:40}...'" "$text" "$line"
  done < <(jq -r '.content.instructions.en | split("\n") | map(sub("^\\s*[0-9]+[.)]\\s*"; "")) | .[] | select(length > 0)' <<<"$item")
  # reps / sets / time and the timer
  has "$label: the target section" "$text" "Your target"
  jq -e '.content.dose.reps != null' >/dev/null <<<"$item" && has "$label: reps" "$text" "Reps $(jq -r '.content.dose.reps' <<<"$item")"
  jq -e '.content.dose.sets != null' >/dev/null <<<"$item" && has "$label: sets" "$text" "Sets $(jq -r '.content.dose.sets' <<<"$item")"
  jq -e '.content.dose.durationSec != null' >/dev/null <<<"$item" && has "$label: time" "$text" "Time $(jq -r '.content.dose.durationSec' <<<"$item") s"
  if jq -e '.content.dose | (.reps != null or .sets != null or .durationSec != null)' >/dev/null <<<"$item"; then pass "$label: the drill has a dose (reps/sets/time) and it is shown"
  else fail "$label: the drill has a dose (reps/sets/time)" "  content.dose: $(jq -c '.content.dose' <<<"$item")"; fi
  has "$label: the count-up timer" "$text" "Start timer"
  # common mistakes, regression, progression
  n=$(jq '.content.mistakes | length' <<<"$item")
  if [ "$n" -gt 0 ]; then has "$label: common mistakes heading" "$text" "Common mistakes"
    while IFS= read -r line; do has "$label: mistake '${line:0:40}...'" "$text" "$line"; done < <(jq -r '.content.mistakes[].en' <<<"$item")
  else fail "$label: the drill has common mistakes" "  none in the API"; fi
  n=$(jq '.content.progressions | length' <<<"$item")
  if [ "$n" -gt 0 ]; then has "$label: progression ('Make it harder')" "$text" "Make it harder"
    while IFS= read -r line; do has "$label: progression '$line'" "$text" "$line"; done < <(jq -r '.content.progressions[].en' <<<"$item")
  else fail "$label: the drill has a progression" "  none in the API"; fi
  # regression: not every seeded drill has one (the easiest ones cannot get easier): shown when the API has it
  n=$(jq '.content.regressions | length' <<<"$item")
  if [ "$n" -gt 0 ]; then has "$label: regression ('Make it easier')" "$text" "Make it easier"
    while IFS= read -r line; do has "$label: regression '$line'" "$text" "$line"; done < <(jq -r '.content.regressions[].en' <<<"$item")
  else pass "$label: no regression in the data (an entry-level drill): no 'Make it easier' section expected"; fi
  # conditions
  has "$label: conditions heading" "$text" "What you need"
  has "$label: equipment" "$text" "Equipment $(jq -r --argjson w "$EQUIPMENT_WORDS" '$w[.content.conditions.equipment]' <<<"$item")"
  has "$label: space" "$text" "Space $(jq -r --argjson w "$SPACE_WORDS" '[.content.conditions.spaces[] | $w[.]] | join(", ")' <<<"$item")"
  has "$label: partner" "$text" "Partner $(jq -r 'if .content.conditions.partner then "With a partner" else "On your own" end' <<<"$item")"
  # safety, in its highlighted notice
  n=$(jq '.content.safety | length' <<<"$item")
  if [ "$n" -gt 0 ]; then
    pw_quiet "$label: the safety notice" '(async page => await page.getByRole("region", { name: "Safety", exact: true }).innerText())' &&
      { has "$label: safety title" "$PW_OUT" "Safety first"
        while IFS= read -r line; do has "$label: safety '${line:0:40}...'" "$PW_OUT" "$line"; done < <(jq -r '.content.safety[].en' <<<"$item"); }
  else fail "$label: the drill has a safety note" "  none in the API"; fi
}

# ============================================================================================================================
start_stack || exit 1
assert_api /health '.ok == true and .database == "ok"' -l "stack: /health ok on the temp DB (port $E2E_API_PORT_USED, own media dir)"
assert_eq "$(sqlite_count sports "slug = '$SPORT'")" 1 "the real seed is loaded (sport $SPORT)"
assert_eq "$(sqlite_count drill_versions)" "$(sqlite_count drill_versions "status = 'COMMUNITY'")" "the real seed: every drill version is COMMUNITY"
assert_eq "$(sqlite_count player_profiles),$(sqlite_count sessions),$(sqlite_count session_events),$(sqlite_count user)" "0,0,0,0" "start state: no player, no session, no event, no account"
fetch - GET "/api/onboarding/$SPORT?locale=en"
OPTIONS=$F_BODY
chk "options (public): the 5 seeded skill tests the wizard shows" 200 '(.tests | length) == 5 and (.equipment | index("ball_wall")) != null'
fetch - GET '/api/player/today?locale=en'
chk "api: no cookie, no session (GET /api/player/today 401 problem)" 401 '.status == 401'

D1=$(TZ=$TZ_DAY1 date +%F)                       # the calendar day of day 1 in the device zone of day 1
D_NEXT=$(date -d "$D1 + $SPACING_DAYS days" +%F)  # the next session date the summary must show
D2=$(TZ=$TZ_DAY2 date +%F)                       # the calendar day of the later visit
if [ "$D2" \> "$D1" ]; then pass "date mechanism: $TZ_DAY2 is on a later calendar day ($D2) than $TZ_DAY1 ($D1) right now"
else fail "date mechanism: $TZ_DAY2 ($D2) is later than $TZ_DAY1 ($D1)" "  the two zones share a day: the premise of the simulated date is broken"; fi

# --- A. the player onboards through the browser -------------------------------------------------------------------------------
WEB_ON=0
open_browser "browser opened on the landing page (day 1: device zone $TZ_DAY1)" "$TZ_DAY1" / && WEB_ON=1
if [ "$WEB_ON" = 1 ]; then
  WEB_OK=1
  pw_run "landing: START TRAINING leads to the sign-in gate, and Start opens the wizard" '(async page => {
    await page.getByRole("link", { name: "Start training" }).first().click();
    await page.waitForURL("**/account/sign-in**");
    await page.getByRole("button", { name: "Start training" }).click();
    await page.waitForURL("**/train/onboarding");
    await page.getByRole("heading", { name: "A few questions to get started" }).waitFor();
    return page.url(); })'
  [ "$WEB_OK" = 1 ] && run_wizard
  if [ "$WEB_OK" = 1 ]; then
    enter_result juggling-max-touches 15
    enter_result wall-passing-60s 30
    enter_result ball-mastery-30s 40
    enter_result weak-foot-passes 4
    pw_run "onboarding: Continue creates the plan and opens MY ROADMAP" '(async page => {
      await page.getByText("Done: 5 of 5").waitFor();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForURL("**/train/roadmap");
      await page.getByRole("heading", { name: "Your focus skills" }).waitFor();
      return await page.locator("main").innerText(); })'
  fi
fi
PLAYER=$(sqlite_scalar "SELECT player_id FROM player_profiles")
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  assert_eq "$(sqlite_count player_profiles),$(sqlite_count roadmaps),$(sqlite_count test_results "skipped = 0"),$(sqlite_count user "\"isAnonymous\" = 1")" "1,1,4,1" "db: the onboarded player made in the UI: 1 profile, 1 roadmap, 4 measured results, 1 anonymous user"
  assert_eq "$(sqlite_scalar "SELECT age || '/' || equipment || '/' || space || '/' || partner || '/' || days_per_week || '/' || minutes_per_session FROM player_profiles")" "$PLAYER_AGE/ball_wall/yard/0/$DAYS_PER_WEEK/$BUDGET" "db: the profile is the one the wizard collected"
  assert_eq "$(sqlite_count sessions)" 0 "db: onboarding made no session yet (a session is composed when today is opened)"
  # the browser's own cookie: the same identity for the curl cross-checks (real session cookie, not a second visitor)
  COOKIE=$(pw cookie-list | jq -r '.result // ""' | sed -nE 's/^ *(better-auth[^= ]*session_token=[^ ]+) .*/\1/p' | head -n1)
  if [ -n "$COOKIE" ]; then pass "the browser holds a Better Auth session cookie (used for the curl cross-checks)"; else fail "the browser holds a Better Auth session cookie" "  cookie-list: $(pw cookie-list | jq -r '.result // ""' | head -c 400)"; WEB_OK=0; fi
elif [ "$WEB_ON" = 1 ]; then WEB_OK=0; fi

# --- A. open today's session: 1 API call ----------------------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  since=$(last_request_index); since=${since:-0}
  pw_run "open the session: press \"Open today's training\" on MY ROADMAP, the drill list appears" '(async page => {
    await page.getByRole("link", { name: "Open today'"'"'s training" }).click();
    await page.waitForURL("**/train");
    await page.getByRole("list", { name: "Today'"'"'s drills" }).waitFor();
    await page.getByRole("button", { name: "Finish session" }).waitFor();
    await page.waitForLoadState("networkidle");
    return await page.locator("main").innerText(); })'
fi
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  expect_calls "call budget: opening today's session costs 1 API call" "$since" "GET /api/player/today 200"
  TRAIN_TEXT=$PW_OUT
  fetch "$COOKIE" GET '/api/player/today?locale=en' '' -H "X-Timezone: $TZ_DAY1"
  S1=$F_BODY
  chk "api (the browser's cookie): today's session is the stored one, planner rules, day-1 date $D1, no skill test due yet" 200 \
    ".planner == \"rules\" and .date == \"$D1\" and (.items | length) >= 3 and (.skillTest == null) and all(.items[]; .done == false)"
  N=$(jq '.items | length' <<<"$S1")
  assert_eq "$(sqlite_count sessions "player_id = '$PLAYER' AND date = '$D1'")" 1 "db: exactly 1 session of the player, dated $D1 (the device day, sent as X-Timezone)"
  has "the headline shows the session total" "$TRAIN_TEXT" "$(jq -r .totalMinutes <<<"$S1") min today"
  has "the completed pill starts at 0/$N" "$TRAIN_TEXT" "0/$N completed"
  pw_run "the drill rows on screen (title, minutes)" '(async page => JSON.stringify(await page.getByRole("list", { name: "Today'"'"'s drills" }).getByRole("listitem").allInnerTexts()))'
  ROWS=$PW_OUT
  assert_eq "$(jq 'length' <<<"$ROWS")" "$N" "the list shows $N drills, one per item of the session"
  UI_MIN=$(jq -r '[.[] | (split("\n") | map(select(test("^[0-9]+ min$"))) | .[0] | sub(" min$"; "") | tonumber)] | add' <<<"$ROWS")
  API_MIN=$(jq '[.items[].minutes] | add' <<<"$S1")
  assert_eq "$UI_MIN" "$API_MIN" "the minutes on screen add up to the API's minutes ($API_MIN)"
  if [ "${UI_MIN:-0}" -ge $((BUDGET - BUDGET_TOLERANCE)) ] && [ "${UI_MIN:-0}" -le $((BUDGET + BUDGET_TOLERANCE)) ]; then pass "the drill minutes sum to $UI_MIN, within $BUDGET_TOLERANCE of the $BUDGET-minute budget"
  else fail "the drill minutes sum to within $BUDGET_TOLERANCE of the $BUDGET-minute budget" "  sum on screen: $UI_MIN"; fi
  for ((i = 0; i < N; i++)); do
    title=$(jq -r ".items[$i].content.title.en" <<<"$S1")
    has "row $((i + 1)): the API's drill '$title' is in this place of the list" "$(jq -r ".[$i]" <<<"$ROWS")" "$title"
  done
  unfit=$(fit_bad "$S1" "$PLAYER_AGE")
  if [ -z "$unfit" ]; then pass "every drill of the session fits the player: equipment in the Ball + wall kit, space no larger than a yard, no partner, age $PLAYER_AGE in range"
  else fail "every drill of the session fits the player's equipment and space" "  not fitting: $unfit"; fi
  pw_run "Finish session is disabled while drills are open, with its hint" '(async page => JSON.stringify({
    disabled: await page.getByRole("button", { name: "Finish session" }).isDisabled(),
    hint: await page.getByText("Finish is available when every drill is done.").isVisible() }))'
  [ "$(jq -r '.disabled and .hint' <<<"$PW_OUT")" = true ] && pass "Finish session is disabled and says why (Finish is available when every drill is done.)" || fail "Finish session is disabled and says why" "  $PW_OUT"
  has "the roadmap focus panel shows the goal skill first" "$TRAIN_TEXT" "Weak foot Level"
fi

# --- B. the drills: content, swap without reload, Done, a result --------------------------------------------------------------------
SWAP_ID="" SWAPPED_FROM="" RESULT_ID=""
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  # the drill that is swapped: the first with a listed regression; the result goes on the first drill
  SWAP_ID=$(jq -r '[.items[] | select((.content.regressions | length) > 0) | .itemId] | .[0] // ""' <<<"$S1")
  RESULT_ID=$(jq -r '.items[0].itemId' <<<"$S1")
  if [ -n "$SWAP_ID" ]; then pass "a drill with a listed regression exists in the session ($SWAP_ID) for the 'too hard' swap"
  else fail "a drill with a listed regression exists in the session for the 'too hard' swap" "  no item lists a regression: $(jq -c '[.items[] | {itemId, r: (.content.regressions | length)}]' <<<"$S1")"; fi
  CUR=$S1
  for ((i = 0; i < N && WEB_OK == 1; i++)); do
    id=$(jq -r ".items[$i].itemId" <<<"$CUR")
    if [ "$i" -eq 0 ]; then
      pw_run "open drill $id from the list (tap the row)" "(async page => { await page.locator('a[href=\"/train/drill/$id\"]').click(); await page.waitForURL('**/train/drill/$id'); return page.url(); })"
    else
      pw_run "open drill $id with 'Next drill'" "(async page => { await page.getByRole('link', { name: 'Next drill' }).click(); await page.waitForURL('**/train/drill/$id'); return page.url(); })"
    fi
    [ "$WEB_OK" = 1 ] || break
    item=$(jq -c ".items[$i]" <<<"$CUR")
    check_drill_page "$item"

    if [ "$id" = "$SWAP_ID" ]; then
      SWAPPED_FROM=$item
      old_title=$(jq -r '.content.title.en' <<<"$item")
      pw_quiet "swap: set a marker on this page (a reload would lose it)" "(async page => { await page.evaluate(() => { window.__j3_marker = 'kept'; }); return 'ok'; })"
      since=$(last_request_index); since=${since:-0}
      pw_run "swap: 'Too hard' on '$old_title'" "(async page => {
        await page.getByRole('button', { name: 'Too hard' }).click();
        await page.getByRole('status').filter({ hasText: 'Swapped for an easier drill.' }).waitFor();
        return JSON.stringify({ marker: await page.evaluate(() => window.__j3_marker ?? null), url: page.url(), h1: await page.getByRole('heading', { level: 1 }).innerText() }); })"
      if [ "$WEB_OK" = 1 ]; then
        assert_eq "$(jq -r .marker <<<"$PW_OUT")" kept "swap: no page reload (the window marker survived)"
        assert_eq "$(jq -r .url <<<"$PW_OUT" | sed 's|^https\?://[^/]*||')" "/train/drill/$id" "swap: still on the same drill page (the item keeps its place)"
        expect_calls "swap: 1 API call, the swap endpoint" "$since" "POST /api/player/today/swap 200"
        fetch "$COOKIE" GET '/api/player/today?locale=en' '' -H "X-Timezone: $TZ_DAY1"
        CUR=$F_BODY
        new=$(jq -c ".items[$i]" <<<"$CUR")
        new_title=$(jq -r '.content.title.en' <<<"$new")
        if [ "$new_title" != "$old_title" ] && [ "$(jq -r '.drillVersionId' <<<"$new")" != "$(jq -r '.drillVersionId' <<<"$item")" ]; then pass "swap: the drill is another one ('$old_title' -> '$new_title')"
        else fail "swap: the drill is another one" "  before '$old_title' $(jq -r .drillVersionId <<<"$item"), after '$new_title' $(jq -r .drillVersionId <<<"$new")"; fi
        if jq -e --arg t "$new_title" '.content.regressions | map(.en) | index($t) != null' >/dev/null <<<"$item"; then pass "swap: the new drill is one of the old drill's listed regressions"
        else fail "swap: the new drill is a listed regression of the old drill" "  '$new_title' not in $(jq -c '[.content.regressions[].en]' <<<"$item")"; fi
        has "swap: the page now shows the new drill" "$(jq -r .h1 <<<"$PW_OUT")" "$new_title"
        if jq -e '.regressionOf != null' >/dev/null <<<"$new"; then pass "swap: the relation is recorded on the item (regressionOf $(jq -r .regressionOf <<<"$new"))"
        else fail "swap: the relation is recorded on the item (regressionOf)" "  item: $(jq -c 'del(.content)' <<<"$new")"; fi
        assert_eq "$(jq -c '[.items[] | .drillVersionId] | del(.['"$i"'])' <<<"$CUR")" "$(jq -c '[.items[] | .drillVersionId] | del(.['"$i"'])' <<<"$S1")" "swap: only that item changed, the other drills are the same"
        assert_eq "$(jq -c "[.items[$i] | .done]" <<<"$CUR")" "[false]" "swap: the swapped item is still to do"
        assert_eq "$(sqlite_count sessions "player_id = '$PLAYER'")" 1 "db: the swap rewrote the session, it made no second one"
        assert_eq "$(sqlite_scalar "SELECT json_extract(items, '\$[$i].drillVersionId') FROM sessions WHERE player_id = '$PLAYER'")" "$(jq -r .drillVersionId <<<"$new")" "db: the session stores the swapped-in drill version"
        unfit=$(fit_bad "$CUR" "$PLAYER_AGE")
        [ -z "$unfit" ] && pass "swap: every drill of the session still fits the player's kit and space" || fail "swap: every drill still fits the player's kit and space" "  not fitting: $unfit"
        echo "info: session total after the swap: $(jq '[.items[].minutes] | add' <<<"$CUR") min (budget $BUDGET)" >&2
        check_drill_page "$new"   # the new drill's own page shows its own content
        item=$new
      fi
    fi

    if [ "$id" = "$RESULT_ID" ]; then
      since=$(last_request_index); since=${since:-0}
      pw_run "result: type 12 into 'Your result' and save it on drill $id" "(async page => {
        await page.getByRole('textbox', { name: /Your result/ }).fill('12');
        await page.getByRole('button', { name: 'Save result' }).click();
        await page.getByText('Result saved: 12').waitFor();
        return 'ok'; })"
      [ "$WEB_OK" = 1 ] && expect_calls "result: 1 API call (the events endpoint)" "$since" "POST /api/player/session-events 200"
    fi

    since=$(last_request_index); since=${since:-0}
    pw_run "Done on drill $id" "(async page => {
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByRole('button', { name: 'Undo' }).waitFor();
      await page.getByText('Marked as done.').waitFor();
      return await page.locator('main').innerText(); })"
    if [ "$WEB_OK" = 1 ]; then
      expect_calls "Done on drill $id: 1 API call (the events endpoint)" "$since" "POST /api/player/session-events 200"
      has "drill $id: the state reads Done (a word and a check, not colour alone)" "$PW_OUT" "Marked as done."
    fi
  done
  # after the last drill: back to the list, every drill done
  if [ "$WEB_OK" = 1 ]; then
    pw_run "back to today's session from the last drill" "(async page => {
      await page.getByRole('link', { name: \"Back to today's session\", exact: true }).click();
      await page.waitForURL('**/train');
      await page.getByRole('button', { name: 'Finish session' }).waitFor();
      return JSON.stringify({ text: await page.locator('main').innerText(), enabled: await page.getByRole('button', { name: 'Finish session' }).isEnabled() }); })"
  fi
  if [ "$WEB_OK" = 1 ]; then
    has "every drill is done: $N/$N completed" "$(jq -r .text <<<"$PW_OUT")" "$N/$N completed"
    [ "$(jq -r .enabled <<<"$PW_OUT")" = true ] && pass "Finish session is enabled once every drill is done" || fail "Finish session is enabled once every drill is done" "  $PW_OUT"
    [ "$(jq -r '.text | test("All drills done")' <<<"$PW_OUT")" = true ] && pass "the list says: All drills done. Finish the session to save it." || fail "the list says all drills are done" "  $PW_OUT"
  fi
fi

# --- C. finish and the summary: 1 API call --------------------------------------------------------------------------------------
SUMMARY_TEXT=""
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  since=$(last_request_index); since=${since:-0}
  pw_run "Finish session: the summary opens" '(async page => {
    await page.getByRole("button", { name: "Finish session" }).click();
    await page.waitForURL("**/train/summary");
    await page.getByRole("heading", { level: 1, name: "Session complete" }).waitFor();
    await page.waitForLoadState("networkidle");
    return await page.locator("main").innerText(); })'
fi
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  SUMMARY_TEXT=$PW_OUT
  expect_calls "call budget: finishing the session costs 1 API call" "$since" "POST /api/player/session-events 200"
  DONE_MIN=$(jq '[.items[].minutes] | add' <<<"$CUR")
  has "summary: Session complete" "$SUMMARY_TEXT" "Session complete"
  has "summary: drills completed $N of $N" "$SUMMARY_TEXT" "Drills completed $N of $N"
  has "summary: minutes trained = the minutes of the done drills ($DONE_MIN)" "$SUMMARY_TEXT" "Minutes trained so far $DONE_MIN"
  has "summary: the streak is 1 day" "$SUMMARY_TEXT" "Current streak (days in a row) 1"
  has "summary: 1 session finished" "$SUMMARY_TEXT" "Sessions finished 1"
  has "summary: the next session date is $D_NEXT ($SPACING_DAYS days on, 3 sessions a week)" "$SUMMARY_TEXT" "Next session $(LC_ALL=C date -d "$D_NEXT" '+%A, %B %-d')"
  has "summary: the link My Journey" "$SUMMARY_TEXT" "My Journey"
  has "summary: the link Back home" "$SUMMARY_TEXT" "Back home"
  pw_run "summary: the two links go to /progress and /" '(async page => JSON.stringify({ journey: await page.getByRole("link", { name: "My Journey" }).getAttribute("href"), home: await page.getByRole("link", { name: "Back home" }).getAttribute("href") }))'
  [ "$WEB_OK" = 1 ] && assert_eq "$PW_OUT" '{"journey":"/progress","home":"/"}' "summary: My Journey -> /progress, Back home -> /"
  if [[ ${SUMMARY_TEXT,,} == *confetti* ]] ; then fail "summary: calm tone, no confetti"; else pass "summary: calm tone (no confetti, no ranking against others: the copy compares only with the player's own earlier sessions)"; fi
  has "summary: the copy measures against the player's own sessions only" "$SUMMARY_TEXT" "measured only against your own earlier sessions"
fi

# --- D. the database and the replay of the same batch ------------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  SID=$(jq -r .id <<<"$CUR")
  assert_eq "$(sqlite_count sessions)" 1 "db: 1 session in all"
  assert_eq "$(sqlite_count sessions "player_id = '$PLAYER' AND finished_at IS NOT NULL")" 1 "db: that session is finished (finished_at set from the session_finished event)"
  assert_eq "$(sqlite_scalar "SELECT count(*) FROM sessions s, json_each(s.items) j WHERE json_extract(j.value, '\$.done') = 1")" "$N" "db: all $N items of the session are stored as done"
  EXPECTED_EVENTS=$((N + 1 + 1))
  assert_eq "$(sqlite_count session_events)" "$EXPECTED_EVENTS" "db: $EXPECTED_EVENTS session_events ($N drill_done + 1 result + 1 session_finished)"
  assert_eq "$(sqlite_scalar "SELECT group_concat(type || ':' || n, ',') FROM (SELECT type, count(*) AS n FROM session_events GROUP BY type ORDER BY type)")" "drill_done:$N,result:1,session_finished:1" "db: the events by type"
  assert_eq "$(sqlite_scalar "SELECT count(DISTINCT client_uuid) FROM session_events")" "$EXPECTED_EVENTS" "db: every event has its own client_uuid (no duplicate)"
  assert_eq "$(sqlite_scalar "SELECT count(DISTINCT item_id) FROM session_events WHERE type = 'drill_done'")" "$N" "db: each drill was marked done exactly once"
  assert_eq "$(sqlite_scalar "SELECT item_id || '=' || value FROM session_events WHERE type = 'result'")" "$RESULT_ID=12.0" "db: the result 12 is stored against drill $RESULT_ID"
  assert_eq "$(sqlite_count session_events "session_id = '$SID' AND player_id = '$PLAYER'")" "$EXPECTED_EVENTS" "db: every event belongs to the player's session"
  BEFORE_ROW=$(sqlite_json "SELECT id, items, finished_at FROM sessions")
  BATCH=$(sqlite_json "SELECT client_uuid AS clientUuid, session_id AS sessionId, type, item_id AS itemId, value, at FROM session_events ORDER BY id" | jq -c '{events: map(with_entries(select(.value != null)))}')
  assert_eq "$(jq '.events | length' <<<"$BATCH")" "$EXPECTED_EVENTS" "the batch to replay is the $EXPECTED_EVENTS stored events"
  fetch "$COOKIE" POST /api/player/session-events "$BATCH" -H "X-Timezone: $TZ_DAY1"
  chk "replay: posting the same batch again with curl is 200 and answers the finished session" 200 \
    ".session.id == \"$SID\" and (.session.items | all(.[]; .done == true)) and .progress == {sessionsCompleted: 1, minutesTrained: $DONE_MIN, streakDays: 1} and .nextSessionDate == \"$D_NEXT\""
  # day 1 as the API holds it AFTER the training (the swap-time copy in CUR has nothing done yet): the history input of day 2
  CUR=$(jq -c .session <<<"$F_BODY")
  assert_eq "$(jq '[.items[] | select(.done)] | length' <<<"$CUR")" "$N" "replay: the day-1 session as answered has all $N drills done (the history the next session is built from)"
  assert_eq "$(sqlite_count session_events)" "$EXPECTED_EVENTS" "replay: still $EXPECTED_EVENTS session_events (no duplicate rows)"
  assert_eq "$(sqlite_scalar "SELECT count(DISTINCT client_uuid) FROM session_events")" "$EXPECTED_EVENTS" "replay: still $EXPECTED_EVENTS distinct client_uuids"
  assert_eq "$(sqlite_json "SELECT id, items, finished_at FROM sessions")" "$BEFORE_ROW" "replay: the session row (items, finished_at) is untouched"
  assert_eq "$(sqlite_count sessions)" 1 "replay: still 1 session"
  fetch "$COOKIE" POST /api/player/session-events "$BATCH" -H "X-Timezone: $TZ_DAY1"
  chk "replay: a third post is identical again (idempotent)" 200 ".progress == {sessionsCompleted: 1, minutesTrained: $DONE_MIN, streakDays: 1}"
  assert_eq "$(sqlite_count session_events)" "$EXPECTED_EVENTS" "replay x2: still $EXPECTED_EVENTS session_events"
fi

# --- E. reload: the completed state comes from the API --------------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw_run "reload: clear the browser's local copy of the session (IndexedDB), so only the API can answer" '(async page => {
    const dbs = await page.evaluate(async () => { const all = await indexedDB.databases(); for (const d of all) indexedDB.deleteDatabase(d.name); return all.map((d) => d.name); });
    return JSON.stringify(dbs); })'
  pw goto "$STACK_URL/train" >/dev/null
  pw_run "reload /train: the completed state is shown" '(async page => {
    await page.getByRole("list", { name: "Today'"'"'s drills" }).waitFor();
    await page.getByText(/^[0-9]+\/[0-9]+ completed$/).waitFor();
    return JSON.stringify({ text: await page.locator("main").innerText(), rows: await page.getByRole("list", { name: "Today'"'"'s drills" }).getByRole("listitem").allInnerTexts() }); })'
  if [ "$WEB_OK" = 1 ]; then
    has "reload /train: $N/$N completed" "$(jq -r .text <<<"$PW_OUT")" "$N/$N completed"
    assert_eq "$(jq '[.rows[] | select(split("\n") | index("Done"))] | length' <<<"$PW_OUT")" "$N" "reload /train: every one of the $N drill rows reads Done"
    # a full page load starts a fresh request list in playwright-cli ("requests since loading the page"), so index 0 = this reload
    if api_calls 0 | grep -q '^GET /api/player/today 200'; then pass "reload /train: the state came from GET /api/player/today (200) after the reload"
    else fail "reload /train: the state came from GET /api/player/today (200) after the reload" "  observed since the reload: $(api_calls 0 | tr '\n' ';')"; fi
  fi
  pw goto "$STACK_URL/train/summary" >/dev/null
  pw_run "summary opened in a new page load, with no finished session in memory: redirects to /train" '(async page => { await page.waitForURL("**/train"); return page.url(); })'
  assert_eq "$(sqlite_count session_events),$(sqlite_count sessions)" "$EXPECTED_EVENTS,1" "db after the reloads: the same $EXPECTED_EVENTS events and 1 session (the reloads wrote nothing)"
fi

# --- F. the next visit, on a later simulated date -------------------------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw close >/dev/null 2>&1 || true
  if open_browser "browser reopened on the same profile (day 2: device zone $TZ_DAY2, later calendar day $D2)" "$TZ_DAY2" /train; then
    pw_run "next visit: /train shows a NEW session, all to do" '(async page => {
      await page.getByRole("list", { name: "Today'"'"'s drills" }).waitFor();
      await page.getByText(/^0\/[0-9]+ completed$/).waitFor();
      return JSON.stringify({ text: await page.locator("main").innerText(), rows: await page.getByRole("list", { name: "Today'"'"'s drills" }).getByRole("listitem").allInnerTexts() }); })'
    if [ "$WEB_OK" = 1 ]; then
      DAY2_UI=$PW_OUT
      assert_eq "$(pw cookie-list | jq -r '.result // ""' | grep -c 'session_token')" 1 "next visit: the same profile still holds the player's session cookie (same player, not a new visitor)"
      fetch "$COOKIE" GET '/api/player/today?locale=en' '' -H "X-Timezone: $TZ_DAY2"
      S2=$F_BODY
      chk "api: the later visit's session is dated $D2, planner rules, and none of it is done" 200 ".date == \"$D2\" and .planner == \"rules\" and (.items | length) >= 3 and all(.items[]; .done == false)"
      N2=$(jq '.items | length' <<<"$S2")
      assert_eq "$(jq '.rows | length' <<<"$DAY2_UI")" "$N2" "next visit: the list shows the $N2 drills of the API's new session"
      for ((i = 0; i < N2; i++)); do
        title=$(jq -r ".items[$i].content.title.en" <<<"$S2")
        has "next visit: row $((i + 1)) is '$title'" "$(jq -r ".rows[$i]" <<<"$DAY2_UI")" "$title"
      done
      assert_eq "$(sqlite_scalar "SELECT group_concat(date, ',') FROM (SELECT date FROM sessions WHERE player_id = '$PLAYER' ORDER BY date)")" "$D1,$D2" "db: the player has 2 sessions, $D1 and $D2 (one per local day)"
      assert_eq "$(sqlite_scalar "SELECT id FROM sessions WHERE date = '$D2'")" "$(jq -r .id <<<"$S2")" "db: the new session is the one the API answers"
      if [ "$(jq -r .id <<<"$S2")" != "$SID" ] && [ "$(jq -c '[.items[].drillVersionId]' <<<"$S2")" != "$(jq -c '[.items[].drillVersionId]' <<<"$CUR")" ]; then pass "next visit: a different session (another id, another set of drills)"
      else fail "next visit: a different session" "  day 1: $(jq -c '[.items[].content.title.en]' <<<"$CUR")"$'\n'"  day 2: $(jq -c '[.items[].content.title.en]' <<<"$S2")"; fi
      # reflects the recorded results: the drills DONE on day 1 (the swapped-in one included, not the swapped-out one) are not in day 2
      done_drills=$(for v in $(jq -r '.items[] | select(.done) | .drillVersionId' <<<"$CUR"); do sqlite_scalar "SELECT drill_id FROM drill_versions WHERE id = '$v'"; done | sort)
      day2_drills=$(for v in $(jq -r '.items[].drillVersionId' <<<"$S2"); do sqlite_scalar "SELECT drill_id FROM drill_versions WHERE id = '$v'"; done | sort)
      history_check "next visit (browser player, 20 min)" "$done_drills" "$day2_drills"
      sum2=$(jq '[.items[].minutes] | add' <<<"$S2")
      if [ "$sum2" -ge $((BUDGET - BUDGET_TOLERANCE)) ] && [ "$sum2" -le $((BUDGET + BUDGET_TOLERANCE)) ]; then pass "next visit: the drill minutes are $sum2, within $BUDGET_TOLERANCE of the $BUDGET-minute budget"
      else fail "next visit: the drill minutes are within $BUDGET_TOLERANCE of the $BUDGET-minute budget" "  sum: $sum2 (skill test: $(jq -c '.skillTest' <<<"$S2"))"; fi
      unfit=$(fit_bad "$S2" "$PLAYER_AGE")
      [ -z "$unfit" ] && pass "next visit: every drill fits the player's kit and space" || fail "next visit: every drill fits the player's kit and space" "  not fitting: $unfit"
      has "next visit: the headline is this session's minutes" "$(jq -r .text <<<"$DAY2_UI")" "$(jq -r .totalMinutes <<<"$S2") min today"
      assert_eq "$(sqlite_count session_events)" "$EXPECTED_EVENTS" "db: the later visit added no event (still $EXPECTED_EVENTS)"
      assert_eq "$(sqlite_count sessions "finished_at IS NOT NULL")" 1 "db: only day 1 is finished"
    fi
  fi
fi

# --- G. the API contract of the journey, over curl -------------------------------------------------------------------------------------------
if [ -n "${COOKIE:-}" ] && [ -n "${SID:-}" ]; then
  fetch - POST /api/player/session-events '{"events":[]}'
  chk "api: no cookie, no events (POST /api/player/session-events 401)" 401 '.status == 401'
  fetch "$COOKIE" POST /api/player/session-events '{"events":[]}'
  chk "api: an empty batch is a 422 problem with a pointer" 422 '.status == 422 and (.errors | length) > 0 and (.errors[0].pointer | type == "string")'
  fetch "$COOKIE" POST /api/player/session-events "$(jq -nc --arg u "$(uuid c)" '{events: [{clientUuid: $u, sessionId: "no-such-session", type: "session_finished", at: (now | todate | sub("\\.[0-9]+Z$"; ".000Z"))}]}')"
  chk "api: an event of an unknown session is a 404 that names the event (/events/0)" 404 '.status == 404 and (.errors | map(.pointer) | index("/events/0")) != null'
  assert_eq "$(sqlite_count session_events)" "$EXPECTED_EVENTS" "db: the refused batches wrote nothing"
  fetch "$COOKIE" POST /api/player/today/swap '{"itemId":"item-1","direction":"easier"}' -H "X-Timezone: $TZ_DAY1"
  chk "api: swapping a finished drill of day 1 is a 409 problem" 409 '.status == 409'
  fetch "$COOKIE" POST /api/player/today/swap '{"itemId":"item-1","direction":"sideways"}' -H "X-Timezone: $TZ_DAY1"
  chk "api: a swap direction that is not easier/harder is a 422 problem" 422 '.status == 422'
fi
sign_in "a visitor who never onboarded"
if [ -n "$V_COOKIE" ]; then
  fetch "$V_COOKIE" GET '/api/player/today?locale=en'
  chk "api: a signed-in visitor without a plan gets 404 'not onboarded' from today" 404 '.status == 404 and (.detail | test("not onboarded"))'
fi

# --- H. a cohort of other players over curl: the same journey, other ages and budgets --------------------------------------------------
# The browser journey above is ONE player. The picker is seeded by player id and date, so its rules (budget window, kit, history)
# are also proven on other players with other ages and minutes budgets: sign in, start, open today (day-1 zone), do every drill and
# finish in ONE batch, then open the later day (day-2 zone). Per player: the drills fit the kit, the minutes are within 3 of the
# player's own budget, the progress is exact, and none of the drills done on day 1 is in day 2's session.
drill_of() { sqlite_scalar "SELECT drill_id FROM drill_versions WHERE id = '$1'"; }
cohort_player() { # <age> <level> <minutes>
  local age=$1 level=$2 minutes=$3 label="cohort (age $1, $3 min)" ck body s1 s2 sum1 sum2 batch i n bad ids1 ids2
  sign_in "$label"; [ -n "$V_COOKIE" ] || return 0
  ck=$V_COOKIE
  body=$(jq -nc --argjson age "$age" --arg level "$level" --argjson minutes "$minutes" --arg u1 "$(cat /proc/sys/kernel/random/uuid)" --arg u2 "$(cat /proc/sys/kernel/random/uuid)" --arg u3 "$(cat /proc/sys/kernel/random/uuid)" --arg u4 "$(cat /proc/sys/kernel/random/uuid)" --arg u5 "$(cat /proc/sys/kernel/random/uuid)" '{
    profile: {age: $age, level: $level, goal: "weakfoot", equipment: "ball_wall", space: "yard", partner: false, daysPerWeek: 3, minutesPerSession: $minutes, locale: "en"},
    baseline: [{testSlug: "juggling-max-touches", value: 15, clientUuid: $u1}, {testSlug: "wall-passing-60s", value: 30, clientUuid: $u2}, {testSlug: "ball-mastery-30s", value: 40, clientUuid: $u3},
               {testSlug: "weak-foot-passes", value: 4, clientUuid: $u4}, {testSlug: "slalom-time", value: 0, skipped: true, clientUuid: $u5}]}')
  fetch "$ck" POST /api/player/start "$body"
  chk "$label: onboarded over the API" 200 '.roadmap.focus | length >= 2'
  fetch "$ck" GET '/api/player/today?locale=en' '' -H "X-Timezone: $TZ_DAY1"
  s1=$F_BODY
  chk "$label: today's session ($D1) has drills and no skill test yet" 200 ".date == \"$D1\" and (.items | length) >= 2 and .skillTest == null"
  [ "$F_CODE" = 200 ] || return 0
  sum1=$(jq '[.items[].minutes] | add' <<<"$s1")
  if [ "$sum1" -ge $((minutes - BUDGET_TOLERANCE)) ] && [ "$sum1" -le $((minutes + BUDGET_TOLERANCE)) ]; then pass "$label: the drill minutes are $sum1, within $BUDGET_TOLERANCE of the $minutes-minute budget"
  else fail "$label: the drill minutes are within $BUDGET_TOLERANCE of the $minutes-minute budget" "  sum: $sum1 drills: $(jq -c '[.items[] | {t: .content.title.en, m: .minutes}]' <<<"$s1")"; fi
  bad=$(fit_bad "$s1" "$age"); [ -z "$bad" ] && pass "$label: every drill fits (Ball + wall kit, yard, no partner, age $age)" || fail "$label: every drill fits the player's kit, space and age" "  not fitting: $bad"
  n=$(jq '.items | length' <<<"$s1")
  batch=$(jq -nc --argjson s "$s1" --arg at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" --argjson u "$(for ((i = 0; i <= n; i++)); do cat /proc/sys/kernel/random/uuid; done | jq -R . | jq -sc .)" '
    {events: ([$s.items | to_entries[] | {clientUuid: $u[.key], sessionId: $s.id, type: "drill_done", itemId: .value.itemId, at: $at}]
      + [{clientUuid: $u[($s.items | length)], sessionId: $s.id, type: "session_finished", at: $at}])}')
  fetch "$ck" POST /api/player/session-events "$batch" -H "X-Timezone: $TZ_DAY1"
  chk "$label: every drill done and the session finished in ONE call: progress is 1 session, $sum1 minutes, streak 1" 200 \
    ".progress == {sessionsCompleted: 1, minutesTrained: $sum1, streakDays: 1} and (.session.items | all(.[]; .done)) and .nextSessionDate == \"$D_NEXT\""
  fetch "$ck" GET '/api/player/today?locale=en' '' -H "X-Timezone: $TZ_DAY2"
  s2=$F_BODY
  chk "$label: the later day ($D2) is a new session, all to do" 200 ".date == \"$D2\" and .id != \"$(jq -r .id <<<"$s1")\" and (.items | length) >= 2 and all(.items[]; .done == false)"
  [ "$F_CODE" = 200 ] || return 0
  ids1=$(for v in $(jq -r '.items[].drillVersionId' <<<"$s1"); do drill_of "$v"; done | sort)
  ids2=$(for v in $(jq -r '.items[].drillVersionId' <<<"$s2"); do drill_of "$v"; done | sort)
  history_check "$label" "$ids1" "$ids2"
  sum2=$(jq '[.items[].minutes] | add' <<<"$s2")
  if [ "$sum2" -ge $((minutes - BUDGET_TOLERANCE)) ] && [ "$sum2" -le $((minutes + BUDGET_TOLERANCE)) ]; then pass "$label: the later session's minutes are $sum2, within $BUDGET_TOLERANCE of $minutes"
  else fail "$label: the later session's minutes are within $BUDGET_TOLERANCE of $minutes" "  sum: $sum2"; fi
  bad=$(fit_bad "$s2" "$age"); [ -z "$bad" ] && pass "$label: the later session's drills fit the kit, space and age" || fail "$label: the later session's drills fit" "  not fitting: $bad"
}
if [ -n "${SID:-}" ]; then
  cohort_player 12 basic 10
  cohort_player 7 beginner 15
  cohort_player 16 basic 20
  cohort_player 12 basic 30
  cohort_player 16 basic 45
fi
history_aggregate

if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 0 ]; then _e2e_err "NOTE: a browser step failed; the browser steps that depend on it were not run (the first FAIL above is the cause)"; fi
# no explicit stop or summary: the EXIT handler stops the stack, prints the summary, sets the exit code
