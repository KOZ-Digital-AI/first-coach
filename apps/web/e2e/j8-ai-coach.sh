#!/usr/bin/env bash
# apps/web/e2e/j8-ai-coach.sh: slice gate fc-mol-9hy, journey J8 "the AI Coach personalises today's session from approved drills only".
# Integration proof on the REAL stack (real API process, real SQLite file with the real seed, the real built web app served by the
# API, a real browser; nothing mocked, no stubbed model). Two halves, exactly as the criteria split them:
#
#   KEYED half (needs a real OPENAI_API_KEY, from the environment or from the repo's .env; it runs for real when one is present and
#   is reported BLOCKED, reason "external credential: OPENAI_API_KEY", when there is none: never a pass, never a silent skip):
#     K1  a player (age 12, Ball + wall, yard, no partner, 20 min) presses "Personalise with AI" on today's session and within 20 s
#         sees the tag "AI-personalised from approved drills" and a short reason under EVERY drill (the reasons are the API's own).
#     K2  API + sqlite: the stored session is planner 'ai'; every drillVersionId is a PUBLISHED version, inside the candidate set the
#         server logged, and fits the player's kit; the total minutes are inside the validator's window (budget-2 .. budget+3); one
#         ai_calls row holds the candidate ids, the chosen ids (= the session's) and validator_result 'ok'.
#     K3  on a drill, "Explain more simply" shows text labelled "AI-generated — the coach's original text is above" NEXT TO the
#         canonical instructions and safety note (still on the page); sqlite: no new drill version, no contribution.
#   UNKEYED half (always runs; the API is RESTARTED on the same database with OPENAI_API_KEY unset, and a second player is used, since
#   the server answers one AI plan per player per day):
#     U1  the API's /health says aiAvailable false; POST /api/player/today/ai-plan answers 200 in under 2 s with the deterministic
#         session (same drills, planner 'rules') and fallback.code 'no_key'.
#     U2  the UI: the button "Personalise with AI" is on the page, pressing it shows the quiet note "AI is unavailable — here is your
#         standard plan." in under 2 s, with no error alert / error state (no toast).
#     U3  sqlite: the ai_calls row(s) of the player carry the fallback code 'no_key' and NO prompt or free text (no such column, and the
#         note the player typed is nowhere in the table or the database file).
#     U4  explain: the API answers 503 problem 'ai_unavailable' and the drill player shows its quiet "not available" note (no AI text,
#         no alert, the coach's text intact); nothing is written to drill_versions or contributions.
#     U5  the admin setting (the real admin CLI makes the admin, the real PUT /api/admin/settings sets it): with aiPlannerEnabled=false
#         the API answers fallback 'disabled' (the setting beats the missing key) and the button is hidden. Then, since with no key
#         the button is hidden by /health anyway (which would make that check pass for the wrong reason), the API is restarted ONCE
#         MORE with a PLACEHOLDER key value (not a credential: the provider is never called, the setting short-circuits it, and the
#         button is never pressed) so that /health says aiAvailable true: the button must STILL be hidden, because only the setting
#         says so. This step needs no credential and runs for real. If the button is (wrongly) still there, U5b presses it: the server
#         answers 'disabled' before any provider call, which shows the quiet-note path (text, under 2 s, no error) for real.
# Exit codes (lib.sh): 0 every step passed, 1 at least one FAIL, 3 nothing failed but a step was BLOCKED (here: the keyed half without a
# key, or no browser); E2E_ALLOW_BLOCKED=1 keeps a blocked-only run at 0. BLOCKED is never counted as a pass.
#
# Readings of the criteria where they are open (each is one line of the script):
#   * "within 20 s": the time from the click on the button to the tag "AI-personalised from approved drills" on screen, measured in the
#     page; the server's own hard timeout is 20 s, so a slower answer is the deterministic fallback and fails this step.
#   * "total minutes within the budget": the validator's own window of the product (validatePlan: budget-2 .. budget+3), where budget =
#     the player's minutes per session minus the 2-minute skill test when one is due (none is due on day 1) minus finished drills.
#   * "every drillVersionId is a published version": it is the CURRENT version of a drill that is not unpublished (the commons rule that
#     j3 and the API use), and it is one of the ids the server logged as offered (ai_calls.candidate_ids).
#   * "in under 2 s": curl's own clock for the API request, and the page's own clock from the click to the note on screen.
#   * "no error toast": the app has no toast component; the check is that no element with role=alert and no error state ("Could not
#     reach the AI coach") is on the page, and the note itself is a role=status notice.
#   * "explain shows 'unavailable'": the API answer is asserted strictly (503, problem type 'ai_unavailable'). The UI asserts a quiet
#     "AI explanations are not available right now" OR "not switched on here" note: with no key the drill player reads /health first and
#     shows the second wording (messages 'off') instead of offering a button that would end in the first ('unavailable').
#   * "no prompt text / free text": ai_calls has no column for them (PRAGMA table_info) and the typed note ('my ankle is tired') is in no
#     ai_calls value and in no byte of the database file.
#   * BROWSER: Chromium with a UTC clock and en-US (as j7): the app sends X-Timezone UTC, so the curl calls without that header are on
#     the same day. The players are made through the real endpoints (POST /api/auth/sign-in/anonymous, POST /api/player/start), onboarding
#     being J2's proof, and the browser gets the player's real session cookie.
# Fail-slow (no set -e): every step reports. Cleanup: e2e_defer (never `trap ... EXIT` after sourcing lib.sh). The key is never printed.
# Ports: the API gets a free kernel-assigned port (lib.sh start_stack), kept across the restarts; nothing is ever bound to :4111 or
# :5173 and no process this script did not start is touched. The browser session name is unique per run (E2E_SESSION).
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$HERE/lib.sh"

BUDGET=20                # the players' minutes per session
PLAYER_AGE=12
NOTE='my ankle is tired'
AI_WAIT_MS=20000         # "within 20 s"
FALLBACK_WAIT_MS=2000    # "in under 2 s"
PLACEHOLDER_KEY='sk-e2e-placeholder-not-a-credential'   # only makes /health say aiAvailable; the provider is never called with it
NBSP=$(printf '\xc2\xa0')
unset SEED_DIR   # the API must start on the repo's default seed

