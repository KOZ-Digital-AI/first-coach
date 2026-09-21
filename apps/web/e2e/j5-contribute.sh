#!/usr/bin/env bash
# apps/web/e2e/j5-contribute.sh: slice gate fc-mol-uw7, journey J5 "a coach contributes a method and follows its review".
# Integration proof on the REAL stack (real API process, real SQLite file with the real seed, the real built web app served by
# the API, a real browser; nothing mocked, no OpenAI key needed):
#   A. PLAYER  an anonymous PLAYER (a real player session, made by pressing START TRAINING) opens Contribute and is sent to
#              /account/sign-in?redirect=%2Fcontribute, sees no form, and the API refuses that player's POST with 403.
#   B. COACH   a fresh visitor presses CONTRIBUTE on the landing page, is asked to sign in, creates a coach account with a display
#              name, email and password (the real UI), comes back to /contribute and fills the CONTRIBUTE A METHOD form: name, sport,
#              skill, age range, difficulty, goal, instructions, duration, equipment, common mistakes, progression, regression,
#              safety, a small real mp4, source, author. Pressing "Send for review" with only the second attestation ticked shows a
#              field error on the rights attestation and sends nothing; ticking both submits. The thank-you state reads 'Your
#              contribution will become part of the Open Sport Commons after review.' The non-auth /api calls of the submission are
#              counted (<= 2: the form's meta read and the one multipart POST).
#   C. DB      sqlite_count: 1 contribution, state pending, kind new, the coach as submitter; 1 video attachment whose file is under
#              MEDIA_DIR and is byte-identical to the uploaded mp4. My contributions (/contribute/mine) lists it as Pending with
#              Withdraw and without "Edit and resubmit".
#   D. HIDDEN  the pending drill is NOT in /api/commons/drills, the export, the drills table, and NOT in any session: a player whose
#              roadmap targets exactly this skill, equipment and age gets a composed session that does not contain it. Its video is
#              private (a stranger gets 404).
#   E. SUGGEST from a drill detail page 'Suggest improvement' (a dialog) posts an improvement contribution (kind improvement, the
#              drill as target, improvement kind, a video) that is pending too.
#   F. WITHDRAW through My contributions (confirm dialog) the improvement becomes Withdrawn, its attachment row and its file are
#              deleted, and the first contribution (and its file) is untouched.
#   G. API     a second coach (email sign-up over the API) proves the server side: no cookie 401, anonymous player 403, a missing
#              rights attestation 422 pointer /rightsAttested with nothing left on disk, a filled honeypot 422 /website, and
#              someone else's contribution is 404 to withdraw.
# Exit codes (lib.sh): 0 every check passed, 1 at least one FAIL, 3 nothing failed but a check was BLOCKED (no browser, E2E_WEB=off,
# no playwright-cli); E2E_ALLOW_BLOCKED=1 keeps a blocked-only run at 0. BLOCKED is never counted as a pass.
#
# Readings of the criteria where they are open (each is one line of the script):
#   * "presses CONTRIBUTE": the landing page's CONTRIBUTE button (the second, secondary button of the hero; the header navigation
#     has the same link, the landing button is the one a visitor presses first).
#   * "the form submission costs <= 2 API calls": every /api/* request the browser makes from the click on the sign-up button
#     (the coach's account) to the thank-you state, except everything under /api/auth/ (sign-up, the session READS: Better Auth,
#     no contribution data; the same reading as j2's, which leaves out get-session). What remains is the form's own reads and
#     the write, listed in the failure detail; the contract's budget is meta + create. Exactly one GET /api/contribute/meta and
#     exactly one POST /api/contributions (201) are asserted as well.
#   * "signs up with email and password": through the sign-up screen (display name, email, password >= 10 characters).
#   * "attaches a small real mp4": generated here with ffmpeg (a 1 s 64x64 H.264 clip) when ffmpeg exists, else a minimal valid
#     ISO base media byte sequence (ftyp isom, free, mdat); nothing is committed. Either passes the server's magic-byte check.
#   * "ticks both attestations": the rights attestation and 'not FIFA, UEFA or commercial content'. The FIELD ERROR check ticks only
#     the second one, so the error is attributable to the missing rights attestation alone.
#   * "the video file present under MEDIA_DIR": the stored file (contribution_attachments.stored_path) exists in the run's
#     MEDIA_DIR, has the row's byte count, and is byte-identical to the file the browser uploaded (cmp).
#   * "not in any session": a real player (API onboarding: age 12, level basic, goal weak foot, Ball + wall) whose roadmap points
#     at the skill of the contribution gets today's session composed after the contribution exists; neither the session answer nor
#     the stored sessions rows contain the contribution's name.
#   * "Suggest improvement ... targeting that drill": the contribution's kind is improvement, its target_drill_id is the drills.id of
#     the drill page it was made on, and the improvement kind is the one chosen in the dialog.
#   * "withdrawing a pending contribution": done to the improvement (it has its own video), so both the withdrawn row and a
#     deleted file are asserted while the first contribution stays pending with its file.
# Fail-slow (no set -e): every step reports. Cleanup: e2e_defer (never `trap ... EXIT` after sourcing lib.sh).
# Ports: the API gets a free kernel-assigned port (lib.sh start_stack); nothing is ever bound to :4111 or :5173 and no process this
# script did not start is touched. The browser session name is unique per run (E2E_SESSION).
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
: "${E2E_SESSION:=j5-$$-$RANDOM}"
source "$HERE/lib.sh"

J5_CALL_BUDGET=2
SPORT=football
SKILL=weak-foot          # the roadmap skill of a weak-foot player (j2 pins roadmap.focus[0].skill == "weak-foot")
THANKS='Your contribution will become part of the Open Sport Commons after review.'
unset SEED_DIR   # the API must start on the repo's default seed

