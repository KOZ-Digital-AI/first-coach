#!/usr/bin/env bash
# Self-test for lib.sh: boots the real API (and the real built web app), exercises every helper
# against it, including the harness's own failure detection, then checks nothing is left behind.
#   bash apps/web/e2e/lib.test.sh        (any cwd; exit 0 = green, about 15 s)
# The core needs no browser. The browser checks run only when playwright-cli and a usable browser
# exist; otherwise they are recorded BLOCKED (printed in the summary) and only THIS script's own
# exit code tolerates that.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# a hermetic run: nothing from the caller's environment may change the topology under test
unset E2E_WEB E2E_WEB_DIST E2E_API_PORT E2E_API_ENTRY E2E_KEEP E2E_ARTIFACTS_DIR E2E_ALLOW_BLOCKED E2E_BOOT_TIMEOUT
# the API's fail-closed auth reads these; the harness owns them for its API child (see README)
unset NODE_ENV BETTER_AUTH_URL BETTER_AUTH_SECRET BETTER_AUTH_TRUSTED_ORIGINS
# shellcheck source=lib.sh
source "$HERE/lib.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/e2e-libtest.XXXXXX")"
mkdir "$WORK/tmp"
export TMPDIR="$WORK/tmp" # every temp dir lib.sh makes lands here, so leaks are countable
# shellcheck disable=SC2016  # e2e_defer evals these at exit, so single quotes are intended
e2e_defer 'rm -rf -- "$WORK"'
BUSY=""
# shellcheck disable=SC2016
e2e_defer '[ -z "$BUSY" ] || kill "$BUSY" 2>/dev/null || true'

# expect_fail <label> <command...>: passes when the command fails inside a subshell (its own
# pass/fail counters die with the subshell, so the suite's counters are untouched).
expect_fail() {
  local label=$1
  shift
  if ("$@") >/dev/null 2>&1; then fail "$label (the command succeeded but must fail)" || true; else pass "$label"; fi
}
alive() { kill -0 "$1" 2>/dev/null; }
is_unset() { [ -z "${!1+set}" ]; }
yes_if() { if "$@"; then echo yes; else echo no; fi; }
contains() { [[ $1 == *"$2"* ]]; }
# short poll so negative checks stay fast
quick_assert_text() { local E2E_TEXT_TIMEOUT=1; assert_text "$@"; }
# number of playwright-cli daemons for a session (its command line ends with the session name)
daemon_count() { ps -eo args= | awk -v s="$1" '$NF == s && /cliDaemon/ { n++ } END { print n + 0 }'; }
wait_for() { # <file that must become non-empty>, bounded
  local deadline=$((SECONDS + 15))
  until [ -s "$1" ]; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.05
  done
}
start_busy() { # a foreign bun server on a kernel-assigned port: sets BUSY (pid) and BUSY_PORT
  rm -f "$WORK/busy.port"
  bun -e 'const s = Bun.serve({ port: 0, fetch: () => new Response("busy") }); console.log(s.port); await Bun.sleep(120000);' >"$WORK/busy.port" &
  BUSY=$!
  wait_for "$WORK/busy.port"
  BUSY_PORT=$(head -n1 "$WORK/busy.port")
}
# run_child <script text>: a fresh bash started from `/` that sources the library. Sets CHILD_RC, CHILD_OUT.
run_child() {
  local rc=0
  CHILD_OUT=$(cd / && env -u E2E_ALLOW_BLOCKED bash -c "source '$HERE/lib.sh'; $1" 2>&1) || rc=$?
  CHILD_RC=$rc
}