scratch=$(mktemp -d "${TMPDIR:-/tmp}/j8-gate.XXXXXX") || exit 1
# the browser is closed BEFORE the scratch dir is removed
e2e_defer 'pw close >/dev/null 2>&1; rm -rf -- "$scratch"'

# The harness has no public "restart the API on the same DB" (j1a-seed.sh and j7-offline.sh use the same private helpers for the same
# purpose). Refuse loudly if they go away.
for fn in _e2e_kill _e2e_launch_api _e2e_wait_api; do
  declare -F "$fn" >/dev/null || { fail "harness helper $fn is missing (lib.sh changed); this gate needs a same-DB restart"; exit 1; }
done

# --- the key: the environment, else the repo's .env (never printed) ---------------------------------------------------------------
env_file_value() { # <NAME>: its value in the repo's .env, unquoted, or nothing
  local file="$E2E_REPO_ROOT/.env" line
  [ -f "$file" ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$file" | tail -n1) || return 0
  line=${line#*=}; line=${line%%[[:space:]]#*}
  line=$(sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/' <<<"$line")
  printf '%s' "$line"
}
REAL_KEY=$(printf '%s' "${OPENAI_API_KEY:-}" | tr -d '[:space:]')
[ -n "$REAL_KEY" ] || REAL_KEY=$(env_file_value OPENAI_API_KEY | tr -d '[:space:]')
KEYED=0
[ -z "$REAL_KEY" ] || KEYED=1
for name in OPENAI_MODEL OPENAI_VISION_MODEL; do   # model names may come from .env too (not secrets)
  if [ -z "${!name:-}" ]; then val=$(env_file_value "$name"); [ -z "$val" ] || export "$name=$val"; fi
done
unset OPENAI_API_KEY
[ "$KEYED" = 0 ] || export OPENAI_API_KEY=$REAL_KEY
KEY_NOTE=$([ "$KEYED" = 1 ] && echo "a real key is present (env or .env): the keyed half runs" || echo "no OPENAI_API_KEY in the environment or in .env: the keyed half is BLOCKED")
echo "info: $KEY_NOTE" >&2

# --- small helpers (the house helpers of j3-session.sh / j7-offline.sh) ----------------------------------------------------------
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
# timed_post <cookie> <path> <json>: like fetch for a POST, plus F_TIME = curl's own total time in seconds.
timed_post() {
  local out
  out=$(curl -s --max-time "$E2E_HTTP_TIMEOUT" -X POST -o "$scratch/f.body" -w '%{http_code} %{time_total}' -H "Origin: $API_URL" -H "Cookie: $1" \
    -H 'content-type: application/json' -d "$3" "$API_URL$2" 2>/dev/null) || out="000 0"
  F_CODE=${out%% *}; F_TIME=${out##* }; F_BODY=$(cat "$scratch/f.body" 2>/dev/null)
}
# chk <label> <status> <jq expression on F_BODY>
chk() {
  if [ "$F_CODE" != "$2" ]; then fail "$1" "  HTTP $F_CODE (wanted $2): ${F_BODY:0:800}"; return 1; fi
  if jq -e "$3" >/dev/null 2>&1 <<<"$F_BODY"; then pass "$1"; else fail "$1" "  jq -e '$3' was false or failed"$'\n'"  HTTP $F_CODE payload: ${F_BODY:0:1800}"; fi
}
# jchk <label> <json> <jq expression>
jchk() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "  jq -e '$3' was false or failed"$'\n'"  input: ${2:0:1800}"; fi; }
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
norm() { tr -s '[:space:]' ' ' <<<"${1//$NBSP/ }" | sed -E 's/^ //; s/ $//'; }
# has <label> <haystack> <needle>: case-insensitive containment on whitespace-normalised text.
has() {
  local hay needle
  hay=$(norm "$2"); needle=$(norm "$3")
  if [[ ${hay,,} == *"${needle,,}"* ]]; then pass "$1"; else fail "$1" "  needle: $needle"$'\n'"  saw: ${hay:0:1200}"; fi
}
lt_seconds() { awk -v t="$1" -v max="$2" 'BEGIN { exit !(t + 0 < max + 0) }'; }   # <t> < <max> (seconds)

# restart_api <key value | "">: stop the API child and start it again on the SAME temp dir, DB and port, with OPENAI_API_KEY set to
# the value (or unset when empty). Returns _e2e_wait_api's code: 0 ready, 2 died during boot, 1 timeout.
restart_api() {
  local rc=0
  if [ -n "$1" ]; then export OPENAI_API_KEY=$1; else unset OPENAI_API_KEY; fi
  _e2e_kill "$E2E_API_PID"
  _e2e_launch_api "$E2E_API_PORT_USED"
  _e2e_wait_api "$E2E_API_PID" "$E2E_TMP/api.log" "$E2E_API_PORT_USED" || rc=$?
  return "$rc"
}

# start_player <label>: a player made through the real endpoints (anonymous sign-in, POST /api/player/start); sets P_COOKIE, P_ID.
start_player() {
  local label=$1 known
  P_COOKIE="" P_ID=""
  known=$(sqlite_count player_profiles)
  fetch - POST /api/auth/sign-in/anonymous '{}'
  P_COOKIE=$(grep -i '^set-cookie: *[^;]*session_token=' <<<"$F_HDRS" | head -n1 | sed -E 's/^[^:]*: *//; s/;.*//')
  if [ "$F_CODE" = 200 ] && [ -n "$P_COOKIE" ]; then pass "$label: anonymous sign-in answers 200 with a session cookie"
  else P_COOKIE=""; fail "$label: anonymous sign-in answers 200 with a session cookie" "  HTTP $F_CODE headers: ${F_HDRS:0:400} body: ${F_BODY:0:400}"; return 1; fi
  fetch "$P_COOKIE" POST /api/player/start "$(jq -nc --arg a "$(uuid 1)" --arg b "$(uuid 2)" --arg c "$(uuid 3)" --arg d "$(uuid 4)" --arg e "$(uuid 5)" --argjson age "$PLAYER_AGE" --argjson min "$BUDGET" \
    '{profile: {age: $age, level: "basic", goal: "weakfoot", equipment: "ball_wall", space: "yard", partner: false, daysPerWeek: 3, minutesPerSession: $min, locale: "en"},
      baseline: [{testSlug: "juggling-max-touches", value: 15, clientUuid: $a}, {testSlug: "wall-passing-60s", value: 30, clientUuid: $b}, {testSlug: "ball-mastery-30s", value: 40, clientUuid: $c},
                 {testSlug: "weak-foot-passes", value: 4, clientUuid: $d}, {testSlug: "slalom-time", value: 0, skipped: true, clientUuid: $e}]}')"
  chk "$label: POST /api/player/start onboards the player (age $PLAYER_AGE, Ball + wall, yard, no partner, $BUDGET min)" 200 '.profile.minutesPerSession == 20 and (.roadmap.tracks | length) == 5'
  P_ID=$(sqlite_scalar "SELECT player_id FROM player_profiles ORDER BY rowid DESC LIMIT 1")
  assert_eq "$(sqlite_count player_profiles)" "$((known + 1))" "$label: db: one more player profile ($P_ID)"
}

# --- the player's kit (the planner's own rule, candidates.ts; as j3): what a drill may need for THIS player ----------------------
FIT_JQ='def owned: ["nothing","ball","ball_wall"];
  def size: {"home_3x3":1,"yard":2,"gym":2,"field":3};
  .content.conditions as $c
  | ($c.equipment | IN(owned[])) and ([$c.spaces[] | size[.]] | min) <= 2 and ($c.partner == false)
    and ($c.ageMin == null or $c.ageMin <= $age) and ($c.ageMax == null or $c.ageMax >= $age)'
fit_bad() { jq -r --argjson age "$2" "[.items[] | select(($FIT_JQ) | not) | .content.title.en] | join(\", \")" <<<"$1"; }

# --- browser helpers ---------------------------------------------------------------------------------------------------------------
WEB_OK=0 WEB_ON=0
PW_TIMEOUT=10000
# pw_run <label> <js: async page => ...>: runs a Playwright snippet; PASS when it completes, FAIL with the error otherwise; the returned
# value is left in PW_OUT. Every action times out after PW_TIMEOUT ms.
pw_run() {
  local label=$1 code=$2 out
  PW_OUT=""
  out=$(pw run-code "async page => { page.setDefaultTimeout($PW_TIMEOUT); const run = ${code}; return await run(page); }") || {
    fail "$label" "  $(jq -r '.error // .' <<<"$out" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | head -n 12)"; WEB_OK=0; return 1; }
  PW_OUT=$(jq -r '.result | (try fromjson catch .) | if type == "string" then . else tojson end' <<<"$out")
  pass "$label"
}
pw_quiet() { # like pw_run, records nothing on success
  local label=$1 code=$2 out
  PW_OUT=""
  out=$(pw run-code "async page => { page.setDefaultTimeout($PW_TIMEOUT); const run = ${code}; return await run(page); }") || {
    fail "$label" "  $(jq -r '.error // .' <<<"$out" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | head -n 12)"; WEB_OK=0; return 1; }
  PW_OUT=$(jq -r '.result | (try fromjson catch .) | if type == "string" then . else tojson end' <<<"$out")
}
# browse_as <label> <cookie>: a fresh browser (UTC clock, en-US) that holds THIS player's real session cookie. Sets WEB_ON / WEB_OK.
browse_as() {
  local label=$1 cookie=$2 out cfg="$scratch/pw.json"
  WEB_ON=0 WEB_OK=0
  pw close >/dev/null 2>&1
  if [ "$E2E_WEB" != api ]; then blocked "$label" "E2E_WEB=$E2E_WEB: the web app is not served"; return 1; fi
  if ! pw_available; then blocked "$label" "playwright-cli is not installed"; return 1; fi
  printf '{"browser":{"contextOptions":{"timezoneId":"UTC","locale":"en-US"}}}\n' >"$cfg"
  if out=$(pw open "$STACK_URL/" --config="$cfg" 2>&1); then pass "$label: browser opened $STACK_URL/ (Chromium, UTC, en-US)"
  elif grep -qiE 'not installed|Executable doesn.t exist' <<<"$out"; then blocked "$label" "no usable browser: $(grep -iE 'not installed|Executable' <<<"$out" | head -n1)"; return 1
  else fail "$label: browser opened $STACK_URL/" "$out"; return 1; fi
  pw resize 1280 1800 >/dev/null
  WEB_ON=1 WEB_OK=1
  pw_run "$label: the player's session cookie is set in the browser" "(async page => {
    await page.context().addCookies([{ name: $(js "${cookie%%=*}"), value: $(js "${cookie#*=}"), url: $(js "$STACK_URL") }]);
    return 'ok'; })"
}
# open_train: /train with today's drill list on screen and the /health answer (which the AI controls read) in.
open_train() { # <label>
  pw_run "$1: /train shows today's drills" "(async page => {
    const health = page.waitForResponse((r) => new URL(r.url()).pathname === '/health', { timeout: 10000 }).catch(() => null);
    await page.goto($(js "$STACK_URL")+'/train');
    await page.getByRole('list', { name: \"Today's drills\" }).waitFor();
    await health;
    await page.waitForTimeout(700);
    return await page.locator('main').innerText(); })"
}
web_blocked() { blocked "$1" "no usable browser for this step (see the browser step above)"; }