scratch=$(mktemp -d "${TMPDIR:-/tmp}/j5-gate.XXXXXX") || exit 1
e2e_defer 'rm -rf -- "$scratch"'
TOKEN="j5x${$}x${RANDOM}"                                   # unique per run, in every name this run creates
METHOD_NAME="Weak foot wall rebounds $TOKEN"
COACH_NAME="Aidar Coachov"
COACH_EMAIL="coach-$TOKEN@example.com"
COACH_PASSWORD="correct-horse-battery-9"
MP4="$scratch/wall-rebounds-demo.mp4"

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
fetch_mp() { # <cookie | -> <METHOD> <path> <payload json> [video file]: a multipart request (payload part + optional video part)
  local cookie=$1 method=$2 path=$3 payload=$4 video=${5-} args
  args=(-s --max-time "$E2E_HTTP_TIMEOUT" -X "$method" -D "$scratch/f.hdr" -o "$scratch/f.body" -w '%{http_code}')
  args+=(-H "Origin: $API_URL" --form-string "payload=$payload")
  [ "$cookie" = - ] || args+=(-H "Cookie: $cookie")
  [ -z "$video" ] || args+=(-F "video=@$video;type=video/mp4")
  F_CODE=$(curl "${args[@]}" "$API_URL$path" 2>/dev/null) || F_CODE=000
  F_BODY=$(cat "$scratch/f.body" 2>/dev/null)
  F_HDRS=$(tr -d '\r' <"$scratch/f.hdr" 2>/dev/null)
}
chk() { # <label> <status> <jq expression on F_BODY>
  if [ "$F_CODE" != "$2" ]; then fail "$1" "  HTTP $F_CODE (wanted $2): ${F_BODY:0:800}"; return 1; fi
  if jq -e "$3" >/dev/null 2>&1 <<<"$F_BODY"; then pass "$1"; else fail "$1" "  jq -e '$3' was false or failed"$'\n'"  HTTP $F_CODE payload: ${F_BODY:0:1800}"; fi
}
cookie_of() { grep -i '^set-cookie: *[^;]*session_token=' <<<"$F_HDRS" | head -n1 | sed -E 's/^[^:]*: *//; s/;.*//'; }
sign_in() { # <label>: an anonymous visitor over the API (sets V_COOKIE, V_ID)
  local label=$1
  V_COOKIE="" V_ID=""
  fetch - POST /api/auth/sign-in/anonymous '{}'
  V_COOKIE=$(cookie_of)
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
js_str() { jq -Rn --arg s "$1" '$s'; }                      # a bash string as a JavaScript string literal
media_files() { find "$MEDIA_DIR" -type f 2>/dev/null | wc -l | tr -d ' '; }

# gen_mp4 <path>: a small real mp4. ffmpeg when it can make one, else a minimal valid ISO base media byte sequence.
gen_mp4() {
  MP4_SOURCE=""
  if command -v ffmpeg >/dev/null 2>&1; then
    local codec
    for codec in libx264 mpeg4; do
      if ffmpeg -nostdin -v error -y -f lavfi -i testsrc=size=64x64:rate=10 -t 1 -pix_fmt yuv420p -c:v "$codec" -movflags +faststart "$1" </dev/null >/dev/null 2>&1 && [ -s "$1" ]; then
        MP4_SOURCE="ffmpeg $codec"; return 0
      fi
    done
  fi
  # ftyp(isom, minor 0x200, isom+mp41) + free + mdat with 8 bytes of payload: what a decoder-less muxer would write.
  printf '\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isommp41\x00\x00\x00\x08free\x00\x00\x00\x10mdat\x00\x01\x02\x03\x04\x05\x06\x07' >"$1" && MP4_SOURCE="byte sequence"
}

# --- browser helpers (playwright-cli through lib.sh's pw; the visible words are the English ones) ----------------------------
WEB_OK=0
# pw_run <label> <js: async page => ...>: runs a Playwright snippet in the page; PASS when it completes, FAIL with the error
# otherwise; the returned value (a string, or JSON text) is left in PW_OUT. Every action times out after 10 s.
pw_run() {
  local label=$1 code=$2 out
  PW_OUT=""
  out=$(pw run-code "async page => { page.setDefaultTimeout(10000); const run = ${code}; return await run(page); }") || {
    fail "$label" "  $(jq -r '.error // .' <<<"$out" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | head -n 14)"; WEB_OK=0; return 1; }
  PW_OUT=$(jq -r '.result | (try fromjson catch .) | if type == "string" then . else tojson end' <<<"$out")
  pass "$label"
}
text_has() { # <label> <haystack> <needle>: case-insensitive containment (some eyebrows are upper-cased)
  local hay=$2 needle=$3
  if [[ ${hay,,} == *"${needle,,}"* ]]; then pass "$1"; else fail "$1" "  needle: $3"$'\n'"  saw: ${hay:0:1500}"; fi
}
text_lacks() { # <label> <haystack> <needle>
  local hay=$2 needle=$3
  if [[ ${hay,,} != *"${needle,,}"* ]]; then pass "$1"; else fail "$1" "  forbidden text present: $3"$'\n'"  saw: ${hay:0:1500}"; fi
}
requests_list() { pw requests | jq -r '.result // ""'; }
# calls_since <index>: the /api requests of the browser session after request number <index>, "METHOD path status" per line, the
# /api/auth/* calls (sign-up, session reads) left out.
calls_since() {
  requests_list | sed -nE 's/^([0-9]+)\. \[([A-Z]+)\] https?:\/\/[^\/]+(\/api\/[^ ?]*)[^ ]* => \[([0-9]+)\].*/\1 \2 \3 \4/p' |
    awk -v since="$1" '$1 > since && $3 !~ /^\/api\/auth\// { print $2, $3, $4 }'
}
last_request_index() { requests_list | sed -nE 's/^([0-9]+)\. \[.*/\1/p' | sort -n | tail -n1; }
page_text() { pw_run "$1" '(async page => await page.locator("body").innerText())'; }

# ============================================================================================================================
start_stack || exit 1
assert_api /health '.ok == true and .database == "ok"' -l "stack: /health ok on the temp DB (port $E2E_API_PORT_USED, own media dir)"
assert_eq "$(sqlite_count sports "slug = '$SPORT'")" 1 "the real seed is loaded (sport $SPORT)"
assert_eq "$(sqlite_count drills "unpublished_at IS NULL")" 60 "the real seed holds 60 published drills"
assert_eq "$(sqlite_count contributions)" 0 "start state: no contribution"
assert_eq "$(sqlite_count contribution_attachments)" 0 "start state: no attachment"
assert_eq "$(media_files)" 0 "start state: the run's own MEDIA_DIR is empty"
DRILLS0=$(sqlite_count drills) VERSIONS0=$(sqlite_count drill_versions)
gen_mp4 "$MP4"
if [ -s "$MP4" ] && [ "$(head -c 12 "$MP4" | tail -c 8 | head -c 4)" = ftyp ]; then pass "a small real mp4 was made for the upload ($MP4_SOURCE, $(wc -c <"$MP4") bytes, ISO base media header)"
else fail "a small real mp4 was made for the upload" "  no file or no ftyp box at $MP4"; fi

fetch - GET '/api/contribute/meta?locale=en'
META=$F_BODY
chk "meta (public): the sport, the skill tree with $SKILL, the 8 improvement kinds and the mp4 upload limit the form needs" 200 "
  (.sports | map(.slug) | index(\"$SPORT\")) != null and ([.. | objects | select(.slug? == \"$SKILL\")] | length) == 1
  and (.improvementKinds | length) == 8 and (.improvementKinds | index(\"simpler_variant\")) != null
  and .upload.maxMb > 0 and (.upload.mimeTypes | index(\"video/mp4\")) != null"
UPLOAD_MAX_MB=$(jq -r '.upload.maxMb // 0' <<<"$META")

# --- A. an anonymous player is not a contributor -------------------------------------------------------------------------------
WEB_ON=0
if [ "$E2E_WEB" != api ]; then
  blocked "web journey (player asked to sign in, coach sign-up, form, thank-you, My contributions, suggest, withdraw)" "E2E_WEB=$E2E_WEB: the web app is not served"
elif ! pw_available; then
  blocked "web journey (player asked to sign in, coach sign-up, form, thank-you, My contributions, suggest, withdraw)" "playwright-cli is not installed"
elif pw_open /; then
  WEB_ON=1
fi   # pw_open itself recorded BLOCKED (no usable browser) or FAIL

if [ "$WEB_ON" = 1 ]; then
  WEB_OK=1
  pw resize 1280 2400 >/dev/null   # tall: nothing needs scrolling under the sticky header
  pw_run "player: START TRAINING makes a player session and opens the onboarding wizard" '(async page => {
    await page.locator("#main-content").getByRole("link", { name: "Start training" }).click();
    await page.waitForURL("**/train/onboarding");
    await page.getByRole("heading", { name: "A few questions to get started" }).waitFor();
    return page.url(); })'
  if [ "$(pw cookie-list | jq -r '.result // ""' | grep -c 'session_token')" -ge 1 ]; then pass "player: the visitor now holds a (anonymous) session cookie"
  else fail "player: the visitor now holds a (anonymous) session cookie" "  $(pw cookie-list | jq -r '.result // ""' | head -c 400)"; fi
  if [ "$WEB_OK" = 1 ]; then
    pw_run "player: pressing Contribute in the navigation leads to /account/sign-in with a return path" '(async page => {
      await page.getByLabel("Main navigation").getByRole("link", { name: "Contribute" }).click();
      await page.waitForURL("**/account/sign-in**");
      await page.getByRole("heading", { name: "Coach account" }).waitFor();
      return page.url(); })'
    if [ "$WEB_OK" = 1 ]; then
      assert_eq "$(jq -r 'sub("^https?://[^/]+"; "")' <<<"\"$PW_OUT\"")" "/account/sign-in?redirect=%2Fcontribute" "player: the URL is /account/sign-in?redirect=/contribute (return path kept)"
      page_text "player: the sign-in screen text"
      text_has "player: the screen says players never need an account" "$PW_OUT" "Players never need an account"
      text_lacks "player: no contribute form is on screen for a player (no 'Name of the method' field)" "$PW_OUT" "Name of the method"
      text_lacks "player: the form's attestations are not on screen for a player" "$PW_OUT" "not FIFA, UEFA or commercial content"
      pw_run "player: the API refuses that player's POST /api/contributions (browser cookie): 403" '(async page => {
        const r = await page.evaluate(async () => { const f = new FormData(); f.append("payload", "{}"); const x = await fetch("/api/contributions", { method: "POST", body: f, credentials: "include" }); return { status: x.status, ct: x.headers.get("content-type") }; });
        return JSON.stringify(r); })'
      if [ "$WEB_OK" = 1 ]; then
        if [ "$(jq -r .status <<<"$PW_OUT")" = 403 ]; then pass "player: POST /api/contributions as an anonymous player is 403"
        else fail "player: POST /api/contributions as an anonymous player is 403" "  answer: $PW_OUT"; fi
      fi
    fi
  fi
  pw close >/dev/null 2>&1 || true   # the coach is a different person on a fresh browser (no cookies, no storage)
fi
assert_eq "$(sqlite_count contributions)" 0 "after the player: still no contribution"

# --- B. the coach: CONTRIBUTE -> sign in -> sign up -> the form -> thank-you ------------------------------------------------------
if [ "$WEB_ON" = 1 ] && pw_open /; then
  WEB_OK=1
  pw resize 1280 2400 >/dev/null
  if [ "$(pw cookie-list | jq -r '.result // ""' | grep -c 'session_token')" = 0 ]; then pass "coach: the visitor starts with no session cookie"
  else fail "coach: the visitor starts with no session cookie"; fi

  pw_run "coach: presses CONTRIBUTE on the landing page and is asked to sign in (return path /contribute)" '(async page => {
    await page.locator("#main-content").getByRole("link", { name: "Contribute" }).click();
    await page.waitForURL("**/account/sign-in**");
    await page.getByRole("heading", { name: "Coach account" }).waitFor();
    return page.url(); })'
  if [ "$WEB_OK" = 1 ]; then
    assert_eq "$(jq -r 'sub("^https?://[^/]+"; "")' <<<"\"$PW_OUT\"")" "/account/sign-in?redirect=%2Fcontribute" "coach: the sign-in URL carries redirect=/contribute"
    page_text "coach: the sign-in screen text"
    text_has "coach: the screen offers 'Create coach account' and 'Sign in'" "$PW_OUT" "Create coach account"
    text_has "coach: ... and explains that players never need an account" "$PW_OUT" "Players never need an account"
  fi

  since=$(last_request_index); since=${since:-0}   # the submission window starts at the sign-up click
  if [ "$WEB_OK" = 1 ]; then
    pw_run "coach: signs up with a display name, an email and a password (>= 10 characters)" '(async page => {
      await page.getByLabel("Display name", { exact: true }).fill('"$(js_str "$COACH_NAME")"');
      await page.getByLabel("Email", { exact: true }).fill('"$(js_str "$COACH_EMAIL")"');
      await page.getByLabel("Password", { exact: true }).fill('"$(js_str "$COACH_PASSWORD")"');
      await page.getByRole("button", { name: "Create coach account" }).click();
      const form = page.getByLabel("Name of the method", { exact: true });
      const stuck = page.getByText("You are already signed in.");
      await form.or(stuck).first().waitFor({ timeout: 15000 });
      return JSON.stringify({ url: page.url(), formShown: await form.isVisible(), stuck: await stuck.isVisible() }); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    SIGNUP=$PW_OUT
    if jq -e '(.url | test("/contribute$")) and .formShown == true and .stuck == false' >/dev/null <<<"$SIGNUP"; then
      pass "coach: after signing up the sign-in screen returns to the redirect (/contribute) and the form is shown"
    else
      fail "coach: after signing up the sign-in screen returns to the redirect (/contribute) and the form is shown" \
        "  criterion: sign-in returns to the redirect search param afterwards (bead 70i.7), /contribute then shows the form (70i.8)"$'\n'"  page showed: $SIGNUP"
      # keep the rest of the journey proven: the 'already signed in' screen has a Continue button that goes to the redirect
      if jq -e '.stuck == true' >/dev/null <<<"$SIGNUP"; then
        pw_run "coach (workaround for the FAIL above): presses Continue on the 'already signed in' screen and reaches the form" '(async page => {
          await page.getByRole("button", { name: "Continue" }).click();
          await page.waitForURL("**/contribute");
          await page.getByLabel("Name of the method", { exact: true }).waitFor();
          return page.url(); })'
      else WEB_OK=0; fi
    fi
  fi
  if [ "$WEB_OK" = 1 ]; then
    assert_eq "$(sqlite_count user "email = '$COACH_EMAIL' AND COALESCE(\"isAnonymous\", 0) = 0")" 1 "coach: db has the coach account (email, not anonymous)"
    COACH_ID=$(sqlite_scalar "SELECT id FROM \"user\" WHERE email = '$COACH_EMAIL'")
    page_text "coach: the form screen text"
    text_has "coach: the form says the method stays out of training plans until reviewed" "$PW_OUT" "Your method stays out of training plans until it has been reviewed."
    for label in "Name of the method" "Sport" "Skill" "Age from (years)" "Age to (years)" "Difficulty" "Goal" "Instructions" "Duration (minutes)" "Equipment" \
        "Common mistakes" "Progression" "Regression" "Safety" "Video" "Source" "Author"; do
      text_has "coach: the form has the field '$label'" "$PW_OUT" "$label"
    done
    text_has "coach: the form shows the video size/type hint from the meta ('Up to $UPLOAD_MAX_MB MB')" "$PW_OUT" "Up to $UPLOAD_MAX_MB MB"
    text_has "coach: the rights attestation is on the form" "$PW_OUT" "I made this method or have permission to share it"
    text_has "coach: the second attestation 'not FIFA, UEFA or commercial content' is on the form" "$PW_OUT" "This is not FIFA, UEFA or commercial content."

    pw_run "coach: fills the method (name, sport, skill, age, difficulty, goal, duration, equipment, instructions, mistakes, progression, regression, safety, video, source, author)" '(async page => {
      await page.getByLabel("Name of the method", { exact: true }).fill('"$(js_str "$METHOD_NAME")"');
      await page.getByLabel("Sport", { exact: true }).selectOption('"$(js_str "$SPORT")"');
      await page.getByLabel("Skill", { exact: true }).selectOption('"$(js_str "$SKILL")"');
      await page.getByLabel("Age from (years)", { exact: true }).fill("8");
      await page.getByLabel("Age to (years)", { exact: true }).fill("14");
      await page.getByLabel("Difficulty", { exact: true }).selectOption({ label: "Basic" });
      await page.getByLabel("Goal", { exact: true }).selectOption({ label: "Weak foot" });
      await page.getByLabel("Duration (minutes)", { exact: true }).fill("12");
      await page.getByLabel("Equipment", { exact: true }).selectOption({ label: "A ball and a wall" });
      await page.getByLabel("Instructions", { exact: true }).fill("1. Stand two steps from the wall.\n2. Pass the ball against the wall with the inside of your weak foot.\n3. Control the rebound with the same foot and repeat 20 times.");
      await page.getByLabel(/^Common mistakes/).fill("Leaning back and lifting the ball off the ground.");
      await page.getByLabel(/^Progression/).fill("Step back one pace, or use one touch only.");
      await page.getByLabel(/^Regression/).fill("Stand closer to the wall and pass slower.");
      await page.getByLabel(/^Safety/).fill("Check that the wall is clear of windows and other children.");
      await page.getByLabel(/^Video/).setInputFiles('"$(js_str "$MP4")"');
      await page.getByLabel("Source", { exact: true }).fill("Own coaching practice, U12 group, Almaty");
      await page.getByLabel("Author", { exact: true }).fill('"$(js_str "$COACH_NAME")"');
      return "filled"; })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    pw_run "coach: sends with ONLY the second attestation ticked: a field error on the rights attestation, nothing sent" '(async page => {
      await page.getByLabel("This is not FIFA, UEFA or commercial content.", { exact: true }).check();
      await page.getByRole("button", { name: "Send for review" }).click();
      const alert = page.getByRole("alert").filter({ hasText: "Tick this to confirm you may share the method." });
      await alert.first().waitFor();
      const rights = page.getByLabel(/^I made this method or have permission/);
      const other = page.getByLabel("This is not FIFA, UEFA or commercial content.", { exact: true });
      return JSON.stringify({
        alert: await alert.first().innerText(),
        rightsInvalid: await rights.getAttribute("aria-invalid"),
        rightsChecked: await rights.isChecked(),
        otherInvalid: await other.getAttribute("aria-invalid"),
        thanks: await page.getByText("Thank you.").count(),
        url: page.url() }); })'
    if [ "$WEB_OK" = 1 ]; then
      ERR=$PW_OUT
      if jq -e '(.alert | contains("Tick this to confirm you may share the method.")) and .rightsInvalid == "true" and .rightsChecked == false and .otherInvalid == null and .thanks == 0' >/dev/null <<<"$ERR"; then
        pass "coach: the rights attestation shows the field error (aria-invalid) and the form stays; the ticked one shows none"
      else fail "coach: the rights attestation shows the field error (aria-invalid) and the form stays; the ticked one shows none" "  saw: $ERR"; fi
      assert_eq "$(sqlite_count contributions)" 0 "coach: nothing was stored for the refused submit"
      assert_eq "$(media_files)" 0 "coach: no file reached MEDIA_DIR for the refused submit"
      if [ "$(calls_since "$since" | grep -c '^POST /api/contributions')" = 0 ]; then pass "coach: the refused submit sent no POST /api/contributions"
      else fail "coach: the refused submit sent no POST /api/contributions" "  $(calls_since "$since" | tr '\n' ';')"; fi
    fi
  fi
  if [ "$WEB_OK" = 1 ]; then
    pw_run "coach: ticks the rights attestation too and submits: the thank-you state" '(async page => {
      await page.getByLabel(/^I made this method or have permission/).check();
      await page.getByRole("button", { name: "Send for review" }).click();
      await page.getByRole("heading", { name: "Thank you." }).waitFor({ timeout: 30000 });
      return await page.locator("main").innerText(); })'
  fi
  if [ "$WEB_OK" = 1 ]; then
    text_has "thank-you: the exact sentence '$THANKS'" "$PW_OUT" "$THANKS"
    text_has "thank-you: the state 'Waiting for review'" "$PW_OUT" "Waiting for review"
    text_has "thank-you: a link to My contributions" "$PW_OUT" "My contributions"

    # the call budget: sign-up click -> thank-you, without /api/auth/*
    calls=$(calls_since "$since")
    ncalls=$(grep -c . <<<"$calls")
    summary=$(tr '\n' ';' <<<"$calls" | sed 's/;/; /g')
    if [ "$ncalls" -le "$J5_CALL_BUDGET" ] && [ "$ncalls" -ge 1 ]; then pass "call budget: $ncalls non-auth /api calls for the form submission (<= $J5_CALL_BUDGET): $summary"
    else fail "call budget: the form submission costs <= $J5_CALL_BUDGET non-auth /api calls, got $ncalls" "  observed (everything under /api/auth/ left out): ${summary:-none}"; fi
    if [ "$(grep -c '^GET /api/contribute/meta 200' <<<"$calls")" = 1 ] && [ "$(grep -c '^POST /api/contributions 201' <<<"$calls")" = 1 ]; then
      pass "call budget: exactly one GET /api/contribute/meta (200) and one multipart POST /api/contributions (201)"
    else fail "call budget: exactly one GET /api/contribute/meta (200) and one POST /api/contributions (201)" "  observed: ${summary:-none}"; fi
  fi
