#!/usr/bin/env bash
# apps/web/e2e/j1b-commons.sh: slice gate fc-mol-dzt, journey J1b "a visitor browses the Open Sport Commons and downloads the open dataset".
# Journey proof on the REAL stack, nothing mocked: the real API process on a fresh temp SQLite DB with the real seed, serving the real
# built web app on the same origin, driven by a real browser (playwright-cli). Own free port (the harness picks it); a process already
# holding :4111 or :5173 is neither used nor touched.
#
#   1. API + DB       60 published drills, all status COMMUNITY, source 'FIRST COACH Community Draft'; Dribbling + equipment 'ball' narrows to
#                     the same count in the API, in an independent jq count over the unfiltered list, and (step 4) in the browser
#   2. open Commons   from the landing page the 'Open Commons' navigation link opens /commons: the intro 'Sport knowledge as public
#                     infrastructure', the 'Download Commons JSON' and 'Contribute a method' actions, the count line says 'of 60'
#   3. call budget    browse -> detail on a fresh browser: at most 2 non-auth /api requests (GET /api/commons/drills, then
#                     GET /api/commons/drills/:slug), counted with `playwright-cli requests`
#   4. detail (en)    goal, numbered instructions, reps/time, common mistakes, make it harder, make it easier, the conditions block
#                     (equipment, where, partner, age), safety, author 'FIRST COACH Genesis', licence CC BY-SA 4.0, version history with
#                     1.0.0 and the 'Community Draft' badge: every text equals what GET /api/commons/drills/:slug returned
#   5. library        the visitor loads every page ('Show more drills'): 60 cards, each with the 'Community Draft' badge; Track Dribbling +
#                     Equipment Ball narrows the cards to the API's count and puts the filters in the URL; the URL survives a reload
#   6. download       'Download Commons JSON' saves export.json; ajv (draft 2020-12, strict) validates it against GET /api/commons/schema.json
#                     (apps/web/e2e/j1b-validate.mjs, ajv resolved from apps/api); 60 drills, each attributed; a corrupted copy is refused
#   7. kk / ru / en   the library and the detail screen in each language: the words of the messages bundles, the drill's own text in that
#                     language from the API, the 'Community Draft' badge in that language, and no 'undefined' anywhere on the page
#
# Readings of the criteria (where they were open; each is a comment here so a reviewer can disagree with it):
#   - "sees 60 drills": the API pages the list (default 20 per page, "Show more drills" follows nextCursor). The screen must announce all
#     60 ('of 60') on first paint and show 60 cards once the visitor has loaded the pages; the first paint alone is printed as a NOTE.
#   - "equipment 'Ball only'": the equipment facet value is `ball` (drills that need a ball and nothing else; `ball_wall` is 'Ball + wall'),
#     the option's label is 'Ball'. The filter is applied on that option.
#   - "reps/time": the page shows a 'Reps' row when the drill has reps and a 'Time' row when it has durationSec (a drill has either or both).
#   - "conditions": the 'At a glance' block (Equipment, Where, Partner and, when there is a lower age bound, Age).
#   - "version history with v1.0.0": the history lists the semver 1.0.0 (marked 'Current'); the API's history entry is `<slug>-v1.0.0`.
#   - The drill the journey opens is the first one on the first page that HAS every section (11 seeded drills have no 'harder' and 8 no
#     'easier': a section a drill does not have is not rendered, by design, so it cannot be asserted on that drill).
#   - "browse -> detail costs <= 2 API calls": Better Auth's session READ (GET /api/auth/get-session, no data) is not a data call, the same
#     reading as the j0 and j2 gates; the count starts after the landing page has settled.
#   - Kazakh and Russian text is judged against the messages bundles of the app (features/commons/*.messages.ts) AND structurally (script,
#     different from English): the Kazakh text awaits a native-speaker review and will change.
#
# Environment: E2E_WEB=off (API only) runs the API steps and records every browser step BLOCKED. No playwright-cli or no installed browser:
# the browser steps are BLOCKED (exit 3 unless E2E_ALLOW_BLOCKED=1). Exit codes: 0 all passed, 1 a FAIL, 3 BLOCKED.
# Fail-slow (no set -e): every step reports. Cleanup: e2e_defer only (never `trap ... EXIT` after sourcing lib.sh).
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
: "${E2E_TEXT_TIMEOUT:=10}" # a hard navigation plus a client fetch needs more than the 5 s default
source "$HERE/lib.sh"

