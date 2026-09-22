#!/usr/bin/env bash
# apps/web/e2e/j0-landing.sh: slice gate fc-mol-0dx, journey J0 "a visitor lands, switches language and starts".
# Journey proof on the REAL stack, nothing mocked: the real API process on a fresh temp SQLite DB with the real seed,
# serving the real built web app on the same origin, driven by a real browser (playwright-cli). Runs on its own free
# port (the harness picks it); a process already holding :4111 or :5173 is neither used nor touched.
#
#   1. API + DB      GET /api/commons/stats is exactly {drills, tracks, contributions, sports}; drills = 60 and tracks = 5;
#                    every number equals an independent sqlite_count over the temp DB
#   2. landing (en)  the headline 'Every child deserves a great first coach.', 'Created by KOZ AI.', 'Opened to everyone on
#                    the 60th birthday of Kairat Boranbayev.', the '60 YEARS. 60 OPEN TRAINING SESSIONS. FREE FOR EVERYONE.'
#                    block, and the stat strip whose DOM numbers equal the API response (and so the DB); 0 console errors
#   3. call budget   the requests the browser really made on load (`playwright-cli requests`): exactly ONE non-auth /api
#                    request, GET /api/commons/stats; at most ONE Better Auth session READ (GET /api/auth/get-session); and
#                    no other /api/auth call (no sign-in, sign-up or anonymous sign-in: POST /api/auth/*) on a landing view
#   4. language      Қазақша -> Русский -> English: <html lang>, aria-pressed, navigation labels and hero copy change, the
#                    stat numbers do not, and the choice (localStorage fc:lang) survives a reload
#   5. START / CONTRIBUTE   START TRAINING and CONTRIBUTE both point straight at the sign-in gate for a signed-out
#                    visitor (/account/sign-in?redirect=/train and ?redirect=/contribute, real document requests, built
#                    with signInUrl() — auth-gate-spec.md §3.3); pressing Start on the gate creates the session and
#                    lands on the onboarding wizard (/train/onboarding, a new visitor is not onboarded)
#   6. unknown URL   the localized 404 page inside the shell, with links home and to training
#   7. 360px         no horizontal scroll on / in kk, ru and en
#
# Readings of the criteria (where they were open):
#   - "exactly 1 /api request is made on load" is counted as the j2 onboarding gate counts (decision recorded on bead
#     fc-mol-0dx): exactly ONE non-auth /api data request (GET /api/commons/stats), AND at most ONE Better Auth session
#     READ (GET /api/auth/get-session, the shell reads the cookie for the Admin link; it carries no data), AND NO other
#     /api/auth call (a POST sign-in / sign-up / anonymous sign-in on a landing view would create a player before the
#     visitor asked for anything). /health is not under /api. The three are separate checks; a failure prints the full
#     request list with statuses.
#   - "START TRAINING navigates to the sign-in gate": the link is a hard navigation, so the document request for
#     /account/sign-in?redirect=/train is what is asserted; pressing Start there creates the anonymous session and the
#     page then replaces itself with /train/onboarding (the API answers 404 "not onboarded" for a new visitor).
#   - "CONTRIBUTE navigates to the sign-in gate": contributing needs a signed-in, non-anonymous account (journey J5,
#     routes/contribute/index.tsx), so a signed-out visitor's CONTRIBUTE link itself points at
#     /account/sign-in?redirect=/contribute (built with signInUrl(), same as START TRAINING) — the link is a hard
#     navigation, so the document request for /account/sign-in is what is asserted. The landing pathname is asserted as
#     /account/sign-in (location.pathname, so the query string is tolerated) and the redirect parameter as /contribute
#     (the way back after sign-in).
#   - Kazakh and Russian copy is judged structurally (script letters, differs from English, differs from each other), not by
#     exact sentence: the Kazakh text is awaiting a native-speaker review and will change.
#   - The browser is Playwright's chromium, whose default locale is en-US: a fresh visitor sees English first.
#
# Environment: E2E_WEB=off (API only) runs step 1 and records every browser step BLOCKED. No playwright-cli or no installed
# browser: the browser steps are BLOCKED (exit 3 unless E2E_ALLOW_BLOCKED=1). Exit codes: 0 all passed, 1 a FAIL, 3 BLOCKED.
# Fail-slow (no set -e): every step reports. Cleanup: e2e_defer only (never `trap ... EXIT` after sourcing lib.sh).
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
: "${E2E_TEXT_TIMEOUT:=10}" # a hard navigation plus the client redirect to onboarding needs more than the 5 s default
source "$HERE/lib.sh"