# auth_probe <label prefix>: proves the running stack's Better Auth accepts the harness origin. Self-contained
# (only lib.sh helpers), so a child shell can source it too. Uses API_URL as the Origin, as a browser would.
cat >"$WORK/auth-probe.sh" <<'PROBE'
auth_probe() {
  local p=$1 out status cookie wrong right
  out=$(curl -s -i --max-time "$E2E_HTTP_TIMEOUT" -X POST "$API_URL/api/auth/sign-in/anonymous" \
    -H "Origin: $API_URL" -H 'Content-Type: application/json' -d '{}') || true
  status=$(head -n1 <<<"$out" | tr -d '\r' | cut -d' ' -f2)
  cookie=$(grep -i '^set-cookie: better-auth.session_token=' <<<"$out" | head -n1 | sed -E 's/^[^:]*: *([^;]*);.*/\1/' | tr -d '\r') || true
  assert_eq "$status" 200 "$p: anonymous sign-in with the harness Origin returns 200" || true
  assert_eq "$([ -n "$cookie" ] && echo yes || echo no)" yes "$p: the sign-in sets a better-auth.session_token cookie" || true
  wrong=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$E2E_HTTP_TIMEOUT" -X POST "$API_URL/api/auth/sign-out" \
    -H 'Origin: http://127.0.0.1:1' -H "Cookie: $cookie" -H 'Content-Type: application/json' -d '{}') || true
  assert_eq "$wrong" 403 "$p: a cookie with a WRONG Origin is refused 403 (the origin check is really on)" || true
  right=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$E2E_HTTP_TIMEOUT" -X POST "$API_URL/api/auth/sign-out" \
    -H "Origin: $API_URL" -H "Cookie: $cookie" -H 'Content-Type: application/json' -d '{}') || true
  assert_eq "$right" 200 "$p: a cookie with the harness Origin is accepted (BETTER_AUTH_URL == the harness origin)" || true
}
PROBE
# shellcheck source=/dev/null
source "$WORK/auth-probe.sh"

# --- 0. the port picker ------------------------------------------------------------------
FREE=$(_e2e_free_port)
assert_eq "$(yes_if test "$FREE" -ge 1024)" yes "the free port is unprivileged ($FREE)"
assert_eq "$(yes_if port_open "$FREE")" no "the free port is really free"

# --- 0b. fail-closed auth under the harness, API-only topology; a caller's NODE_ENV / BETTER_AUTH_URL cannot break it --------
# The child exports hostile values (production, a wrong URL) and no secret: the harness must still boot the API
# (NODE_ENV=development, BETTER_AUTH_URL=<its own origin>) and Better Auth must accept the harness origin.
run_child "export NODE_ENV=production BETTER_AUTH_URL=http://127.0.0.1:9; unset BETTER_AUTH_SECRET; . '$WORK/auth-probe.sh'; E2E_WEB=off start_stack && auth_probe 'web=off'"
[ "$CHILD_RC" -eq 0 ] || printf '%s\n' "$CHILD_OUT" >&2
assert_eq "$CHILD_RC|$(yes_if grep -Eq '^--- e2e summary: 4 passed, 0 failed, 0 blocked, web=off -- PASS' <<<"$CHILD_OUT")" "0|yes" "web=off: the API boots under fail-closed auth and accepts the harness origin, whatever NODE_ENV/BETTER_AUTH_URL the caller had" || true
assert_eq "$(yes_if contains "$CHILD_OUT" 'dev-only-better-auth-secret')" no "web=off: no secret is printed" || true

