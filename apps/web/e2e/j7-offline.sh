#!/usr/bin/env bash
# apps/web/e2e/j7-offline.sh: slice gate fc-mol-3ye, journey J7 "a player installs the app and trains offline".
# Integration proof on the REAL stack: the real API process, a real SQLite file with the real seed, the PRODUCTION web build
# served by the API (a service worker exists only in the build), a real Chromium through playwright-cli with the context
# switched offline (context.setOffline). Nothing is mocked, no OpenAI key is needed.
#   A. BUILD      two production builds of apps/web (VITE_BUILD_VERSION j7-v1 and j7-v2, into scratch dirs; the repo is never
#                 touched). The API serves v1 (BUILD_VERSION j7-v1). The precache (served /sw.js and the browser's Cache Storage)
#                 holds no video, no pose model and no /api response.
#   B. INSTALL    /manifest.webmanifest fields, icons 192 + 512 + maskable (real PNG sizes), index.html links it, the browser
#                 parses it (no manifest errors, Chrome's installability errors are empty), a service worker is registered,
#                 active and controls the page.
#   C. ONLINE     an onboarded player opens /train, presses "Download today's session" and sees the "Available offline" badge and a
#                 "Last synced" time; the device holds exactly the server's session.
#   D. OFFLINE    the context is offline: a RELOAD of /train and of a drill URL still renders (shell, session, every drill text).
#                 Then, without a reload, every drill is done and the session finished offline; "Saved on this device — will
#                 sync" shows; the summary renders; no API call succeeds while offline.
#   E. BACK ONLINE the outbox replays by itself in ONE API call; sqlite_count shows exactly one set of events; re-posting the
#                 same batch with curl adds none.
#   F. NEW BUILD  the API is restarted on the same DB and port with BUILD_VERSION j7-v2 serving the v2 build (a deploy): the open
#                 app shows "New version available", does not reload by itself, and after "Update" the footer and the running
#                 bundle are the new version.
# Exit codes (lib.sh): 0 every check passed, 1 at least one FAIL, 3 nothing failed but a check was BLOCKED (no browser, E2E_WEB=off,
# no playwright-cli); E2E_ALLOW_BLOCKED=1 keeps a blocked-only run at 0. BLOCKED is never counted as a pass.
#
# Readings of the criteria where they are open (each is one line of the script):
#   * "an onboarded player": onboarding is J2's proof (the wizard). Here the browser itself calls POST /api/auth/sign-in/anonymous
#     and POST /api/player/start (the real endpoints, from the page, same cookie jar), then everything else is the real UI.
#   * "with the browser context set offline a reload still renders /train, the drill player and all drill text": reload /train
#     offline -> the page shows today's session (every drill title) and the badge; navigate the drill URL offline (a fresh load
#     through the service worker) -> every text of that drill (title, goal, steps, mistakes, safety, easier/harder) is on the
#     page. "all drill text" is compared with the server's own GET /api/player/today, not with a copy in this script.
#   * The full offline session (every drill done, finish) runs WITHOUT a reload, after the app has been opened online and the
#     player wired: that is the path the outbox serves. It is a separate step from the reload checks so that one failing does
#     not hide the other.
#   * "in 1 API call": POST /api/player/session-events requests between the `online` switch and the moment the sync settles.
#     The Better Auth session READS (GET /api/auth/get-session) are not API calls of the journey and are not counted.
#   * "footer version changes after accepting": the footer reads GET /health, i.e. the API process's BUILD_VERSION, which the
#     deploy changes at once; so the footer is asserted to read j7-v1 before the deploy and j7-v2 after Update. The new build is
#     proven by the footer (j7-v2 shown, j7-v1 gone), the persisted-cache buster (== BUILD_VERSION j7-v2), the entry script
#     filename differing from the one the page ran before Update (captured before pressing Update) and no prompt left; the
#     version string is NOT looked for inside the entry script text (it is no longer in the entry chunk). Whether the footer
#     already showed v2 while the prompt was up is printed as a note, not asserted.
#   * dist/mediapipe/ (the pose model .task and vision_wasm_* files) legitimately sits in dist since 8nt.11 so /video can fetch
#     it; the dist check only forbids video files there, and the precache and Cache Storage checks forbid any pose/mediapipe
#     entry from being precached or cached.
#   * The browser runs in UTC and en-US (playwright-cli config): downloadToday sends no X-Timezone (the server's "today" is then
#     the UTC day) while the /train screen sends the device's zone, so near local midnight a non-UTC device would disagree with
#     itself; pinning the zone keeps the run deterministic (that gap is reported, not hidden).
# Self-test hooks (the mutation probes of this script): J7_DIST1 / J7_DIST2 use a prebuilt dist directory instead of building
# (never modified). Fail-slow (no set -e): every step reports. Cleanup: e2e_defer (never `trap ... EXIT` after sourcing lib.sh).
# Ports: the API gets a free kernel-assigned port (lib.sh start_stack); nothing is bound to :4111 or :5173 and no process this
# script did not start is touched.
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$HERE/lib.sh"

V1=j7-v1
V2=j7-v2
J7_CALL_BUDGET=1
unset SEED_DIR   # the API must start on the repo's default seed

scratch=$(mktemp -d "${TMPDIR:-/tmp}/j7-gate.XXXXXX") || exit 1
e2e_defer 'rm -rf -- "$scratch"'

# The harness has no public "restart the API on the same DB and port" (j1a-seed.sh uses the same private helpers for the same
# purpose). Refuse loudly if they go away.
for fn in _e2e_kill _e2e_launch_api _e2e_wait_api; do
  declare -F "$fn" >/dev/null || { fail "harness helper $fn is missing (lib.sh changed); this gate needs a same-DB restart"; exit 1; }
done