SEED_SOURCE='FIRST COACH Community Draft'
AUTHOR='FIRST COACH Genesis'
EN_TITLE='Sport knowledge as public infrastructure'
EN_DOWNLOAD='Download Commons JSON'
EN_CONTRIBUTE='Contribute a method'
EN_DRAFT='Community Draft'
LIB_SEL='main ul[aria-label] > li'

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
# wait_quiet <js> <expected>: the same poll without a verdict (0 = reached, 1 = timed out); for waits that are not assertions.
wait_quiet() {
  local js=$1 want=$2 got="" deadline=$((SECONDS + E2E_TEXT_TIMEOUT))
  while :; do
    got=$(pw_eval "$js" 2>/dev/null) || true
    [ "$got" = "$want" ] && return 0
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 0.2
  done
}
# eval_jq <js> <jq filter> <label> [jq args...]: the page value (parsed as JSON) must make `jq -e <filter>` truthy.
eval_jq() {
  local js=$1 filter=$2 label=$3 got
  shift 3
  got=$(pw_eval "$js" 2>&1) || { fail "$label" "  JS failed: ${got:0:400}"; return 1; }
  if jq -e "$@" "$filter" >/dev/null 2>&1 <<<"$got"; then pass "$label"; else fail "$label" "  jq -e '$filter' failed on: ${got:0:600}"; fi
}
# has <haystack> <needle> <label>: fixed-string containment, with the page text printed on failure.
has() {
  case $1 in
    *"$2"*) pass "$3" ;;
    *) fail "$3" "  missing: $2"$'\n'"  in: ${1:0:700}" ;;
  esac
}
# lacks <haystack> <needle> <label>
lacks() {
  case $1 in
    *"$2"*) fail "$3" "  found: $2" ;;
    *) pass "$3" ;;
  esac
}
# calls_after <since-index>: the /api requests of the browser session after request number <since-index>, one "METHOD path status"
# per line (playwright-cli lists "N. [METHOD] url => [status] text"). Only the Better Auth session READ is left out (see the readings): any
# other /api/auth call (a sign-in, an anonymous sign-up) would count against the budget.
calls_after() {
  pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[([A-Z]+)\] https?:\/\/[^\/]+(\/api\/[^ ?]*)[^ ]* => \[([^]]+)\].*/\1 \2 \3 \4/p' |
    awk -v since="$1" '$1 > since && $3 != "/api/auth/get-session" { print $2, $3, $4 }'
}
last_request_index() { pw requests | jq -r '.result // ""' | sed -nE 's/^([0-9]+)\. \[.*/\1/p' | sort -n | tail -n1; }
# card_badges: [badge text of each card of the list] as JSON (null where a card has no badge).
CARD_BADGES_JS="JSON.stringify([...document.querySelectorAll('$LIB_SEL')].map((li) => li.querySelector('[data-status]:not(a)')?.innerText.trim() ?? null))"
MAIN_TEXT_JS='document.querySelector("main")?.innerText ?? ""'
BODY_TEXT_JS='document.body.innerText'
H2_JS='JSON.stringify([...document.querySelectorAll("main h2")].map((h) => h.innerText.trim()))'
cards_n() { pw_eval "document.querySelectorAll('$LIB_SEL').length"; }

start_stack || exit 1
scratch=$(mktemp -d) || exit 1
e2e_defer 'rm -rf "$scratch"'

# --- 1. API + DB ---------------------------------------------------------------------------------------------------------
LIST_ALL=$(api_get '/api/commons/drills?locale=en&limit=100') || LIST_ALL=""
LIST_P1=$(api_get '/api/commons/drills?locale=en') || LIST_P1=""
DB_DRILLS=$(sqlite_count drills 'unpublished_at IS NULL AND current_version_id IS NOT NULL') || DB_DRILLS=x
assert_eq "$DB_DRILLS" 60 "DB: 60 published drills (sqlite_count)"
assert_api '/api/commons/drills?locale=en&limit=100' '.total == 60 and (.items | length) == 60 and .nextCursor == null' \
  -l "API: GET /api/commons/drills lists 60 drills (total 60)"
assert_api '/api/commons/drills?locale=en&limit=100' \
  "[.items[] | select(.status == \"COMMUNITY\" and .source == \"$SEED_SOURCE\")] | length == 60" \
  -l "API: all 60 drills are status COMMUNITY with source '$SEED_SOURCE' (the 'Community Draft' badge)"
assert_api '/api/commons/drills?locale=en' '.total == 60 and (.items | length) > 0 and (.items | length) <= 100 and (.facets.skills | length) == 5 and (.facets | has("statuses", "equipment", "levels"))' \
  -l "API: the first page carries total 60 and the facets (items + facets in one response)"
FILT_TOTAL=$(api_get '/api/commons/drills?locale=en&skill=dribbling&equipment=ball&limit=100' | jq -r '.total // "x"') || FILT_TOTAL=x
FILT_JQ=$(jq -r '[.items[] | select(.track == "dribbling" and .equipment == "ball")] | length' <<<"${LIST_ALL:-null}" 2>/dev/null) || FILT_JQ=y
if [[ "$FILT_TOTAL" =~ ^[0-9]+$ ]] && [ "$FILT_TOTAL" -gt 0 ] && [ "$FILT_TOTAL" -lt 60 ]; then pass "API: Dribbling + ball is a real narrowing ($FILT_TOTAL of 60)"
else fail "API: Dribbling + ball is a real narrowing (between 1 and 59 of 60)" "  got total '$FILT_TOTAL'"; fi
assert_eq "$FILT_TOTAL" "$FILT_JQ" "API: the filtered total ($FILT_TOTAL) equals an independent count over the unfiltered list (track dribbling, equipment ball)"
assert_api '/api/commons/drills?locale=en&skill=dribbling&equipment=ball&limit=100' \
  '(.items | length) == .total and all(.items[]; .track == "dribbling" and .equipment == "ball")' -l "API: every filtered drill is Dribbling + ball"

