#!/usr/bin/env bash
# apps/web/e2e/j9-video-coach.sh: slice gate fc-mol-pl4 (slice fc-mol-8nt), journey J9 "a player analyses a short clip with the Beta AI Video Coach".
# Integration proof on the REAL stack (real API process, real SQLite file with the real seed, the real built web app served by the API, a real
# browser; nothing mocked, no stubbed model, no fake pose result). What it asserts, in the order of the criteria:
#
#   A. CONSENT  a player of age 11: POST /api/player/video-analyses without the consent is 403 problem 'consent required' (API); the Video
#               Coach screen after 'Analyse my dribbling' asks for it instead of offering the camera or the file input, and requests nothing
#               (no rubric, no pose model); PUT consents {videoAnalysis:true} without the guardian is 422 (API) and the privacy screen asks
#               for the guardian's tick first ('Ask a parent or guardian to tick the box first.'); ticked, the switch saves (API + sqlite:
#               granted, guardianConfirmed), and /video now shows the recording tips, the criteria and the two ways to give a clip.
#   B. MODEL    the pose model + WASM are self-hosted (served by the API from the built app, same origin) and are fetched ONLY on /video: the
#               network log of /train, /commons and /progress holds no request for them (nor for the tasks-vision chunk); the log of /video
#               after a clip is chosen holds them, all same-origin (no third-party origin anywhere in any log). If the model files are absent
#               (the fetch script could not download them) every step that needs them is BLOCKED with that reason, never a silent skip.
#   C. CLIPS    (a synthetic clip made here with ffmpeg: a dark, empty scene; never a fake dribble) a 5 s and a 35 s clip are refused with
#               guidance and nothing is sent; a dark 12 s clip is read on the device and answered with the re-record prompt and NO scores
#               (/video/result/rerecord, 'We could not see you well enough' + the filming tips), and the log of that flow holds the rubric
#               GET and NO analysis POST. If this headless browser cannot run the pose model, the screen says so and the step is reported
#               as what it saw (FAIL when the screen is the 'cannot run' one: that is a product statement the gate reports, not hides).
#   D. NETWORK  no request of any flow carries video bytes (no video/* or multipart content-type, no blob:/EBML/ftyp body), no request goes to
#               a third-party origin, every non-GET request is an /api call of this origin.
#   E. NO KEY   the API is RESTARTED on the same database with OPENAI_API_KEY unset: /health says aiAvailable false, a valid analysis POST is
#               503 problem 'ai_unavailable' (logged as fallback 'no_key', nothing stored), and the rest of the app works (/train lists today's
#               drills, /commons and /progress open, no error alert, every /api answer of those visits < 400).
#   F. API      (a placeholder key value makes /health say aiAvailable true so the checks that come AFTER the key check can run; the provider is
#               never called with it: every request below is refused or answered before the model, and OPENAI_BASE_URL points at a closed
#               local port so that a request which wrongly got that far could not reach a third party) raw video is refused: a video/* body is 415,
#               a multipart part named 'video' is 415, a keyframe part that is not image/jpeg is 415; 2 keyframes are 422 at /keyframes; a keyframe
#               over 200 KB is 413; a clip the device could not see (meanVisibility below the rubric minimum) is 200 {rerecord:true,
#               reason:'low_visibility'} without scores, and none of it stored: video_analyses empty, MEDIA_DIR holds no file, no JPEG byte
#               (nor the base64 text of one) in the database file; revoking the consent makes the POST 403 again.
#   G. SCHEMA   migration 009: video_analyses has no BLOB column and no column named like an image, a frame or a video.
#   KEYED (needs a real OPENAI_API_KEY from the environment or from the repo's .env AND the human-supplied apps/web/e2e/fixtures/dribble.mp4;
#   runs for real when both are present, else each step is BLOCKED with "external credential: OPENAI_API_KEY" / "external asset:
#   apps/web/e2e/fixtures/dribble.mp4"; never a pass, never a silent skip): the player picks 'Analyse my dribbling', chooses the clip, sees the
#   on-device progress, sends, and the result screen shows the Beta tag, 'Pose only — the ball is not tracked yet', the confidence, a 1-10 score
#   + note per rubric criterion (equal to the API's, no overall score), 'Focus next', 2-3 recommended drills that open real commons pages, and
#   'Repeat assessment after 3 sessions'; the flow's network log holds the rubric GET and ONE POST with JPEG keyframes + features (no video
#   bytes); afterwards MEDIA_DIR holds no new file and sqlite holds ONE video_analyses row with scores only. With the clip but no key, the same
#   flow ends on a screen that says the analysis is unavailable.
#
# Exit codes (lib.sh): 0 every step passed, 1 at least one FAIL, 3 nothing failed but a step was BLOCKED (here: no key / no clip / no model /
# no browser); E2E_ALLOW_BLOCKED=1 keeps a blocked-only run at 0. BLOCKED is never counted as a pass.
#
# Readings of the criteria where they are open (each is one line of the script):
#   * "the pose model is fetched only on this screen": no request for /mediapipe/*, *.task, *.wasm, vision_wasm*, pose_landmarker*, or a
#     tasks-vision chunk on /train, /commons, /progress; and at least the model file is requested on /video once a clip is chosen (the
#     product loads it lazily, when a clip is coming: bead 8nt.6/8nt.9).
#   * "the network log shows NO request carrying video bytes": no request whose content-type is video/*, audio/* or multipart/form-data,
#     none whose body starts with the EBML (webm) or 'ftyp' (mp4) signature, and no non-GET request to a blob: URL. (The browser reports the
#     GET of the blob: URL that the on-device decoder reads the clip from; that read never leaves the device, so it is not a network request.)
#   * "no third-party origin": every http(s) request URL of every flow starts with the stack's own origin.
#   * "the re-record prompt for a dark/empty clip": the product answers it on the device (nobody found, or mean visibility below the rubric's
#     minimum): it navigates to /video/result/rerecord?rerecord=low_visibility&skill=dribbling and nothing is POSTed. 'too_dark' is never
#     produced by the product (player-video.routes.ts says so), so the gate asserts the prompt and no scores, not that reason.
#   * "with no key the screen shows 'analysis unavailable'": the screen can only tell after a send (no endpoint tells it before), and a send
#     needs a clip in which the device found a person, so the UI half needs dribble.mp4; the API half (503 ai_unavailable, nothing stored)
#     runs always. The UI assertion is that the page says the analysis is unavailable (/unavailable/i on an alert) after Send.
#   * MULTIPART: Bun derives a multipart file's type from its FILENAME extension (a part typed video/webm but named frame.jpg reads as
#     image/jpeg; the JPEG-header check still stops non-JPEG bytes), so the F checks name each file after the type it declares.
#   * BROWSER: Chromium with a UTC clock and en-US (as j8). Players are made through the real endpoints (POST /api/auth/sign-in/anonymous,
#     POST /api/player/start), onboarding being J2's proof; the browser gets the player's real session cookie.
# Fail-slow (no set -e): every step reports. Cleanup: e2e_defer (never `trap ... EXIT` after sourcing lib.sh). The key is never printed.
# Ports: the API gets a free kernel-assigned port (lib.sh start_stack), kept across the restarts; nothing is bound to :4111 or :5173 and no
# process this script did not start is touched. The browser session name is unique per run (E2E_SESSION).
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$HERE/lib.sh"

PLAYER_AGE=11
PLAYER_MINUTES=20
PLACEHOLDER_KEY='sk-e2e-placeholder-not-a-credential'   # only makes /health say aiAvailable; the provider is never called with it
CLIP="$HERE/fixtures/dribble.mp4"
POSE_RE='mediapipe|pose_landmarker|vision_wasm|tasks-vision|vision_bundle|\.task($|\?)|\.wasm($|\?)'
unset SEED_DIR   # the API must start on the repo's default seed

scratch=$(mktemp -d "${TMPDIR:-/tmp}/j9-gate.XXXXXX") || exit 1
# the browser is closed BEFORE the scratch dir is removed
e2e_defer 'pw close >/dev/null 2>&1; rm -rf -- "$scratch"'

# The harness has no public "restart the API on the same DB" (j1a-seed.sh, j7-offline.sh and j8-ai-coach.sh use the same private helpers for
# the same purpose). Refuse loudly if they go away.
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
HAVE_CLIP=0
[ ! -f "$CLIP" ] || HAVE_CLIP=1
echo "info: key: $([ "$KEYED" = 1 ] && echo 'a real key is present (env or .env)' || echo 'no OPENAI_API_KEY in the environment or in .env'); clip: $([ "$HAVE_CLIP" = 1 ] && echo present || echo 'apps/web/e2e/fixtures/dribble.mp4 is absent')" >&2