# --- 1. start_stack: the real API and the real built web, one origin --------------------------
start_stack
API_PORT=$E2E_API_PORT_USED
TMP_DIR=$E2E_TMP
API_PID=$E2E_API_PID
DIST=$E2E_WEB_DIST_USED
assert_eq "$E2E_WEB_MODE" api "default topology is web=api"
assert_eq "$STACK_URL" "$API_URL" "one origin: STACK_URL == API_URL"
assert_eq "$API_URL" "http://127.0.0.1:$API_PORT" "API_URL is built from the port"
assert_eq "$(yes_if test "$API_PORT" -ge 1024 -a "$API_PORT" != 4111)" yes "random unprivileged port, not the fixed default 4111 ($API_PORT)"
assert_eq "$DB_PATH" "$TMP_DIR/app.db" "DB_PATH is inside the temp dir"
assert_eq "$MEDIA_DIR" "$TMP_DIR/media" "MEDIA_DIR is inside the temp dir"
assert_eq "$(yes_if alive "$API_PID")" yes "API process is running"
assert_eq "$(yes_if test -f "$DIST/index.html")" yes "web was built into the temp dir"
assert_eq "$(yes_if test -d "$MEDIA_DIR")" yes "MEDIA_DIR exists"
assert_eq "$(yes_if test -s "$DB_PATH")" yes "the API created and migrated the temp DB"
if [ -r "/proc/$API_PID/environ" ]; then
  API_ENV=$(tr '\0' '\n' <"/proc/$API_PID/environ")
  assert_eq "$(yes_if grep -Fxq "APP_DB_PATH=$DB_PATH" <<<"$API_ENV")" yes "the API got the temp APP_DB_PATH"
  assert_eq "$(yes_if grep -Fxq "MEDIA_DIR=$MEDIA_DIR" <<<"$API_ENV")" yes "the API got the temp MEDIA_DIR"
  assert_eq "$(yes_if grep -Fxq "WEB_DIST=$DIST" <<<"$API_ENV")" yes "the API got the built dist as WEB_DIST"
  assert_eq "$(yes_if grep -Fxq "NODE_ENV=development" <<<"$API_ENV")" yes "the API runs with NODE_ENV=development (fail-closed auth boots without a secret)"
  assert_eq "$(yes_if grep -Fxq "BETTER_AUTH_URL=$API_URL" <<<"$API_ENV")" yes "the API got BETTER_AUTH_URL == the origin the harness uses ($API_URL)"
  assert_eq "$(yes_if grep -q '^BETTER_AUTH_SECRET=' <<<"$API_ENV")" no "the harness never sets BETTER_AUTH_SECRET"
fi
auth_probe 'web=api'

# --- 2. assert_api: positive ---------------------------------------------------------------
assert_api /health '.ok == true'
assert_api /health '.database == "ok"'
assert_api /health '.version | type == "string"'
assert_api -H 'x-e2e: 1' -l 'health with a header' /health '.ok'
assert_api /health '.ok' -H 'x-e2e: 1' -l 'options may follow the positional arguments'
assert_api /api/definitely-not-a-route '.status == 404' -s 404
assert_api "$STACK_URL/health" '.ok == true'
assert_api /health '.ok' -X GET
assert_eq "$(api_get /health | jq -r .database)" ok "api_get prints the body"

# --- 3. assert_api: the harness detects failures ----------------------------------------------
FAILS_BEFORE=$E2E_FAIL
expect_fail "assert_api: false jq expression fails" assert_api /health '.ok == false'
expect_fail "assert_api: null jq result fails" assert_api /health '.no_such_field'
expect_fail "assert_api: invalid jq syntax fails" assert_api /health '.ok =='
expect_fail "assert_api: HTTP 404 fails" assert_api /api/definitely-not-a-route '.'
expect_fail "assert_api: wrong -s status fails" assert_api -s 500 /health '.ok'
expect_fail "assert_api: refused connection fails" assert_api http://127.0.0.1:1/health '.ok'
expect_fail "assert_api: missing arguments fail" assert_api /health
expect_fail "assert_api: an unknown option fails" assert_api --bogus /health '.ok'
expect_fail "assert_eq: mismatch fails" assert_eq a b
expect_fail "assert_text: text absent from a response body fails" quick_assert_text "no-such-text-xyz" url:/health
assert_text '"ok":true' "url:$API_URL/health"
assert_eq "$E2E_FAIL" "$FAILS_BEFORE" "negative checks did not leak failures into the suite counters"
OUT="$( (assert_api /health '.ok == false') 2>&1 || true)"
assert_eq "$(yes_if contains "$OUT" '"database":"ok"')|$(yes_if contains "$OUT" FAIL)" "yes|yes" "a failing assert_api prints FAIL and the response payload"