# ============================================================================================================================
start_stack || exit 1
assert_api /health '.ok == true and .database == "ok"' -l "stack: /health ok on the temp DB (port $E2E_API_PORT_USED, own media dir)"
assert_eq "$(sqlite_count sqlite_master "name = 'ai_calls'")" 1 "db: migration 008 made the ai_calls table"
assert_eq "$(sqlite_count ai_calls)" 0 "db: the ai_calls log starts empty"
assert_eq "$(sqlite_count player_profiles),$(sqlite_count sessions),$(sqlite_count contributions)" "0,0,0" "start state: no player, no session, no contribution"
PUBLISHED_SQL="id IN (SELECT current_version_id FROM drills WHERE unpublished_at IS NULL)"
PUBLISHED=$(sqlite_count drill_versions "$PUBLISHED_SQL")
if [ "$PUBLISHED" -ge 20 ]; then pass "the real seed: $PUBLISHED published drill versions (the candidate pool)"; else fail "the real seed has published drills" "  $PUBLISHED"; fi
assert_api /health ".aiAvailable == $([ "$KEYED" = 1 ] && echo true || echo false)" -l "stack: /health aiAvailable is $([ "$KEYED" = 1 ] && echo true || echo false) (the key the API was started with)"

# ============================================================================================================================
# KEYED half
# ============================================================================================================================
if [ "$KEYED" = 0 ]; then
  blocked "K1: the player presses 'Personalise with AI' and within 20 s sees 'AI-personalised' and a reason under every drill" "external credential: OPENAI_API_KEY"
  blocked "K2: api + sqlite: every drillVersionId published and in the candidate set, minutes within budget, ai_calls row with candidate ids, chosen ids and validator 'ok'" "external credential: OPENAI_API_KEY"
  blocked "K3: 'Explain more simply' shows text labelled 'AI-generated' next to the canonical text; no new drill version or contribution" "external credential: OPENAI_API_KEY"