fi

# --- C. the database and My contributions --------------------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ] && [ -n "${COACH_ID:-}" ]; then
  assert_eq "$(sqlite_count contributions)" 1 "db: exactly 1 contribution"
  assert_eq "$(sqlite_count contributions "state = 'pending' AND kind = 'new' AND submitter_user_id = '$COACH_ID'")" 1 "db: it is pending, a new method, submitted by the coach"
  MAIN_ID=$(sqlite_scalar "SELECT id FROM contributions WHERE submitter_user_id = '$COACH_ID' AND kind = 'new'")
  assert_eq "$(sqlite_scalar "SELECT json_extract(payload, '\$.name') || '|' || json_extract(payload, '\$.sport') || '|' || json_extract(payload, '\$.skill') || '|' || json_extract(payload, '\$.ageMin') || '-' || json_extract(payload, '\$.ageMax') || '|' || json_extract(payload, '\$.level') || '|' || json_extract(payload, '\$.goal') || '|' || json_extract(payload, '\$.durationMin') || '|' || json_extract(payload, '\$.equipment') || '|' || json_extract(payload, '\$.author') || '|' || json_extract(payload, '\$.rightsAttested') || json_extract(payload, '\$.noCommercialContent') FROM contributions WHERE id = '$MAIN_ID'")" \
    "$METHOD_NAME|$SPORT|$SKILL|8-14|basic|weakfoot|12|ball_wall|$COACH_NAME|11" "db: the stored payload holds exactly what the coach entered (both attestations true)"
  assert_eq "$(sqlite_scalar "SELECT length(json_extract(payload, '\$.instructions')) > 40 AND json_extract(payload, '\$.mistakes') <> '' AND json_extract(payload, '\$.progression') <> '' AND json_extract(payload, '\$.regression') <> '' AND json_extract(payload, '\$.safety') <> '' AND json_extract(payload, '\$.source') <> '' FROM contributions WHERE id = '$MAIN_ID'")" 1 "db: instructions, mistakes, progression, regression, safety and source are stored"
  assert_eq "$(sqlite_count contribution_attachments "contribution_id = '$MAIN_ID' AND kind = 'video' AND mime = 'video/mp4'")" 1 "db: 1 video attachment (video/mp4) belongs to it"
  STORED=$(sqlite_scalar "SELECT stored_path FROM contribution_attachments WHERE contribution_id = '$MAIN_ID'")
  MAIN_BYTES=$(sqlite_scalar "SELECT bytes FROM contribution_attachments WHERE contribution_id = '$MAIN_ID'")
  MAIN_ATT=$(sqlite_scalar "SELECT id FROM contribution_attachments WHERE contribution_id = '$MAIN_ID'")
  if [ -n "$STORED" ] && [ -f "$MEDIA_DIR/$STORED" ]; then pass "media: the video file $STORED is present under MEDIA_DIR"
  else fail "media: the video file is present under MEDIA_DIR" "  stored_path='$STORED'; MEDIA_DIR has: $(ls -A "$MEDIA_DIR" 2>&1 | head -n 5 | tr '\n' ' ')"; fi
  assert_eq "$(wc -c <"$MEDIA_DIR/$STORED" 2>/dev/null | tr -d ' ')" "$MAIN_BYTES" "media: the file on disk has the byte count of the row ($MAIN_BYTES)"
  if cmp -s "$MP4" "$MEDIA_DIR/$STORED"; then pass "media: the stored file is byte-identical to the mp4 the browser uploaded"
  else fail "media: the stored file is byte-identical to the mp4 the browser uploaded" "  source $(wc -c <"$MP4") bytes, stored $(wc -c <"$MEDIA_DIR/$STORED" 2>/dev/null) bytes"; fi
  assert_eq "$(media_files)" 1 "media: MEDIA_DIR holds exactly that one file"

  # My contributions: lists it as pending
  pw_run "coach: opens My contributions from the thank-you state" '(async page => {
    await page.getByRole("region").getByRole("link", { name: "My contributions" }).click();
    await page.waitForURL("**/contribute/mine");
    await page.getByRole("list", { name: "Your contributions" }).waitFor();
    return await page.locator("main").innerText(); })'
  if [ "$WEB_OK" = 1 ]; then
    text_has "mine: the contribution is listed with its name" "$PW_OUT" "$METHOD_NAME"
    text_has "mine: it carries the state tag 'Pending'" "$PW_OUT" "Pending"
    text_has "mine: ... with the sentence 'Waiting for a reviewer.'" "$PW_OUT" "Waiting for a reviewer."
    text_has "mine: it can be withdrawn" "$PW_OUT" "Withdraw"
    text_lacks "mine: a pending item has no 'Edit and resubmit' (only changes-requested ones do)" "$PW_OUT" "Edit and resubmit"
    pw_run "coach: the mine list (GET /api/contributions/mine with the coach's cookie) and its private video" '(async page => {
      const r = await page.evaluate(async (attId) => {
        const list = await fetch("/api/contributions/mine", { credentials: "include" });
        const body = await list.json();
        const media = await fetch("/api/media/" + encodeURIComponent(attId), { credentials: "include", headers: { Range: "bytes=0-7" } });
        const viewUrl = body[0] && body[0].attachments[0] ? body[0].attachments[0].url : null;
        const view = viewUrl ? await fetch(viewUrl, { credentials: "include" }) : null;
        return { status: list.status, body, mediaStatus: media.status, mediaCache: media.headers.get("cache-control"), mediaType: media.headers.get("content-type"),
                 viewUrl, viewStatus: view ? view.status : null, viewType: view ? view.headers.get("content-type") : null };
      }, '"$(js_str "$MAIN_ATT")"');
      return JSON.stringify(r); })'
    if [ "$WEB_OK" = 1 ]; then
      MINE=$PW_OUT
      if jq -e --arg id "$MAIN_ID" --arg n "$METHOD_NAME" --arg att "$MAIN_ATT" --argjson bytes "$MAIN_BYTES" '.status == 200 and (.body | length) == 1 and .body[0].id == $id and .body[0].state == "pending" and .body[0].payload.name == $n
          and (.body[0].attachments | length) == 1 and .body[0].attachments[0].id == $att and .body[0].attachments[0].kind == "video" and .body[0].attachments[0].mimeType == "video/mp4"
          and .body[0].attachments[0].size == $bytes and (.body[0].attachments[0].url | length) > 0' >/dev/null <<<"$MINE"; then
        pass "api (browser cookie): GET /api/contributions/mine lists the one pending contribution with its video attachment (id, video/mp4, size)"
      else fail "api (browser cookie): GET /api/contributions/mine lists the one pending contribution with its video attachment (id, video/mp4, size)" "  ${MINE:0:1400}"; fi
      if jq -e '(.mediaStatus == 200 or .mediaStatus == 206) and (.mediaCache | test("no-store")) and .mediaType == "video/mp4"' >/dev/null <<<"$MINE"; then
        pass "api: the owner reads the pending video at /api/media/<attachment id> (200/206, video/mp4, Cache-Control no-store)"
      else fail "api: the owner reads the pending video at /api/media/<attachment id> (200/206, video/mp4, Cache-Control no-store)" "  ${MINE:0:300} ... media: $(jq -c '{mediaStatus, mediaCache, mediaType}' <<<"$MINE")"; fi
      # not asserted (no criterion names it), printed so a reviewer sees it: what the attachment's own `url` resolves to for the owner
      _e2e_err "NOTE: the attachment view url '$(jq -r .viewUrl <<<"$MINE")' answers $(jq -r .viewStatus <<<"$MINE") ($(jq -r .viewType <<<"$MINE")) for the owner; the private route is /api/media/<attachment id>"
      fetch - GET "/api/media/$MAIN_ATT"
      if [ "$F_CODE" = 404 ]; then pass "api: a stranger (no cookie) gets 404 for the pending video"; else fail "api: a stranger (no cookie) gets 404 for the pending video" "  HTTP $F_CODE"; fi
    fi
  fi

  # --- D. the pending method is not public, and not in any session ------------------------------------------------------------
  fetch - GET '/api/commons/drills?locale=en&limit=100'
  chk "commons: /api/commons/drills still lists exactly the 60 seeded drills" 200 '.total == 60 and (.items | length) == 60'
  if grep -qF "$TOKEN" <<<"$F_BODY"; then fail "commons: the pending method is NOT in /api/commons/drills" "  the run's token '$TOKEN' appears in the list"; else pass "commons: the pending method is NOT in /api/commons/drills"; fi
  fetch - GET '/api/commons/export.json'
  if [ "$F_CODE" = 200 ] && ! grep -qF "$TOKEN" <<<"$F_BODY"; then pass "commons: the pending method is NOT in the open dataset export"; else fail "commons: the pending method is NOT in the open dataset export" "  HTTP $F_CODE"; fi
  assert_eq "$(sqlite_count drills),$(sqlite_count drill_versions)" "$DRILLS0,$VERSIONS0" "db: no drill and no drill version was created (still $DRILLS0 drills, $VERSIONS0 versions)"
  assert_eq "$(sqlite_count drill_versions "content LIKE '%$TOKEN%'")" 0 "db: no drill version contains the pending method"

  # a player whose roadmap points at exactly this skill/equipment/age gets a session composed AFTER the contribution exists
  sign_in "session probe"
  if [ -n "$V_COOKIE" ]; then
    PROBE_ID=$V_ID
    run1=$(jq -nc --arg u1 "$(uuid 1)" --arg u2 "$(uuid 2)" --arg u3 "$(uuid 3)" --arg u4 "$(uuid 4)" --arg u5 "$(uuid 5)" '{
      profile: {age: 12, level: "basic", goal: "weakfoot", equipment: "ball_wall", space: "yard", partner: false, daysPerWeek: 3, minutesPerSession: 20, locale: "en"},
      baseline: [
        {testSlug: "juggling-max-touches", value: 15, clientUuid: $u1}, {testSlug: "wall-passing-60s", value: 30, clientUuid: $u2},
        {testSlug: "ball-mastery-30s", value: 40, clientUuid: $u3}, {testSlug: "weak-foot-passes", value: 4, clientUuid: $u4},
        {testSlug: "slalom-time", value: 0, skipped: true, clientUuid: $u5}]}')
    fetch "$V_COOKIE" POST /api/player/start "$run1"
    chk "session probe: a weak-foot / Ball + wall / age 12 player onboards (roadmap focus starts with $SKILL)" 200 ".roadmap.focus[0].skill == \"$SKILL\""
    fetch "$V_COOKIE" GET '/api/player/today?locale=en'
    chk "session probe: today's session is composed from published drills only (all COMMUNITY, non-empty)" 200 '(.items | length) >= 1 and all(.items[]; .status == "COMMUNITY")'
    if grep -qF "$TOKEN" <<<"$F_BODY" || grep -qF "$MAIN_ID" <<<"$F_BODY"; then fail "not in any session: today's session does not contain the pending method" "  the token or the contribution id is in: ${F_BODY:0:600}"
    else pass "not in any session: today's session does not contain the pending method"; fi
    assert_eq "$(sqlite_count sessions "player_id = '$PROBE_ID'")" 1 "not in any session: the probe's session row is stored (so the next check is not vacuous)"
    assert_eq "$(sqlite_count sessions "items LIKE '%$TOKEN%' OR items LIKE '%$MAIN_ID%'")" 0 "not in any session: no stored session row contains the pending method"
  fi
