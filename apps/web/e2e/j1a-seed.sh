#!/usr/bin/env bash
# apps/web/e2e/j1a-seed.sh: slice gate fc-mol-07f, journey J1a "the Open Sport Commons seed loads".
# Integration proof on the REAL stack (real API process, real SQLite file, no mocks, no browser, no OpenAI key):
#   1. boot on an empty DB applies the migrations (001_commons and every later file) and loads the seed
#   2. sqlite_count: 1 sport, 5 top-level skills, >= 15 sub-skill nodes, 5 skill tests, 60 drills, 60 published
#      versions, all COMMUNITY and CC-BY-SA-4.0
#   3. restarting the API on the same DB leaves every count unchanged (idempotent)
#   4. a seed with a prerequisite cycle makes the boot FAIL with a clear error, and the DB is untouched
#   5. editing one drill's text in a temp copy of the seed and rebooting adds version 1.0.1; 1.0.0 stays readable
# Fail-slow (no set -e): every step reports. Cleanup: e2e_defer (never `trap ... EXIT` after sourcing lib.sh).
# There is no web step: apps/web has no library route yet.
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$HERE/lib.sh"

SEED_SRC="$E2E_REPO_ROOT/config/commons"
MIGRATIONS="$E2E_REPO_ROOT/apps/api/src/db/migrations"
unset SEED_DIR   # the API must start on the repo's default seed unless a step says otherwise

scratch=$(mktemp -d) || exit 1
e2e_defer 'rm -rf "$scratch"'

# The harness has no public "restart the API on the same DB" (start_stack always wipes). Its private helpers
# do exactly that: same E2E_TMP / DB_PATH / port, extra env inherited by the child. Refuse loudly if they go away.
for fn in _e2e_kill _e2e_launch_api _e2e_wait_api; do
  declare -F "$fn" >/dev/null || { fail "harness helper $fn is missing (lib.sh changed); this gate needs a same-DB restart"; exit 1; }
done

# restart_api <seed dir | ""> : stop the API child, start it again on the SAME temp dir and DB with SEED_DIR set
# ("" = default seed). Returns _e2e_wait_api's code: 0 ready, 2 the process died during boot, 1 timeout.
restart_api() {
  local rc=0
  _e2e_kill "$E2E_API_PID"
  SEED_DIR="$1" _e2e_launch_api "$E2E_API_PORT_USED"
  _e2e_wait_api "$E2E_API_PID" "$E2E_TMP/api.log" "$E2E_API_PORT_USED" || rc=$?
  return "$rc"
}

# counts: one line with every number the criterion names, read from the real DB.
counts() {
  local pub="id IN (SELECT current_version_id FROM drills WHERE unpublished_at IS NULL)"
  echo "sports=$(sqlite_count sports)" \
    "top_skills=$(sqlite_count skills 'parent_id IS NULL')" \
    "sub_skills=$(sqlite_count skills 'parent_id IS NOT NULL')" \
    "tests=$(sqlite_count skill_tests)" \
    "drills=$(sqlite_count drills)" \
    "published_versions=$(sqlite_count drill_versions "$pub")" \
    "community_cc_by_sa=$(sqlite_count drill_versions "$pub AND status = 'COMMUNITY' AND license = 'CC-BY-SA-4.0'")" \
    "all_versions=$(sqlite_count drill_versions)"
}
EXPECTED="sports=1 top_skills=5 sub_skills=25 tests=5 drills=60 published_versions=60 community_cc_by_sa=60 all_versions=60"

# seed_log <jq predicate> <label>: the API's "seed loaded" log line (JSON) satisfies the predicate.
seed_log() {
  local line
  line=$(grep -m1 '"msg":"seed loaded"' "$E2E_TMP/api.log")
  if jq -e "$1" >/dev/null 2>&1 <<<"$line"; then pass "$2"; else fail "$2" "  seed line: ${line:-<none>}"; fi
}