else
  start_player "keyed player A" && A_COOKIE=$P_COOKIE A_ID=$P_ID
  if [ -z "${A_COOKIE:-}" ]; then fail "keyed half: player A exists" "  no cookie"
  else
    fetch "$A_COOKIE" GET '/api/player/today?locale=en'
    S0=$F_BODY
    chk "keyed: today's session starts as the deterministic one (planner rules, 2-8 drills, nothing done)" 200 '.planner == "rules" and (.items | length) >= 2 and all(.items[]; .done == false)'
    BUDGET_AI=$((BUDGET - $(jq 'if .skillTest == null then 0 else 2 end' <<<"$S0")))
    VERSIONS_BEFORE=$(sqlite_count drill_versions); CONTRIB_BEFORE=$(sqlite_count contributions)
    browse_as "keyed" "$A_COOKIE" && open_train "keyed: open"
    OUTCOME=""
    if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
      PW_TIMEOUT=30000
      pw_run "K1: type a note and press 'Personalise with AI'" "(async page => {
        await page.getByRole('textbox', { name: /Anything the coach should know/ }).fill($(js "$NOTE"));
        const tag = page.getByText('AI-personalised from approved drills');
        const std = page.getByText('AI is unavailable — here is your standard plan.');
        const err = page.getByText('Could not reach the AI coach');
        const t0 = Date.now();
        await page.getByRole('button', { name: 'Personalise with AI' }).click();
        await tag.or(std).or(err).first().waitFor({ timeout: 26000 });
        const ms = Date.now() - t0;
        const outcome = (await tag.count()) > 0 ? 'ai' : (await std.count()) > 0 ? 'rules' : 'error';
        const region = page.getByRole('region', { name: 'Why these drills today' });
        const rows = outcome === 'ai' ? await region.getByRole('listitem').evaluateAll((lis) => lis.map((li) => ({ text: li.innerText, reason: li.querySelector('p') ? li.querySelector('p').innerText : '' }))) : [];
        const noteText = outcome === 'rules' ? await page.getByRole('status').allInnerTexts() : [];
        return JSON.stringify({ outcome, ms, rows, noteText, alerts: await page.locator('[role=alert]').count() }); })"
      PW_TIMEOUT=10000
      if [ "$WEB_OK" = 1 ]; then
        OUTCOME=$(jq -r .outcome <<<"$PW_OUT")
        UI_RESULT=$PW_OUT
        assert_eq "$OUTCOME" ai "K1: the session comes back marked 'AI-personalised from approved drills' (not the standard-plan note or an error)"
        [ "$OUTCOME" = ai ] || echo "info: K1 outcome $OUTCOME: $(jq -c '{ms, noteText, alerts}' <<<"$UI_RESULT")" >&2
        if [ "$OUTCOME" = ai ]; then
          jchk "K1: within $((AI_WAIT_MS / 1000)) s of the click (took $(jq .ms <<<"$UI_RESULT") ms)" "$UI_RESULT" ".ms <= $AI_WAIT_MS"
        fi
      fi
    else web_blocked "K1: press 'Personalise with AI' (UI)"; fi

    # K2: the API and the database
    fetch "$A_COOKIE" GET '/api/player/today?locale=en'
    S_AI=$F_BODY
    chk "K2 api: today's stored session is planner 'ai' with 2-8 drills" 200 '.planner == "ai" and (.items | length) >= 2 and (.items | length) <= 8'
    if [ "$(jq -r .planner <<<"$S_AI")" = ai ]; then
      N=$(jq '.items | length' <<<"$S_AI")
      chk "K2 api: a short reason (1-160 characters, no link) under every drill" 200 'all(.items[]; (.reason // "") as $r | ($r | gsub("\\s"; "") | length) > 0 and ($r | length) <= 160 and ($r | test("https?://|www\\.") | not))'
      if [ -n "${UI_RESULT:-}" ] && [ "$OUTCOME" = ai ]; then
        jchk "K1: the screen lists $N drills with the API's own reason under each, in order" "$(jq -nc --argjson ui "$UI_RESULT" --argjson api "$S_AI" '{ui: ($ui.rows | map(.reason)), api: ($api.items | map(.reason | gsub("^\\s+|\\s+$"; "")))}')" '.ui == .api and (.ui | length) == '"$N"' and all(.ui[]; length > 0)'
      fi
      IDS=$(jq -c '[.items[].drillVersionId]' <<<"$S_AI")
      IN_LIST=$(jq -r 'map("'"'"'" + . + "'"'"'") | join(",")' <<<"$IDS")
      assert_eq "$(sqlite_count drill_versions "$PUBLISHED_SQL AND id IN ($IN_LIST)")" "$(jq 'unique | length' <<<"$IDS")" "K2 db: every drillVersionId of the stored session is a published drill version"
      assert_eq "$(jq 'unique | length' <<<"$IDS")" "$N" "K2 api: no drill twice in the session"
      unfit=$(fit_bad "$S_AI" "$PLAYER_AGE")
      if [ -z "$unfit" ]; then pass "K2: every drill fits the player's kit (Ball + wall, yard, no partner, age $PLAYER_AGE)"; else fail "K2: every drill fits the player's kit" "  not fitting: $unfit"; fi
      SUM=$(jq '[.items[].minutes] | add' <<<"$S_AI")
      if [ "$SUM" -ge $((BUDGET_AI - 2)) ] && [ "$SUM" -le $((BUDGET_AI + 3)) ]; then pass "K2: the total is $SUM min, inside the budget window $((BUDGET_AI - 2))..$((BUDGET_AI + 3)) (budget $BUDGET_AI)"
      else fail "K2: the total minutes are within the budget" "  $SUM min, allowed $((BUDGET_AI - 2))..$((BUDGET_AI + 3)) for a budget of $BUDGET_AI"; fi
      assert_eq "$(sqlite_scalar "SELECT planner FROM sessions WHERE player_id = '$A_ID'")" ai "K2 db: the session row is stored with planner 'ai'"
      assert_eq "$(sqlite_count ai_calls "player_id = '$A_ID' AND kind = 'plan'")" 1 "K2 db: exactly one ai_calls plan row for the player"
      ROW=$(sqlite_json "SELECT candidate_ids, chosen_ids, validator_result, fallback_code, model, profile_hash, latency_ms FROM ai_calls WHERE player_id = '$A_ID' AND kind = 'plan'" | jq -c '.[0] // {}')
      jchk "K2 db: the ai_calls row: validator_result 'ok', no fallback code, a model, a profile hash" "$ROW" '.validator_result == "ok" and .fallback_code == null and (.model | length) > 0 and (.profile_hash | length) == 64'
      jchk "K2 db: the ai_calls row: chosen_ids are exactly the stored session's drill versions" "$(jq -nc --argjson row "$ROW" --argjson ids "$IDS" '{chosen: ($row.chosen_ids | fromjson), ids: $ids}')" '.chosen == .ids'
      jchk "K2 db: the ai_calls row: candidate_ids hold the offered set and every chosen id is in it" "$(jq -nc --argjson row "$ROW" --argjson ids "$IDS" '{cand: ($row.candidate_ids | fromjson), ids: $ids}')" '(.cand | length) >= (.ids | length) and ((.ids - .cand) | length) == 0'
      jchk "K2 db: every offered candidate is a published drill version" "$(jq -nc --argjson n "$(sqlite_count drill_versions "$PUBLISHED_SQL AND id IN ($(jq -r '.candidate_ids | fromjson | map("'"'"'" + . + "'"'"'") | join(",")' <<<"$ROW"))")" --argjson row "$ROW" '{published: $n, offered: ($row.candidate_ids | fromjson | length)}')" '.published == .offered and .offered > 0'
    fi

    # K3: explain
    if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ] && [ "$(jq -r .planner <<<"$S_AI")" = ai ]; then
      ITEM=$(jq -c '.items[0]' <<<"$S_AI")
      PW_TIMEOUT=30000
      pw_run "K3: open the first drill and press 'Explain more simply'" "(async page => {
        await page.locator('a[href^=\"/train/drill/\"]').first().click();
        await page.getByRole('heading', { level: 1 }).waitFor();
        const label = page.getByRole('heading', { name: \"AI-generated — the coach's original text is above\" });
        const quiet = page.getByText(/AI explanations are not (available right now|switched on here)/);
        const err = page.getByText('Could not get an explanation');
        await page.getByRole('button', { name: 'Explain more simply' }).click();
        await label.or(quiet).or(err).first().waitFor({ timeout: 26000 });
        const outcome = (await label.count()) > 0 ? 'ai' : (await quiet.count()) > 0 ? 'unavailable' : 'error';
        const panel = outcome === 'ai' ? await page.locator('section', { has: label }).innerText() : '';
        return JSON.stringify({ outcome, panel, main: await page.locator('main').innerText(), safety: await page.getByRole('region', { name: 'Safety', exact: true }).count() }); })"
      PW_TIMEOUT=10000
      if [ "$WEB_OK" = 1 ]; then
        EXPL=$PW_OUT
        assert_eq "$(jq -r .outcome <<<"$EXPL")" ai "K3: 'Explain more simply' shows the AI text (not the unavailable note or an error)"
        if [ "$(jq -r .outcome <<<"$EXPL")" = ai ]; then
          has "K3: the panel is labelled 'AI-generated — the coach's original text is above'" "$(jq -r .panel <<<"$EXPL")" "AI-generated — the coach's original text is above"
          jchk "K3: the panel holds a text of its own after the label" "$EXPL" '(.panel | split("\n") | map(select(length > 0)) | length) >= 2'
          while IFS= read -r line; do has "K3: the canonical instruction is still on the page: '${line:0:40}...'" "$(jq -r .main <<<"$EXPL")" "$line"
          done < <(jq -r '.content.instructions.en | split("\n") | map(sub("^\\s*[0-9]+[.)]\\s*"; "")) | .[] | select(length > 0)' <<<"$ITEM")
          if [ "$(jq '.content.safety | length' <<<"$ITEM")" -gt 0 ]; then
            while IFS= read -r line; do has "K3: the canonical safety note is still on the page: '${line:0:40}...'" "$(jq -r .main <<<"$EXPL")" "$line"; done < <(jq -r '.content.safety[].en' <<<"$ITEM")
          fi
        fi
        assert_eq "$(sqlite_count drill_versions),$(sqlite_count contributions)" "$VERSIONS_BEFORE,$CONTRIB_BEFORE" "K3 db: no new drill version and no contribution after the plan and the explanation"
        assert_eq "$(sqlite_count ai_calls "player_id = '$A_ID' AND kind = 'explain'")" 1 "K3 db: one ai_calls explain row"
      fi
    elif [ "$WEB_ON" = 0 ]; then web_blocked "K3: 'Explain more simply' (UI)"
    else fail "K3: 'Explain more simply' on a drill of the AI session" "  no AI session to open a drill from (K1/K2 failed)"; fi
  fi