EN_HEADLINE='Every child deserves a great first coach.'
EN_CREDIT='Created by KOZ AI.'
EN_DEDICATION='Opened to everyone on the 60th birthday of Kairat Boranbayev.'
EN_SUMMARY='60 YEARS. 60 OPEN TRAINING SESSIONS. FREE FOR EVERYONE.'
EN_NAV='["Open Commons","Start"]'
EN_NOT_FOUND='We can'"'"'t find that page'

# wait_eval <js> <expected> <label>: polls a JS expression on the live page until its value equals <expected>.
wait_eval() {
  local js=$1 want=$2 label=$3 got="" deadline=$((SECONDS + E2E_TEXT_TIMEOUT))
  while :; do
    got=$(pw_eval "$js" 2>&1) || true
    [ "$got" = "$want" ] && { pass "$label"; return 0; }
    [ "$SECONDS" -ge "$deadline" ] && break
    sleep 0.2
  done
  fail "$label" "  expected: $want"$'\n'"  actual:   ${got:0:400}"
}
# eval_jq <js> <jq filter> <label> [jq args...]: the page value (parsed as JSON) must make `jq -e <filter>` truthy.
eval_jq() {
  local js=$1 filter=$2 label=$3 got
  shift 3
  got=$(pw_eval "$js" 2>&1) || { fail "$label" "  JS failed: ${got:0:400}"; return 1; }
  if jq -e "$@" "$filter" >/dev/null 2>&1 <<<"$got"; then pass "$label"; else fail "$label" "  jq -e '$filter' failed on: ${got:0:600}"; fi
}
# wait_stats: the stat strip has left its skeleton (four <li>, no aria-busy).
wait_stats() { wait_eval 'document.querySelectorAll("section[aria-busy=\"false\"] ul li").length' 4 "$1"; }
# stats_dom: [[label, number], ...] read from the stat strip.
STATS_JS='JSON.stringify([...document.querySelectorAll("section[aria-busy] ul li")].map((li) => [...li.children].map((c) => c.textContent.trim())))'
NAV_JS='JSON.stringify([...document.querySelectorAll("header nav a")].map((a) => a.textContent.trim()))'
PATH_JS='location.pathname'
# api_reqs: the /api requests the browser has made in this session, one "METHOD path status" per line.
api_reqs() {
  pw requests | jq -r '.result // ""' | sed -nE 's#^[0-9]+\. \[([A-Z]+)\] https?://[^/]+(/api/[^ ?]*)[^ ]* => \[([0-9]+)\].*#\1 \2 \3#p'
}
# last_request_index: the highest request number playwright-cli has recorded so far (a checkpoint to diff against).
last_request_index() { pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[.*/\1/p' | sort -n | tail -n1; }
# api_reqs_since <index>: like api_reqs, but only the /api requests made after request number <index> — used for the
# gate's own call-budget checks, which must not be polluted by the language-switch reloads earlier in this journey.
api_reqs_since() {
  pw requests | jq -r '.result // ""' | sed -nE 's#^([0-9]+)\. \[([A-Z]+)\] https?://[^/]+(/api/[^ ?]*)[^ ]* => \[([0-9]+)\].*#\1 \2 \3 \4#p' \
    | awk -v since="${1:-0}" '$1 > since { print $2, $3, $4 }'
}
# doc_requests: every request (static ones too) the browser has made, "METHOD path", no assets.
doc_requests() {
  pw requests --static | jq -r '.result // ""' | sed -nE 's#^[0-9]+\. \[([A-Z]+)\] https?://[^/]+(/[^ ?]*).*#\1 \2#p' | grep -v ' /assets/'
}

start_stack || exit 1

# --- 1. API + DB -------------------------------------------------------------------------------
STATS=$(api_get /api/commons/stats) || STATS=""
assert_api /api/commons/stats '(keys | sort) == ["contributions","drills","sports","tracks"] and (.[] | type == "number")' \
  -l "API: GET /api/commons/stats is exactly {drills, tracks, contributions, sports}, all numbers"
assert_api /api/commons/stats '.drills == 60 and .tracks == 5' -l "API: the seed gives drills == 60 and tracks == 5"
PUBLISHED='unpublished_at IS NULL AND current_version_id IS NOT NULL'
DB_DRILLS=$(sqlite_count drills "$PUBLISHED") || DB_DRILLS=x
DB_TRACKS=$(sqlite_count skills "id IN (SELECT ds.skill_id FROM drill_skills ds JOIN drills d ON d.id = ds.drill_id WHERE ds.is_primary = 1 AND d.unpublished_at IS NULL AND d.current_version_id IS NOT NULL)") || DB_TRACKS=x
DB_TOP=$(sqlite_count skills 'parent_id IS NULL') || DB_TOP=x
DB_CONTRIB=$(sqlite_count drill_versions "origin = 'contribution' AND drill_id IN (SELECT id FROM drills WHERE $PUBLISHED)") || DB_CONTRIB=x
DB_SPORTS=$(sqlite_count sports) || DB_SPORTS=x
eval_stat() { jq -r ".$1" <<<"$STATS" 2>/dev/null; }
assert_eq "$(eval_stat drills)" "$DB_DRILLS" "API drills equals sqlite_count of published drills ($DB_DRILLS)"
assert_eq "$(eval_stat tracks)" "$DB_TRACKS" "API tracks equals sqlite_count of the primary skills of published drills ($DB_TRACKS)"
assert_eq "$DB_TOP" 5 "DB: 5 top-level skill tracks"
assert_eq "$(eval_stat contributions)" "$DB_CONTRIB" "API contributions equals sqlite_count of contributed versions ($DB_CONTRIB)"
assert_eq "$(eval_stat sports)" "$DB_SPORTS" "API sports equals sqlite_count of sports ($DB_SPORTS)"

# --- browser gate ------------------------------------------------------------------------------
BROWSER=1
if [ "$E2E_WEB" = off ]; then
  BROWSER=0
  blocked "browser journey (landing, call budget, language, START/CONTRIBUTE, 404, 360px)" "E2E_WEB=off: the web app is not served"
elif ! pw_available; then
  BROWSER=0
  blocked "browser journey (landing, call budget, language, START/CONTRIBUTE, 404, 360px)" "playwright-cli is not installed"
elif ! pw_open /; then
  BROWSER=0 # pw_open already recorded the FAIL or BLOCKED
  blocked "browser journey (landing, call budget, language, START/CONTRIBUTE, 404, 360px)" "the browser could not open the app"
fi

if [ "$BROWSER" = 1 ]; then
  pw resize 1280 800 >/dev/null || fail "browser: resize to 1280x800"

  # --- 2. the landing page, English ------------------------------------------------------------
  wait_eval 'document.documentElement.lang' en "landing: a fresh visitor gets <html lang=en> (browser locale en-US)"
  assert_text "$EN_HEADLINE" 'eval:document.querySelector("h1")?.innerText'
  assert_text "$EN_CREDIT"
  assert_text "$EN_DEDICATION"
  wait_eval 'document.querySelector("aside").innerText.replace(/\s+/g, " ")' "60 $EN_SUMMARY $EN_CREDIT $EN_DEDICATION" \
    "landing: the dark card reads '60' + '$EN_SUMMARY' + the credit + the dedication"
  wait_stats "landing: the stat strip left its skeleton (4 numbers)"
  eval_jq "$STATS_JS" '[.[][1] | gsub("[^0-9]"; "") | tonumber] == [$a.drills, $a.tracks, $a.contributions, $a.sports]' \
    "landing: the strip's DOM numbers equal the API response (drills, tracks, contributions, sports)" --argjson a "${STATS:-null}"
  eval_jq "$STATS_JS" '.[0] == ["Open drills", "60"] and .[1] == ["Skill tracks", "5"]' \
    "landing: the strip shows 60 drills and 5 tracks (from GET /api/commons/stats, which sqlite_count confirms)"
  eval_jq "$STATS_JS" '.[0][1] == $d and .[1][1] == $t' "landing: the strip's drills/tracks equal sqlite_count" \
    --arg d "$DB_DRILLS" --arg t "$DB_TRACKS"
  eval_jq "$NAV_JS" ". == $EN_NAV" "landing: the navigation reads Open Commons and Start (a signed-out visitor sees no player tabs)"
  # No console error on load (the only run of this check: later pages are not part of the landing).
  out=$(pw console error) || true
  n=$(jq -r '.result // ""' <<<"$out" | grep -oE 'Errors: [0-9]+' | head -n1 | grep -oE '[0-9]+')
  if [ "${n:-x}" = 0 ]; then pass "landing: 0 console errors on load"
  else fail "landing: 0 console errors on load (got '${n:-unparsed}')" "$(jq -r '.result // .' <<<"$out" | head -n 12)"; fi

  # --- 3. the call budget: what the browser really requested since the page opened --------------
  reqs=$(api_reqs)
  reqlist=$'  every /api request the browser made on load (METHOD path status):\n'"$(sed 's/^/    /' <<<"${reqs:-(none)}")"
  landing_calls=$(grep -c '^GET /api/commons/stats ' <<<"$reqs")
  data_calls=$(grep -v ' /api/auth/' <<<"$reqs" | grep -c .)
  session_reads=$(grep -c '^GET /api/auth/get-session ' <<<"$reqs")
  auth_other=$(grep ' /api/auth/' <<<"$reqs" | grep -vc '^GET /api/auth/get-session ')
  assert_eq "$landing_calls" 1 "call budget: exactly 1 GET /api/commons/stats on load (the landing's own call)"
  if [ "$data_calls" = 1 ] && [ "$landing_calls" = 1 ]; then
    pass "call budget: exactly 1 non-auth /api request on load, and it is GET /api/commons/stats"
  else fail "call budget: exactly 1 non-auth /api request on load, and it is GET /api/commons/stats (saw $data_calls)" "$reqlist"; fi
  if [ "$session_reads" -le 1 ]; then pass "call budget: at most 1 session read (GET /api/auth/get-session) on load (saw $session_reads)"
  else fail "call budget: at most 1 session read (GET /api/auth/get-session) on load (saw $session_reads)" "$reqlist"; fi
  if [ "$auth_other" = 0 ]; then pass "call budget: no sign-in, sign-up or anonymous sign-in (any other /api/auth call) on a landing view"
  else fail "call budget: no sign-in, sign-up or anonymous sign-in (any other /api/auth call) on a landing view (saw $auth_other)" "$reqlist"; fi

  # --- 4. language switch: kk, ru, en, each surviving a reload ----------------------------------
  declare -A HEAD CARD
  CARD[en]=$(pw_eval 'document.querySelector("aside").innerText.replace(/\s+/g, " ")')
  HEAD[en]=$EN_HEADLINE
  switch_language() { # <kk|ru|en>: click the header language button, check the page follows, reload, check it stayed
    local code=$1 nav pressed
    pw click "button[lang=\"$code\"]" >/dev/null || fail "language $code: click the switch button[lang=$code]"
    wait_eval 'document.documentElement.lang' "$code" "language $code: <html lang> follows the click"
    wait_eval "document.querySelector('button[lang=\"$code\"]').getAttribute('aria-pressed')" true "language $code: its button is aria-pressed (not colour alone)"
    wait_eval 'localStorage.getItem("fc:lang")' "$code" "language $code: the choice is stored (localStorage fc:lang)"
    HEAD[$code]=$(pw_eval 'document.querySelector("h1").innerText')
    CARD[$code]=$(pw_eval 'document.querySelector("aside").innerText.replace(/\s+/g, " ")')
    nav=$(pw_eval "$NAV_JS")
    if [ "$code" = en ]; then
      assert_eq "${HEAD[en]}" "$EN_HEADLINE" "language en: the hero headline is the English one"
      assert_eq "$nav" "$(jq -c . <<<"$EN_NAV")" "language en: the navigation is the English one"
    else
      # structural (script tests run in the browser, so the shell's locale cannot skew them): not English, Cyrillic,
      # Kazakh-only letters in kk and none in ru
      if [ "${HEAD[$code]}" != "$EN_HEADLINE" ] && [ "$(pw_eval '/[\u0400-\u04FF]/.test(document.querySelector("h1").innerText)')" = true ]; then
        pass "language $code: the hero headline changed to Cyrillic text ('${HEAD[$code]}')"
      else fail "language $code: the hero headline changed to Cyrillic text" "  h1 is '${HEAD[$code]}'"; fi
      if [ "${CARD[$code]}" != "${CARD[en]}" ]; then pass "language $code: the dedication card copy changed"
      else fail "language $code: the dedication card copy changed" "  card is still '${CARD[$code]}'"; fi
      eval_jq "$NAV_JS" ".[1] != \"Start\" and length == 2" \
        "language $code: the navigation labels (Open Commons, Start) changed: $nav"
      kz=$(pw_eval '/[\u04D8\u04D9\u0492\u0493\u049A\u049B\u04A2\u04A3\u04E8\u04E9\u04B0\u04B1\u04AE\u04AF\u04BA\u04BB]/.test(document.querySelector("h1").innerText)')
      if [ "$code" = kk ]; then assert_eq "$kz" true "language kk: the headline uses Kazakh letters"
      else assert_eq "$kz" false "language ru: the headline is Russian, not Kazakh"; fi
    fi
    # the numbers are data, not copy: unchanged in every language; the labels are translated
    eval_jq "$STATS_JS" '[.[][1] | gsub("[^0-9]"; "") | tonumber] == [$a.drills, $a.tracks, $a.contributions, $a.sports]' \
      "language $code: the stat numbers still equal the API response" --argjson a "${STATS:-null}"
    # survives a reload
    pw reload >/dev/null || fail "language $code: reload"
    wait_eval 'document.documentElement.lang' "$code" "language $code: <html lang> is still $code after a reload"
    wait_eval 'document.querySelector("h1")?.innerText' "${HEAD[$code]}" "language $code: the hero headline is still the same after a reload"
    wait_eval "document.querySelector('button[lang=\"$code\"]').getAttribute('aria-pressed')" true "language $code: its button is still pressed after a reload"
  }
  switch_language kk
  eval_jq "$NAV_JS" 'length == 2' "language kk: the navigation still has its 2 links after the reload"
  switch_language ru
  if [ "${HEAD[kk]}" != "${HEAD[ru]}" ]; then pass "language: the kk and ru headlines differ"; else fail "language: the kk and ru headlines differ" "  both '${HEAD[kk]}'"; fi
  switch_language en

  # --- 5. START TRAINING and CONTRIBUTE ----------------------------------------------------------
  wait_eval 'document.querySelector("main a[href=\"/account/sign-in?redirect=%2Ftrain\"]").innerText' 'Start training' "START TRAINING: the primary button is a link to the sign-in gate (/account/sign-in?redirect=/train)"
  wait_eval 'document.querySelector("main a[href=\"/account/sign-in?redirect=%2Fcontribute\"]").innerText' 'Contribute' "CONTRIBUTE: the secondary button is a link to the sign-in gate (/account/sign-in?redirect=/contribute)"
  gate_mark=$(last_request_index) # checkpoint: only requests after this belong to the START TRAINING -> gate navigation, not the earlier language-switch reloads
  pw click 'main a[href="/account/sign-in?redirect=%2Ftrain"]' >/dev/null || fail "START TRAINING: click"
  wait_eval "$PATH_JS" /account/sign-in "START TRAINING: a signed-out visitor lands on /account/sign-in"
  wait_eval 'new URLSearchParams(location.search).get("redirect")' /train "START TRAINING: the sign-in page keeps ?redirect=/train"
  if doc_requests | grep -qxF 'GET /account/sign-in'; then pass "START TRAINING: the browser navigated to the sign-in gate (GET /account/sign-in)"
  else fail "START TRAINING: the browser navigated to the sign-in gate (GET /account/sign-in)" "$(doc_requests | sed 's/^/    /')"; fi
  pre_start_reqs=$(api_reqs_since "$gate_mark")
  if grep -qF '/api/player/' <<<"$pre_start_reqs"; then
    fail "gate: opening /train signed out makes no player API call before the redirect (no GET /api/player/today)" "$(sed 's/^/    /' <<<"${pre_start_reqs:-(none)}")"
  else pass "gate: opening /train signed out makes no player API call before the redirect (no GET /api/player/today)"; fi
  pre_start_session_reads=$(grep -c '^GET /api/auth/get-session ' <<<"$pre_start_reqs")
  if [ "$pre_start_session_reads" -le 1 ]; then pass "gate: the redirect to sign-in costs no extra session read (still at most 1 GET /api/auth/get-session)"
  else fail "gate: the redirect to sign-in costs no extra session read (still at most 1 GET /api/auth/get-session)" "$(sed 's/^/    /' <<<"${pre_start_reqs:-(none)}")"; fi
  pw click 'button:has-text("Start training")' >/dev/null || fail "START TRAINING: click Start"
  wait_eval "$PATH_JS" /train/onboarding "START TRAINING: pressing Start creates the player session and opens the onboarding wizard (/train/onboarding)"
  assert_text "Step" 'eval:document.querySelector("main").innerText'
  pw goto "$STACK_URL/" >/dev/null || fail "return to /"
  wait_eval "$PATH_JS" / "back on the landing page"
  pw click 'main a[href="/account/sign-in?redirect=%2Fcontribute"]' >/dev/null || fail "CONTRIBUTE: click"
  wait_eval "$PATH_JS" /account/sign-in "CONTRIBUTE: an anonymous visitor lands on /account/sign-in (the J5 contributor gate)"
  wait_eval 'new URLSearchParams(location.search).get("redirect")' /contribute "CONTRIBUTE: the sign-in page keeps ?redirect=/contribute (the way back after sign-in)"
  if doc_requests | grep -qxF 'GET /account/sign-in'; then pass "CONTRIBUTE: the browser navigated to the sign-in gate (GET /account/sign-in)"
  else fail "CONTRIBUTE: the browser navigated to the sign-in gate (GET /account/sign-in)" "$(doc_requests | sed 's/^/    /')"; fi
  echo "NOTE     the sign-in page for CONTRIBUTE renders: '$(pw_eval 'document.querySelector("h1")?.innerText ?? ""' 2>/dev/null)'"

  # --- 6. an unknown URL -------------------------------------------------------------------------
  pw goto "$STACK_URL/no-such-page-$RANDOM" >/dev/null || fail "open an unknown URL"
  wait_eval 'document.querySelector("h1")?.innerText' "$EN_NOT_FOUND" "404: an unknown URL shows the 404 page ('$EN_NOT_FOUND')"
  eval_jq 'JSON.stringify({header: !!document.querySelector("header nav"), footer: !!document.querySelector("footer"), links: [...document.querySelectorAll("main a, #main-content a")].map((a) => a.getAttribute("href"))})' \
    '.header and .footer and (.links | index("/") != null) and (.links | index("/train") != null)' \
    "404: the page keeps the shell (header navigation, footer) and links home (/) and to training (/train)"

  # --- 7. 360px: no horizontal scroll -------------------------------------------------------------
  pw resize 360 800 >/dev/null || fail "browser: resize to 360x800"
  for code in kk ru en; do
    pw goto "$STACK_URL/" >/dev/null || fail "360px: open /"
    wait_stats "360px ($code): the landing rendered its stat strip"
    pw click "button[lang=\"$code\"]" >/dev/null || fail "360px: switch to $code"
    wait_eval 'document.documentElement.lang' "$code" "360px: language $code selected"
    wait_eval '[window.innerWidth, document.documentElement.scrollWidth <= window.innerWidth, document.body.scrollWidth <= window.innerWidth].join()' \
      "360,true,true" "360px ($code): viewport 360 and no horizontal scroll (documentElement and body scrollWidth <= 360)"
  done
fi

# no explicit stop or summary: the EXIT handler stops the stack, prints the summary and sets the exit code