# --- small helpers (the house helpers of j3-session.sh / j7-offline.sh / j8-ai-coach.sh) ---------------------------------------------
# fetch <cookie | -> <METHOD> <path> [json body | ""] [extra curl args...]: one request to the real API; sets F_CODE, F_BODY, F_HDRS.
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
NBSP=$(printf '\xc2\xa0')
norm() { tr -s '[:space:]' ' ' <<<"${1//$NBSP/ }" | sed -E 's/^ //; s/ $//'; }
# has <label> <haystack> <needle>: containment on whitespace-normalised text (case-sensitive: the labels are exact).
has() {
  local hay needle
  hay=$(norm "$2"); needle=$(norm "$3")
  if [[ $hay == *"$needle"* ]]; then pass "$1"; else fail "$1" "  needle: $needle"$'\n'"  saw: ${hay:0:1200}"; fi
}
# hasnt <label> <haystack> <extended regex>: the text must NOT match (case-insensitive).
hasnt() {
  local hay
  hay=$(norm "$2")
  if grep -qiE -- "$3" <<<"$hay"; then fail "$1" "  matched /$3/ in: ${hay:0:1200}"; else pass "$1"; fi
}
count_files() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }

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

# start_player <label> <age>: a player made through the real endpoints (anonymous sign-in, POST /api/player/start); sets P_COOKIE, P_ID.
start_player() {
  local label=$1 age=$2 known
  P_COOKIE="" P_ID=""
  known=$(sqlite_count player_profiles)
  fetch - POST /api/auth/sign-in/anonymous '{}'
  P_COOKIE=$(grep -i '^set-cookie: *[^;]*session_token=' <<<"$F_HDRS" | head -n1 | sed -E 's/^[^:]*: *//; s/;.*//')
  if [ "$F_CODE" = 200 ] && [ -n "$P_COOKIE" ]; then pass "$label: anonymous sign-in answers 200 with a session cookie"
  else P_COOKIE=""; fail "$label: anonymous sign-in answers 200 with a session cookie" "  HTTP $F_CODE headers: ${F_HDRS:0:400} body: ${F_BODY:0:400}"; return 1; fi
  fetch "$P_COOKIE" POST /api/player/start "$(jq -nc --arg a "$(uuid 1)" --arg b "$(uuid 2)" --arg c "$(uuid 3)" --arg d "$(uuid 4)" --arg e "$(uuid 5)" --argjson age "$age" --argjson min "$PLAYER_MINUTES" \
    '{profile: {age: $age, level: "basic", goal: "weakfoot", equipment: "ball_wall", space: "yard", partner: false, daysPerWeek: 3, minutesPerSession: $min, locale: "en"},
      baseline: [{testSlug: "juggling-max-touches", value: 15, clientUuid: $a}, {testSlug: "wall-passing-60s", value: 30, clientUuid: $b}, {testSlug: "ball-mastery-30s", value: 40, clientUuid: $c},
                 {testSlug: "weak-foot-passes", value: 4, clientUuid: $d}, {testSlug: "slalom-time", value: 0, skipped: true, clientUuid: $e}]}')"
  chk "$label: POST /api/player/start onboards the player (age $age, $PLAYER_MINUTES min)" 200 ".profile.age == $age and (.roadmap.tracks | length) == 5"
  P_ID=$(sqlite_scalar "SELECT player_id FROM player_profiles ORDER BY rowid DESC LIMIT 1")
  assert_eq "$(sqlite_count player_profiles)" "$((known + 1))" "$label: db: one more player profile ($P_ID)"
}

# --- the request bodies ----------------------------------------------------------------------------------------------------------------
# Three tiny real JPEGs (ffmpeg test frames): the API checks the JPEG header, the declared size, the type and the byte cap.
JPEG_OK=0
make_jpegs() {
  local i
  command -v ffmpeg >/dev/null 2>&1 || return 1
  for i in 1 2 3; do
    ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=64x48:rate=1" -vf "hue=h=$((i * 70))" -frames:v 1 "$scratch/kf$i.jpg" 2>/dev/null || return 1
    [ "$(head -c 3 "$scratch/kf$i.jpg" | od -An -tx1 | tr -d ' \n')" = ffd8ff ] || return 1
  done
}
# req_json <skillSlug> <rubricVersion> <meanVisibility> <clientUuid> [keyframe count 1..3]: a CreateVideoAnalysisRequest with real JPEG keyframes.
req_json() {
  local n=${5:-3} kfs=() i
  for ((i = 1; i <= n; i++)); do kfs+=("$(base64 -w0 "$scratch/kf$i.jpg")"); done
  printf '%s\n' "${kfs[@]}" | jq -Rn --arg s "$1" --argjson v "$2" --argjson vis "$3" --arg u "$4" \
    '[inputs] as $k | {skillSlug: $s, rubricVersion: $v, durationSec: 12, features: {meanVisibility: $vis, framesAnalysed: 60},
      keyframes: ($k | map({mimeType: "image/jpeg", data: ., width: 64, height: 48})), clientUuid: $u}'
}

# --- browser helpers (the house helpers of j8-ai-coach.sh) -----------------------------------------------------------------------------
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
# pw_js <label> <args-json> <js body>: the body runs with `page` and `A` (the parsed args) and must end in a return of a JSON string.
pw_js() { pw_run "$1" "(async page => { const A = $2; $3 })"; }
pw_js_quiet() { pw_quiet "$1" "(async page => { const A = $2; $3 })"; }
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
web_blocked() { blocked "$1" "no usable browser for this step (see the browser step above)"; }

# The network log of one browser snippet: every request of the whole browser context (pages, workers), and every response status.
JS_NET_ON='const log = []; const statuses = [];
  const onReq = (r) => { let n = 0; let head = ""; let post = null; try { const b = r.postDataBuffer(); if (b) { n = b.length; head = b.subarray(0, 8).toString("latin1");
      if (r.method() === "POST" && r.url().endsWith("/api/player/video-analyses")) post = b.toString("utf8"); } } catch (e) {}
    log.push({ m: r.method(), u: r.url(), ct: r.headers()["content-type"] || "", n, head, post }); };
  const onRes = (r) => { statuses.push({ u: r.url(), s: r.status() }); };
  const ctx = page.context(); ctx.on("request", onReq); ctx.on("response", onRes);
  const netOff = () => { ctx.off("request", onReq); ctx.off("response", onRes); };'

# jq programs over one network log ({log: [{m,u,ct,n,head}], base: "http://127.0.0.1:port"}).
NET_FOREIGN='[.log[] | select(.u | test("^https?://")) | select(.u | startswith($base) | not) | .u]'
NET_VIDEO='[.log[] | select((.ct | test("^(video|audio)/|multipart/form-data"; "i")) or ((.u | startswith("blob:")) and .m != "GET") or (.head | test("^\u001aEß£")) or (.head | test("ftyp")))]'
NET_NONGET='[.log[] | select(.m != "GET" and .m != "HEAD" and .m != "OPTIONS") | select(.u | startswith($base))]'
NET_POSE='[.log[] | select(.u | test($re; "i")) | .u]'
net_jq() { # <log json with .base> <jq expression using $base and $re>
  jq -e --arg base "$STACK_URL" --arg re "$POSE_RE" "$2" <<<"$1" >/dev/null 2>&1
}
# net_common <label> <json: {log, base}>: no third-party origin, no video bytes, non-GET requests only to /api of this origin.
net_common() {
  local label=$1 j=$2 bad
  bad=$(jq -c --arg base "$STACK_URL" "$NET_FOREIGN" <<<"$j")
  if [ "$bad" = '[]' ] && [ "$(jq '.log | length' <<<"$j")" -gt 0 ]; then pass "$label: no third-party origin ($(jq '.log | length' <<<"$j") requests, every one to $STACK_URL or local)"
  else fail "$label: no third-party origin" "  foreign: ${bad:0:600} (requests: $(jq '.log | length' <<<"$j"))"; fi
  bad=$(jq -c --arg base "$STACK_URL" "$NET_VIDEO | map({m, u: .u[0:80], ct, n})" <<<"$j")
  if [ "$bad" = '[]' ]; then pass "$label: no request carries video bytes (no video/* or multipart content-type, no blob: URL, no EBML/ftyp body)"
  else fail "$label: no request carries video bytes" "  ${bad:0:800}"; fi
  bad=$(jq -c --arg base "$STACK_URL" "$NET_NONGET | map(select(.u | startswith(\$base + \"/api/\") | not) | {m, u})" <<<"$j")
  if [ "$bad" = '[]' ]; then pass "$label: every non-GET request goes to /api of this origin"
  else fail "$label: every non-GET request goes to /api of this origin" "  ${bad:0:600}"; fi
}

# ============================================================================================================================
# The pose model + WASM: fetched by the web build's prebuild script (scripts/fetch-pose-model.ts, idempotent). If the download is
# impossible the model steps are BLOCKED with the reason, and the app is built WITHOUT the prebuild so that everything else still runs.
# ============================================================================================================================
POSE_OK=0 POSE_WHY=""
if pose_out=$(cd "$E2E_REPO_ROOT" && bun scripts/fetch-pose-model.ts 2>&1); then
  POSE_OK=1