fi

# ============================================================================================================================
# UNKEYED half: OPENAI_API_KEY unset, the API restarted on the same database, a second player
# ============================================================================================================================
pw close >/dev/null 2>&1
restart_api ""; rc=$?
assert_eq "$rc" 0 "unkeyed: the API restarted on the same database with OPENAI_API_KEY unset (ready again)"
assert_api /health '.ok == true and .aiAvailable == false' -l "unkeyed: /health says aiAvailable false"
assert_eq "$(sqlite_count ai_calls "kind = 'plan'" )" "$([ "$KEYED" = 1 ] && echo 1 || echo 0)" "unkeyed: the database survived the restart ($([ "$KEYED" = 1 ] && echo 'the keyed half'"'"'s ai_calls plan row is still there' || echo 'no ai_calls plan row yet: nothing was called'))"

start_player "unkeyed player B" && B_COOKIE=$P_COOKIE B_ID=$P_ID
[ -n "${B_COOKIE:-}" ] || { fail "unkeyed half: player B exists" "  no cookie"; exit 1; }
fetch "$B_COOKIE" GET '/api/player/today?locale=en'
SB0=$F_BODY
chk "unkeyed: today's session is the deterministic one (planner rules, 2-8 drills, nothing done)" 200 '.planner == "rules" and (.items | length) >= 2 and all(.items[]; .done == false)'
IDS_B=$(jq -c '[.items[].drillVersionId]' <<<"$SB0")
VERSIONS_B=$(sqlite_count drill_versions); CONTRIB_B=$(sqlite_count contributions)
BTN=0
ROWS_BEFORE=$(sqlite_count ai_calls "player_id = '$B_ID'")