# --- small helpers -------------------------------------------------------------------------------------------------------
NBSP=$(printf '\xc2\xa0')
EMPTY_JSON={}
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
# jchk <label> <json> <jq expression>: the expression is truthy on the JSON text.
jchk() {
  if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "  jq -e '$3' was false or failed on: ${2:0:1500}"; fi
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
# text_has <label> <haystack> <needle>: case-insensitive containment; no-break spaces are spaces.
text_has() {
  local hay=${2//$NBSP/ } needle=$3
  if [[ ${hay,,} == *"${needle,,}"* ]]; then pass "$1"; else fail "$1" "  needle: $3"$'\n'"  saw: ${hay:0:1500}"; fi
}

# --- browser helpers (playwright-cli through lib.sh's pw; the visible words are the English ones) ---------------------------
WEB_OK=0
# JS shared by every snippet (a bash string; no single quotes inside): origin of the page, tolerant text compare, IndexedDB read.
JS_PRELUDE='
const origin = () => page.url().replace(/^(https?:\/\/[^\/]+).*$/, "$1");
const norm = (s) => String(s).replace(/[\s ]+/g, " ").trim().toLowerCase();
const goOffline = async () => { await page.context().setOffline(true); await page.waitForFunction(() => navigator.onLine === false, null, { timeout: 8000 }); };
const goOnline = async () => { await page.context().setOffline(false); await page.waitForFunction(() => navigator.onLine === true, null, { timeout: 8000 }); };
const missing = (text, phrases) => { const t = norm(text); return phrases.filter((p) => !t.includes(norm(p))); };
const idbAll = () => page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  if (!dbs.some((d) => d.name === "keyval-store")) return {};
  const db = await new Promise((res, rej) => { const r = indexedDB.open("keyval-store"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  if (!db.objectStoreNames.contains("keyval")) { db.close(); return {}; }
  const st = db.transaction("keyval", "readonly").objectStore("keyval");
  const keys = await new Promise((res) => { const r = st.getAllKeys(); r.onsuccess = () => res(r.result); });
  const out = {};
  for (const k of keys) out[k] = await new Promise((res) => { const r = st.get(k); r.onsuccess = () => res(r.result); });
  db.close();
  return out;
});
'
# pw_js <label> <args json> <js: async (page, A) => ...> [timeout ms]: runs a Playwright snippet in the page; the returned string
# is left in PW_OUT. Silent on success (the assertions that follow are the checks), FAIL with the error otherwise.
pw_js() {
  local label=$1 args=$2 code=$3 tmo=${4:-10000} out
  PW_OUT=""
  out=$(pw run-code "async page => { page.setDefaultTimeout($tmo); ${JS_PRELUDE} const A = ${args}; const run = ${code}; return await run(page, A); }") || {
    fail "$label" "  $(jq -r '.error // .' <<<"$out" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | head -n 12)"; WEB_OK=0; return 1; }
  PW_OUT=$(jq -r '.result | (try fromjson catch .) | if type == "string" then . else tojson end' <<<"$out")
}
# api_calls <since-index>: the /api requests of the browser session after request number <since-index> (playwright-cli lists
# "N. [METHOD] url => [status] text"); one "METHOD path status" per line, the Better Auth session READS left out.
api_calls() {
  pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[([A-Z]+)\] https?:\/\/[^\/]+(\/api\/[^ ?]*)[^ ]* => \[([^]]+)\].*/\1 \2 \3 \4/p' |
    awk -v since="$1" '$1 > since && $3 != "/api/auth/get-session" { print $2, $3, $4 }'
}
last_request_index() { pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[.*/\1/p' | sort -n | tail -n1; }

# ============================================================================================================================
# --- A. the two production builds -------------------------------------------------------------------------------------------
DIST1=${J7_DIST1:-} DIST2=${J7_DIST2:-}
if [ "$E2E_WEB" = api ]; then
  build_dist() { # <outdir> <version> <log>: the real production build, the version baked into the bundle (vite.config.ts)
    (cd "$E2E_WEB_DIR" && VITE_BUILD_VERSION="$2" BUILD_VERSION="$2" bun run build --outDir "$1" --emptyOutDir) >"$3" 2>&1
  }
  if [ -z "$DIST1" ]; then
    DIST1=$scratch/dist-1
    if build_dist "$DIST1" "$V1" "$scratch/build-1.log"; then pass "build: production web build 1 (VITE_BUILD_VERSION=$V1)"
    else _e2e_log_tail "$scratch/build-1.log" 30; fail "build: production web build 1"; exit 1; fi
  else pass "build: prebuilt dist 1 (J7_DIST1=$DIST1)"; fi
  if [ -z "$DIST2" ]; then
    DIST2=$scratch/dist-2
    if build_dist "$DIST2" "$V2" "$scratch/build-2.log"; then pass "build: production web build 2 (VITE_BUILD_VERSION=$V2)"
    else _e2e_log_tail "$scratch/build-2.log" 30; fail "build: production web build 2"; exit 1; fi
  else pass "build: prebuilt dist 2 (J7_DIST2=$DIST2)"; fi
  export E2E_WEB_DIST=$DIST1
fi
export BUILD_VERSION=$V1   # the API process's own version (GET /health, the footer); a deploy changes it below

start_stack || exit 1
assert_api /health '.ok == true and .database == "ok"' -l "stack: /health ok on the temp DB (port $E2E_API_PORT_USED, own media dir)"
assert_api /health ".version == \"$V1\"" -l "stack: the API reports BUILD_VERSION $V1"
assert_eq "$(sqlite_count player_profiles)" 0 "start state: no player profile yet"
assert_eq "$(sqlite_count session_events)" 0 "start state: no session event yet"

if [ "$E2E_WEB" != api ]; then
  blocked "offline journey (manifest, service worker, offline reload, outbox, update prompt)" "E2E_WEB=$E2E_WEB: the web app is not served"
  exit 0
fi

# --- A2. the precache holds no video and no pose model (served /sw.js) -----------------------------------------------------
SW_HDRS=$(curl -s -D- -o "$scratch/sw.js" --max-time "$E2E_HTTP_TIMEOUT" "$STACK_URL/sw.js" | tr -d '\r')
SW_JS=$(cat "$scratch/sw.js" 2>/dev/null)
SW_URLS=$(grep -oE 'url:"[^"]+"' <<<"$SW_JS" | sed -E 's/^url:"//; s/"$//' | sort -u)
SW_COUNT=$(grep -c . <<<"$SW_URLS")
if grep -qi '^HTTP/[0-9.]* 200' <<<"$SW_HDRS" && grep -qiE '^content-type: *(text|application)/javascript' <<<"$SW_HDRS"; then pass "sw.js is served (200, JavaScript)"
else fail "sw.js is served (200, JavaScript)" "  ${SW_HDRS:0:400}"; fi
if grep -qi '^cache-control: *no-cache' <<<"$SW_HDRS"; then pass "sw.js is not cached by the HTTP cache (Cache-Control: no-cache), so an update is seen at once"
else fail "sw.js is Cache-Control: no-cache" "  ${SW_HDRS:0:400}"; fi
if [ "$SW_COUNT" -ge 20 ]; then pass "precache: the app shell is precached ($SW_COUNT entries)"; else fail "precache: the app shell is precached (>= 20 entries)" "  got $SW_COUNT"; fi
for want in 'index.html' 'manifest.webmanifest' 'pwa-192x192.png' 'pwa-512x512.png' 'maskable-512x512.png'; do
  if grep -qxF "$want" <<<"$SW_URLS"; then pass "precache: lists $want"; else fail "precache: lists $want" "  entries: ${SW_URLS:0:800}"; fi
done
if grep -qE '^assets/inter-cyrillic-wght-normal-.*\.woff2$' <<<"$SW_URLS" && grep -qE '^assets/inter-cyrillic-ext-wght-normal-.*\.woff2$' <<<"$SW_URLS"; then
  pass "precache: the self-hosted Inter cyrillic and cyrillic-ext fonts (Kazakh) are precached"
else fail "precache: the self-hosted Inter cyrillic and cyrillic-ext fonts (Kazakh) are precached" "  fonts: $(grep woff2 <<<"$SW_URLS" | tr '\n' ' ')"; fi
bad=$(grep -iE '\.(mp4|webm|mov|task|tflite|onnx|wasm)$|pose|mediapipe|landmark' <<<"$SW_URLS")
if [ -z "$bad" ]; then pass "precache: no video (.mp4/.webm/.mov) and no pose model (.task/.tflite/.onnx/.wasm, pose, mediapipe) in the $SW_COUNT entries"
else fail "precache: no video and no pose model" "  offending entries: $(tr '\n' ' ' <<<"$bad")"; fi
if grep -qE 'StaleWhileRevalidate|NetworkFirst|CacheFirst|NetworkOnly|caches\.open|runtimeCaching' <<<"$SW_JS"; then
  fail "service worker: no runtime caching (no /api, video or model response is ever cached)" "  sw.js contains a caching strategy: $(grep -oE 'StaleWhileRevalidate|NetworkFirst|CacheFirst|NetworkOnly|caches\.open|runtimeCaching' <<<"$SW_JS" | sort -u | tr '\n' ' ')"
else pass "service worker: no runtime caching strategy in sw.js"; fi
if grep -qF 'NavigationRoute' <<<"$SW_JS" && grep -qF '/^\/api' <<<"$SW_JS"; then pass "service worker: navigations fall back to index.html with /api excluded (NavigationRoute denylist)"
else fail "service worker: navigations fall back to index.html with /api excluded" "  tail of sw.js: ${SW_JS: -400}"; fi
# dist/mediapipe/ (pose model .task, vision_wasm_*) is served from dist on purpose (8nt.11); only video is forbidden in dist.
# That none of it is precached is asserted above (precache list) and on the device below (Cache Storage).
media=$(find "$DIST1" -type f \( -iname '*.mp4' -o -iname '*.webm' -o -iname '*.mov' \) 2>/dev/null)
if [ -z "$media" ]; then pass "dist: the production build contains no video file (.mp4/.webm/.mov)"; else fail "dist: the production build contains no video file (.mp4/.webm/.mov)" "  $media"; fi

# --- B. installability: manifest, icons -------------------------------------------------------------------------------------
MANIFEST=$(curl -s -D "$scratch/m.hdr" --max-time "$E2E_HTTP_TIMEOUT" "$STACK_URL/manifest.webmanifest")
if grep -qiE '^content-type: *application/(manifest\+json|json)' "$scratch/m.hdr"; then pass "manifest: /manifest.webmanifest is served as application/manifest+json"
else fail "manifest: served as a manifest" "  $(head -n5 "$scratch/m.hdr")"; fi
jchk "manifest: name 'FIRST COACH — БІРІНШІ БАПКЕР', short_name 'First Coach'" "$MANIFEST" '.name == "FIRST COACH — БІРІНШІ БАПКЕР" and .short_name == "First Coach"'
jchk "manifest: display standalone, start_url /train" "$MANIFEST" '.display == "standalone" and .start_url == "/train"'
jchk "manifest: theme_color #101815, background_color #f4f3ee" "$MANIFEST" '.theme_color == "#101815" and .background_color == "#f4f3ee"'
jchk "manifest: lang-neutral (no lang key)" "$MANIFEST" 'has("lang") | not'
png_size() { curl -s --max-time "$E2E_HTTP_TIMEOUT" "$1" | head -c 24 | od -An -tu1 -j16 -N8 | awk 'NF == 8 { printf "%dx%d", $1*16777216+$2*65536+$3*256+$4, $5*16777216+$6*65536+$7*256+$8 }'; }
icon_ok() { # <label> <jq selecting the manifest icon> <WxH>
  local src size ct
  src=$(jq -r "[.icons[] | $2] | first | .src // empty" <<<"$MANIFEST")
  if [ -z "$src" ]; then fail "$1" "  no such icon in the manifest: $(jq -c .icons <<<"$MANIFEST")"; return; fi
  size=$(png_size "$STACK_URL/${src#/}")
  ct=$(curl -sI --max-time "$E2E_HTTP_TIMEOUT" "$STACK_URL/${src#/}" | tr -d '\r' | grep -i '^content-type:' | tr 'A-Z' 'a-z')
  if [ "$size" = "$3" ] && [[ $ct == *image/png* ]]; then pass "$1 ($src is a real PNG of $size)"; else fail "$1" "  $src: PNG size '$size' (wanted $3), $ct"; fi
}
icon_ok "manifest: icon 192" 'select(.sizes == "192x192" and (.purpose // "any" | contains("maskable") | not))' 192x192
icon_ok "manifest: icon 512" 'select(.sizes == "512x512" and (.purpose // "any" | contains("maskable") | not))' 512x512
icon_ok "manifest: maskable icon" 'select(.purpose // "" | contains("maskable"))' 512x512
INDEX_HTML=$(curl -s --max-time "$E2E_HTTP_TIMEOUT" "$STACK_URL/")
if grep -q '<link rel="manifest" href="/manifest.webmanifest"' <<<"$INDEX_HTML" && grep -q 'name="theme-color" content="#101815"' <<<"$INDEX_HTML"; then pass "index.html links the manifest and sets the theme colour"
else fail "index.html links the manifest and sets the theme colour" "  ${INDEX_HTML:0:600}"; fi

# --- browser ----------------------------------------------------------------------------------------------------------------
printf '{"browser":{"contextOptions":{"timezoneId":"UTC","locale":"en-US"}}}\n' >"$scratch/pw.json"
WEB_ON=0
if ! pw_available; then blocked "browser journey (service worker, offline, outbox, update prompt)" "playwright-cli is not installed"
else
  if out=$(pw open "$STACK_URL/" --config="$scratch/pw.json" 2>&1); then pass "browser opened $STACK_URL/ (Chromium, UTC, en-US)"; WEB_ON=1
  elif grep -qiE 'not installed|Executable doesn.t exist' <<<"$out"; then blocked "browser: open $STACK_URL/" "no usable browser: $(grep -iE 'not installed|Executable' <<<"$out" | head -n1)"
  else fail "browser: open $STACK_URL/" "$out"; fi
fi

if [ "$WEB_ON" = 1 ]; then
  WEB_OK=1
  pw resize 1280 1800 >/dev/null

  # --- B2. the service worker is registered ---------------------------------------------------------------------------------
  pw_js "service worker: reading the registration" '{}' 'async (page) => JSON.stringify(await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return { supported: false };
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 15000))]);
    if (!reg) return { supported: true, registered: false };
    return { supported: true, registered: true, state: reg.active && reg.active.state, scope: reg.scope, script: reg.active && reg.active.scriptURL };
  }))' 25000
  if [ "$WEB_OK" = 1 ]; then
    jchk "service worker: registered and activated ($PW_OUT)" "$PW_OUT" ".registered == true and .state == \"activated\" and .scope == \"$STACK_URL/\" and (.script | endswith(\"/sw.js\"))"
    pw_js "service worker: caches after activation" '{}' 'async (page) => JSON.stringify(await page.evaluate(async () => {
      const out = {}; for (const n of await caches.keys()) { const c = await caches.open(n); out[n] = (await c.keys()).map((r) => new URL(r.url).pathname); } return out; }))'
    if [ "$WEB_OK" = 1 ]; then
      jchk "service worker: the precache is filled ($SW_COUNT entries listed, all of them in Cache Storage)" "$PW_OUT" "(keys | length) >= 1 and ([.[]] | flatten | length) >= $SW_COUNT"
    fi
    pw reload >/dev/null
    pw_js "service worker: controls the page after a reload" '{}' 'async (page) => JSON.stringify(await page.evaluate(() => ({ controlled: !!navigator.serviceWorker.controller })))'
    [ "$WEB_OK" = 1 ] && jchk "service worker: the page is controlled by it (an offline load will be answered by it)" "$PW_OUT" '.controlled == true'
    pw_js "installability: Chrome's own verdict" '{}' 'async (page) => {
      try {
        const c = await page.context().newCDPSession(page);
        const r = await c.send("Page.getInstallabilityErrors");
        const m = await c.send("Page.getAppManifest");
        return JSON.stringify({ ok: true, errs: r.installabilityErrors.map((e) => e.errorId), manifestUrl: m.url, manifestErrors: m.errors });
      } catch (e) { return JSON.stringify({ ok: false, why: String(e) }); } }'
    if [ "$WEB_OK" = 1 ]; then
      if jq -e '.ok == false' >/dev/null <<<"$PW_OUT"; then blocked "installability: Chrome's installability verdict" "the CDP call is not available: $(jq -r .why <<<"$PW_OUT")"
      else
        jchk "installability: the browser parsed the manifest ($STACK_URL/manifest.webmanifest) with no manifest error" "$PW_OUT" ".manifestUrl == \"$STACK_URL/manifest.webmanifest\" and (.manifestErrors | length) == 0"
        # the profile is in-memory (incognito-like), so 'in-incognito' is the one error that is about the test browser, not the app
        jchk "installability: Chrome reports no installability error (only 'in-incognito' is about the test profile): $(jq -c .errs <<<"$PW_OUT")" "$PW_OUT" '(.errs - ["in-incognito"]) | length == 0'
      fi
    fi
  fi

  # --- C. an onboarded player, online: Download today's session -------------------------------------------------------------
  if [ "$WEB_OK" = 1 ]; then
    pw_js "onboarding: the player signs in anonymously and starts (real endpoints, called from the page)" '{}' 'async (page) => {
      const post = (p, b) => page.evaluate(async ([p, b]) => { const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return r.status; }, [p, b]);
      const u = (c) => c.repeat(8) + "-" + c.repeat(4) + "-4" + c.repeat(3) + "-8" + c.repeat(3) + "-" + c.repeat(12);
      const a = await post("/api/auth/sign-in/anonymous", {});
      const s = await post("/api/player/start", { profile: { age: 12, level: "basic", goal: "weakfoot", equipment: "ball_wall", space: "yard", partner: false, daysPerWeek: 3, minutesPerSession: 20, locale: "en" },
        baseline: [{ testSlug: "juggling-max-touches", value: 15, clientUuid: u("1") }, { testSlug: "wall-passing-60s", value: 30, clientUuid: u("2") }, { testSlug: "ball-mastery-30s", value: 40, clientUuid: u("3") },
          { testSlug: "weak-foot-passes", value: 4, clientUuid: u("4") }, { testSlug: "slalom-time", value: 0, skipped: true, clientUuid: u("5") }] });
      return JSON.stringify({ signIn: a, start: s }); }'
    [ "$WEB_OK" = 1 ] && jchk "onboarding: anonymous sign-in 200 and POST /api/player/start 200" "$PW_OUT" '.signIn == 200 and .start == 200'
  fi
  COOKIE="" PID="" TODAY=""
  if [ "$WEB_OK" = 1 ]; then
    COOKIE=$(pw cookie-list | jq -r '.result // ""' | sed -nE 's/^(better-auth\.session_token=[^ ]+) .*/\1/p' | head -n1)
    if [ -n "$COOKIE" ]; then pass "the browser holds the player's session cookie"; else fail "the browser holds the player's session cookie"; fi
    PID=$(sqlite_scalar "SELECT player_id FROM player_profiles")
    assert_eq "$(sqlite_count player_profiles)" 1 "db: exactly 1 player profile (the onboarded player)"
    # the server's own session: the truth the device copy and every offline text are compared with
    fetch "$COOKIE" GET '/api/player/today?locale=en'
    TODAY=$F_BODY
    chk "api: GET /api/player/today composes today's session (the truth for the offline checks)" 200 '(.items | length) >= 2 and .planner == "rules"'
  fi
  ND=$(jq '.items | length' <<<"${TODAY:-$EMPTY_JSON}" 2>/dev/null || echo 0)
  SESSION_ID=$(jq -r '.id // ""' <<<"${TODAY:-$EMPTY_JSON}" 2>/dev/null)
  ITEM_IDS=$(jq -c '[.items[].itemId]' <<<"${TODAY:-$EMPTY_JSON}" 2>/dev/null || echo '[]')
  TITLES=$(jq -c '[.items[].content.title.en]' <<<"${TODAY:-$EMPTY_JSON}" 2>/dev/null || echo '[]')
  # every text of every drill, in the UI's own English wording: title, goal, steps (numbers stripped), mistakes, safety, easier, harder
  PHRASES=$(jq -c '[.items[] | .content | [(.title.en // empty), (.goal.en // empty),
      ((.instructions.en // "") | split("\n")[] | sub("^[0-9]+\\. *"; "") | select(length > 0)),
      ((.mistakes // [])[] | .en // empty), ((.safety // [])[] | .en // empty), ((.progressions // [])[] | .en // empty), ((.regressions // [])[] | .en // empty)]]' <<<"${TODAY:-$EMPTY_JSON}" 2>/dev/null || echo '[]')

  if [ "$WEB_OK" = 1 ] && [ "$ND" -ge 2 ]; then
    pw_js "/train online: today's session lists the drills" "{\"n\": $ND}" 'async (page, A) => {
      await page.goto(origin() + "/train");
      await page.locator("main ol > li").first().waitFor();
      await page.getByText("Available offline").or(page.getByRole("button", { name: "Download today\x27s session" })).first().waitFor();
      await page.waitForTimeout(1500);
      const rows = await page.locator("main ol > li").count();
      const banner = await page.getByText("You are offline").count();
      const prompt = await page.getByText("New version available").count();
      const footer = await page.locator("footer").innerText();
      return JSON.stringify({ rows, banner, prompt, footer, main: await page.locator("main").innerText() }); }'
    if [ "$WEB_OK" = 1 ]; then
      jchk "/train online: $ND drills are listed, like the API's session" "$PW_OUT" ".rows == $ND"
      jchk "/train online: no offline banner while online, and no update prompt while the running build is the served one" "$PW_OUT" '.banner == 0 and .prompt == 0'
      jchk "footer (before the deploy): 'Version $V1' (GET /health)" "$PW_OUT" ".footer | contains(\"Version $V1\")"
      pw_js "persisted query cache: what the app saved in IndexedDB" '{}' 'async (page) => {
        let v = {}; for (let i = 0; i < 20; i++) { v = await idbAll(); if (Object.keys(v).some((k) => k.endsWith(":query-cache"))) break; await page.waitForTimeout(300); }
        const k = Object.keys(v).find((x) => x.endsWith(":query-cache"));
        const blob = k ? v[k] : null;
        return JSON.stringify({ key: k || null, buster: blob && blob.buster, mutations: blob && blob.clientState.mutations.length, queryKeys: blob ? blob.clientState.queries.map((q) => q.queryKey[0]) : [] }); }'
      if [ "$WEB_OK" = 1 ]; then
        jchk "persisted cache: fc:<playerId>:query-cache exists for THIS player, its buster is the build version $V1, it holds 'today' and no mutation, and only allow-listed keys ($(jq -c .queryKeys <<<"$PW_OUT"))" "$PW_OUT" \
          ".key == \"fc:$PID:query-cache\" and .buster == \"$V1\" and .mutations == 0 and (.queryKeys | index(\"today\")) != null and all(.queryKeys[]; IN(\"today\",\"me\",\"journey\",\"onboarding\",\"commons\"))"
      fi
    fi

    pw_js "download: Download today's session, then the badge" '{}' 'async (page) => {
      const btn = page.getByRole("button", { name: "Download today\x27s session" });
      const before = await btn.isEnabled();
      await btn.click();
      await page.getByText("Available offline").waitFor();
      return JSON.stringify({ before, region: await page.locator("[data-slot=today]").innerText() }); }' 15000
    if [ "$WEB_OK" = 1 ]; then
      jchk "download: the button was offered and pressing it shows the 'Available offline' badge" "$PW_OUT" '.before == true and (.region | contains("Available offline"))'
      jchk "download: the badge shows a last-synced time ('Last synced: <date>, <time>')" "$PW_OUT" '.region | test("Last synced: [A-Z][a-z]{2} [0-9]{1,2}, 20[0-9]{2}, [0-9]{1,2}:[0-9]{2}")'
      pw_js "device: what the download stored" '{}' 'async (page) => JSON.stringify(await page.evaluate(() => {
        const out = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("fc:")) out[k] = localStorage.getItem(k); } return out; }))'
      if [ "$WEB_OK" = 1 ]; then
        REC=$(jq -c --arg k "fc:$PID:session" '.[$k] | fromjson? // empty' <<<"$PW_OUT")
        now=$(date -u +%s)
        jchk "device: the offline session is stored under fc:<playerId>:session for this player and is exactly the server's session ($ND drills, id $SESSION_ID)" "${REC:-$EMPTY_JSON}" \
          ".playerId == \"$PID\" and .session.id == \"$SESSION_ID\" and (.session.items | length) == $ND and .locale == \"en\""
        dl=$(jq -r '.downloadedAt // ""' <<<"${REC:-$EMPTY_JSON}"); dls=$(date -u -d "$dl" +%s 2>/dev/null || echo 0)
        if [ "$dls" -gt 0 ] && [ $((now - dls)) -ge -5 ] && [ $((now - dls)) -le 300 ]; then pass "device: downloadedAt ($dl) is the time of this download"
        else fail "device: downloadedAt is the time of this download" "  downloadedAt='$dl' now=$(date -u +%FT%TZ)"; fi
      fi
    fi

    # --- D1. offline: a RELOAD still renders --------------------------------------------------------------------------------
    if [ "$WEB_OK" = 1 ]; then
      pw_js "offline reload of /train" "{\"titles\": $TITLES}" 'async (page, A) => {
        await goOffline();
        let navError = null;
        try { await page.reload(); } catch (e) { navError = String(e).split("\n")[0]; }
        if (navError) return JSON.stringify({ navError });
        await page.getByRole("heading", { level: 1 }).first().waitFor().catch(() => {});
        let listSeen = true; await page.locator("main ol > li").first().waitFor({ timeout: 6000 }).catch(() => { listSeen = false; });
        const main = await page.locator("main").innerText().catch(() => "");
        return JSON.stringify({ shell: await page.evaluate(() => document.querySelector("#root").children.length > 0), listSeen, missingTitles: missing(main, A.titles), badge: /Available offline/.test(main), main: main.slice(0, 500), path: page.url().replace(/^https?:\/\/[^\/]+/, "").split(/[?#]/)[0], device: { queryCache: Object.keys(await idbAll().catch(() => ({}))).some((k) => k.endsWith(":query-cache")), session: await page.evaluate(() => Object.keys(localStorage).some((k) => /^fc:.*:session$/.test(k))) } }); }' 30000
      if [ "$WEB_OK" = 1 ]; then
        jchk "offline reload: the app shell is served by the service worker (the page loads with no network and the React app mounts)" "$PW_OUT" '.navError == null and .shell == true'
        jchk "offline reload: /train renders today's session (every drill title) and the 'Available offline' badge" "$PW_OUT" '.listSeen == true and (.missingTitles | length) == 0 and .badge == true'
        jchk "offline: /train still opens with the network down — the gate answers from the cached session, it never waits for get-session" "$PW_OUT" '.navError == null and .path == "/train"'
        jchk "offline: the remembered player (localStorage fc:last-player) is never redirected to sign-in" "$PW_OUT" '.path != "/account/sign-in"'
        [ "$(jq -r '.listSeen // false' <<<"$PW_OUT")" = true ] || echo "  observed offline /train (first 500 chars): $(jq -r '.main // .navError' <<<"$PW_OUT" | tr '\n' '|'); on the device at that moment: persisted query cache=$(jq -r '.device.queryCache' <<<"$PW_OUT"), downloaded session=$(jq -r '.device.session' <<<"$PW_OUT")" >&2
      fi
    fi
    WEB_OK=1
    if [ "$ND" -ge 1 ]; then
      first_id=$(jq -r '.[0]' <<<"$ITEM_IDS"); first_phrases=$(jq -c '.[0]' <<<"$PHRASES")
      pw_js "offline load of the drill player URL" "{\"id\": \"$first_id\", \"phrases\": $first_phrases}" 'async (page, A) => {
        await page.context().setOffline(true);
        let navError = null;
        try { await page.goto(origin() + "/train/drill/" + A.id); } catch (e) { navError = String(e).split("\n")[0]; }
        if (navError) return JSON.stringify({ navError });
        await page.getByRole("heading", { level: 1 }).first().waitFor().catch(() => {});
        let drillSeen = true; await page.getByText(/Drill 1 of/i).first().waitFor({ timeout: 6000 }).catch(() => { drillSeen = false; });
        const main = await page.locator("main").innerText().catch(() => "");
        return JSON.stringify({ drillSeen, missing: missing(main, A.phrases), main: main.slice(0, 400), path: page.url().replace(/^https?:\/\/[^\/]+/, "").split(/[?#]/)[0] }); }' 30000
      if [ "$WEB_OK" = 1 ]; then
        jchk "offline reload of /train/drill/$first_id: the drill player renders with ALL of the drill's text (title, goal, steps, mistakes, safety, easier, harder)" "$PW_OUT" '.navError == null and .drillSeen == true and (.missing | length) == 0'
        jchk "offline: /train/drill/$first_id opens from the cache with the same rule" "$PW_OUT" ".navError == null and .path == \"/train/drill/$first_id\""
        [ "$(jq -r '.drillSeen // false' <<<"$PW_OUT")" = true ] || echo "  observed offline drill page (first 400 chars): $(jq -r '.main // .navError' <<<"$PW_OUT" | tr '\n' '|')" >&2
      fi
    fi
    WEB_OK=1

    # --- D2. offline: the whole session, without a reload -------------------------------------------------------------------
    pw_js "back online for a moment: /train opened, the player wired" '{}' 'async (page) => {
      await goOnline();
      await page.goto(origin() + "/train");
      await page.locator("main ol > li").first().waitFor();
      await page.getByText("Available offline").waitFor();
      await page.waitForTimeout(1500);
      await goOffline();
      await page.getByText("You are offline — training still works").waitFor();
      return "ok"; }' 30000
    if [ "$WEB_OK" = 1 ]; then
      SINCE_OFF=$(last_request_index); SINCE_OFF=${SINCE_OFF:-0}
      pw_js "offline: open every drill from the list, check its text, press Done" "{\"n\": $ND, \"phrases\": $PHRASES}" 'async (page, A) => {
        const res = [];
        for (let i = 0; i < A.n; i++) {
          if (i === 0) await page.locator("main ol a").first().click(); else await page.getByRole("link", { name: "Next drill" }).click();
          await page.waitForURL("**/train/drill/**");
          await page.getByText(new RegExp("Drill " + (i + 1) + " of " + A.n, "i")).first().waitFor();
          const main = await page.locator("main").innerText();
          await page.getByRole("button", { name: "Done", exact: true }).click();
          await page.getByRole("button", { name: "Undo" }).waitFor();
          res.push({ i: i + 1, missing: missing(main, A.phrases[i]), alerts: await page.locator("[role=alert]").count() });
        }
        await page.getByRole("link", { name: "Back to today\x27s session" }).click();
        await page.waitForURL("**/train");
        await page.getByText(/Saved on this device/).first().waitFor({ timeout: 10000 });
        const today = await page.locator("main").innerText();
        return JSON.stringify({ res, allDone: /All drills done/.test(today), pending: (today.replace(/[\s ]+/g, " ").match(/Saved on this device . will sync: ([0-9]+)/) || [])[1] || null, progress: norm(today).includes(A.n + "/" + A.n + " completed") }); }' 60000
      if [ "$WEB_OK" = 1 ]; then
        jchk "offline: each of the $ND drills opens from the device and shows ALL of its text, Done is accepted with no error" "$PW_OUT" '(.res | length) == '"$ND"' and all(.res[]; (.missing | length) == 0 and .alerts == 0)'
        jchk "offline: every drill is done ($ND/$ND completed) and the session can be finished" "$PW_OUT" '.allDone == true and .progress == true'
        jchk "offline: 'Saved on this device — will sync' is shown with $ND waiting" "$PW_OUT" ".pending == \"$ND\""
        pw_js "offline: finish the session" '{}' 'async (page) => {
          await page.getByRole("button", { name: "Finish session" }).click();
          await page.waitForURL("**/train/summary");
          await page.getByRole("heading", { name: "Session complete" }).waitFor();
          const summary = await page.locator("main").innerText();
          await page.goBack();
          await page.waitForURL("**/train");
          await page.getByText(/Saved on this device/).first().waitFor({ timeout: 10000 });
          const today = (await page.locator("[data-slot=today]").innerText()).replace(/[\s ]+/g, " ");
          const v = await idbAll(); const k = Object.keys(v).find((x) => x.endsWith(":outbox"));
          return JSON.stringify({ summary, pending: (today.match(/Saved on this device . will sync: ([0-9]+)/) || [])[1] || null, outbox: k ? v[k] : [] }); }' 30000
        if [ "$WEB_OK" = 1 ]; then
          OUTBOX=$(jq -c '.outbox' <<<"$PW_OUT")
          jchk "offline: Finish session works with no network and the summary renders ('Session complete', drills $ND of $ND)" "$PW_OUT" ".summary | test(\"Session complete\") and test(\"Drills completed\") and test(\"$ND\")"
          jchk "offline: back on /train 'Saved on this device — will sync: $((ND + 1))' ($ND drills + the finish)" "$PW_OUT" ".pending == \"$((ND + 1))\""
          jchk "offline: the outbox on the device holds $ND drill_done + 1 session_finished, one distinct clientUuid each, all for session $SESSION_ID" "$OUTBOX" \
            "length == $((ND + 1)) and ([.[].clientUuid] | unique | length) == $((ND + 1)) and ([.[].event.type] | map(select(. == \"drill_done\")) | length) == $ND and ([.[].event.type] | map(select(. == \"session_finished\")) | length) == 1 and all(.[]; .event.sessionId == \"$SESSION_ID\" and .playerId == \"$PID\")"
          calls=$(api_calls "$SINCE_OFF"); ok_events=$(grep -c '^POST /api/player/session-events [0-9]' <<<"$calls")
          assert_eq "$ok_events" 0 "offline: no session-events request succeeded while the context was offline (attempts: $(grep -c '^POST /api/player/session-events' <<<"$calls"))"
          assert_eq "$(sqlite_count session_events)" 0 "db: the server has received no event yet (everything is on the device)"
        fi
      fi
    fi

    # --- E. back online: one replay ------------------------------------------------------------------------------------------
    if [ "$WEB_OK" = 1 ]; then
      SINCE_ON=$(last_request_index); SINCE_ON=${SINCE_ON:-0}
      pw_js "back online: the outbox replays by itself" '{}' 'async (page) => {
        await goOnline();
        let banner = true; await page.getByText("Back online — syncing").waitFor({ timeout: 8000 }).catch(() => { banner = false; });
        let drained = true; await page.waitForFunction(() => !document.body.innerText.includes("Saved on this device"), null, { timeout: 20000 }).catch(() => { drained = false; });
        await page.waitForTimeout(3000);
        const v = await idbAll(); const k = Object.keys(v).find((x) => x.endsWith(":outbox"));
        const today = await page.locator("main").innerText();
        return JSON.stringify({ banner, drained, left: k ? v[k].length : 0, done: /All drills done/.test(today) }); }' 40000
      if [ "$WEB_OK" = 1 ]; then
        jchk "back online: 'Back online — syncing' is announced, the pending notice goes away and the device outbox is empty" "$PW_OUT" '.banner == true and .drained == true and .left == 0'
        calls=$(api_calls "$SINCE_ON"); posts=$(grep -c '^POST /api/player/session-events' <<<"$calls")
        summary=$(tr '\n' ';' <<<"$calls" | sed 's/;/; /g')
        if [ "$posts" -eq "$J7_CALL_BUDGET" ]; then pass "back online: the outbox replayed in $posts POST /api/player/session-events call (observed /api calls: $summary)"
        else fail "back online: the outbox replays in $J7_CALL_BUDGET API call (N offline results sync in 1 call), got $posts" "  observed /api calls since the online switch (get-session reads not counted): ${summary:-none}"; fi
        assert_eq "$(grep -c '^POST /api/player/session-events 200' <<<"$calls")" "$posts" "back online: every replay call was answered 200"
        assert_eq "$(sqlite_count session_events "player_id = '$PID'")" "$((ND + 1))" "db: session_events holds exactly one set of events ($ND drill_done + 1 session_finished)"
        assert_eq "$(sqlite_scalar "SELECT COUNT(DISTINCT client_uuid) FROM session_events WHERE player_id = '$PID'")" "$((ND + 1))" "db: every event has its own clientUuid (no duplicate row)"
        assert_eq "$(sqlite_count session_events "player_id = '$PID' AND type = 'drill_done'"),$(sqlite_count session_events "player_id = '$PID' AND type = 'session_finished'")" "$ND,1" "db: $ND drill_done and 1 session_finished"
        assert_eq "$(sqlite_scalar "SELECT finished_at IS NOT NULL FROM sessions WHERE player_id = '$PID'")" 1 "db: the session is finished on the server"
        # the very same batch, again, with curl: idempotent by clientUuid
        BATCH=$(jq -c '{events: [.[].event]}' <<<"$OUTBOX")
        fetch "$COOKIE" POST /api/player/session-events "$BATCH"
        chk "re-post of the same batch with curl: 200, the session is all done, 1 session completed" 200 '(.session.items | all(.[]; .done == true)) and .progress.sessionsCompleted == 1'
        assert_eq "$(sqlite_count session_events "player_id = '$PID'")" "$((ND + 1))" "db: the curl re-post added no event (still $((ND + 1)))"
        fetch "$COOKIE" POST /api/player/session-events "$BATCH"
        assert_eq "$(sqlite_count session_events "player_id = '$PID'"),$(sqlite_scalar "SELECT COUNT(*) FROM sessions WHERE player_id = '$PID'")" "$((ND + 1)),1" "db: a second re-post changes nothing (still $((ND + 1)) events, 1 session)"
      fi
    fi

    # --- E2. Cache Storage after the whole journey: nothing but the precache -----------------------------------------------------
    if [ "$WEB_OK" = 1 ]; then
      pw_js "caches after the journey" '{}' 'async (page) => JSON.stringify(await page.evaluate(async () => {
        const out = {}; for (const n of await caches.keys()) { const c = await caches.open(n); out[n] = (await c.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search); } return out; }))'
      if [ "$WEB_OK" = 1 ]; then
        jchk "Cache Storage after the journey: only precache caches (no runtime cache): $(jq -c 'keys' <<<"$PW_OUT")" "$PW_OUT" 'keys | all(.[]; startswith("workbox-precache"))'
        jchk "Cache Storage after the journey: no /api response is cached" "$PW_OUT" '[.[][]] | map(select(test("^/(api|health)(/|$)"))) | length == 0'
        jchk "Cache Storage after the journey: no video and no pose model is cached" "$PW_OUT" '[.[][]] | map(select(test("\\.(mp4|webm|mov|task|tflite|onnx|wasm)($|\\?)|pose|mediapipe|landmark"; "i"))) | length == 0'
      fi
    fi

    # --- F. a new build is deployed --------------------------------------------------------------------------------------------
    if [ "$WEB_OK" = 1 ]; then
      SW1_SUM=$(sha256sum "$scratch/sw.js" | cut -c1-16)
      # the deploy: the same API process image, DB and port restarted with the new BUILD_VERSION serving the new web build
      _e2e_kill "$E2E_API_PID"; unset E2E_API_PID
      export BUILD_VERSION=$V2
      E2E_WEB_DIST_USED=$DIST2
      _e2e_launch_api "$E2E_API_PORT_USED"
      if _e2e_wait_api "$E2E_API_PID" "$E2E_TMP/api.log" "$E2E_API_PORT_USED"; then pass "deploy: the API restarted on the same DB and port with BUILD_VERSION=$V2 serving the new build"
      else fail "deploy: the API restarted with BUILD_VERSION=$V2"; WEB_OK=0; fi
    fi
    if [ "$WEB_OK" = 1 ]; then
      assert_api /health ".version == \"$V2\" and .database == \"ok\"" -l "deploy: /health now reports $V2"
      SW2_SUM=$(curl -s --max-time "$E2E_HTTP_TIMEOUT" "$STACK_URL/sw.js" | sha256sum | cut -c1-16)
      if [ "$SW1_SUM" != "$SW2_SUM" ]; then pass "deploy: the new /sw.js differs from the old one (the browser can see the update)"; else fail "deploy: the new /sw.js differs from the old one" "  same checksum $SW1_SUM"; fi
      assert_eq "$(sqlite_count session_events "player_id = '$PID'")" "$((ND + 1))" "deploy: the DB survived the restart (still $((ND + 1)) events)"
      pw_js "new build: the open app finds the update" "{\"v1\": \"$V1\", \"v2\": \"$V2\"}" 'async (page, A) => {
        await page.goto(origin() + "/train");
        await page.getByText("New version available").waitFor({ timeout: 25000 });
        const t0 = await page.evaluate(() => performance.timeOrigin);
        const prompt = await page.locator("[role=status]").filter({ hasText: "New version available" }).innerText();
        const footerBefore = await page.locator("footer").innerText();
        await page.waitForTimeout(3000);
        const t1 = await page.evaluate(() => performance.timeOrigin);
        const updateBtn = await page.getByRole("button", { name: "Update", exact: true }).isEnabled();
        const later = await page.getByRole("button", { name: "Later", exact: true }).count();
        const entryBefore = await page.evaluate(() => { const s = document.querySelector("script[type=module]"); return s ? s.src.replace(/^.*\//, "") : null; });
        return JSON.stringify({ prompt, footerBefore, sameDocument: t0 === t1, updateBtn, later, t0, entryBefore }); }' 40000
      if [ "$WEB_OK" = 1 ]; then
        T0=$(jq -r .t0 <<<"$PW_OUT")
        ENTRY_BEFORE=$(jq -r '.entryBefore // empty' <<<"$PW_OUT")
        jchk "new build: the app shows 'New version available' with an Update button (and Later) and names the running version $V1" "$PW_OUT" ".updateBtn == true and .later == 1 and (.prompt | contains(\"New version available\")) and (.prompt | contains(\"$V1\"))"
        jchk "new build: the prompt does not reload the page by itself (same document 3 s later)" "$PW_OUT" '.sameDocument == true'
        if jq -e ".footerBefore | contains(\"Version $V2\")" >/dev/null <<<"$PW_OUT"; then echo "  note: the footer already reads $V2 while the prompt is up (it shows the API's BUILD_VERSION from GET /health, not the bundle's)"; else echo "  note: the footer still reads $V1 while the prompt is up"; fi
        pw_js "new build: accept the update" "{\"v1\": \"$V1\", \"v2\": \"$V2\", \"t0\": $T0}" 'async (page, A) => {
          await page.getByRole("button", { name: "Update", exact: true }).click();
          await page.waitForFunction((t) => performance.timeOrigin !== t, A.t0, { timeout: 25000 });
          await page.getByRole("heading", { level: 1 }).first().waitFor();
          let footerV2 = true; await page.waitForFunction((v) => { const f = document.querySelector("footer"); return !!f && f.innerText.includes("Version " + v); }, A.v2, { timeout: 15000 }).catch(() => { footerV2 = false; });
          const footer = await page.locator("footer").innerText();
          const promptLeft = await page.getByText("New version available").count();
          const entrySrc = await page.evaluate(() => { const s = document.querySelector("script[type=module]"); return s ? s.src.replace(/^.*\//, "") : null; });
          const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { active: r && r.active && r.active.state, waiting: !!(r && r.waiting), controller: !!navigator.serviceWorker.controller }; });
          await page.getByText("Available offline").or(page.getByRole("button", { name: "Download today\x27s session" })).first().waitFor();
          const badge = await page.getByText("Available offline").count();
          let buster = null; for (let i = 0; i < 25 && buster !== A.v2; i++) { const v = await idbAll(); const k = Object.keys(v).find((x) => x.endsWith(":query-cache")); buster = k ? v[k].buster : null; if (buster !== A.v2) await page.waitForTimeout(400); }
          return JSON.stringify({ footerV2, footer, promptLeft, entrySrc, sw, badge, buster }); }' 90000
        if [ "$WEB_OK" = 1 ]; then
          jchk "new build: after Update the page reloaded and the footer reads 'Version $V2' (it read $V1 before the deploy)" "$PW_OUT" '.footerV2 == true'
          if [ -n "$ENTRY_BEFORE" ]; then pass "new build: the entry script before Update was captured ($ENTRY_BEFORE)"; else fail "new build: the entry script before Update was captured" "  no script[type=module] on the page before Update"; fi
          jchk "new build: the bundle that runs after Update is the new build (footer shows $V2 and not $V1, cache-buster is $V2, entry script differs from the pre-update $ENTRY_BEFORE, the prompt is gone)" "$PW_OUT" \
            ".footerV2 == true and (.footer | contains(\"Version $V2\")) and ((.footer | contains(\"Version $V1\")) | not) and .buster == \"$V2\" and (.entrySrc | type) == \"string\" and .entrySrc != \"\" and .entrySrc != \"$ENTRY_BEFORE\" and .promptLeft == 0"
          jchk "new build: the new service worker is active and in control, none is left waiting" "$PW_OUT" '.sw.active == "activated" and .sw.controller == true and .sw.waiting == false'
          jchk "new build: the device still holds today's downloaded session (the 'Available offline' badge)" "$PW_OUT" '.badge == 1'
          jchk "new build: the persisted query cache is re-stamped with the new build version $V2 (buster tied to BUILD_VERSION)" "$PW_OUT" ".buster == \"$V2\""
        fi
      fi
    fi
  fi
fi

if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 0 ]; then _e2e_err "NOTE: a browser step failed to run; the browser steps that depend on it were not run (the first FAIL above is the cause)"; fi
# no explicit stop or summary: the EXIT handler stops the stack, prints the summary, sets the exit code