else
  POSE_WHY="external asset: the pose model and WASM (apps/web/public/mediapipe) are absent and could not be downloaded ($(tail -n 2 <<<"$pose_out" | head -n 1 | sed -E 's#https?://[^ ]*/##' | cut -c1-140))"
  echo "info: $POSE_WHY" >&2
  if E2E_BUILD_OUT=$( (cd "$E2E_WEB_DIR" && bun x vite build --outDir "$scratch/web-dist" --emptyOutDir) 2>&1); then
    export E2E_WEB_DIST="$scratch/web-dist"
  else
    echo "$E2E_BUILD_OUT" | tail -n 20 >&2
  fi
fi

# ============================================================================================================================
start_stack || exit 1
assert_api /health '.ok == true and .database == "ok"' -l "stack: /health ok on the temp DB (port $E2E_API_PORT_USED, own media dir)"
assert_api /health ".aiAvailable == $([ "$KEYED" = 1 ] && echo true || echo false)" -l "stack: /health aiAvailable is $([ "$KEYED" = 1 ] && echo true || echo false) (the key the API was started with)"
assert_eq "$(count_files "$MEDIA_DIR")" 0 "start state: MEDIA_DIR holds no file"
assert_eq "$(sqlite_count video_analyses)" 0 "start state: no video analysis"

# --- G. the schema: migration 009 has no place for a clip or a picture -----------------------------------------------------------------
assert_eq "$(sqlite_count sqlite_master "name = 'video_analyses' AND type = 'table'")" 1 "G: migration 009 made the video_analyses table"
COLS=$(sqlite_json "SELECT name, type FROM pragma_table_info('video_analyses')")
jchk "G: video_analyses has the columns of the contract (id, player_id, skill_slug, rubric_version, confidence, scores, focus_next, recommended, features_summary, client_uuid, created_at)" "$COLS" \
  '(map(.name) | sort) == (["id","player_id","skill_slug","rubric_version","confidence","scores","focus_next","recommended","features_summary","client_uuid","created_at"] | sort)'
jchk "G: no BLOB column, and no column named like an image, a frame, a video or a keyframe" "$COLS" 'all(.[]; (.type | ascii_upcase) != "BLOB" and (.name | test("image|img|frame|video|keyframe|jpeg|jpg|photo|picture|blob|bytes"; "i") | not))'
assert_eq "$(sqlite_json "SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND upper(p.type) = 'BLOB'" | jq 'length')" 0 "G: no table of the whole database has a BLOB column"

# --- the rubric endpoint (public) ----------------------------------------------------------------------------------------------------
fetch - GET '/api/video/rubrics/dribbling?locale=en'
chk "rubric: GET /api/video/rubrics/dribbling?locale=en is public (no cookie), 4-7 criteria with label, description and look-for cues, recording tips, a minimum visibility" 200 \
  '.skill == "dribbling" and (.version | . >= 1) and (.criteria | length | . >= 4 and . <= 7) and all(.criteria[]; (.key | length) > 0 and (.label | length) > 0 and (.description | length) > 0 and (.lookFor | length) > 0) and (.recordingTips | length) > 0 and (.minVisibility > 0 and .minVisibility <= 1)'
RUBRIC_EN=$F_BODY
RUBRIC_VERSION=$(jq -r .version <<<"$RUBRIC_EN" 2>/dev/null || echo 1)
RUBRIC_MIN=$(jq -r .minVisibility <<<"$RUBRIC_EN" 2>/dev/null || echo 0.6)
for loc in kk ru; do
  fetch - GET "/api/video/rubrics/dribbling?locale=$loc"
  chk "rubric: the $loc text differs from English (localised, criteria keys the same)" 200 "(.criteria | map(.key)) == $(jq -c '.criteria | map(.key)' <<<"$RUBRIC_EN") and (.criteria[0].label != $(jq '.criteria[0].label' <<<"$RUBRIC_EN")) and (.recordingTips[0] != $(jq '.recordingTips[0]' <<<"$RUBRIC_EN"))"
done
fetch - GET '/api/video/rubrics/no-such-skill?locale=en'
if [ "$F_CODE" = 404 ] && grep -qi '^content-type: *application/problem+json' <<<"$F_HDRS"; then pass "rubric: an unknown skill is a 404 problem+json"; else fail "rubric: an unknown skill is a 404 problem+json" "  HTTP $F_CODE ${F_HDRS:0:300} ${F_BODY:0:300}"; fi
for skill in dribbling ball-mastery passing-first-touch weak-foot juggling-coordination; do
  fetch - GET "/api/video/rubrics/$skill?locale=en"
  [ "$F_CODE" = 200 ] || fail "rubric: the skill '$skill' the screen lists has a rubric" "  HTTP $F_CODE"
done
pass "rubric: the five skills the screen lists all have a rubric (200)"

# --- the model files are served by the API from the built app, same origin ---------------------------------------------------------------
if [ "$POSE_OK" = 1 ]; then
  for f in pose_landmarker_lite.task vision_wasm_internal.wasm vision_wasm_internal.js; do
    want=$(stat -c %s "$E2E_WEB_DIR/public/mediapipe/$f")
    got=$(curl -s --max-time 30 -o /dev/null -w '%{http_code} %{size_download} %{content_type}' "$STACK_URL/mediapipe/$f")
    if [ "${got%% *}" = 200 ] && [ "$(awk '{print $2}' <<<"$got")" = "$want" ] && [[ $got != *text/html* ]]; then pass "B: the self-hosted /mediapipe/$f is served by this origin ($want bytes)"
    else fail "B: the self-hosted /mediapipe/$f is served by this origin" "  wanted 200, $want bytes, not html; got: $got"; fi
  done
else
  blocked "B: the self-hosted pose model and WASM are served by this origin" "$POSE_WHY"
fi

# ============================================================================================================================
# A. CONSENT: a player of age 11
# ============================================================================================================================
start_player "player A" "$PLAYER_AGE" && A_COOKIE=$P_COOKIE A_ID=$P_ID
if [ -z "${A_COOKIE:-}" ]; then fail "player A exists" "  no cookie"; exit 1; fi
if make_jpegs; then JPEG_OK=1; pass "fixtures: three real JPEG frames made with ffmpeg for the API checks"; else blocked "fixtures: three JPEG frames for the API checks" "ffmpeg is not installed or cannot encode a JPEG"; fi
UUID_A=$(uuid a)

fetch - POST /api/player/video-analyses '{}'
chk "A api: POST /api/player/video-analyses without a session is 401" 401 '.status == 401'
fetch "$A_COOKIE" GET /api/player/consents
chk "A api: the age-11 player's consents start off (video analysis granted false)" 200 '.videoAnalysis.granted == false'
if [ "$JPEG_OK" = 1 ]; then
  fetch "$A_COOKIE" POST /api/player/video-analyses "$(req_json dribbling "$RUBRIC_VERSION" 0.9 "$UUID_A")"
  chk "A api: WITHOUT the consent the analysis POST is 403 problem 'consent required' (a valid body, good visibility)" 403 '.title == "consent required" and .status == 403'
fi
fetch "$A_COOKIE" GET /api/player/video-analyses
chk "A api: the history can be read without the consent (200, empty)" 200 '. == []'
assert_eq "$(sqlite_count video_analyses),$(count_files "$MEDIA_DIR")" "0,0" "A: the refused request stored nothing (no analysis row, no file in MEDIA_DIR)"

# --- the browser, as player A ---------------------------------------------------------------------------------------------------------
browse_as "A" "$A_COOKIE"