# --- 4. sqlite_count against the migrated DB ----------------------------------------------------
assert_eq "$(sqlite_count sqlite_master "type = 'table' AND name = 'schema_migrations'")" 1 "schema_migrations table exists in the migrated DB"
shopt -s nullglob # the migrations dir may not exist yet (no migration bead has landed)
MIGRATION_SQL=("$E2E_REPO_ROOT"/apps/api/src/db/migrations/*.sql)
shopt -u nullglob
assert_eq "$(sqlite_count schema_migrations)" "${#MIGRATION_SQL[@]}" "schema_migrations rows == .sql files on disk (${#MIGRATION_SQL[@]})"
assert_eq "$(sqlite_count schema_migrations 'version < 0')" 0 "sqlite_count honours a where clause"
expect_fail "sqlite_count: unknown table fails" sqlite_count no_such_table
expect_fail "sqlite_count: unsafe table name is rejected" sqlite_count 'sqlite_master; DROP TABLE schema_migrations'
expect_fail "sqlite_count: bad where clause fails" sqlite_count schema_migrations 'nonsense((('
expect_fail "sqlite_count: a smuggled statement fails" sqlite_count schema_migrations '1=1; DROP TABLE schema_migrations'
assert_eq "$(sqlite_count sqlite_master "name = 'schema_migrations'")" 1 "sqlite_count is read-only (the table survived)"
E2E_DB=$DB_PATH bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.env.E2E_DB);
  db.run("PRAGMA busy_timeout = 5000");
  db.run("CREATE TABLE e2e_marker (x)");
  db.run("INSERT INTO e2e_marker VALUES (1)");'
assert_eq "$(sqlite_count e2e_marker)" 1 "sqlite_count sees a row written after boot"

# --- 5. web through the same origin -------------------------------------------------------------
assert_text '<div id="root">' url:/
ASSET=$(api_get / | grep -oE '/assets/[^"]+\.js' | head -n1)
assert_eq "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$STACK_URL$ASSET" | cut -d';' -f1)" "200 text/javascript" "the built JS asset ($ASSET) is served by the API origin"

# --- 6. browser (real playwright-cli; BLOCKED, never a pass, when it cannot run) -----------------
BROWSER_USED=no
if pw_open /; then
  BROWSER_USED=yes
  assert_text "FIRST COACH" title
  assert_text "$STACK_URL" "eval:location.href"
  assert_text "en" "eval:document.documentElement.lang"
  pw eval "document.body.append('E2E-PROBE-TEXT')" >/dev/null
  assert_text "E2E-PROBE-TEXT" # visible text of the live page
  assert_eq "$(yes_if test "$(daemon_count "$E2E_SESSION")" = 1)" yes "a playwright daemon for this session is running"
  expect_fail "pw: a failing playwright-cli command exits non-zero (ref does not exist)" pw click e999
  expect_fail "assert_text: text absent from the live page fails" quick_assert_text "no-such-text-xyz"
  expect_fail "assert_text: text absent from the title fails" quick_assert_text "no-such-text-xyz" title
fi
# BLOCKED is never a pass: it stays in the summary. This script alone tolerates it for its exit code.
if [ "$E2E_BLOCKED" -gt 0 ]; then
  printf 'note: %d BLOCKED browser step(s): no usable browser here; the summary keeps the count\n' "$E2E_BLOCKED"
  E2E_ALLOW_BLOCKED=1
fi

# --- 7. stop_stack ---------------------------------------------------------------------------------
start_busy # an unrelated bun process: stop_stack must not touch it
SESSION=$E2E_SESSION
stop_stack
assert_eq "$(yes_if port_open "$API_PORT")" no "API port $API_PORT is closed after stop_stack"
assert_eq "$(yes_if test -e "$TMP_DIR")" no "temp dir removed"
assert_eq "$(yes_if test -e "$DIST")" no "generated web dist removed with the temp dir"
assert_eq "$(yes_if alive "$API_PID")" no "API process gone"
assert_eq "$(daemon_count "$SESSION")" 0 "no playwright daemon for this run's session remains after stop_stack"
assert_eq "$(yes_if alive "$BUSY")" yes "stop_stack left an unrelated bun process alone"
assert_eq "$(curl -s "http://127.0.0.1:$BUSY_PORT/")" busy "the unrelated server still answers"
assert_eq "$(stop_stack && echo ok)" ok "stop_stack is idempotent"
GENERATED=(STACK_URL API_URL DB_PATH MEDIA_DIR E2E_TMP E2E_API_PORT_USED E2E_WEB_MODE E2E_WEB_DIST_USED E2E_API_PID)
UNSET_ALL=yes
for v in "${GENERATED[@]}"; do is_unset "$v" || { UNSET_ALL="no ($v is still set)"; break; }; done
assert_eq "$UNSET_ALL" yes "stop_stack unsets every generated variable"
assert_eq "${E2E_WEB_DIST:-}" "" "the caller-facing E2E_WEB_DIST knob was not overwritten"
NOSTACK="$( (assert_api /health '.ok') 2>&1 || true)"
assert_eq "$(yes_if contains "$NOSTACK" unbound)" no "assert_api with no stack fails cleanly, not with 'unbound variable'"
expect_fail "assert_api with no stack fails" assert_api /health '.ok'
expect_fail "sqlite_count with no stack fails" sqlite_count schema_migrations

# --- 8. restart: a second start_stack works and starts from scratch ---------------------------------
start_stack
assert_api /health '.ok == true'
assert_eq "$(yes_if test "$E2E_TMP" != "$TMP_DIR")" yes "a restart gets a fresh temp dir (temp dirs are per start_stack)"
assert_eq "$E2E_WEB_MODE" api "restart: still web=api"
assert_text '<div id="root">' url:/
expect_fail "restart: data written before the stop is gone" sqlite_count e2e_marker
API2_PID=$E2E_API_PID
TMP2=$E2E_TMP
PORT2=$E2E_API_PORT_USED
stop_stack
assert_eq "$(yes_if port_open "$PORT2")|$(yes_if alive "$API2_PID")|$(yes_if test -e "$TMP2")" "no|no|no" "restart: the second stop_stack cleans up too"

# --- 9. the port race: the first candidate is taken, the API retries with a new port -------------------
RESTORE_PICKER=$(declare -f _e2e_free_port)
eval "real$RESTORE_PICKER" # keeps the real picker as real_e2e_free_port
_e2e_free_port() { # first call: the port of the foreign server; then real ones (the counter lives in a file)
  if [ -e "$WORK/first-port-used" ]; then real_e2e_free_port; else : >"$WORK/first-port-used"; echo "$BUSY_PORT"; fi
}
mkdir "$WORK/stubdist" && printf '<!doctype html><div id="root">stub</div>' >"$WORK/stubdist/index.html"
E2E_WEB_DIST=$WORK/stubdist start_stack 2>"$WORK/race.err"
assert_eq "$(yes_if test "$E2E_API_PORT_USED" != "$BUSY_PORT")" yes "port race: the stack came up on another port ($E2E_API_PORT_USED, not $BUSY_PORT)"
assert_eq "$(yes_if grep -q retrying "$WORK/race.err")" yes "port race: the retry is reported"
assert_api /health '.ok == true'
assert_eq "$(yes_if alive "$BUSY")" yes "port race: the foreign server was not touched"
assert_text 'stub' url:/
RACE_TMP=$E2E_TMP
stop_stack
assert_eq "$(yes_if test -f "$WORK/stubdist/index.html")" yes "a caller-supplied E2E_WEB_DIST is never deleted"
assert_eq "$(yes_if test -e "$RACE_TMP")" no "port race: temp dir removed"
unset -f _e2e_free_port real_e2e_free_port
eval "$RESTORE_PICKER"
kill "$BUSY" 2>/dev/null || true
BUSY=""

# --- 10. a pinned busy port fails fast (no retry) with the server log, and cleans up -------------------
start_busy
mkdir "$WORK/busytmp"
BOUT=$( (TMPDIR="$WORK/busytmp" E2E_WEB=off E2E_API_PORT=$BUSY_PORT start_stack) 2>&1) && brc=0 || brc=$?
assert_eq "$(yes_if test "$brc" -ne 0)|$(yes_if contains "$BOUT" 'exited during boot')" "yes|yes" "start_stack on a busy pinned port fails fast"
assert_eq "$(yes_if contains "$BOUT" retrying)" no "a pinned port is never retried"
assert_eq "$(yes_if contains "$BOUT" 'tail of')" yes "the failure prints the server log tail"
assert_eq "$(find "$WORK/busytmp" -mindepth 1 | wc -l | tr -d ' ')" 0 "the failed start left no temp dir behind"
kill "$BUSY" 2>/dev/null || true
BUSY=""

# --- 11. readiness: listening line AND announced port AND /health -----------------------------------------
cat >"$WORK/fake-api.ts" <<'TS'
// stand-in API entry for readiness tests only: always answers /health 200 on $PORT
const mode = process.env.FAKE_MODE ?? "reordered";
const s = Bun.serve({ port: Number(process.env.PORT), fetch: () => Response.json({ ok: true }) });
process.on("SIGTERM", () => process.exit(0));
const line = (o: object) => console.log(JSON.stringify(o));
if (mode === "reordered") line({ port: s.port, version: "x", msg: "listening", level: "info" });
if (mode === "silent") line({ level: "info", msg: "booting", port: s.port });
if (mode === "otherport") line({ level: "info", msg: "listening", port: s.port + 1 });
TS
run_child "E2E_API_ENTRY='$WORK/fake-api.ts' FAKE_MODE=reordered E2E_WEB=off start_stack && assert_api /health '.ok == true'"
assert_eq "$CHILD_RC" 0 "readiness survives a key-order change in the listening line"
assert_eq "$(yes_if grep -Eq '^--- e2e summary: .*, web=off -- ' <<<"$CHILD_OUT")" yes "the summary line records the degraded topology (web=off)"
assert_eq "$(yes_if contains "$CHILD_OUT" 'E2E_WEB=off')" yes "E2E_WEB=off is announced loudly"
for mode in silent otherport; do
  run_child "E2E_API_ENTRY='$WORK/fake-api.ts' FAKE_MODE=$mode E2E_BOOT_TIMEOUT=2 E2E_WEB=off start_stack || true; echo AFTER_START"
  assert_eq "$CHILD_RC|$(yes_if contains "$CHILD_OUT" 'not ready within 2s')|$(yes_if contains "$CHILD_OUT" AFTER_START)" "1|yes|yes" "readiness: a /health 200 without a matching listening line ($mode) times out, is a FAIL, and start_stack returns"
  assert_eq "$(yes_if contains "$CHILD_OUT" 'tail of')|$(yes_if contains "$CHILD_OUT" '"msg"')" "yes|yes" "readiness timeout ($mode) prints the server log tail"
done
run_child "E2E_WEB=preview start_stack || true"
assert_eq "$CHILD_RC|$(yes_if contains "$CHILD_OUT" E2E_WEB)" "1|yes" "an unknown E2E_WEB value (the removed preview mode) is refused"

# --- 12. exit codes, defers, traps, in child shells started from / -------------------------------------------
run_child 'pass ok'
assert_eq "$CHILD_RC|$(yes_if grep -Eq '^--- e2e summary: .*, web=api -- PASS' <<<"$CHILD_OUT")" "0|yes" "exit 0 when everything passed; the summary line names the topology"
run_child 'pass ok; fail bad || true; pass again'
assert_eq "$CHILD_RC|$(yes_if contains "$CHILD_OUT" '1 failed')" "1|yes" "exit 1 and a summary when a step failed"
run_child 'pass ok; blocked needs-key "no OpenAI key"'
assert_eq "$CHILD_RC|$(yes_if contains "$CHILD_OUT" 'BLOCKED (not a pass)')|$(yes_if contains "$CHILD_OUT" '1 blocked')" "3|yes|yes" "a BLOCKED step is never a pass (exit 3, counted loudly)"
CHILD_OUT=$(cd / && E2E_ALLOW_BLOCKED=1 bash -c "source '$HERE/lib.sh'; blocked x y" 2>&1) && rc=0 || rc=$?
assert_eq "$rc|$(yes_if contains "$CHILD_OUT" '1 blocked')" "0|yes" "E2E_ALLOW_BLOCKED=1 lets a blocked-only run exit 0, still counting it"
run_child 'pass ok; blocked x y; fail bad || true'
assert_eq "$CHILD_RC" 1 "a FAIL wins over BLOCKED (exit 1)"
run_child 'set -e; false; pass never'
assert_eq "$(yes_if test "$CHILD_RC" -ne 0)|$(yes_if contains "$CHILD_OUT" ABORTED)" "yes|yes" "an aborted script (set -e) exits non-zero and says so"
run_child 'set -euo pipefail; assert_eq 1 2 "set -e run" || true; echo continued'
assert_eq "$CHILD_RC|$(yes_if contains "$CHILD_OUT" '1 failed')" "1|yes" "set -euo pipefail scripts still get the summary and exit 1"
run_child 'e2e_defer "echo D1"; e2e_defer "echo D2"; pass ok; exit 0'
assert_eq "$(grep '^D[12]$' <<<"$CHILD_OUT" | tr '\n' ' ')" "D2 D1 " "e2e_defer runs newest first"
run_child 'e2e_defer "echo D1"; pass ok; exit 5'
assert_eq "$CHILD_RC|$(yes_if contains "$CHILD_OUT" D1)" "5|yes" "the script's own exit code survives the cleanup"
CHILD_OUT=$(cd / && bash -c "trap 'echo PREV_TRAP_RAN' EXIT; source '$HERE/lib.sh'; pass ok" 2>&1) && rc=0 || rc=$?
assert_eq "$rc|$(yes_if contains "$CHILD_OUT" PREV_TRAP_RAN)|$(yes_if contains "$CHILD_OUT" '1 passed')" "0|yes|yes" "an EXIT trap set before sourcing is chained"
CHILD_OUT=$(cd / && bash --posix -c "source '$HERE/lib.sh'; pass ok" 2>&1) && rc=0 || rc=$?
assert_eq "$rc|$(yes_if contains "$CHILD_OUT" 'command not found')" "0|no" "POSIX mode: no stray 'command not found' from trap parsing"
CHILD_OUT=$(cd / && bash -c "source '$HERE/lib.sh'; printf 'ROOT=%s\\n' \"\$E2E_REPO_ROOT\"" 2>&1)
assert_eq "$CHILD_OUT" "ROOT=$E2E_REPO_ROOT" "repo root resolves from BASH_SOURCE regardless of cwd"
CHILD_OUT=$(bash "$HERE/lib.sh" 2>&1) && rc=0 || rc=$?
assert_eq "$rc|$(yes_if contains "$CHILD_OUT" 'source this file')" "2|yes" "executing lib.sh instead of sourcing it is refused"
if command -v zsh >/dev/null 2>&1; then
  ZOUT=$(zsh -c "source '$HERE/lib.sh'" 2>&1) && zrc=0 || zrc=$?
  assert_eq "$(yes_if test "$zrc" -ne 0)|$(yes_if contains "$ZOUT" bash)" "yes|yes" "sourcing from zsh is refused with a clear message"
fi

# --- 13. pw: JSON error mapping and BLOCKED classification, with a stand-in playwright-cli ---------------------
mkdir "$WORK/shim" "$WORK/cwd"
cat >"$WORK/shim/playwright-cli" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *iserror*) echo '{"isError":true,"error":"Error: Ref e999 not found"}'; exit 0 ;;
  *crash*) echo 'boom' >&2; exit 3 ;;
  *open*)
    [ "${SHIM_OPEN:-ok}" = missing ] && { echo 'Error: Browser "chrome" is not installed. Run `playwright-cli install-browser chrome`' >&2; exit 1; }
    [ "${SHIM_OPEN:-ok}" = broken ] && { echo 'net::ERR_CONNECTION_REFUSED' >&2; exit 1; }
    echo '{"session":"x"}'; exit 0 ;;
  *) echo '{"result":"\"fine\""}'; exit 0 ;;
esac
SH
chmod +x "$WORK/shim/playwright-cli"
PWENV="export PATH='$WORK/shim':\$PATH E2E_ARTIFACTS_DIR='$WORK/art'"
run_child "$PWENV; pw eval fine >/dev/null; echo rc=\$?"
assert_eq "$(yes_if contains "$CHILD_OUT" 'rc=0')" yes "pw: a normal reply exits 0"
run_child "$PWENV; pw eval iserror; echo rc=\$?"
assert_eq "$(yes_if contains "$CHILD_OUT" 'rc=1')|$(yes_if contains "$CHILD_OUT" isError)" "yes|yes" "pw: {\"isError\":true} is mapped to exit 1 (the reply is still printed)"
run_child "$PWENV; pw eval crash; echo rc=\$?"
assert_eq "$(yes_if contains "$CHILD_OUT" 'rc=3')" yes "pw: a real non-zero exit status passes through"
run_child "$PWENV; SHIM_OPEN=missing pw_open http://example.invalid/ || true"
assert_eq "$CHILD_RC|$(yes_if contains "$CHILD_OUT" 'BLOCKED  browser')|$(yes_if contains "$CHILD_OUT" 'not installed')" "3|yes|yes" "pw_open: a missing browser is BLOCKED (exit 3), not a pass"
run_child "$PWENV; SHIM_OPEN=broken pw_open http://example.invalid/ || true"
assert_eq "$CHILD_RC|$(yes_if contains "$CHILD_OUT" 'FAIL     browser')" "1|yes" "pw_open: any other open failure is a FAIL"
run_child "pw_available() { return 1; }; pw_open http://example.invalid/ || true"
assert_eq "$CHILD_RC|$(yes_if contains "$CHILD_OUT" 'BLOCKED  browser')" "3|yes" "pw_open without playwright-cli is BLOCKED (exit 3)"
run_child "cd '$WORK/cwd'; export PATH='$WORK/shim':\$PATH; unset E2E_ARTIFACTS_DIR; pw eval x; echo rc=\$?"
assert_eq "$(yes_if contains "$CHILD_OUT" 'rc=0')|$(yes_if contains "$CHILD_OUT" fine)" "no|no" "pw with no stack and no E2E_ARTIFACTS_DIR is refused (it would litter the cwd)"
assert_eq "$(find "$WORK/cwd" -mindepth 1 | wc -l | tr -d ' ')" 0 "a refused pw left nothing in the cwd"

# --- 14. signals mid-run: the caller's own EXIT trap runs, the stack is torn down, exit = 128+n ---------------------
signal_case() { # <signal name> <expected exit code>
  cat >"$WORK/child.sh" <<EOF
trap 'echo USER_EXIT_TRAP_RAN' EXIT
source '$HERE/lib.sh'
E2E_WEB=off start_stack
echo "READY \$E2E_API_PORT_USED \$E2E_TMP \$E2E_API_PID"
while :; do sleep 0.1; done
EOF
  : >"$WORK/child.out"
  bash "$WORK/child.sh" >"$WORK/child.out" 2>&1 &
  local child=$! crc=0 c_port c_tmp c_pid deadline=$((SECONDS + 30))
  until grep -q '^READY ' "$WORK/child.out"; do
    [ "$SECONDS" -lt "$deadline" ] || { cat "$WORK/child.out"; kill -KILL "$child" 2>/dev/null || true; fail "SIG$1: child stack never became ready" || true; return 0; }
    sleep 0.1
  done
  read -r _ c_port c_tmp c_pid < <(grep '^READY ' "$WORK/child.out")
  kill -"$1" "$child"
  wait "$child" || crc=$?
  assert_eq "$crc" "$2" "SIG$1: the script exits $2"
  assert_eq "$(grep -c USER_EXIT_TRAP_RAN "$WORK/child.out")" 1 "SIG$1: the caller's own EXIT trap still ran (chained)"
  assert_eq "$(yes_if port_open "$c_port")" no "SIG$1: the stack port is closed"
  assert_eq "$(yes_if test -e "$c_tmp")" no "SIG$1: temp dir removed"
  assert_eq "$(yes_if alive "$c_pid")" no "SIG$1: the API process is gone"
  assert_eq "$(yes_if grep -Eq '^--- e2e summary: .*, web=off -- ' "$WORK/child.out")" yes "SIG$1: the summary line is still printed, with the topology"
}
signal_case TERM 143
signal_case HUP 129

# --- 15. nothing left behind ----------------------------------------------------------------------------------------
assert_eq "$(find "$TMPDIR" -maxdepth 1 -name 'e2e-stack.*' | wc -l | tr -d ' ')" 0 "no e2e-stack temp dir is left in TMPDIR"
assert_eq "$(daemon_count "$E2E_SESSION")" 0 "no playwright daemon for this run's session is left"
assert_eq "$(yes_if test "$BROWSER_USED" = yes -o "$E2E_BLOCKED" -gt 0)" yes "the browser section either ran or was recorded BLOCKED"