fi

# --- E. Suggest improvement on a drill detail page ------------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ] && [ -n "${MAIN_ID:-}" ]; then
  fetch - GET '/api/commons/drills?locale=en&limit=100'
  DRILL_SLUG=$(jq -r '.items[0].slug // ""' <<<"$F_BODY")
  DRILL_TITLE=$(jq -r '.items[0].title.en // ""' <<<"$F_BODY")
  IMPROVEMENT_TEXT="Show a simpler variant: start with the ball resting on the ground and pass it slowly with the weak foot, $TOKEN."
  WEB_OK=1
  pw_run "suggest: the coach opens the drill detail page /commons/$DRILL_SLUG" '(async page => {
    await page.goto('"$(js_str "$STACK_URL/commons/$DRILL_SLUG")"');
    await page.getByRole("button", { name: "Suggest improvement" }).waitFor();
    return await page.locator("main").innerText(); })'
  if [ "$WEB_OK" = 1 ]; then
    text_has "suggest: the drill detail page offers 'Suggest improvement'" "$PW_OUT" "Suggest improvement"
    pw_run "suggest: the dialog asks for the kind, the text, an optional video, the author and both attestations; the coach fills it" '(async page => {
      await page.getByRole("button", { name: "Suggest improvement" }).click();
      const dialog = page.getByRole("dialog", { name: "Suggest an improvement" });
      await dialog.waitFor();
      await dialog.getByLabel("What kind of improvement?").waitFor();
      const kinds = await dialog.getByLabel("What kind of improvement?").locator("option").allInnerTexts();
      const author = await dialog.getByLabel("Your name", { exact: true }).inputValue();
      const shown = await dialog.innerText();
      await dialog.getByLabel("What kind of improvement?").selectOption("simpler_variant");
      await dialog.getByLabel("Your suggestion", { exact: true }).fill('"$(js_str "$IMPROVEMENT_TEXT")"');
      await dialog.getByLabel("Video (optional)", { exact: true }).setInputFiles('"$(js_str "$MP4")"');
      await dialog.getByLabel(/^I wrote this or I have the right to share it/).check();
      await dialog.getByLabel("It contains no advertising and nothing commercial.", { exact: true }).check();
      return JSON.stringify({ kinds, author, shown }); })'
    if [ "$WEB_OK" = 1 ]; then
      DLG=$PW_OUT
      if jq -e '.kinds | (index("A different explanation") != null and index("A new progression") != null and index("A simpler variant") != null and index("An adaptation for another age") != null
          and index("A translation") != null and index("A new video") != null and index("An accessibility adaptation") != null and index("A safety improvement") != null)' >/dev/null <<<"$DLG"; then
        pass "suggest: the dialog offers all 8 improvement kinds"
      else fail "suggest: the dialog offers all 8 improvement kinds" "  $(jq -c .kinds <<<"$DLG")"; fi
      assert_eq "$(jq -r .author <<<"$DLG")" "$COACH_NAME" "suggest: the author field starts with the coach's display name"
      text_has "suggest: the dialog names the drill it is for" "$(jq -r .shown <<<"$DLG")" "For “$DRILL_TITLE”"
      pw_run "suggest: the coach sends the suggestion: the thank-you state" '(async page => {
        const dialog = page.getByRole("dialog", { name: "Suggest an improvement" });
        await dialog.getByRole("button", { name: "Send suggestion" }).click();
        await dialog.getByText("A reviewer will read your suggestion.").waitFor({ timeout: 30000 });
        return await dialog.innerText(); })'
      if [ "$WEB_OK" = 1 ]; then
        text_has "suggest: the dialog thanks the coach" "$PW_OUT" "Thank you"
        text_has "suggest: ... and says the drill changes only if a reviewer accepts" "$PW_OUT" "The drill changes only if they accept it."
        text_has "suggest: ... and links to My contributions" "$PW_OUT" "See my contributions"
      fi
    fi
  fi
  assert_eq "$(sqlite_count contributions)" 2 "db: 2 contributions now (the method and the improvement)"
  IMP_ID=$(sqlite_scalar "SELECT id FROM contributions WHERE kind = 'improvement'")
  assert_eq "$(sqlite_count contributions "id = '$IMP_ID' AND kind = 'improvement' AND state = 'pending' AND submitter_user_id = '$COACH_ID' AND improvement_kind = 'simpler_variant' AND target_drill_id = (SELECT id FROM drills WHERE slug = '$DRILL_SLUG')")" 1 \
    "db: the improvement is pending, submitted by the coach, kind simpler_variant, and targets the drill $DRILL_SLUG"
  assert_eq "$(sqlite_scalar "SELECT json_extract(payload, '\$.targetDrillSlug') || '|' || json_extract(payload, '\$.kind') || '|' || json_extract(payload, '\$.instructions') FROM contributions WHERE id = '$IMP_ID'")" \
    "$DRILL_SLUG|improvement|$IMPROVEMENT_TEXT" "db: the stored payload names the target drill and holds the coach's text"
  assert_eq "$(sqlite_count contribution_attachments "contribution_id = '$IMP_ID' AND kind = 'video' AND mime = 'video/mp4'")" 1 "db: the improvement carries its own video attachment"
  IMP_STORED=$(sqlite_scalar "SELECT stored_path FROM contribution_attachments WHERE contribution_id = '$IMP_ID'")
  if [ -n "$IMP_STORED" ] && [ -f "$MEDIA_DIR/$IMP_STORED" ] && [ "$IMP_STORED" != "$STORED" ]; then pass "media: the improvement's video is its own file under MEDIA_DIR"
  else fail "media: the improvement's video is its own file under MEDIA_DIR" "  stored_path='$IMP_STORED'"; fi
  assert_eq "$(media_files)" 2 "media: MEDIA_DIR holds 2 files (one per contribution)"
  assert_eq "$(sqlite_count drills),$(sqlite_count drill_versions)" "$DRILLS0,$VERSIONS0" "db: the suggestion changed no drill and no drill version"