# B. /train: no pose model, no WASM; the nav link
JS_TRAIN="$JS_NET_ON
  await page.goto(A.base + '/train');
  await page.getByRole('list', { name: \"Today's drills\" }).waitFor();
  await page.waitForTimeout(1200);
  const nav = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Video Coach · Beta' });
  const navCount = await nav.count();
  const href = navCount > 0 ? await nav.first().getAttribute('href') : null;
  for (const p of ['/commons', '/progress']) { await page.goto(A.base + p); await page.waitForTimeout(1200); }
  await page.goto(A.base + '/train'); await page.getByRole('list', { name: \"Today's drills\" }).waitFor();
  netOff();
  return JSON.stringify({ base: A.base, log, navCount, href });"
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw_js "B: browse /train, /commons and /progress with the network log on" "$(jq -nc --arg base "$STACK_URL" '{base: $base}')" "$JS_TRAIN"
  if [ "$WEB_OK" = 1 ]; then
    TRAIN_NET=$PW_OUT
    if net_jq "$TRAIN_NET" '(.log | length) > 5 and ([.log[] | select(.u | test("/api/player/today"))] | length) >= 1'; then pass "B: the log is live (it holds the app's own requests, e.g. GET /api/player/today)"
    else fail "B: the network log of /train is live" "  $(jq -c '.log | map(.u)' <<<"$TRAIN_NET" | cut -c1-500)"; fi
    POSE_HITS=$(jq -c --arg re "$POSE_RE" "$NET_POSE" <<<"$TRAIN_NET")
    if [ "$POSE_HITS" = '[]' ]; then pass "B: the pose model is NOT fetched on /train (nor /commons, /progress): no request for /mediapipe, *.task, *.wasm or the tasks-vision chunk"
    else fail "B: the pose model is not fetched on /train, /commons or /progress" "  requests: ${POSE_HITS:0:600}"; fi
    net_common "B /train" "$TRAIN_NET"
    jchk "shell: the main navigation has the link 'Video Coach · Beta' to /video" "$TRAIN_NET" '.navCount >= 1 and .href == "/video"'
  fi
else web_blocked "B: the pose model is not fetched on /train (network log)"; fi

# A. /video without the consent
JS_GATE="$JS_NET_ON
  await page.goto(A.base + '/video');
  await page.getByRole('button', { name: 'Analyse my dribbling' }).click();
  await page.getByRole('heading', { name: 'Before you start' }).waitFor();
  await page.waitForTimeout(800);
  netOff();
  const body = await page.evaluate(() => document.body.innerText);
  const buttons = await page.getByRole('button').allInnerTexts();
  const link = page.getByRole('link', { name: 'Open privacy settings' });
  return JSON.stringify({ base: A.base, log, body, buttons, fileInputs: await page.locator('input[type=file]').count(),
    linkHref: (await link.count()) > 0 ? await link.first().getAttribute('href') : null, alerts: await page.locator('[role=alert]').count() });"
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw_js "A: /video, pick 'Analyse my dribbling': the consent step" "$(jq -nc --arg base "$STACK_URL" '{base: $base}')" "$JS_GATE"
  if [ "$WEB_OK" = 1 ]; then
    GATE=$PW_OUT
    GATE_TEXT=$(jq -r .body <<<"$GATE")
    has "A: the screen asks for the consent first ('Before you start')" "$GATE_TEXT" "Before you start"
    has "A: it says video analysis is off and how to turn it on" "$GATE_TEXT" "Video analysis is off"
    has "A: ...'Turn it on in Privacy settings to go on.'" "$GATE_TEXT" "Turn it on in Privacy settings to go on."
    has "A: it discloses that still frames go to an AI provider" "$GATE_TEXT" "These pictures are seen by an AI provider, which writes your feedback."
    has "A: it says the video stays on the phone" "$GATE_TEXT" "Your video. It is never uploaded, and it is cleared from memory when we finish."
    jchk "A: the link 'Open privacy settings' goes to /settings/privacy" "$GATE" '.linkHref == "/settings/privacy"'
    jchk "A: no camera button and no file input while the consent is missing" "$GATE" '.fileInputs == 0 and ([.buttons[] | select(test("Record with the camera|Choose a video"))] | length) == 0'
    if net_jq "$GATE" '[.log[] | select(.u | test("/api/video/rubrics|mediapipe|\\.task|\\.wasm"; "i"))] | length == 0'; then pass "A: nothing is requested before the consent: no rubric GET, no pose model, no WASM"
    else fail "A: nothing is requested before the consent" "  $(jq -c '[.log[] | select(.u | test("/api/video/rubrics|mediapipe|task|wasm"; "i")) | .u]' <<<"$GATE")"; fi
    net_common "A /video (no consent)" "$GATE"
  fi
else web_blocked "A: the consent step of /video (UI)"; fi

# A. the guardian rule, API first (age 11)
fetch "$A_COOKIE" PUT /api/player/consents '{"videoAnalysis":true}'
chk "A api: PUT consents {videoAnalysis:true} without the guardian's confirmation is 422 for an age-11 player" 422 '.status == 422'
fetch "$A_COOKIE" GET /api/player/consents
chk "A api: ...and video analysis is still off" 200 '.videoAnalysis.granted == false'
assert_eq "$(sqlite_count consents "player_id = '$A_ID' AND kind = 'videoAnalysis' AND granted = 1")" 0 "A db: no granted video-analysis consent row yet"

# A. the privacy screen: the guardian's tick first, then the switch
JS_PRIV="await page.goto(A.base + '/video');
  await page.getByRole('button', { name: 'Analyse my dribbling' }).click();
  await page.getByRole('link', { name: 'Open privacy settings' }).click();
  await page.getByRole('heading', { name: 'Your privacy', level: 1 }).waitFor();
  const sw = page.getByRole('switch', { name: 'Video analysis' });
  await sw.waitFor();
  const url = page.url();
  await sw.click({ force: true });
  await page.getByText('Ask a parent or guardian to tick the box first.').waitFor();
  const afterFirst = { on: await sw.isChecked(), body: await page.evaluate(() => document.body.innerText) };
  const tick = page.getByRole('checkbox', { name: 'A parent or guardian is with me and says yes' });
  await tick.check();
  await sw.click({ force: true });
  await page.getByText('Saved. Video analysis is on.').waitFor();
  return JSON.stringify({ url, afterFirst, on: await sw.isChecked(), body: await page.evaluate(() => document.body.innerText) });"
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw_js "A: the link opens /settings/privacy; the switch without the tick asks for the guardian; the ticked switch saves" "$(jq -nc --arg base "$STACK_URL" '{base: $base}')" "$JS_PRIV"
  if [ "$WEB_OK" = 1 ]; then
    PRIV=$PW_OUT
    jchk "A: the link 'Open privacy settings' landed on /settings/privacy" "$PRIV" '.url | endswith("/settings/privacy")'
    jchk "A: the switch stayed OFF after the first click without the tick (the guardian is asked for first)" "$PRIV" '.afterFirst.on == false'
    has "A: ...with the words 'Ask a parent or guardian to tick the box first.'" "$(jq -r .afterFirst.body <<<"$PRIV")" "Ask a parent or guardian to tick the box first."
    jchk "A: ticked, the switch is ON and the screen says 'Saved. Video analysis is on.'" "$PRIV" '.on == true'
    has "A: 'A parent or guardian said yes.' is shown" "$(jq -r .body <<<"$PRIV")" "A parent or guardian said yes."
  fi
  fetch "$A_COOKIE" GET /api/player/consents
  chk "A api: GET consents: video analysis granted, guardianConfirmed true (saved by the ticked switch)" 200 '.videoAnalysis.granted == true and .videoAnalysis.guardianConfirmed == true'
  assert_eq "$(sqlite_count consents "player_id = '$A_ID' AND kind = 'videoAnalysis' AND granted = 1")" 1 "A db: exactly one granted video-analysis consent row"
else
  web_blocked "A: the privacy screen asks for the guardian's tick, then saves (UI)"
  fetch "$A_COOKIE" PUT /api/player/consents '{"videoAnalysis":true,"guardianConfirmed":true}'
  chk "A api: (no browser) PUT consents with guardianConfirmed:true is 200" 200 '.videoAnalysis.granted == true and .videoAnalysis.guardianConfirmed == true'
fi

# A. /video once the consent is granted: the tips and the two ways to give a clip
JS_OPEN="$JS_NET_ON
  await page.goto(A.base + '/video');
  await page.getByRole('button', { name: 'Analyse my dribbling' }).click();
  await page.getByRole('heading', { name: 'Record or choose a clip' }).waitFor();
  await page.getByText('How to film').waitFor();
  await page.waitForTimeout(500);
  netOff();
  return JSON.stringify({ base: A.base, log, body: await page.evaluate(() => document.body.innerText), fileInputs: await page.locator('input[type=file]').count(),
    buttons: await page.getByRole('button').allInnerTexts(), alerts: await page.locator('[role=alert]').count() });"
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw_js "A: /video after the consent: pick 'Analyse my dribbling'" "$(jq -nc --arg base "$STACK_URL" '{base: $base}')" "$JS_OPEN"
  if [ "$WEB_OK" = 1 ]; then
    OPEN=$PW_OUT
    OPEN_TEXT=$(jq -r .body <<<"$OPEN")
    has "A: the screen carries the Beta label ('Video Coach · Beta')" "$OPEN_TEXT" "Video Coach · Beta"
    has "A: the screen shows 'Record or choose a clip'" "$OPEN_TEXT" "Record or choose a clip"
    has "A: ...the clip limits (10 to 30 seconds)" "$OPEN_TEXT" "Clips must be 10 to 30 seconds long."
    jchk "A: a file input for choosing a clip is there ('Choose a video from this device')" "$OPEN" '.fileInputs == 1'
    has "A: ...its label" "$OPEN_TEXT" "Choose a video from this device"
    while IFS= read -r tip; do has "A: the recording tip from the rubric is on the screen: '${tip:0:50}'" "$OPEN_TEXT" "$tip"; done < <(jq -r '.recordingTips[0:2][]' <<<"$RUBRIC_EN")
    while IFS= read -r label; do has "A: the rubric criterion '$label' is listed" "$OPEN_TEXT" "$label"; done < <(jq -r '.criteria[].label' <<<"$RUBRIC_EN")
    if net_jq "$OPEN" '[.log[] | select(.u | test("/api/video/rubrics/dribbling"))] | length >= 1'; then pass "A: the rubric GET /api/video/rubrics/dribbling was made once the consent was there"; else fail "A: the rubric GET was made" "  no such request"; fi
  fi
else web_blocked "A: /video shows the tips and the clip input after the consent (UI)"; fi

# ============================================================================================================================
# C. CLIPS (synthetic dark scene made here) and B. the pose model on /video
# ============================================================================================================================
DARK_OK=0
if command -v ffmpeg >/dev/null 2>&1 &&
  ffmpeg -y -loglevel error -f lavfi -i "color=c=black:s=320x240:r=15" -t 12 -c:v libvpx -b:v 100k -pix_fmt yuv420p "$scratch/dark12.webm" 2>/dev/null &&
  ffmpeg -y -loglevel error -f lavfi -i "color=c=black:s=320x240:r=15" -t 5 -c:v libvpx -b:v 100k -pix_fmt yuv420p "$scratch/dark5.webm" 2>/dev/null &&
  ffmpeg -y -loglevel error -f lavfi -i "color=c=black:s=160x120:r=5" -t 35 -c:v libvpx -b:v 20k -pix_fmt yuv420p "$scratch/dark35.webm" 2>/dev/null; then
  DARK_OK=1; pass "fixtures: synthetic dark clips (5 s, 12 s, 35 s WebM) made with ffmpeg"
else blocked "fixtures: synthetic dark clips" "ffmpeg with the libvpx encoder is not available"; fi

# one flow: pick the skill, choose a clip, wait for what the screen ends on. Args: base, clip (path), waitMs, then a mode for what to do at the review.
JS_FLOW="$JS_NET_ON
  await page.goto(A.base + '/video');
  await page.getByRole('button', { name: 'Analyse my dribbling' }).click();
  const input = page.locator('input[type=file]');
  await input.waitFor({ state: 'attached' });
  await input.setInputFiles(A.clip);
  const t0 = Date.now(); const progress = []; const phases = []; let outcome = 'timeout';
  while (Date.now() - t0 < A.waitMs) {
    const url = page.url();
    const body = await page.evaluate(() => document.body.innerText);
    if (/\\/video\\/result\\//.test(url)) { outcome = 'result'; break; }
    if (body.includes('Ready to send?')) { outcome = 'review'; break; }
    if (body.includes('This device cannot run the analysis')) { outcome = 'unsupported'; break; }
    if (body.includes('We could not read this clip')) { outcome = 'read-failed'; break; }
    if (body.includes('This video cannot be opened.')) { outcome = 'unreadable'; break; }
    if (/This clip is [0-9.,]+ seconds\\. That is too (short|long)\\./.test(body)) { outcome = 'duration'; break; }
    if (body.includes('Reading your movement on this phone') && !phases.includes('processing')) phases.push('processing');
    const pb = page.getByRole('progressbar', { name: 'Reading your movement' });
    if ((await pb.count()) > 0) { const v = await pb.first().getAttribute('aria-valuenow'); if (progress[progress.length - 1] !== v) progress.push(v); }
    await page.waitForTimeout(200);
  }
  let after = {};
  if (outcome === 'review' && A.send) {
    const pics = await page.getByRole('img', { name: /Picture [0-9]+ of [0-9]+ that will be sent/ }).count();
    await page.getByRole('button', { name: 'Send for analysis' }).click();
    const t1 = Date.now(); let end = 'timeout';
    while (Date.now() - t1 < A.sendWaitMs) {
      const body = await page.evaluate(() => document.body.innerText);
      if (/\\/video\\/result\\//.test(page.url())) { end = 'result'; break; }
      if (await page.locator('[role=alert]').count() > 0) { end = 'alert'; break; }
      await page.waitForTimeout(250);
    }
    after = { pics, end, alerts: await page.locator('[role=alert]').allInnerTexts() };
  }
  if (outcome === 'result' || after.end === 'result') { await page.waitForTimeout(1500); await page.getByRole('heading', { level: 1 }).first().waitFor(); }
  netOff();
  return JSON.stringify({ base: A.base, log, statuses, outcome, phases, progress, after, url: page.url(), body: await page.evaluate(() => document.body.innerText),
    alerts: await page.locator('[role=alert]').allInnerTexts(), ms: Date.now() - t0 });"
flow() { # <label> <clip path> <waitMs> <send 0|1>
  pw_js "$1" "$(jq -nc --arg base "$STACK_URL" --arg clip "$2" --argjson waitMs "$3" --argjson send "$([ "$4" = 1 ] && echo true || echo false)" '{base: $base, clip: $clip, waitMs: $waitMs, send: $send, sendWaitMs: 90000}')" "$JS_FLOW"
}

if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ] && [ "$DARK_OK" = 1 ]; then
  PW_TIMEOUT=30000
  flow "C: choose the 5 s clip" "$scratch/dark5.webm" 25000 0
  if [ "$WEB_OK" = 1 ]; then
    F=$PW_OUT
    assert_eq "$(jq -r .outcome <<<"$F")" duration "C: the 5 s clip is refused on the screen (outcome: $(jq -r .outcome <<<"$F"))"
    has "C: ...'This clip is 5 seconds. That is too short.' with the guidance" "$(jq -r .body <<<"$F")" "This clip is 5 seconds. That is too short."
    has "C: ...and 'Use a clip of 10 to 30 seconds so the coach can see enough.'" "$(jq -r .body <<<"$F")" "Use a clip of 10 to 30 seconds so the coach can see enough."
    if net_jq "$F" '[.log[] | select(.m != "GET")] | length == 0'; then pass "C: nothing was posted for the 5 s clip"; else fail "C: nothing was posted for the 5 s clip" "  $(jq -c '[.log[] | select(.m != "GET") | .u]' <<<"$F")"; fi
    net_common "C 5 s clip" "$F"
  fi
  flow "C: choose the 35 s clip" "$scratch/dark35.webm" 25000 0
  if [ "$WEB_OK" = 1 ]; then
    F=$PW_OUT
    assert_eq "$(jq -r .outcome <<<"$F")" duration "C: the 35 s clip is refused on the screen (outcome: $(jq -r .outcome <<<"$F"))"
    has "C: ...'This clip is 35 seconds. That is too long.'" "$(jq -r .body <<<"$F")" "This clip is 35 seconds. That is too long."
    net_common "C 35 s clip" "$F"
  fi

  # B + C: the 12 s dark clip: the model is fetched now (and only now), the re-record prompt with no scores
  if [ "$POSE_OK" = 1 ]; then
    flow "C: choose the dark, empty 12 s clip (on-device reading)" "$scratch/dark12.webm" 120000 0
  else
    blocked "B: on /video, once a clip is chosen, the pose model is requested from the self-hosted /mediapipe path" "$POSE_WHY"
    blocked "C: the dark/empty clip is answered with the re-record prompt and no scores" "$POSE_WHY"
  fi
  if [ "$POSE_OK" = 1 ] && [ "$WEB_OK" = 1 ]; then
    DARK=$PW_OUT
    echo "info: dark clip outcome: $(jq -c '{outcome, phases, progress, ms, url}' <<<"$DARK")" >&2
    if [ "$POSE_OK" = 1 ]; then
      HITS=$(jq -c --arg re "$POSE_RE" "$NET_POSE" <<<"$DARK")
      if net_jq "$DARK" '[.log[] | select(.u | test("/mediapipe/pose_landmarker_lite\\.task"))] | length >= 1'; then pass "B: on /video, once a clip is chosen, the pose model /mediapipe/pose_landmarker_lite.task is requested"
      else fail "B: on /video, once a clip is chosen, the pose model is requested" "  pose-related requests: ${HITS:0:400}; outcome $(jq -r .outcome <<<"$DARK"); screen: $(jq -r .body <<<"$DARK" | tr '\n' '|' | cut -c1-500)"; fi
      if net_jq "$DARK" '([.log[] | select(.u | test("/mediapipe/")) | select(.u | startswith($base + "/mediapipe/"))] | length) == ([.log[] | select(.u | test("/mediapipe/"))] | length)'; then pass "B: every model/WASM request is to this origin's /mediapipe path (self-hosted)"
      else fail "B: every model/WASM request is self-hosted" "  ${HITS:0:400}"; fi
      jchk "B: the model and the WASM (pose_landmarker_lite.task, vision_wasm_internal.wasm) answered 200 on /video" "$DARK" '([.statuses[] | select(.u | test("/mediapipe/pose_landmarker_lite\\.task|/mediapipe/vision_wasm[a-z_]*\\.wasm"))] | length) >= 2 and all(.statuses[] | select(.u | test("/mediapipe/")); .s == 200)'
    else
      blocked "B: on /video the pose model is requested from the self-hosted /mediapipe path" "$POSE_WHY"
    fi
    OUT=$(jq -r .outcome <<<"$DARK")
    if [ "$POSE_OK" != 1 ]; then
      blocked "C: the dark/empty clip is answered with the re-record prompt and no scores" "$POSE_WHY"
    elif [ "$OUT" = result ]; then
      jchk "C: the dark clip navigated to the re-record screen /video/result/rerecord?rerecord=low_visibility&skill=dribbling" "$DARK" '.url | test("/video/result/rerecord\\?") and test("rerecord=low_visibility") and test("skill=dribbling")'
      DARK_TEXT=$(jq -r .body <<<"$DARK")
      has "C: 'We could not see you well enough' (the re-record prompt)" "$DARK_TEXT" "We could not see you well enough"
      has "C: ...with its hint 'Stand so your whole body is in the picture, in good light, then film again.'" "$DARK_TEXT" "Stand so your whole body is in the picture, in good light, then film again."
      has "C: ...'There is no score this time.'" "$DARK_TEXT" "There is no score this time."
      has "C: ...the filming tips ('How to film')" "$DARK_TEXT" "How to film"
      has "C: ...and 'Film again'" "$DARK_TEXT" "Film again"
      hasnt "C: no score on the re-record screen (no 'N / 10', no 'Focus next', no criterion)" "$DARK_TEXT" '[0-9]+ */ *10|focus next|recommended next|confidence'
      if net_jq "$DARK" '[.log[] | select(.m != "GET")] | length == 0'; then pass "C: nothing at all was POSTed for the dark clip (the device answered; no request carries the clip or a picture)"
      else fail "C: nothing was POSTed for the dark clip" "  $(jq -c '[.log[] | select(.m != "GET") | {m, u}]' <<<"$DARK")"; fi
      jchk "C: the rubric GET was made and the on-device progress ran ($(jq -c .progress <<<"$DARK"))" "$DARK" '([.log[] | select(.u | test("/api/video/rubrics/dribbling"))] | length) >= 1 and (.phases | index("processing") != null)'
      net_common "C dark clip" "$DARK"
    else
      # The headless browser could not run the pose model, or the clip could not be decoded: report what the screen said, honestly.
      fail "C: the dark/empty clip is answered with the re-record prompt and no scores" \
        "  outcome '$OUT' after $(jq .ms <<<"$DARK") ms, phases $(jq -c .phases <<<"$DARK"), progress $(jq -c .progress <<<"$DARK"), url $(jq -r .url <<<"$DARK")"$'\n'"  screen: $(jq -r .body <<<"$DARK" | tr '\n' '|' | cut -c1-700)"
      net_common "C dark clip (outcome $OUT)" "$DARK"
    fi
  fi
  PW_TIMEOUT=10000
else
  if [ "$DARK_OK" != 1 ]; then blocked "C: the 5 s / 35 s clips are refused and the dark clip gets the re-record prompt" "no synthetic clip could be made (ffmpeg with libvpx)"
  else web_blocked "C: the clip steps (UI)"; fi
fi

# ============================================================================================================================
# KEYED: the real analysis of the human-supplied clip (needs the key AND dribble.mp4)
# ============================================================================================================================
# check_result_screen <player cookie> <analysis json from the API> <flow json>: the whole result screen against the API's own answer.
check_result_screen() {
  local api=$2 flowj=$3 body n
  body=$(jq -r .body <<<"$flowj")
  jchk "K result: the screen is /video/result/<the analysis id>" "$(jq -nc --argjson f "$flowj" --argjson a "$api" '{url: $f.url, id: $a.id}')" '. as $x | ($x.url | endswith("/video/result/" + $x.id))'
  has "K result: 'Your analysis'" "$body" "Your analysis"
  has "K result: the Beta label" "$body" "Beta"
  has "K result: the limitation 'Pose only — the ball is not tracked yet'" "$body" "Pose only — the ball is not tracked yet"
  local level; level=$(jq -r '.confidence | (.[0:1] | ascii_upcase) + .[1:]' <<<"$api")
  has "K result: the confidence ('Confidence: $level', the API's)" "$body" "Confidence: $level"
  has "K result: 'Focus next'" "$body" "Focus next"
  has "K result: ...with the API's focus sentence" "$body" "$(jq -r .focusNext <<<"$api")"
  has "K result: 'Recommended next'" "$body" "Recommended next"
  has "K result: the hint to add a drill to today's session" "$body" "Open a drill and add it to today's session."
  has "K result: 'Repeat assessment after 3 sessions'" "$body" "Repeat assessment after 3 sessions"
  jchk "K api: the analysis says beta true, repeatAfterSessions 3, no overall score field, one 1-10 score + note per rubric criterion" "$api" \
    ".beta == true and .repeatAfterSessions == 3 and ([keys[] | select(test(\"total|overall|rating|grade|average|^score$\"; \"i\"))] | length == 0) and (.scores | map(.key) | sort) == $(jq -c '.criteria | map(.key) | sort' <<<"$RUBRIC_EN") and all(.scores[]; (.score | type) == \"number\" and .score >= 1 and .score <= 10 and (.note | length) > 0)"
  while IFS=$'\t' read -r lab score note; do
    has "K result: criterion '$lab' shows its score '$score / 10'" "$body" "$lab $score / 10"
    has "K result: ...and its note" "$body" "$note"
  done < <(jq -r '.scores[] | [.label, (.score | tostring), .note] | @tsv' <<<"$api")
  jchk "K result: one bar (meter) per criterion with the API's own score" "$flowj" "([.meters[] | .now] | sort) == $(jq -c '[.scores[].score] | sort' <<<"$api") and (.meters | length) == $(jq '.scores | length' <<<"$api")"
  hasnt "K result: NO overall score (no 'overall score', 'total score', 'out of 100', no number over 10, no '/ 100')" "$body" 'overall score|total score|out of 100|/ *100|[0-9]+ */ *(1[1-9]|[2-9][0-9])'
  assert_eq "$(grep -oE '[0-9]+ / 10' <<<"$(norm "$body")" | wc -l | tr -d ' ')" "$(jq '.scores | length' <<<"$api")" "K result: exactly one 'N / 10' per criterion on the screen and no other score figure (no overall one)"
  n=$(jq '.recommended | length' <<<"$api")
  if [ "$n" -ge 2 ] && [ "$n" -le 3 ]; then pass "K result: $n recommended drills (2-3)"; else fail "K result: 2-3 recommended drills" "  the API recommends $n"; fi
  jchk "K result: the screen links every recommended drill to its commons page /commons/<slug>" "$flowj" "([.drillLinks[] | .href] | sort) == $(jq -c '[.recommended[] | "/commons/" + .slug] | sort' <<<"$api")"
}

JS_RESULT="const drills = await page.locator('a[href^=\"/commons/\"]').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href'), text: a.innerText })));
  const meters = await page.getByRole('meter').evaluateAll((ms) => ms.map((m) => ({ label: m.getAttribute('aria-label'), now: Number(m.getAttribute('aria-valuenow')) })));
  return JSON.stringify({ url: page.url(), body: await page.evaluate(() => document.body.innerText), drillLinks: drills, meters });"

if [ "$KEYED" = 1 ] && [ "$HAVE_CLIP" = 1 ] && [ "$POSE_OK" = 1 ] && [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  ANALYSES_BEFORE=$(sqlite_count video_analyses); FILES_BEFORE=$(count_files "$MEDIA_DIR")
  PW_TIMEOUT=60000
  flow "K1: pick 'Analyse my dribbling', choose dribble.mp4, watch the on-device progress, press Send, wait for the result" "$CLIP" 180000 1
  PW_TIMEOUT=10000
  if [ "$WEB_OK" = 1 ]; then
    KF=$PW_OUT
    echo "info: keyed flow: $(jq -c '{outcome, phases, progress, after, url, ms}' <<<"$KF")" >&2
    assert_eq "$(jq -r .outcome <<<"$KF")" review "K1: the clip was read on the device and the screen reached the review ('Ready to send?'), not '$(jq -r .outcome <<<"$KF")'"
    jchk "K1: the on-device processing progress was shown (a progress bar 'Reading your movement': $(jq -c .progress <<<"$KF"))" "$KF" '.phases | index("processing") != null'
    jchk "K1: the review shows 3-6 pictures that will be sent" "$KF" '.after.pics >= 3 and .after.pics <= 6'
    jchk "K1: after Send the screen went to the result (not an error alert: $(jq -c '.after.alerts' <<<"$KF"))" "$KF" '.after.end == "result"'
    net_common "K1" "$KF"
    jchk "K4: the network log holds exactly ONE analysis POST (/api/player/video-analyses) and no other non-GET request" "$KF" \
      '([.log[] | select(.m == "POST" and (.u | endswith("/api/player/video-analyses")))] | length) == 1 and ([.log[] | select(.m != "GET" and .m != "HEAD" and .m != "OPTIONS")] | length) == 1'
    jchk "K4: the only /api/video request is the rubric GET" "$KF" '([.log[] | select(.u | test("/api/video/"))] | length) >= 1 and all(.log[] | select(.u | test("/api/video/")); .m == "GET" and (.u | test("/api/video/rubrics/")))'
    # the POST's own body: JPEG keyframes + pose features and nothing else, far smaller than a clip
    jchk "K4: the POST is application/json: skill, rubric version, duration, features and 3-6 small JPEG keyframes, no video key" "$KF" \
      '[.log[] | select(.m == "POST" and (.u | endswith("/api/player/video-analyses")))][0] | (.ct | startswith("application/json")) and (.post | fromjson | ((keys | sort) == ["clientUuid","durationSec","features","keyframes","rubricVersion","skillSlug"]) and (.keyframes | length >= 3 and length <= 6) and all(.keyframes[]; .mimeType == "image/jpeg" and (.data | startswith("/9j/")) and .width <= 512 and .height <= 512 and (.data | length) <= 280000) and (.features | has("meanVisibility") and has("framesAnalysed")))'
    jchk "K4: ...and its size is that of a few small pictures (under 1.3 MB), not of a clip" "$KF" '[.log[] | select(.m == "POST" and (.u | endswith("/api/player/video-analyses")))][0].n | . > 1000 and . < 1300000'
    if [ "$(jq -r .after.end <<<"$KF")" = result ]; then
      fetch "$A_COOKIE" GET /api/player/video-analyses
      API_LIST=$F_BODY
      chk "K api: GET /api/player/video-analyses lists the analysis" 200 'length == 1'
      API_ONE=$(jq -c '.[0]' <<<"$API_LIST")
      pw_js "K result: read the result screen" '{}' "$JS_RESULT"
      [ "$WEB_OK" != 1 ] || check_result_screen "$A_COOKIE" "$API_ONE" "$PW_OUT"
      # the recommended drills open real commons pages
      while IFS=$'\t' read -r slug title; do
        pw_js "K result: open the recommended drill '$title'" "$(jq -nc --arg base "$STACK_URL" --arg slug "$slug" '{base: $base, slug: $slug}')" \
          "await page.goto(A.base + '/commons/' + A.slug); await page.getByRole('heading', { level: 1 }).first().waitFor(); await page.waitForTimeout(500); return JSON.stringify({ h1: await page.getByRole('heading', { level: 1 }).first().innerText(), body: await page.evaluate(() => document.body.innerText) });"
        [ "$WEB_OK" != 1 ] || has "K result: the drill page /commons/$slug opens with the drill's title '$title'" "$PW_OUT" "$title"
      done < <(jq -r '.recommended[] | [.slug, .title] | @tsv' <<<"$API_ONE")
      # the database and the media directory
      assert_eq "$(sqlite_count video_analyses)" "$((ANALYSES_BEFORE + 1))" "K db: exactly ONE new video_analyses row"
      assert_eq "$(count_files "$MEDIA_DIR")" "$FILES_BEFORE" "K: MEDIA_DIR holds no new file after the request ($FILES_BEFORE before)"
      ROW=$(sqlite_json "SELECT * FROM video_analyses WHERE player_id = '$A_ID'" | jq -c '.[0]')
      jchk "K db: the row holds scores, focus, drills and a numbers-only summary: scores are the API's, no image or base64 run in any column" "$ROW" \
        '(.scores | fromjson | length) >= 1 and (.features_summary | fromjson | has("meanVisibility")) and ([.[] | strings] | all(test("[A-Za-z0-9+/=]{256}") | not)) and ([.[] | strings] | all(contains("/9j/") | not))'
      if grep -qaF -e '/9j/' "$DB_PATH" "$DB_PATH-wal" 2>/dev/null; then fail "K db: no JPEG (base64 '/9j/') anywhere in the database file" "  found in $DB_PATH*"; else pass "K db: no JPEG (base64 '/9j/') anywhere in the database file or its WAL"; fi
      if grep -qaP '\xff\xd8\xff' "$DB_PATH" "$DB_PATH-wal" 2>/dev/null; then fail "K db: no raw JPEG bytes in the database file" "  found"; else pass "K db: no raw JPEG bytes (FF D8 FF) in the database file"; fi
      assert_eq "$(sqlite_count ai_calls "player_id = '$A_ID' AND kind = 'video'")" 1 "K db: one ai_calls row of kind 'video' for the analysis"
    fi
  fi
else
  KEYED_REASONS=()
  [ "$KEYED" = 1 ] || KEYED_REASONS+=("external credential: OPENAI_API_KEY")
  [ "$HAVE_CLIP" = 1 ] || KEYED_REASONS+=("external asset: apps/web/e2e/fixtures/dribble.mp4")
  [ "$POSE_OK" = 1 ] || KEYED_REASONS+=("$POSE_WHY")
  { [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; } || KEYED_REASONS+=("no usable browser")
  KR=$(printf '%s; ' "${KEYED_REASONS[@]}"); KR=${KR%; }
  blocked "K1: the player picks 'Analyse my dribbling', chooses the clip, sees the on-device processing progress and sends it" "$KR"
  blocked "K2: the result screen: Beta, 'Pose only — the ball is not tracked yet', confidence, a 1-10 score + note per criterion, 'Focus next', 2-3 recommended drills, 'Repeat assessment after 3 sessions', no overall score" "$KR"
  blocked "K3: the recommended drills open real commons drill pages" "$KR"
  blocked "K4: the network log of the real flow holds the rubric GET and ONE POST with JPEG keyframes + features, no video bytes" "$KR"
  blocked "K5: after the request MEDIA_DIR has no new file and sqlite holds one video_analyses row with scores only" "$KR"
fi

# ============================================================================================================================
# E. NO KEY: the API restarts on the same database with OPENAI_API_KEY unset
# ============================================================================================================================
pw close >/dev/null 2>&1
restart_api ""; rc=$?
assert_eq "$rc" 0 "E: the API restarted on the same database with OPENAI_API_KEY unset"
assert_api /health '.ok == true and .aiAvailable == false' -l "E: /health says aiAvailable false"
ROWS_BEFORE=$(sqlite_count video_analyses)
if [ "$JPEG_OK" = 1 ]; then
  fetch "$A_COOKIE" POST /api/player/video-analyses "$(req_json dribbling "$RUBRIC_VERSION" 0.9 "$(uuid b)")"
  chk "E api: with the consent and no key the analysis POST is 503 problem 'ai_unavailable' (a valid body)" 503 '.type == "ai_unavailable" and .status == 503'
  assert_eq "$(sqlite_count video_analyses)" "$ROWS_BEFORE" "E db: nothing was stored"
  assert_eq "$(sqlite_count ai_calls "player_id = '$A_ID' AND kind = 'video' AND fallback_code = 'no_key'")" 1 "E db: the refusal is logged in ai_calls with fallback 'no_key' (and no prompt or picture column)"
  assert_eq "$(count_files "$MEDIA_DIR")" 0 "E: MEDIA_DIR still holds no file"
else blocked "E api: the analysis POST without a key is 503 ai_unavailable" "no JPEG frames (ffmpeg)"; fi
fetch "$A_COOKIE" GET /api/video/rubrics/dribbling?locale=en
chk "E api: the rubric is still served without a key (public)" 200 '.criteria | length >= 4'
fetch "$A_COOKIE" GET '/api/player/today?locale=en'
chk "E api: today's session is served without a key" 200 '(.items | length) >= 2'

JS_APP="$JS_NET_ON
  const visits = [];
  for (const p of ['/train', '/commons', '/progress', '/video']) {
    await page.goto(A.base + p); await page.waitForTimeout(1500);
    visits.push({ p, url: page.url(), alerts: await page.locator('[role=alert]').count(), text: (await page.evaluate(() => document.body.innerText)).slice(0, 400), list: await page.getByRole('list', { name: \"Today's drills\" }).count() });
  }
  netOff();
  return JSON.stringify({ base: A.base, log, statuses, visits });"
browse_as "A (no key)" "$A_COOKIE"
if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  pw_js "E: with no key visit /train, /commons, /progress and /video" "$(jq -nc --arg base "$STACK_URL" '{base: $base}')" "$JS_APP"
  if [ "$WEB_OK" = 1 ]; then
    APP=$PW_OUT
    jchk "E: the rest of the app works: /train lists today's drills" "$APP" '[.visits[] | select(.p == "/train")][0] | .list >= 1 and .alerts == 0 and (.url | endswith("/train"))'
    jchk "E: /commons, /progress open on their own URLs with content and no error alert" "$(jq -c '{visits}' <<<"$APP")" '[.visits[] | select(.p == "/commons" or .p == "/progress")] | length == 2 and all(.[]; . as $v | ($v.url | endswith($v.p)) and ($v.text | length) > 30 and $v.alerts == 0)'
    jchk "E: every /api answer of those visits is below 400 (no 401/403/404/5xx)" "$APP" '[.statuses[] | select(.u | test("/api/")) | select(.s >= 400)] | length == 0'
    jchk "E: /video itself opens with no key (the skill list is there; nothing errors before a clip is sent)" "$APP" '[.visits[] | select(.p == "/video")][0] | (.text | contains("Analyse my dribbling")) and .alerts == 0'
    net_common "E no key" "$APP"
  fi
else web_blocked "E: the rest of the app works with no key (UI)"; fi

# E (UI): with a clip the flow ends on a screen that says the analysis is unavailable (needs a person in the clip: dribble.mp4)
if [ "$HAVE_CLIP" = 1 ] && [ "$POSE_OK" = 1 ] && [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; then
  PW_TIMEOUT=60000
  flow "E: no key, choose dribble.mp4, press Send" "$CLIP" 180000 1
  PW_TIMEOUT=10000
  if [ "$WEB_OK" = 1 ]; then
    NK=$PW_OUT
    assert_eq "$(jq -r .outcome <<<"$NK")" review "E ui: the clip was read on the device and reached the review ('$(jq -r .outcome <<<"$NK")')"
    jchk "E ui: after Send the screen says the analysis is unavailable (an alert containing 'unavailable'): $(jq -c '.after.alerts' <<<"$NK")" "$NK" '(.after.alerts | join(" ")) | test("unavailable"; "i")'
    assert_eq "$(sqlite_count video_analyses)" "$ROWS_BEFORE" "E ui db: still nothing stored"
  fi
else
  R=()
  [ "$HAVE_CLIP" = 1 ] || R+=("external asset: apps/web/e2e/fixtures/dribble.mp4")
  [ "$POSE_OK" = 1 ] || R+=("$POSE_WHY")
  { [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 1 ]; } || R+=("no usable browser")
  R=$(printf '%s; ' "${R[@]}"); R=${R%; }
  blocked "E ui: with no key the screen shows that the analysis is unavailable after Send (a send needs a clip in which the device finds a person)" "$R"
fi

# ============================================================================================================================
# F. API: the checks that come after the key check (a placeholder key value; the provider is never called)
# ============================================================================================================================
pw close >/dev/null 2>&1
# The provider must never be contacted with the placeholder: point its base URL at a closed local port, so that a request which (wrongly)
# got past every check would fail at once instead of reaching a third party.
export OPENAI_BASE_URL="http://127.0.0.1:9"
restart_api "$PLACEHOLDER_KEY"; rc=$?
assert_eq "$rc" 0 "F: the API restarted on the same database with a placeholder key value (no credential: never used)"
assert_api /health '.ok == true and .aiAvailable == true' -l "F: /health now says aiAvailable true (the checks after the key check can run)"
AI_CALLS_BEFORE=$(sqlite_count ai_calls)
if [ "$JPEG_OK" = 1 ]; then
  echo 'not a video, just bytes labelled as one' >"$scratch/fake.mp4"
  fetch "$A_COOKIE" POST /api/player/video-analyses "" -H 'content-type: video/mp4' --data-binary "@$scratch/fake.mp4"
  chk "F api: a video/mp4 body is refused: 415" 415 '.status == 415'
  fetch "$A_COOKIE" POST /api/player/video-analyses "" -F "payload=$(req_json dribbling "$RUBRIC_VERSION" 0.9 "$(uuid c)" | jq -c 'del(.keyframes)');type=application/json" -F "video=@$scratch/fake.mp4;type=video/mp4"
  chk "F api: a multipart part named 'video' is refused: 415" 415 '.status == 415'
  fetch "$A_COOKIE" POST /api/player/video-analyses "" -F "payload=$(req_json dribbling "$RUBRIC_VERSION" 0.9 "$(uuid c)" | jq -c 'del(.keyframes)');type=application/json" \
    -F "keyframes=@$scratch/kf1.jpg;type=video/webm;filename=frame1.webm" -F "keyframes=@$scratch/kf2.jpg;type=image/jpeg;filename=frame2.jpg" -F "keyframes=@$scratch/kf3.jpg;type=image/jpeg;filename=frame3.jpg"
  chk "F api: a keyframe part typed video/* is refused: 415" 415 '.status == 415'
  fetch "$A_COOKIE" POST /api/player/video-analyses "" -F "payload=$(req_json dribbling "$RUBRIC_VERSION" 0.9 "$(uuid c)" | jq -c 'del(.keyframes)');type=application/json" \
    -F "keyframes=@$scratch/kf1.jpg;type=image/png;filename=frame1.png" -F "keyframes=@$scratch/kf2.jpg;type=image/jpeg;filename=frame2.jpg" -F "keyframes=@$scratch/kf3.jpg;type=image/jpeg;filename=frame3.jpg"
  chk "F api: a keyframe part that is not image/jpeg is refused: 415" 415 '.status == 415'
  fetch "$A_COOKIE" POST /api/player/video-analyses "$(req_json dribbling "$RUBRIC_VERSION" 0.9 "$(uuid d)" 2)"
  chk "F api: 2 keyframes (fewer than 3) are 422 with a pointer at /keyframes" 422 'any(.errors[]; .pointer | startswith("/keyframes"))'
  { printf '/9j/'; head -c 299996 /dev/zero | tr '\0' 'A'; } >"$scratch/big.b64"
  req_json dribbling "$RUBRIC_VERSION" 0.9 "$(uuid e)" | jq -c --rawfile big "$scratch/big.b64" '.keyframes[0].data = $big' >"$scratch/big.json"
  fetch "$A_COOKIE" POST /api/player/video-analyses "" -H 'content-type: application/json' --data-binary "@$scratch/big.json"
  chk "F api: a keyframe of about 225 KB (over 200 KB) is 413" 413 '.status == 413'
  fetch "$A_COOKIE" POST /api/player/video-analyses "$(req_json dribbling "$RUBRIC_VERSION" 0.9 "$(uuid f)" | jq -c '.durationSec = 45')"
  chk "F api: a clip of 45 s (over 30 s) is 422 at /durationSec" 422 'any(.errors[]; .pointer == "/durationSec")'
  fetch "$A_COOKIE" POST /api/player/video-analyses "$(req_json dribbling "$RUBRIC_VERSION" 0.9 "$(uuid f)" | jq -c '.video = "AAAA"')"
  chk "F api: an extra 'video' key in the JSON is refused (422, strict schema)" 422 '.status == 422'
  fetch "$A_COOKIE" POST /api/player/video-analyses "$(req_json dribbling "$RUBRIC_VERSION" 0.05 "$(uuid 7)")"
  chk "F api: a clip the device could not see (meanVisibility 0.05 < the rubric's $RUBRIC_MIN) is 200 {rerecord: true, reason: 'low_visibility'} with NO scores" 200 '.rerecord == true and .reason == "low_visibility" and (has("scores") | not)'
  assert_eq "$(sqlite_count ai_calls)" "$AI_CALLS_BEFORE" "F db: none of these reached the model (no ai_calls row was written)"
  assert_eq "$(sqlite_count video_analyses)" "$ROWS_BEFORE" "F db: nothing was stored (no video_analyses row)"
  assert_eq "$(count_files "$MEDIA_DIR")" 0 "F: MEDIA_DIR holds no file after 415/413/422/rerecord requests carrying pictures"
  if grep -qaF -e '/9j/' "$DB_PATH" "$DB_PATH-wal" 2>/dev/null; then fail "F db: no JPEG (base64 '/9j/') anywhere in the database file" "  found in $DB_PATH*"; else pass "F db: no JPEG (base64 '/9j/') anywhere in the database file or its WAL"; fi
  if grep -qaP '\xff\xd8\xff' "$DB_PATH" "$DB_PATH-wal" 2>/dev/null; then fail "F db: no raw JPEG bytes in the database file" "  found"; else pass "F db: no raw JPEG bytes (FF D8 FF) in the database file"; fi
  # revoke the consent: the same valid request is 403 again
  fetch "$A_COOKIE" PUT /api/player/consents '{"videoAnalysis":false}'
  chk "F api: revoking the video-analysis consent is 200 (granted false)" 200 '.videoAnalysis.granted == false'
  fetch "$A_COOKIE" POST /api/player/video-analyses "$(req_json dribbling "$RUBRIC_VERSION" 0.9 "$(uuid 8)")"
  chk "F api: after the revocation the analysis POST is 403 problem 'consent required' again" 403 '.title == "consent required"'
else blocked "F api: the checks after the key check (415, 422, 413, rerecord, nothing stored)" "no JPEG frames (ffmpeg)"; fi

# no explicit stop or summary: the EXIT handler stops the stack, prints the summary, sets the exit code