# U2: the UI (first, on a page the player just opened): the button, the quiet note
browse_as "unkeyed" "$B_COOKIE" && open_train "unkeyed: open"
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  BTN=$(pw_eval "document.querySelectorAll('main button').length && [...document.querySelectorAll('main button')].filter((b) => b.innerText.trim() === 'Personalise with AI').length" 2>/dev/null || echo 0)
  if [ "$BTN" = 1 ]; then
    pass "U2: the 'Personalise with AI' button is on today's session with the key unset"
    pw_run "U2: type a note and press it: the quiet note comes back" "(async page => {
      await page.getByRole('textbox', { name: /Anything the coach should know/ }).fill($(js "$NOTE"));
      const std = page.getByText('AI is unavailable — here is your standard plan.');
      const t0 = Date.now();
      await page.getByRole('button', { name: 'Personalise with AI' }).click();
      await std.waitFor({ timeout: 8000 });
      const ms = Date.now() - t0;
      return JSON.stringify({ ms, alerts: await page.locator('[role=alert]').count(), errorState: await page.getByText('Could not reach the AI coach').count(),
        tag: await page.getByText('AI-personalised from approved drills').count(), statuses: await page.getByRole('status').allInnerTexts() }); })"
    if [ "$WEB_OK" = 1 ]; then
      jchk "U2: the note 'AI is unavailable — here is your standard plan.' shows in under $((FALLBACK_WAIT_MS / 1000)) s (took $(jq .ms <<<"$PW_OUT") ms)" "$PW_OUT" ".ms < $FALLBACK_WAIT_MS"
      jchk "U2: no error toast, no alert, no error state, and no 'AI-personalised' tag" "$PW_OUT" '.alerts == 0 and .errorState == 0 and .tag == 0'
      jchk "U2: the note is a quiet role=status notice" "$PW_OUT" '[.statuses[] | select(contains("AI is unavailable"))] | length >= 1'
    fi
  else
    fail "U2: the 'Personalise with AI' button is on today's session with the key unset (so it can be pressed and return the standard plan)" \
      "  the page shows no such button ($BTN found): GET /health says aiAvailable false, and the control hides itself for that (today-extra.tsx: availability.data?.aiAvailable === false -> null)"$'\n'"  the page text:$(pw_eval "document.querySelector('main').innerText" 2>/dev/null | tr '\n' '|' | cut -c1-500)"
    fail "U2: pressing it shows 'AI is unavailable — here is your standard plan.' in under $((FALLBACK_WAIT_MS / 1000)) s, with no error toast" "  not reachable: there is no button to press"
  fi
else web_blocked "U2: the button, the quiet note in under 2 s, no error toast (UI)"; fi

# U1: the API, the deterministic session, no_key, under 2 s
timed_post "$B_COOKIE" '/api/player/today/ai-plan?locale=en' "$(jq -nc --arg n "$NOTE" '{note: $n}')"
chk "U1 api: POST /api/player/today/ai-plan without a key is 200 (never an error status), planner 'rules', fallback code 'no_key'" 200 '.planner == "rules" and .fallback.code == "no_key"'
if lt_seconds "$F_TIME" 2; then pass "U1 api: it answered in $F_TIME s (under 2 s)"; else fail "U1 api: it answers in under 2 s" "  took $F_TIME s"; fi
jchk "U1 api: the answer IS the deterministic session (the same drill versions in the same order as before, all to do)" "$F_BODY" ".items | map(.drillVersionId) == $IDS_B and all(.[]; .done == false)"
fetch "$B_COOKIE" GET '/api/player/today?locale=en'
chk "U1 api: the stored session is unchanged (planner rules, the same drills)" 200 ".planner == \"rules\" and (.items | map(.drillVersionId)) == $IDS_B"
assert_eq "$(sqlite_scalar "SELECT planner FROM sessions WHERE player_id = '$B_ID'")" rules "U1 db: the session row still says planner 'rules'"