fi

# --- F. withdraw the improvement through My contributions -----------------------------------------------------------------------------
if [ "$WEB_ON" = 1 ] && [ -n "${IMP_ID:-}" ]; then
  IMP_NAME=$(sqlite_scalar "SELECT json_extract(payload, '\$.name') FROM contributions WHERE id = '$IMP_ID'")
  WEB_OK=1
  pw_run "withdraw: My contributions lists both contributions as Pending" '(async page => {
    await page.goto('"$(js_str "$STACK_URL/contribute/mine")"');
    await page.getByRole("list", { name: "Your contributions" }).waitFor();
    await page.getByRole("button", { name: '"$(js_str "Withdraw “$IMP_NAME”")"' }).waitFor();
    return await page.locator("main").innerText(); })'
  if [ "$WEB_OK" = 1 ]; then
    text_has "withdraw: the method is listed" "$PW_OUT" "$METHOD_NAME"
    text_has "withdraw: the improvement is listed (kind 'Improvement to an existing drill')" "$PW_OUT" "Improvement to an existing drill"
    pw_run "withdraw: Withdraw asks for a confirmation, the coach confirms" '(async page => {
      await page.getByRole("button", { name: '"$(js_str "Withdraw “$IMP_NAME”")"' }).click();
      const dialog = page.getByRole("dialog", { name: "Withdraw this contribution?" });
      await dialog.waitFor();
      const asked = await dialog.innerText();
      await dialog.getByRole("button", { name: "Yes, withdraw" }).click();
      await page.getByText('"$(js_str "Withdrawn: “$IMP_NAME”. It is no longer in review.")"').waitFor();
      return JSON.stringify({ asked, list: await page.getByRole("list", { name: "Your contributions" }).innerText() }); })'
    if [ "$WEB_OK" = 1 ]; then
      text_has "withdraw: the confirm dialog says the attached files are deleted" "$(jq -r .asked <<<"$PW_OUT")" "the files you attached are deleted"
      text_has "withdraw: the list now shows the state 'Withdrawn'" "$(jq -r .list <<<"$PW_OUT")" "Withdrawn"
      text_has "withdraw: the other contribution is still 'Pending'" "$(jq -r .list <<<"$PW_OUT")" "Pending"
    fi
  fi
  assert_eq "$(sqlite_count contributions "id = '$IMP_ID' AND state = 'withdrawn'")" 1 "db: the improvement is now withdrawn"
  assert_eq "$(sqlite_count contribution_attachments "contribution_id = '$IMP_ID'")" 0 "db: the improvement's attachment row is deleted"
  if [ -n "${IMP_STORED:-}" ] && [ ! -e "$MEDIA_DIR/$IMP_STORED" ]; then pass "media: the improvement's video file is deleted from MEDIA_DIR"
  else fail "media: the improvement's video file is deleted from MEDIA_DIR" "  $MEDIA_DIR/${IMP_STORED:-?} still exists"; fi
  assert_eq "$(sqlite_count contributions "id = '$MAIN_ID' AND state = 'pending'")" 1 "db: the first contribution is still pending"
  if [ -f "$MEDIA_DIR/$STORED" ] && cmp -s "$MP4" "$MEDIA_DIR/$STORED"; then pass "media: the first contribution's video is untouched"; else fail "media: the first contribution's video is untouched"; fi
  assert_eq "$(media_files)" 1 "media: MEDIA_DIR holds exactly 1 file after the withdrawal"
  assert_eq "$(sqlite_count contributions)" 2 "db: the withdrawn contribution is kept (state withdrawn), nothing else was added"