# The drill the journey opens: the first drill of the first page that has every section and a dose (see the readings).
EXPORT=$(api_get /api/commons/export.json) || EXPORT=""
SLUG=$(jq -r --argjson p1 "${LIST_P1:-null}" '
  ([.sports[].drills[]] | map({key: .slug, value: .}) | from_entries) as $by
  | [$p1.items[].slug | $by[.] | select(. != null)
     | select((.content.mistakes | length) > 0 and (.content.progressions | length) > 0 and (.content.regressions | length) > 0
              and (.content.safety | length) > 0 and (.content.dose.reps != null or .content.dose.durationSec != null))
     | .slug][0] // ""' <<<"${EXPORT:-null}" 2>/dev/null) || SLUG=""
if [ -n "$SLUG" ]; then pass "the journey opens '$SLUG' (first drill of the first page with every section)"
else fail "a drill with every section exists on the first page of the list"; SLUG=none; fi
DETAIL_EN=$(api_get "/api/commons/drills/$SLUG?locale=en") || DETAIL_EN=""
assert_api "/api/commons/drills/$SLUG?locale=en" \
  '.attribution.author == "'"$AUTHOR"'" and .attribution.license == "CC-BY-SA-4.0" and (.history | map(.semver) | index("1.0.0")) != null and (.history[0].versionId | endswith("-v1.0.0"))' \
  -l "API: the drill's attribution is '$AUTHOR', CC-BY-SA-4.0, and its history holds 1.0.0 (versionId ...-v1.0.0)"
for lc in kk ru en; do
  assert_api "/api/commons/drills/$SLUG?locale=$lc" '(.content.title | length) > 0 and (.content.goal | length) > 0' -l "API: the drill's title and goal come back in $lc"
done

# the messages bundles of the app, read from source (type imports are erased): the words each language must show
MSG=$(bun -e '
  const dir = process.argv[1] + "/apps/web/src/features/commons/";
  const load = async (f) => (await import(dir + f)).default;
  console.log(JSON.stringify({ library: await load("library.messages.ts"), detail: await load("detail.messages.ts"), trust: await load("trust-badge.messages.ts") }));
' "$E2E_REPO_ROOT" 2>"$scratch/msg.err") || MSG=""
if jq -e '.library.kk.title and .library.ru.title and .library.en.title and .detail.kk.goal and .trust.ru.communityDraft' >/dev/null 2>&1 <<<"${MSG:-null}"; then
  pass "the kk/ru/en messages bundles of library, detail and trust-badge load ($(jq -c '[.library.en.title, .trust.en.communityDraft]' <<<"$MSG"))"
else fail "the kk/ru/en messages bundles of library, detail and trust-badge load" "$(head -c 400 "$scratch/msg.err")"; MSG=null; fi
msg() { jq -r "$1 // \"<missing $1>\"" <<<"$MSG"; } # msg <jq path>: one string of the bundles

# --- browser gate --------------------------------------------------------------------------------------------------------
BROWSER=1
STEPS="browser journey (open Commons, call budget, detail, library, filters, download, kk/ru/en)"
if [ "$E2E_WEB" = off ]; then
  BROWSER=0; blocked "$STEPS" "E2E_WEB=off: the web app is not served"
elif ! pw_available; then
  BROWSER=0; blocked "$STEPS" "playwright-cli is not installed"
elif ! pw_open /; then
  BROWSER=0; blocked "$STEPS" "the browser could not open the app"
fi

if [ "$BROWSER" = 1 ]; then
  pw resize 1280 800 >/dev/null || fail "browser: resize to 1280x800"

  # --- 2. open Commons from the landing page ---------------------------------------------------------------------------
  wait_eval 'document.documentElement.lang' en "landing: a fresh visitor gets <html lang=en> (browser locale en-US)"
  wait_eval 'document.querySelectorAll("section[aria-busy=\"false\"] ul li").length' 4 "landing: the page settled (stat strip loaded) before the call count starts"
  IDX0=$(last_request_index); IDX0=${IDX0:-0}
  eval_jq 'JSON.stringify([...document.querySelectorAll("header nav a")].map((a) => [a.getAttribute("href"), a.innerText.trim()]))' \
    'any(.[]; . == ["/commons", "Open Commons"])' "landing: the navigation has the 'Open Commons' link to /commons"
  pw click 'header nav a[href="/commons"]' >/dev/null || fail "click the 'Open Commons' navigation link"
  wait_eval 'location.pathname' /commons "the visitor lands on /commons"
  wait_eval 'document.querySelector("main h1")?.innerText' "$EN_TITLE" "library: the header reads '$EN_TITLE'"
  wait_quiet "(document.querySelector('main p[aria-live]')?.innerText ?? '').replace(/[0-9]+/, 'N')" 'Showing N of 60' || true
  LIB=$(pw_eval "$MAIN_TEXT_JS") || LIB=""
  has "$LIB" 'Sport knowledge as public infrastructure' "library: the intro 'Sport knowledge as public infrastructure'"
  has "$LIB" "$EN_DOWNLOAD" "library: the '$EN_DOWNLOAD' action"
  has "$LIB" "$EN_CONTRIBUTE" "library: the '$EN_CONTRIBUTE' action"
  eval_jq "JSON.stringify([...document.querySelectorAll('main a')].map((a) => [a.getAttribute('href'), a.innerText.trim(), a.hasAttribute('download')]))" \
    'any(.[]; . == ["/api/commons/export.json", "'"$EN_DOWNLOAD"'", true]) and any(.[]; . == ["/contribute", "'"$EN_CONTRIBUTE"'", false])' \
    "library: '$EN_DOWNLOAD' is a download link to /api/commons/export.json, '$EN_CONTRIBUTE' a link to /contribute"
  FIRST_N=$(cards_n)
  eval_jq "JSON.stringify(document.querySelector('main p[aria-live]').innerText)" 'test("^Showing [0-9]+ of 60$")' "library: the count line announces all 60 drills ('Showing N of 60')"
  echo "NOTE     the first paint shows $FIRST_N of 60 cards (the API pages its list); step 5 loads every page"

  # --- 3. the call budget: browse -> detail ----------------------------------------------------------------------------
  pw click "a[href=\"/commons/$SLUG\"]" >/dev/null || fail "click the card of $SLUG"
  wait_eval 'location.pathname' "/commons/$SLUG" "the card opens /commons/$SLUG (client navigation)"
  TITLE_EN=$(jq -r '.content.title.en // ""' <<<"${DETAIL_EN:-null}")
  wait_eval 'document.querySelector("main h1")?.innerText' "$TITLE_EN" "detail: the heading is the drill's title ('$TITLE_EN')"
  CALLS=$(calls_after "$IDX0")
  NCALLS=$(grep -c . <<<"$CALLS")
  calllist=$'  every non-auth /api request since the landing page settled (METHOD path status):\n'"$(sed 's/^/    /' <<<"${CALLS:-(none)}")"
  if [ "$NCALLS" -le 2 ]; then pass "call budget: browse -> detail made $NCALLS non-auth /api calls (<= 2)"
  else fail "call budget: browse -> detail made $NCALLS non-auth /api calls (<= 2)" "$calllist"; fi
  if [ "$(grep -c '^GET /api/commons/drills 200$' <<<"$CALLS")" = 1 ] && [ "$(grep -c "^GET /api/commons/drills/$SLUG 200\$" <<<"$CALLS")" = 1 ]; then
    pass "call budget: they are exactly GET /api/commons/drills (the list with its facets) and GET /api/commons/drills/$SLUG"
  else fail "call budget: they are exactly GET /api/commons/drills and GET /api/commons/drills/$SLUG, both 200" "$calllist"; fi

  # --- 4. the drill detail (en): every text equals the API's -----------------------------------------------------------
  DET=$(pw_eval "$MAIN_TEXT_JS") || DET=""
  j() { jq -r "$1" <<<"${DETAIL_EN:-null}"; }
  eval_jq "$H2_JS" '. == ["Goal", "At a glance", "Safety", "How to do it", "Common mistakes", "Make it harder", "Make it easier", "Who checked this drill", "Where this drill comes from", "Version history"]' \
    "detail: the sections are Goal, At a glance, Safety, How to do it, Common mistakes, Make it harder, Make it easier, review, attribution, Version history"
  has "$DET" "$(j '.content.goal.en')" "detail: the goal"
  n=0
  while IFS= read -r step; do
    n=$((n + 1)); has "$DET" "$step" "detail: instruction $n is shown ('${step:0:40}...')"
  done < <(jq -r '.content.instructions.en | split("\n") | map(gsub("^\\s*[0-9]+\\s*[.)]\\s*"; "") | gsub("\\s+$"; "")) | map(select(. != "")) | .[]' <<<"${DETAIL_EN:-null}")
  [ "$n" -ge 2 ] && pass "detail: the instructions have $n steps" || fail "detail: the instructions have several steps" "  got $n"
  eval_jq "document.querySelectorAll('main ol > li').length" ". == $n" "detail: the instructions are one numbered-list item per step ($n)"
  if [ "$(j '.content.dose.reps // empty')" != "" ]; then
    has "$DET" "Reps"$'\n'"$(j '.content.dose.reps')" "detail: the 'Reps' row (the drill has reps: $(j '.content.dose.reps'))"
  fi
  if [ "$(j '.content.dose.durationSec // empty')" != "" ]; then
    has "$DET" "Time"$'\n'"$(j '.content.dose.durationSec') s" "detail: the 'Time' row ($(j '.content.dose.durationSec') s)"
  fi
  for row in Equipment Where Partner; do has "$DET" "$row"$'\n' "detail: the conditions row '$row'"; done
  if [ "$(j '.content.conditions.ageMin // 0')" -gt 0 ]; then has "$DET" $'Age\nfrom '"$(j '.content.conditions.ageMin')" "detail: the conditions row 'Age' (from $(j '.content.conditions.ageMin'))"; fi
  for field in safety mistakes progressions regressions; do
    m=0
    while IFS= read -r line; do
      m=$((m + 1)); has "$DET" "$line" "detail: $field $m is shown ('${line:0:40}...')"
    done < <(jq -r ".content.$field[].en" <<<"${DETAIL_EN:-null}")
    [ "$m" -ge 1 ] || fail "detail: the drill has $field (the journey opens a drill with every section)"
  done
  has "$DET" "$AUTHOR" "detail: the author '$AUTHOR'"
  has "$DET" $'Licence\nCC BY-SA 4.0' "detail: the licence 'CC BY-SA 4.0'"
  eval_jq "JSON.stringify([...document.querySelectorAll('main a')].filter((a) => a.innerText.trim() === 'CC BY-SA 4.0').map((a) => a.href))" \
    'length == 1 and (.[0] | startswith("https://creativecommons.org/licenses/by-sa/4.0"))' "detail: the licence names CC BY-SA 4.0 and links to its legal text"
  has "$DET" "$SEED_SOURCE" "detail: the source '$SEED_SOURCE'"
  eval_jq "JSON.stringify([...document.querySelectorAll('main [data-status]:not(a)')].map((e) => e.innerText.trim()))" \
    "length >= 1 and .[0] == \"$EN_DRAFT\"" "detail: the badge reads '$EN_DRAFT'"
  eval_jq "JSON.stringify([...document.querySelectorAll('main section')].filter((s) => s.querySelector('h2')?.innerText.trim() === 'Version history').map((s) => [...s.querySelectorAll('li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim()))[0] ?? [])" \
    '(length >= 1) and (.[0] | startswith("1.0.0 Current"))' "detail: the version history lists 1.0.0 as the current version (API history entry ...-v1.0.0)"
  lacks "$DET" undefined "detail: no 'undefined' on the page (en)"
  # an unknown slug shows the not-found state, not a blank page (the visitor's dead end)
  pw goto "$STACK_URL/commons/no-such-drill-$RANDOM" >/dev/null || fail "open an unknown drill"
  wait_eval 'document.querySelector("main h1")?.innerText' Drill "detail: an unknown slug still renders the screen (h1 'Drill')"
  assert_text 'We could not find this drill' 'eval:document.querySelector("main")?.innerText'

  # --- 5. the library: 60 cards, badges, filters in the URL ------------------------------------------------------------
  pw goto "$STACK_URL/commons" >/dev/null || fail "open /commons"
  wait_eval 'document.querySelector("main h1")?.innerText' "$EN_TITLE" "library: /commons opened again"
  wait_quiet "document.querySelectorAll('$LIB_SEL').length > 0" true || true
  for _ in 1 2 3 4 5 6; do
    have=$(cards_n)
    [ "$(pw_eval '[...document.querySelectorAll("main button")].some((b) => b.innerText.trim() === "Show more drills")')" = true ] || break
    pw click "getByRole('button', { name: 'Show more drills' })" >/dev/null || { fail "click 'Show more drills'"; break; }
    wait_quiet "document.querySelectorAll('$LIB_SEL').length > $have" true || { fail "'Show more drills' brought more cards (had $have)"; break; }
  done
  assert_eq "$(cards_n)" 60 "library: 60 drill cards once every page is loaded"
  eval_jq "JSON.stringify(document.querySelector('main p[aria-live]').innerText)" '. == "Showing 60 of 60"' "library: the count line reads 'Showing 60 of 60'"
  eval_jq "$CARD_BADGES_JS" "length == 60 and all(.[]; . == \"$EN_DRAFT\")" "library: each of the 60 cards has a '$EN_DRAFT' status badge"
  eval_jq "JSON.stringify(new Set([...document.querySelectorAll('$LIB_SEL a')].map((a) => a.getAttribute('href'))).size)" '. == 60' "library: the 60 cards are 60 different drills"
  eval_jq "JSON.stringify([...document.querySelectorAll('$LIB_SEL')].filter((li) => li.innerText.includes('Source: $SEED_SOURCE') && li.innerText.includes('Licence: CC BY-SA 4.0')).length)" '. == 60' \
    "library: each card names its source and licence (CC BY-SA 4.0)"
  eval_jq "JSON.stringify([...document.querySelectorAll('main select')].map((s) => [s.labels[0]?.innerText.trim(), [...s.options].map((o) => o.text)]))" \
    'map(.[0]) == ["Track", "Status", "Equipment", "Level"] and (.[0][1] | index("Dribbling")) != null and (.[2][1] | index("Ball")) != null' \
    "library: the filters Track, Status, Equipment and Level are built from the facets (Dribbling, Ball among the options)"

  pw select "getByLabel('Track')" dribbling >/dev/null || fail "select Track = Dribbling"
  pw select "getByLabel('Equipment')" ball >/dev/null || fail "select Equipment = Ball"
  wait_eval "document.querySelector('main p[aria-live]')?.innerText" "Showing $FILT_TOTAL of $FILT_TOTAL" "filters: the count line reads 'Showing $FILT_TOTAL of $FILT_TOTAL' (the API's count for Dribbling + Ball)"
  assert_eq "$(cards_n)" "$FILT_TOTAL" "filters: Dribbling + Ball narrows the cards from 60 to $FILT_TOTAL, the count the API returns"
  eval_jq "JSON.stringify([...document.querySelectorAll('$LIB_SEL')].map((li) => li.innerText))" \
    "length == $FILT_TOTAL and all(.[]; contains(\"DRIBBLING\") and contains(\"Equipment: Ball\") and (contains(\"Ball +\") | not))" "filters: every remaining card is a Dribbling drill that needs Ball"
  eval_jq "JSON.stringify([...document.querySelectorAll('$LIB_SEL a')].map((a) => a.getAttribute('href')).sort())" \
    ". == $(jq -c '[.items[] | select(.track == "dribbling" and .equipment == "ball") | "/commons/" + .slug] | sort' <<<"${LIST_ALL:-null}")" "filters: the remaining cards are exactly the drills the API lists for Dribbling + ball"
  eval_jq 'JSON.stringify(Object.fromEntries(new URLSearchParams(location.search)))' '. == {"skill": "dribbling", "equipment": "ball"}' "filters: they live in the URL (?skill=dribbling&equipment=ball), so the view is shareable"
  eval_jq "$CARD_BADGES_JS" "all(.[]; . == \"$EN_DRAFT\")" "filters: the filtered cards keep their '$EN_DRAFT' badge"
  pw reload >/dev/null || fail "reload the filtered view"
  wait_eval "document.querySelector('main p[aria-live]')?.innerText" "Showing $FILT_TOTAL of $FILT_TOTAL" "filters: after a reload of the shared URL the same $FILT_TOTAL drills show"
  eval_jq "JSON.stringify([...document.querySelectorAll('main select')].map((s) => s.options[s.selectedIndex].text))" \
    '.[0] == "Dribbling" and .[2] == "Ball"' "filters: the selects show Dribbling and Ball after the reload"

  # --- 6. Download Commons JSON ----------------------------------------------------------------------------------------
  DL="$scratch/commons-export.json"
  out=$(pw run-code "async page => { const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: '$EN_DOWNLOAD' }).click()]); await dl.saveAs('$DL'); return JSON.stringify({ name: dl.suggestedFilename(), url: dl.url(), failure: await dl.failure() }); }") \
    || { fail "download: press '$EN_DOWNLOAD'" "  $(jq -r '.error // .' <<<"$out" 2>/dev/null | head -n 8)"; }
  res=$(jq -r '.result | (try fromjson catch .) | if type == "string" then (try fromjson catch "{}") else . end | tojson' <<<"${out:-null}" 2>/dev/null || echo '{}')
  if jq -e '.name == "export.json" and (.url | endswith("/api/commons/export.json")) and .failure == null' >/dev/null 2>&1 <<<"$res"; then
    pass "download: '$EN_DOWNLOAD' saved export.json from /api/commons/export.json"
  else fail "download: '$EN_DOWNLOAD' saved export.json from /api/commons/export.json" "  browser reported: $res"; fi
  if [ -s "$DL" ] && jq -e . "$DL" >/dev/null 2>&1; then pass "download: the saved file is non-empty JSON ($(wc -c <"$DL") bytes)"; else fail "download: the saved file is non-empty JSON"; fi
  curl -s --max-time "$E2E_HTTP_TIMEOUT" "$API_URL/api/commons/schema.json" -o "$scratch/schema.json" -D "$scratch/schema.hdr" || fail "GET /api/commons/schema.json"
  grep -qi '^content-type: application/json' "$scratch/schema.hdr" && pass "API: schema.json is served as application/json" || fail "API: schema.json is served as application/json" "$(head -n 6 "$scratch/schema.hdr")"
  jq -e '."$schema" == "https://json-schema.org/draft/2020-12/schema" and .type == "object" and (.properties | has("sports", "attribution_notice", "license"))' "$scratch/schema.json" >/dev/null 2>&1 \
    && pass "API: schema.json is a JSON Schema (draft 2020-12) of the export" || fail "API: schema.json is a JSON Schema (draft 2020-12) of the export"
  if vout=$(bun "$HERE/j1b-validate.mjs" "$scratch/schema.json" "$DL" 2>"$scratch/validate.err"); then
    if jq -e '.valid == true' >/dev/null 2>&1 <<<"$vout"; then pass "download: the saved file validates against /api/commons/schema.json (ajv, draft 2020-12, strict)"
    else fail "download: the saved file validates against /api/commons/schema.json (ajv)" "  $(jq -c '.errors' <<<"$vout")"; fi
    jq -e '.drills == 60 and .sports >= 1' >/dev/null 2>&1 <<<"$vout" && pass "download: the file holds 60 drills" || fail "download: the file holds 60 drills" "  $vout"
    jq -e '.unattributed == []' >/dev/null 2>&1 <<<"$vout" && pass "download: every drill has an author, a source and a licence" || fail "download: every drill has an author, a source and a licence" "  unattributed: $(jq -c '.unattributed' <<<"$vout")"
  else
    fail "download: ajv validation could not run (helper j1b-validate.mjs; ajv is a dependency of apps/api)" "$(head -c 500 "$scratch/validate.err")"
  fi
  # the check is not vacuous: a copy with a drill stripped of its author is refused by the same schema
  jq '.sports[0].drills[0].attribution.author = ""' "$DL" >"$scratch/bad-export.json" 2>/dev/null
  vbad=$(bun "$HERE/j1b-validate.mjs" "$scratch/schema.json" "$scratch/bad-export.json" 2>/dev/null) || vbad=""
  jq -e '.valid == false and (.errors | length) > 0' >/dev/null 2>&1 <<<"$vbad" && pass "download: control, a copy with an empty author is REFUSED by ajv (the validation can fail)" || fail "download: control, a copy with an empty author is refused by ajv" "  $vbad"
  jq -e --arg a "$AUTHOR" '
      .license == "CC-BY-SA-4.0" and (.attribution_notice | test("CC BY-SA 4.0")) and (.attribution_notice | test("FIRST COACH"))
      and ([.sports[].drills[]] | length == 60)
      and all(.sports[].drills[]; .attribution.author == $a and .attribution.license == "CC-BY-SA-4.0" and (.attribution.source | length > 0) and (.attribution.semver | length > 0))' \
    "$DL" >/dev/null 2>&1 && pass "download: top-level licence CC-BY-SA-4.0 and attribution notice; all 60 drills credit '$AUTHOR' under CC-BY-SA-4.0" \
    || fail "download: top-level licence and attribution notice; all 60 drills credit '$AUTHOR' under CC-BY-SA-4.0"
  jq -e 'all(.sports[].drills[]; (.content.title | has("kk", "ru", "en")) and all(.content.title[]; length > 0) and (.content.goal | has("kk", "ru", "en")))' "$DL" >/dev/null 2>&1 \
    && pass "download: every drill carries its title and goal in kk, ru and en" || fail "download: every drill carries its title and goal in kk, ru and en"
  if cmp -s "$DL" <(api_get /api/commons/export.json); then pass "download: the saved file is byte-for-byte what GET /api/commons/export.json serves"
  else fail "download: the saved file is byte-for-byte what GET /api/commons/export.json serves"; fi

  # --- 7. kk, ru, en: library and detail, no 'undefined' ---------------------------------------------------------------
  unset LANG_HEAD; declare -A LANG_HEAD
  check_language() { # <kk|ru|en>
    local lc=$1 title draft dl contribute summary pat line tt goal txt
    pw click "button[lang=\"$lc\"]" >/dev/null || fail "language $lc: click the switch button[lang=$lc]"
    wait_eval 'document.documentElement.lang' "$lc" "language $lc: <html lang> follows the click"
    # -- the library
    pw goto "$STACK_URL/commons" >/dev/null || fail "language $lc: open /commons"
    title=$(msg ".library.$lc.title"); draft=$(msg ".trust.$lc.communityDraft"); dl=$(msg ".library.$lc.download"); contribute=$(msg ".library.$lc.contribute")
    wait_eval 'document.querySelector("main h1")?.innerText' "$title" "language $lc: the library header reads '$title'"
    wait_quiet "document.querySelectorAll('$LIB_SEL').length > 0" true || true
    LANG_HEAD[$lc]=$title
    txt=$(pw_eval "$BODY_TEXT_JS") || txt=""
    lacks "$txt" undefined "language $lc: no 'undefined' on the library page"
    has "$txt" "$(msg ".library.$lc.intro")" "language $lc: the library intro"
    has "$txt" "$dl" "language $lc: the download action '$dl'"
    has "$txt" "$contribute" "language $lc: the contribute action '$contribute'"
    for f in track status equipment level search; do has "$txt" "$(msg ".library.$lc.filter.$f")" "language $lc: the filter label '$(msg ".library.$lc.filter.$f")'"; done
    summary=$(msg ".library.$lc.summary")
    pat=${summary//\{\{shown\}\}/[0-9]+}; pat="^${pat//\{\{total\}\}/60}\$"
    line=$(pw_eval "document.querySelector('main p[aria-live]')?.innerText") || line=""
    if [[ "$line" =~ $pat ]]; then pass "language $lc: the count line follows '$summary' with 60 in total ('$line')"
    else fail "language $lc: the count line follows '$summary' with 60 in total" "  got '$line', expected /$pat/"; fi
    eval_jq "$CARD_BADGES_JS" "length > 0 and all(.[]; . == \"$draft\")" "language $lc: every card's badge reads '$draft'"
    eval_jq "JSON.stringify([document.documentElement.scrollWidth <= window.innerWidth])" '. == [true]' "language $lc: no horizontal scroll on the library at 1280px"
    if [ "$lc" != en ]; then
      eval_jq "JSON.stringify([document.querySelector('main h1').innerText, document.querySelector('$LIB_SEL h2').innerText, document.querySelector('$LIB_SEL [data-status]:not(a)').innerText])" \
        'all(.[]; test("[Ѐ-ӿ]"))' "language $lc: the title, the first drill's title and the badge are Cyrillic"
      [ "$title" != "$EN_TITLE" ] && pass "language $lc: the library title differs from English" || fail "language $lc: the library title differs from English"
    fi
    # the drill titles arrive from the API in the language: the first card's title is the API's
    first=$(api_get "/api/commons/drills?locale=$lc" | jq -r '.items[0].title["'"$lc"'"] // ""')
    wait_eval "document.querySelector('$LIB_SEL h2')?.innerText" "$first" "language $lc: the first card's title is the API's ('$first')"
    # -- the detail screen
    pw goto "$STACK_URL/commons/$SLUG" >/dev/null || fail "language $lc: open /commons/$SLUG"
    local detail; detail=$(api_get "/api/commons/drills/$SLUG?locale=$lc") || detail=""
    tt=$(jq -r ".content.title[\"$lc\"] // \"\"" <<<"${detail:-null}"); goal=$(jq -r ".content.goal[\"$lc\"] // \"\"" <<<"${detail:-null}")
    wait_eval 'document.querySelector("main h1")?.innerText' "$tt" "language $lc: the drill heading is the API's title ('$tt')"
    txt=$(pw_eval "$BODY_TEXT_JS") || txt=""
    lacks "$txt" undefined "language $lc: no 'undefined' on the detail page"
    has "$txt" "$goal" "language $lc: the goal is the API's text in $lc"
    has "$txt" "$AUTHOR" "language $lc: the author '$AUTHOR'"
    has "$txt" "CC BY-SA 4.0" "language $lc: the licence CC BY-SA 4.0"
    has "$txt" "1.0.0" "language $lc: the version 1.0.0 in the attribution and the history"
    eval_jq "$H2_JS" \
      ". == [\"$(msg ".detail.$lc.goal")\", \"$(msg ".detail.$lc.glance")\", \"$(msg ".detail.$lc.safety")\", \"$(msg ".detail.$lc.how")\", \"$(msg ".detail.$lc.mistakes")\", \"$(msg ".detail.$lc.harder")\", \"$(msg ".detail.$lc.easier")\", \"$(msg ".detail.$lc.trust.title")\", \"$(msg ".detail.$lc.source.title")\", \"$(msg ".detail.$lc.history.title")\"]" \
      "language $lc: the detail sections are Goal, glance, Safety, How, Mistakes, Harder, Easier, review, attribution, history (in $lc)"
    eval_jq "JSON.stringify([...document.querySelectorAll('main [data-status]:not(a)')].map((e) => e.innerText.trim())[0] ?? '')" ". == \"$draft\"" "language $lc: the detail badge reads '$draft'"
    has "$txt" "$(msg ".detail.$lc.history.current")" "language $lc: the version history marks the current version ('$(msg ".detail.$lc.history.current")')"
    eval_jq "JSON.stringify([document.documentElement.scrollWidth <= window.innerWidth])" '. == [true]' "language $lc: no horizontal scroll on the detail screen at 1280px"
  }
  check_language kk
  check_language ru
  if [ "${LANG_HEAD[kk]:-a}" != "${LANG_HEAD[ru]:-a}" ] && [ "${LANG_HEAD[ru]:-a}" != "${LANG_HEAD[en]:-b}" ]; then pass "language: the kk and ru library titles differ from each other"
  else fail "language: the kk and ru library titles differ from each other" "  kk '${LANG_HEAD[kk]:-}' ru '${LANG_HEAD[ru]:-}'"; fi
  check_language en
  # the download control in kk and ru: the link is the same file, its label is translated
  for lc in kk ru; do
    dl=$(msg ".library.$lc.download")
    pw click "button[lang=\"$lc\"]" >/dev/null || fail "language $lc: switch for the download link"
    pw goto "$STACK_URL/commons" >/dev/null || fail "language $lc: open /commons"
    wait_eval "[...document.querySelectorAll('main a[download]')].map((a) => a.innerText.trim() + '|' + a.getAttribute('href')).join()" "$dl|/api/commons/export.json" \
      "language $lc: the download link reads '$dl' and still points at /api/commons/export.json"
  done
  pw click 'button[lang="en"]' >/dev/null || true
  # console: the whole journey produced no console error
  out=$(pw console error) || true
  n=$(jq -r '.result // ""' <<<"$out" | grep -oE 'Errors: [0-9]+' | head -n1 | grep -oE '[0-9]+')
  if [ "${n:-x}" = 0 ]; then pass "browser: 0 console errors in the whole journey"
  else fail "browser: 0 console errors in the whole journey (got '${n:-unparsed}')" "$(jq -r '.result // .' <<<"$out" | head -n 12)"; fi
fi

# no explicit stop or summary: the EXIT handler stops the stack, prints the summary and sets the exit code