# U3: the log
assert_eq "$(sqlite_count ai_calls "player_id = '$B_ID' AND kind = 'plan'")" "$((ROWS_BEFORE + 1 + $([ "$WEB_ON" = 1 ] && [ "$BTN" = 1 ] 2>/dev/null && echo 1 || echo 0)))" "U3 db: one ai_calls row per plan request of the player (the button's, when it could be pressed, and the API call's)"
RB=$(sqlite_json "SELECT * FROM ai_calls WHERE player_id = '$B_ID'")
jchk "U3 db: every row of the player: kind 'plan', fallback code 'no_key', no validator result, nothing chosen, the offered ids logged, a profile hash" "$RB" 'length >= 1 and all(.[]; .kind == "plan" and .fallback_code == "no_key" and .validator_result == null and .chosen_ids == "[]" and (.candidate_ids | fromjson | length) > 0 and (.profile_hash | length) == 64 and .latency_ms >= 0)'
assert_eq "$(sqlite_json "SELECT name FROM pragma_table_info('ai_calls') WHERE lower(name) GLOB '*prompt*' OR lower(name) GLOB '*note*' OR lower(name) GLOB '*text*' OR lower(name) GLOB '*message*' OR lower(name) GLOB '*output*' OR lower(name) GLOB '*image*'")" "[]" "U3 db: the ai_calls table has no prompt, note, text, message, output or image column"
if jq -e --arg n "$NOTE" 'tostring | ascii_downcase | contains($n | ascii_downcase) | not' >/dev/null <<<"$(sqlite_json "SELECT * FROM ai_calls")"; then pass "U3 db: the note the player typed ('$NOTE') is in no ai_calls value"
else fail "U3 db: the note the player typed is in no ai_calls value" "  found in: $(sqlite_json "SELECT * FROM ai_calls" | head -c 600)"; fi
if grep -qaF -- "$NOTE" "$DB_PATH" "$DB_PATH-wal" 2>/dev/null; then fail "U3 db: the note the player typed is stored nowhere in the database file" "  '$NOTE' found in $DB_PATH*"
else pass "U3 db: the note the player typed is stored nowhere in the database file (no byte of it in app.db or its WAL)"; fi