fi

# --- G. the server side, with a second coach over the API ---------------------------------------------------------------------------
COACH2_EMAIL="coach2-$TOKEN@example.com"
fetch - POST /api/auth/sign-up/email "$(jq -nc --arg e "$COACH2_EMAIL" '{name: "Second Coach", email: $e, password: "another-long-password-7"}')"
COOKIE2=$(cookie_of)
if [ "$F_CODE" = 200 ] && [ -n "$COOKIE2" ]; then
  pass "api: a second coach signs up over the API (200, session cookie)"
  payload2=$(jq -nc --arg n "Second coach method $TOKEN" '{kind: "new", locale: "en", name: $n, sport: "football", skill: "weak-foot", ageMin: 8, ageMax: 14, level: "basic", goal: "weakfoot",
    instructions: "1. Pass against the wall.", durationMin: 10, equipment: "ball_wall", mistakes: "", progression: "", regression: "", safety: "", source: "own practice", author: "Second Coach",
    rightsAttested: true, noCommercialContent: true, website: ""}')
  files0=$(media_files) contribs0=$(sqlite_count contributions)
  fetch_mp - POST /api/contributions "$payload2" "$MP4"
  chk "api: POST /api/contributions with no cookie is 401" 401 '.status == 401'
  sign_in "api player"
  if [ -n "$V_COOKIE" ]; then
    fetch_mp "$V_COOKIE" POST /api/contributions "$payload2" "$MP4"
    chk "api: POST /api/contributions by an anonymous player is 403" 403 '.status == 403'
    fetch "$V_COOKIE" GET /api/contributions/mine
    chk "api: GET /api/contributions/mine by an anonymous player is 403" 403 '.status == 403'
  fi
  fetch_mp "$COOKIE2" POST /api/contributions "$(jq -c 'del(.rightsAttested)' <<<"$payload2")" "$MP4"
  chk "api: a missing rights attestation is a 422 problem+json with the pointer /rightsAttested" 422 '.status == 422 and (.errors | map(.pointer) | index("/rightsAttested")) != null'
  fetch_mp "$COOKIE2" POST /api/contributions "$(jq -c '.rightsAttested = false' <<<"$payload2")" "$MP4"
  chk "api: rightsAttested false is a 422 with the pointer /rightsAttested too" 422 '(.errors | map(.pointer) | index("/rightsAttested")) != null'
  fetch_mp "$COOKIE2" POST /api/contributions "$(jq -c '.website = "http://spam.example"' <<<"$payload2")" "$MP4"
  chk "api: a filled honeypot (website) is a 422 on /website" 422 '(.errors | map(.pointer) | index("/website")) != null'
  assert_eq "$(sqlite_count contributions),$(media_files)" "$contribs0,$files0" "api: none of the refused submissions stored a row or a file"
  if [ -n "${MAIN_ID:-}" ]; then
    fetch "$COOKIE2" DELETE "/api/contributions/$MAIN_ID"
    chk "api: another coach cannot withdraw the first coach's contribution (404)" 404 '.status == 404'
    assert_eq "$(sqlite_count contributions "id = '$MAIN_ID' AND state = 'pending'")" 1 "db: ... and it is still pending"
  else
    blocked "api: another coach cannot withdraw the first coach's contribution" "the first contribution was not created (see above)"
  fi
  fetch "$COOKIE2" GET /api/contributions/mine
  chk "api: the second coach's list is empty (owner isolation)" 200 'length == 0'
else
  fail "api: a second coach signs up over the API (200, session cookie)" "  HTTP $F_CODE headers: ${F_HDRS:0:300} body: ${F_BODY:0:400}"
fi

if [ "$WEB_ON" = 1 ] && [ "$WEB_OK" = 0 ]; then _e2e_err "NOTE: a browser step failed; the browser steps that depend on it were not run (the first FAIL above is the cause)"; fi

# no explicit stop or summary: the EXIT handler stops the stack, prints the summary, sets the exit code