# --- 1. first boot on an empty database ---------------------------------------------------------
start_stack || exit 1
assert_api /health '.ok == true and .database == "ok"' -l "boot on an empty DB: /health ok"
files=0
for f in "$MIGRATIONS"/*.sql; do
  name=$(basename "$f" .sql); files=$((files + 1))
  assert_eq "$(sqlite_count schema_migrations "name = '$name'")" 1 "migration $name recorded"
done
assert_eq "$(sqlite_count schema_migrations)" "$files" "schema_migrations holds exactly the $files migration files (001_commons first)"
assert_eq "$(sqlite_count schema_migrations "version = 1 AND name = '001_commons'")" 1 "migration 001_commons applied"
seed_log '.sports == 1 and .skills == 30 and .tests == 5 and .drills.inserted == 60 and .versions == 60' "first boot log: seed loaded 60 drills / 60 versions"

# --- 2. the counts the criterion names ----------------------------------------------------------
assert_eq "$(counts)" "$EXPECTED" "seed counts: 1 sport, 5 top skills, 25 sub-skills, 5 tests, 60 drills, 60 published versions, all COMMUNITY + CC-BY-SA-4.0"
subs=$(sqlite_count skills 'parent_id IS NOT NULL')
if [ "$subs" -ge 15 ]; then pass "sub-skill nodes ($subs) >= 15"; else fail "sub-skill nodes ($subs) >= 15"; fi
assert_api /api/commons/stats '.drills == 60 and .tracks == 5 and .sports == 1' -l "GET /api/commons/stats reports 60 drills / 5 tracks / 1 sport"

# --- 3. restart on the same DB: idempotent ------------------------------------------------------
restart_api "" ; assert_eq "$?" 0 "restart on the same DB: API ready again"
assert_eq "$(counts)" "$EXPECTED" "after restart every count is unchanged"
seed_log '.sports == 0 and .skills == 0 and .tests == 0 and .drills.unchanged == 60 and .drills.inserted == 0 and .drills.updated == 0 and .versions == 0' \
  "restart log: nothing written (60 drills unchanged, 0 new versions)"

# --- 4. a prerequisite cycle: boot must fail, the DB must stay as it was ------------------------
cp -r "$SEED_SRC" "$scratch/seed-cycle"
jq '(.nodes[] | select(.slug == "basic-touches") | .prerequisites) = [{"skill": "inside-touches", "minLevel": 2}]' \
  "$scratch/seed-cycle/football/skill-graph.json" >"$scratch/sg.json" && mv "$scratch/sg.json" "$scratch/seed-cycle/football/skill-graph.json"
# basic-touches now requires inside-touches, which already requires basic-touches
rc=0; restart_api "$scratch/seed-cycle" || rc=$?
assert_eq "$rc" 2 "cycle seed: the API process died during boot (did not start listening)"
cp "$E2E_TMP/api.log" "$scratch/cycle.log"
if kill -0 "$E2E_API_PID" 2>/dev/null; then fail "cycle seed: the API process has exited"; else pass "cycle seed: the API process has exited"; fi
if port_open "$E2E_API_PORT_USED"; then fail "cycle seed: nothing listens on port $E2E_API_PORT_USED"; else pass "cycle seed: nothing listens on port $E2E_API_PORT_USED"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$API_URL/health" 2>/dev/null || true)
if [ "$code" = 200 ]; then fail "cycle seed: /health does not answer" "  got HTTP 200"; else pass "cycle seed: /health does not answer (curl status '$code')"; fi
for needle in '"msg":"boot failed"' 'Boot hook 20-seed.boot.ts failed' 'Invalid seed' 'Cycle along prerequisites' 'football/skill-graph.json' 'basic-touches' 'inside-touches'; do
  if grep -qF -- "$needle" "$scratch/cycle.log"; then pass "cycle boot log names: $needle"; else fail "cycle boot log names: $needle" "$(tail -n 5 "$scratch/cycle.log" | cut -c1-600)"; fi
done
assert_eq "$(counts)" "$EXPECTED" "after the failed boot the earlier valid seed is untouched (no wipe, no half-load)"

# --- 5. edited drill text: new immutable version 1.0.1, 1.0.0 stays readable --------------------
cp -r "$SEED_SRC" "$scratch/seed-edit"
drill_file=$(find "$scratch/seed-edit/football/drills" -name '*.json' | sort | head -n 1)
slug=$(jq -r '.drills[0].slug' "$drill_file")
orig=$(jq -r '.drills[0].goal.en' "$drill_file")
jq --arg s "$slug" '(.drills[] | select(.slug == $s) | .goal.en) += " (edited)"' "$drill_file" >"$scratch/d.json" && mv "$scratch/d.json" "$drill_file"
cmp -s "$SEED_SRC/football/drills/$(basename "$drill_file")" "$drill_file" && fail "the temp seed copy really differs from the repo seed"
q() { printf '%s' "${1//\'/\'\'}"; }                       # SQL string literal body
did="(SELECT id FROM drills WHERE slug = '$slug')"

restart_api "$scratch/seed-edit" ; assert_eq "$?" 0 "boot on the edited seed copy: API ready"
seed_log '.drills.updated == 1 and .drills.unchanged == 59 and .drills.inserted == 0 and .versions == 1' "edited-seed log: exactly 1 drill updated, 59 unchanged"
assert_eq "$(sqlite_count drills)" 60 "still 60 drills"
assert_eq "$(sqlite_count drill_versions)" 61 "now 61 versions"
assert_eq "$(sqlite_count drill_versions "drill_id = $did")" 2 "the edited drill ($slug) has 2 versions"
assert_eq "$(sqlite_count drills "id IN (SELECT drill_id FROM drill_versions GROUP BY drill_id HAVING COUNT(*) > 1)")" 1 "exactly one drill has more than one version"
assert_eq "$(sqlite_count drill_versions "drill_id = $did AND semver = '1.0.1' AND status = 'COMMUNITY' AND parent_version_id = (SELECT id FROM drill_versions WHERE drill_id = $did AND semver = '1.0.0') AND json_extract(content, '\$.goal.en') = '$(q "$orig (edited)")'")" 1 \
  "version 1.0.1 has the edited text, status COMMUNITY, parent 1.0.0"
assert_eq "$(sqlite_count drill_versions "drill_id = $did AND semver = '1.0.0' AND status = 'COMMUNITY' AND json_extract(content, '\$.goal.en') = '$(q "$orig")'")" 1 \
  "version 1.0.0 is still there with the ORIGINAL text (immutable)"
assert_eq "$(sqlite_count drills "slug = '$slug' AND current_version_id IN (SELECT id FROM drill_versions WHERE semver = '1.0.1')")" 1 "the drill's current version is 1.0.1"
assert_eq "$(sqlite_count drill_versions "semver <> '1.0.0'")" 1 "every other drill still has only its 1.0.0"
assert_api "/api/commons/drills/$slug?locale=en" \
  ".versionId | endswith(\"-v1.0.1\")" -l "GET /api/commons/drills/$slug serves 1.0.1"
assert_api "/api/commons/drills/$slug?locale=en" \
  "(.history | map(.semver)) == [\"1.0.1\", \"1.0.0\"] and (.history[1].versionId | endswith(\"-v1.0.0\")) and (.content.goal.en | endswith(\" (edited)\"))" \
  -l "drill history lists 1.0.1 then 1.0.0 (newest first), current text is the edited one"
assert_api /api/commons/stats '.drills == 60 and .tracks == 5 and .sports == 1' -l "stats unchanged after the edit (60 drills)"
restart_api "$scratch/seed-edit" ; assert_eq "$?" 0 "reboot on the edited seed again: API ready"
assert_eq "$(sqlite_count drill_versions)" 61 "reboot on the same edited seed adds no version (still 61)"

# no explicit stop or summary: the EXIT handler stops the stack, prints the summary, sets the exit code