# U4: explain
BITEM=$(jq -c '.items[0]' <<<"$SB0")
BVER=$(jq -r .drillVersionId <<<"$BITEM")
fetch "$B_COOKIE" POST "/api/player/drills/$BVER/explain" '{"locale":"en","audience":"child"}'
chk "U4 api: POST /api/player/drills/:versionId/explain without a key is 503 problem 'ai_unavailable'" 503 '.type == "ai_unavailable"'
assert_eq "$(sqlite_count drill_versions),$(sqlite_count contributions)" "$VERSIONS_B,$CONTRIB_B" "U4 db: the explain request created no drill version and no contribution"
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw_run "U4: open the first drill: the explain panel" "(async page => {
    const health = page.waitForResponse((r) => new URL(r.url()).pathname === '/health', { timeout: 10000 }).catch(() => null);
    await page.locator('a[href^=\"/train/drill/\"]').first().click();
    await page.getByRole('heading', { level: 1 }).waitFor();
    await health;
    await page.waitForTimeout(700);
    const btn = page.getByRole('button', { name: /Explain more simply|Try again/ });
    let pressed = false;
    if ((await btn.count()) > 0) { await btn.first().click(); pressed = true; await page.waitForTimeout(1500); }
    return JSON.stringify({ pressed, main: await page.locator('main').innerText(), alerts: await page.locator('[role=alert]').count(), ai: await page.getByText(\"AI-generated — the coach's original text is above\").count() }); })"
  if [ "$WEB_OK" = 1 ]; then
    UN=$PW_OUT
    if [[ $(jq -r .main <<<"$UN") == *"AI explanations are not available right now."* ]]; then pass "U4: the drill player says 'AI explanations are not available right now.' (unavailable) after the request (button pressed: $(jq .pressed <<<"$UN"))"
    elif [[ $(jq -r .main <<<"$UN") == *"AI explanations are not switched on here."* ]]; then pass "U4: the drill player says 'AI explanations are not switched on here.' (the unavailable state with no key, read from /health; button pressed: $(jq .pressed <<<"$UN"))"
    else fail "U4: the drill player shows a quiet 'AI explanations are not available' note" "  main: $(jq -r .main <<<"$UN" | tr '\n' '|' | cut -c1-700)"; fi
    jchk "U4: no AI text panel and no alert" "$UN" '.ai == 0 and .alerts == 0'
    while IFS= read -r line; do has "U4: the coach's canonical instruction is intact: '${line:0:40}...'" "$(jq -r .main <<<"$UN")" "$line"
    done < <(jq -r '.content.instructions.en | split("\n") | map(sub("^\\s*[0-9]+[.)]\\s*"; "")) | .[] | select(length > 0)' <<<"$BITEM")
  fi
else web_blocked "U4: the drill player's quiet 'unavailable' note (UI)"; fi
assert_eq "$(sqlite_count drill_versions),$(sqlite_count contributions)" "$VERSIONS_B,$CONTRIB_B" "U4 db: still no new drill version, no contribution"

# U5: the admin setting
ADMIN_EMAIL="j8-admin@example.test"
ADMIN_PASSWORD="J8-gate-$RANDOM$RANDOM-pw"
if out=$(cd "$E2E_TMP" && NODE_ENV=development BETTER_AUTH_URL="$API_URL" APP_DB_PATH="$DB_PATH" MASTRA_DB_PATH="$E2E_TMP/mastra.db" MEDIA_DIR="$MEDIA_DIR" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  bun "$E2E_REPO_ROOT/apps/api/src/cli/admin.ts" create --email "$ADMIN_EMAIL" --name "J8 Admin" 2>&1); then pass "U5: the admin CLI made an admin account (the product's only way to make one)"
else fail "U5: the admin CLI made an admin account" "  $(sed "s/$ADMIN_PASSWORD/***/g" <<<"$out" | head -n 8)"; fi
fetch - POST /api/auth/sign-in/email "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email: $e, password: $p}')"
ADMIN_COOKIE=$(grep -i '^set-cookie: *[^;]*session_token=' <<<"$F_HDRS" | head -n1 | sed -E 's/^[^:]*: *//; s/;.*//')
if [ "$F_CODE" = 200 ] && [ -n "$ADMIN_COOKIE" ]; then pass "U5: the admin signs in (200, a session cookie)"; else ADMIN_COOKIE=""; fail "U5: the admin signs in" "  HTTP $F_CODE: ${F_BODY:0:300}"; fi
if [ -n "$ADMIN_COOKIE" ]; then
  fetch "$ADMIN_COOKIE" GET /api/admin/settings
  chk "U5: GET /api/admin/settings: the AI planner setting is on by default" 200 '.aiPlannerEnabled == true'
  fetch "$ADMIN_COOKIE" PUT /api/admin/settings '{"aiPlannerEnabled":false}'
  chk "U5: PUT /api/admin/settings {aiPlannerEnabled:false} answers the updated settings" 200 '.aiPlannerEnabled == false'
  fetch "$ADMIN_COOKIE" GET /api/admin/settings
  chk "U5: GET /api/admin/settings reads it back off" 200 '.aiPlannerEnabled == false'
fi
timed_post "$B_COOKIE" '/api/player/today/ai-plan?locale=en' '{}'
chk "U5 api: with aiPlannerEnabled=false the plan request is 200, planner 'rules', fallback 'disabled' (the setting, not the missing key)" 200 '.planner == "rules" and .fallback.code == "disabled"'
assert_eq "$(sqlite_count ai_calls "player_id = '$B_ID' AND fallback_code = 'disabled'")" 1 "U5 db: that request was logged with fallback code 'disabled'"
if [ "$WEB_ON" = 1 ]; then
  pw_run "U5 (key unset): reload /train with the setting off" "(async page => {
    const health = page.waitForResponse((r) => new URL(r.url()).pathname === '/health', { timeout: 10000 }).catch(() => null);
    await page.goto($(js "$STACK_URL")+'/train');
    await page.getByRole('list', { name: \"Today's drills\" }).waitFor();
    await health;
    await page.waitForTimeout(1000);
    return JSON.stringify({ buttons: await page.getByRole('button', { name: 'Personalise with AI' }).count(), regions: await page.getByRole('region', { name: 'Personalise with AI' }).count(), drills: await page.getByRole('list', { name: \"Today's drills\" }).getByRole('listitem').count() }); })"
  [ "$WEB_OK" = 1 ] && jchk "U5: with aiPlannerEnabled=false (and no key) the 'Personalise with AI' button is hidden, today's drills are still listed" "$PW_OUT" '.buttons == 0 and .regions == 0 and .drills >= 2'
else web_blocked "U5: the button is hidden with aiPlannerEnabled=false (UI)"; fi

# U5 once more, so that it does not pass for the wrong reason: a configured key (a placeholder value, never sent anywhere: the setting
# answers first and the button is never pressed) makes /health say aiAvailable true. Only the SETTING can hide the button now.
pw close >/dev/null 2>&1
restart_api "$PLACEHOLDER_KEY"; rc=$?
assert_eq "$rc" 0 "U5: the API restarted on the same database with a placeholder key value (no credential: it is never used)"
assert_api /health '.ok == true and .aiAvailable == true' -l "U5: /health now says aiAvailable true (so only the setting can hide the button)"
fetch "$ADMIN_COOKIE" GET /api/admin/settings
chk "U5: the setting is still off after the restart (stored in the database)" 200 '.aiPlannerEnabled == false'
browse_as "setting off, key configured" "$B_COOKIE"
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw_run "U5: open /train as the player while the admin setting aiPlannerEnabled is false (a key is configured)" "(async page => {
    const health = page.waitForResponse((r) => new URL(r.url()).pathname === '/health', { timeout: 10000 }).catch(() => null);
    await page.goto($(js "$STACK_URL")+'/train');
    await page.getByRole('list', { name: \"Today's drills\" }).waitFor();
    await health;
    await page.waitForTimeout(1500);
    return JSON.stringify({ buttons: await page.getByRole('button', { name: 'Personalise with AI' }).count(), regions: await page.getByRole('region', { name: 'Personalise with AI' }).count(), drills: await page.getByRole('list', { name: \"Today's drills\" }).getByRole('listitem').count(),
      main: (await page.locator('main').innerText()).slice(0, 600) }); })"
  if [ "$WEB_OK" = 1 ]; then
    if jq -e '.buttons == 0 and .regions == 0 and .drills >= 2' >/dev/null <<<"$PW_OUT"; then pass "U5: with aiPlannerEnabled=false the 'Personalise with AI' button is hidden even though a key is configured"
    else fail "U5: with the admin setting aiPlannerEnabled=false the 'Personalise with AI' button is hidden (a key is configured, /health aiAvailable true)" \
      "  the button is still on the page: $(jq -c '{buttons, regions, drills}' <<<"$PW_OUT"). A player cannot read aiPlannerEnabled (GET /api/admin/settings is admin-only; /health and the session do not carry it), so the control only learns 'disabled' from a fallback after pressing"$'\n'"  page: $(jq -r .main <<<"$PW_OUT" | tr '\n' '|' | cut -c1-400)"; fi
  fi
  # When the button is (wrongly) still there, pressing it is safe and shows the note path for real: the server answers 'disabled' BEFORE
  # any provider call, so the placeholder key is never used. Only the note, the time and the absence of an error are asserted here.
  if [ "$WEB_OK" = 1 ] && [ "$(jq -r .buttons <<<"$PW_OUT" 2>/dev/null)" = 1 ]; then
    pw_run "U5b: press the (still visible) button: the setting answers 'disabled' and the note shows" "(async page => {
      const std = page.getByText('AI is unavailable — here is your standard plan.');
      const t0 = Date.now();
      await page.getByRole('button', { name: 'Personalise with AI' }).click();
      await std.waitFor({ timeout: 8000 });
      const ms = Date.now() - t0;
      return JSON.stringify({ ms, alerts: await page.locator('[role=alert]').count(), errorState: await page.getByText('Could not reach the AI coach').count(),
        tag: await page.getByText('AI-personalised from approved drills').count(), main: await page.locator('main').innerText() }); })"
    if [ "$WEB_OK" = 1 ]; then
      jchk "U5b: the quiet note 'AI is unavailable — here is your standard plan.' shows in under $((FALLBACK_WAIT_MS / 1000)) s (took $(jq .ms <<<"$PW_OUT") ms), no error toast or state, no AI tag" "$PW_OUT" ".ms < $FALLBACK_WAIT_MS and .alerts == 0 and .errorState == 0 and .tag == 0"
      has "U5b: the note gives the reason for the 'disabled' code" "$(jq -r .main <<<"$PW_OUT")" "The AI coach is switched off for now."
      assert_eq "$(sqlite_scalar "SELECT planner FROM sessions WHERE player_id = '$B_ID'")" rules "U5b db: the session is still the deterministic one (planner 'rules')"
    fi
  fi
else web_blocked "U5: the button is hidden with aiPlannerEnabled=false while a key is configured (UI)"; fi

# no explicit stop or summary: the EXIT handler stops the stack, prints the summary, sets the exit code
