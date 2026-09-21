#!/usr/bin/env bash
# apps/web/e2e/s0-stack.sh: slice gate fc-mol-bip, slice S0 "the stack boots, is healthy and ships as one image".
# Journey proof on the REAL stack, nothing mocked. Steps (S0_STEPS selects a subset, default "clone dev stack docker";
# an unselected step is recorded BLOCKED, so a partial run can never exit 0 without E2E_ALLOW_BLOCKED=1):
#   clone   git clone --local --no-hardlinks of this repo's HEAD (COMMITTED files only): bun install --frozen-lockfile,
#           bun run typecheck, bun run test, all exit 0 (the full fast suite, up to ~10 min)
#   dev     the REAL `bun run dev` from that clone: API up, Vite up, GET /health, /api/does-not-exist = 404 problem+json
#           through the Vite /api proxy; only the process groups this script started are killed
#   stack   harness start_stack (real API + built SPA, temp DB): /health {ok:true, version, database:"ok"}, the 404
#           problem+json contract, playwright-cli opens the root: root layout rendered, ZERO console errors
#   docker  docker build -t first-coach:gate --build-arg BUILD_VERSION=gate; docker run with a named volume on /data:
#           /health ok + version "gate" + database "ok", SPA at /, 404 problem+json, app.db in the volume before and
#           after `docker restart` (same inode and birth time, seed log says 60 unchanged / 0 inserted)
# Environment deviations (each is recorded BLOCKED with the reason, never PASS; exit 3 unless E2E_ALLOW_BLOCKED=1):
#   - port 4111 held by another process: `bun run dev` cannot be moved (the Vite proxy target is hard-coded in
#     apps/web/vite.config.ts), so the dev step runs the real dev script with PORT=<free> and proves the Vite /api
#     proxy with a second Vite whose config only overrides the proxy target. The foreign process is never touched.
#   - no playwright-cli / browser, no docker daemon: the browser / docker checks are BLOCKED.
# Cleanup: e2e_defer only (never `trap ... EXIT` after sourcing lib.sh). Fail-slow (no set -e): every step reports.
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$HERE/lib.sh"
ROOT="$E2E_REPO_ROOT"
S0_STEPS=${S0_STEPS:-"clone dev stack docker"}
scratch=$(mktemp -d "${TMPDIR:-/tmp}/s0-gate.XXXXXX") || exit 1
e2e_defer 'rm -rf -- "$scratch"'
want() { [[ " $S0_STEPS " == *" $1 "* ]] || { blocked "step $1" "not selected by S0_STEPS='$S0_STEPS'"; return 1; }; }
strip() { sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$1" 2>/dev/null; }
tail_of() { printf '%s\n' "  --- tail of $1 ---" && strip "$1" | tail -n "${2:-30}" | cut -c1-300; }

# assert_problem404 <base-url> <label>: GET <base>/api/does-not-exist is 404, content-type application/problem+json,
# and the body is problem-details JSON (status 404 and a title).
assert_problem404() {
  local base=$1 label=$2 hdr body ct code
  hdr="$scratch/h.$RANDOM"
  body=$(curl -s --max-time 10 -D "$hdr" "$base/api/does-not-exist" 2>/dev/null)
  code=$(head -n1 "$hdr" 2>/dev/null | tr -d '\r' | awk '{print $2}')
  ct=$(grep -i '^content-type:' "$hdr" 2>/dev/null | head -n1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//' | tr 'A-Z' 'a-z')
  if [ "$code" = 404 ] && [[ $ct == application/problem+json* ]] && jq -e '.status == 404 and (.title | type == "string")' >/dev/null 2>&1 <<<"$body"; then
    pass "$label: /api/does-not-exist is 404 application/problem+json with a problem body"
  else
    fail "$label: /api/does-not-exist is 404 application/problem+json with a problem body" "  status='$code' content-type='$ct' body=${body:0:300}"
  fi
}
# assert_health <base-url> <jq> <label>
assert_health() { assert_api "$1/health" "$2" -l "$3"; }

# --- background process groups (dev servers): only the groups started here are ever signalled -----
BG_PGIDS=()
bg_start() { # <log> <dir> <cmd...>: own session/process group; sets BG_PID and BG_PGID
  local log=$1 dir=$2; shift 2
  (cd "$dir" && exec setsid "$@") >"$log" 2>&1 </dev/null &
  BG_PID=$!; sleep 0.2
  BG_PGID=$(ps -o pgid= -p "$BG_PID" 2>/dev/null | tr -d ' '); BG_PGID=${BG_PGID:-$BG_PID}
  BG_PGIDS+=("$BG_PGID")
}
bg_stop_all() {
  local pg deadline=$((SECONDS + 10))
  for pg in ${BG_PGIDS[@]+"${BG_PGIDS[@]}"}; do kill -TERM -- "-$pg" 2>/dev/null || true; done
  for pg in ${BG_PGIDS[@]+"${BG_PGIDS[@]}"}; do
    while pgrep -g "$pg" >/dev/null 2>&1 && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.2; done
    pgrep -g "$pg" >/dev/null 2>&1 && kill -KILL -- "-$pg" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
e2e_defer 'bg_stop_all'
wait_for() { # <seconds> <command...>: poll until the command succeeds
  local deadline=$((SECONDS + $1)); shift
  until "$@" 2>/dev/null; do [ "$SECONDS" -lt "$deadline" ] || return 1; sleep 0.3; done
}

# --- 1. fresh clone: install, typecheck, test -------------------------------------------------
CLONE=""
step_clone() {
  want clone || return 0
  if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
    echo "WARNING: the working tree has uncommitted changes; the clone below only sees commit $(git -C "$ROOT" rev-parse --short HEAD)" >&2
  fi
  CLONE="$scratch/clone"
  if ! git clone -q --local --no-hardlinks "$ROOT" "$CLONE" 2>"$scratch/clone.log"; then
    fail "fresh clone of $(git -C "$ROOT" rev-parse --short HEAD)" "$(tail_of "$scratch/clone.log")"; CLONE=""; return 0
  fi
  pass "fresh clone of HEAD $(git -C "$CLONE" rev-parse --short HEAD) (git clone --local --no-hardlinks)"
  local cmd log rc df0 df1
  df0=$(df -k --output=avail "$scratch" | tail -n1)
  for cmd in "bun install --frozen-lockfile" "bun run typecheck" "bun run test"; do
    log="$scratch/clone-${cmd//[^a-z]/-}.log"; rc=0
    (cd "$CLONE" && timeout 900 $cmd) >"$log" 2>&1 </dev/null || rc=$?
    if [ "$rc" -eq 0 ]; then pass "clone: $cmd exits 0"
      [ "$cmd" = "bun run test" ] && echo "  test totals: $(strip "$log" | grep -E '^@[^ ]+ test: +([0-9]+ (pass|fail)|Ran [0-9]+ tests)' | sed -E 's/ test: +/: /' | cut -c1-70 | tr '\n' ';')"
    else fail "clone: $cmd exits 0 (exit $rc)" "$(tail_of "$log" 40)"; [ "$cmd" = "bun install --frozen-lockfile" ] && CLONE="" && break; fi
  done
  df1=$(df -k --output=avail "$scratch" | tail -n1)
  echo "  clone disk use: $(( (df0 - df1) / 1024 )) MiB (install + build artefacts), removed at exit"
}

dev_api_ready() { grep -q '"msg":"listening"' "$DEV_LOG" && curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$DEV_PORT/health"; }
vite_url() { local u; u=$(strip "$1" | grep -oE 'Local:[[:space:]]+http://[^ ]+' | head -n1 | awk '{print $2}'); [ -n "$u" ] && printf '%s' "${u%/}"; }
# --- 2. the real `bun run dev` -----------------------------------------------------------------
step_dev() {
  want dev || return 0
  local root=${CLONE:-}
  if [ -z "$root" ]; then
    if [[ " $S0_STEPS " == *" clone "* ]]; then fail "dev: no installed fresh clone to run bun run dev in (clone step failed)"; return 0; fi
    root=$ROOT; echo "  note: clone step not selected, running bun run dev in $ROOT (partial run)"
  fi
  local dt="$scratch/dev" apiport=4111 blocked_4111=0 log="$scratch/dev.log" vurl="" i
  mkdir -p "$dt"
  if port_open 4111; then
    blocked_4111=1; apiport=$(_e2e_free_port)
    blocked "bun run dev on :4111" "port 4111 is held by a foreign process on this host (never touched); the real dev script runs with PORT=$apiport instead"
  fi
  bg_start "$log" "$root" env PORT="$apiport" APP_DB_PATH="$dt/app.db" MEDIA_DIR="$dt/media" MASTRA_DB_PATH="$dt/mastra.db" \
    BACKUP_DIR="$dt/backups" bun run dev
  # readiness (bounded): API listening line + /health 200, then the Vite "Local:" URL answering
  DEV_LOG=$log DEV_PORT=$apiport
  if wait_for 90 dev_api_ready; then
    pass "dev: API is up on :$apiport (bun run dev)"
  else fail "dev: API is up on :$apiport (bun run dev)" "$(tail_of "$log")"; return 0; fi
  wait_for 60 vite_url "$log" >/dev/null; vurl=$(vite_url "$log")
  if [ -n "$vurl" ] && wait_for 30 curl -sf -o /dev/null --max-time 2 "$vurl/"; then
    pass "dev: Vite dev server is up on $vurl"
    assert_text '<title>FIRST COACH</title>' "url:$vurl/"
  else fail "dev: Vite dev server is up (Local URL '$vurl')" "$(tail_of "$log")"; return 0; fi
  assert_health "http://127.0.0.1:$apiport" '.ok == true and (.version | type == "string") and .database == "ok"' "dev: /health on the dev API :$apiport"
  if [ "$blocked_4111" = 0 ]; then
    assert_health "http://localhost:4111" '.ok == true and .database == "ok"' "dev: curl localhost:4111/health"
    assert_health "$vurl" '.ok == true and .database == "ok"' "dev: /health through the Vite proxy ($vurl)"
    assert_problem404 "$vurl" "dev: through the Vite /api proxy"
  else
    # the real Vite proxies to the hard-coded :4111 (foreign process): prove the proxy with a second Vite, same
    # config, only the proxy target overridden (config file removed at exit), pointed at THIS dev API.
    local vport cfg="$root/apps/web/vite.s0gate.config.ts" vlog="$scratch/vite2.log"
    vport=$(_e2e_free_port)
    printf 'import { mergeConfig } from "vite";\nimport base from "./vite.config";\nconst t = "http://127.0.0.1:%s";\nexport default mergeConfig(base, { server: { proxy: { "/api": { target: t }, "/health": { target: t } } } });\n' "$apiport" >"$cfg"
    e2e_defer "rm -f -- '$cfg'"
    bg_start "$vlog" "$root/apps/web" bunx vite --config vite.s0gate.config.ts --host 127.0.0.1 --port "$vport" --strictPort
    if wait_for 60 curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$vport/"; then
      assert_health "http://127.0.0.1:$vport" '.ok == true and .database == "ok"' "dev (proxy proof, vite :$vport -> API :$apiport): /health"
      assert_problem404 "http://127.0.0.1:$vport" "dev (proxy proof, vite :$vport -> API :$apiport)"
    else fail "dev (proxy proof): second Vite on :$vport" "$(tail_of "$vlog")"; fi
  fi
  echo "  dev ports: API=$apiport Vite=$vurl"
  bg_stop_all
  local left=0 pg; for pg in "${BG_PGIDS[@]}"; do pgrep -g "$pg" >/dev/null 2>&1 && left=1; done
  if [ "$left" = 0 ] && ! port_open "$apiport"; then
    pass "dev: every process this script started is gone, :$apiport released"
  else fail "dev: leftover dev processes or port :$apiport still open"; fi
  BG_PGIDS=()
}

# --- 3. harness stack + browser ---------------------------------------------------------------
step_stack() {
  want stack || return 0
  start_stack || return 0
  assert_api /health '.ok == true and (.version | type == "string" and length > 0) and .database == "ok"' -l "stack: GET /health is 200 {ok:true, version, database:\"ok\"}"
  assert_problem404 "$API_URL" "stack"
  if pw_open /; then
    assert_text "FIRST COACH" title
    assert_text "true" 'eval:!!document.querySelector("#root [data-slot=header]") && document.querySelector("#root").children.length > 0'
    local out n
    out=$(pw console error) || true
    n=$(jq -r '.result // ""' <<<"$out" | grep -oE 'Errors: [0-9]+' | head -n1 | grep -oE '[0-9]+')
    if [ "${n:-x}" = 0 ]; then pass "browser: root layout rendered with 0 console errors"
    else fail "browser: root layout rendered with 0 console errors (got '${n:-unparsed}')" "$(jq -r '.result // .' <<<"$out" | head -n 12)"; fi
  fi
  stop_stack
}

docker_tidy() {
  local new c img pass
  new=$(comm -13 <(printf '%s\n' "$IMG_BEFORE") <(docker images -a -q --no-trunc | sort -u))
  [ -n "$new" ] || return 0
  for c in $(docker ps -a -q --filter status=exited --filter status=created); do
    img=$(docker inspect -f '{{.Image}}' "$c" 2>/dev/null)
    grep -qxF "$img" <<<"$new" && docker rm -f "$c" >/dev/null 2>&1
  done
  for pass in 1 2 3; do  # children before parents: newest first
    for img in $(docker images -a --no-trunc --format '{{.CreatedAt}}|{{.ID}}' | sort -r | cut -d'|' -f2); do
      grep -qxF "$img" <<<"$new" && docker rmi "$img" >/dev/null 2>&1
    done
  done
  return 0
}
# --- 4. the container --------------------------------------------------------------------------
step_docker() {
  want docker || return 0
  docker info >/dev/null 2>&1 || { blocked "container proof" "docker daemon is not reachable ('docker info' failed)"; return 0; }
  local rnd=$RANDOM$RANDOM img=first-coach:gate cname vol hp secret base out
  cname="fc-gate-$rnd"; vol="fc-gate-vol-$rnd"
  # the legacy builder leaves untagged stage images (and the container of a failed step): remove exactly what this run added
  IMG_BEFORE=$(docker images -a -q --no-trunc | sort -u)
  e2e_defer 'docker_tidy'
  e2e_defer "docker rmi '$img' >/dev/null 2>&1 || true"
  e2e_defer "docker volume rm -f '$vol' >/dev/null 2>&1 || true"
  e2e_defer "docker rm -f '$cname' >/dev/null 2>&1 || true"
  local brc=0
  docker build -t "$img" --build-arg BUILD_VERSION=gate "$ROOT" >"$scratch/build.log" 2>&1 || brc=$?
  if [ "$brc" -ne 0 ] && grep -qE 'failed to apply diff|invalid tar header' "$scratch/build.log"; then
    echo "WARNING: docker daemon layer-store error (not a Dockerfile error), retrying the build once" >&2
    brc=0; docker build -t "$img" --build-arg BUILD_VERSION=gate "$ROOT" >"$scratch/build.log" 2>&1 || brc=$?
  fi
  if [ "$brc" -eq 0 ]; then pass "docker build -t $img --build-arg BUILD_VERSION=gate exits 0"
  else fail "docker build exits 0 (exit $brc)" "$(tail_of "$scratch/build.log" 40)"; return 0; fi
  hp=$(_e2e_free_port); base="http://127.0.0.1:$hp"
  secret=$(head -c 30 /dev/urandom | od -An -tx1 | tr -d ' \n')   # 60 hex chars, per run, never printed
  docker volume create "$vol" >/dev/null || { fail "docker volume create $vol"; return 0; }
  # production container: fail-closed auth needs a secret (>= 32 chars) and the public origin
  BETTER_AUTH_SECRET=$secret docker run -d --name "$cname" -p "127.0.0.1:$hp:4111" -v "$vol:/data" \
    -e BETTER_AUTH_SECRET -e "BETTER_AUTH_URL=$base" "$img" >"$scratch/run.log" 2>&1 \
    || { fail "docker run" "$(tail_of "$scratch/run.log")"; return 0; }
  if wait_for 90 curl -sf -o /dev/null --max-time 2 "$base/health"; then pass "container answers /health on $base"
  else fail "container answers /health within 90s" "$(docker logs --tail 30 "$cname" 2>&1 | cut -c1-300)"; return 0; fi
  assert_api "$base/health" '.ok == true and .version == "gate" and .database == "ok"' -l "container: /health is {ok:true, version:\"gate\", database:\"ok\"}"
  out=$(curl -s -D- --max-time 10 "$base/" 2>/dev/null)
  if grep -qi '^content-type: *text/html' <<<"$out" && grep -q '<div id="root">' <<<"$out" && grep -q '<title>FIRST COACH</title>' <<<"$out"
  then pass "container: GET / serves the SPA (text/html, #root, FIRST COACH)"; else fail "container: GET / serves the SPA" "  ${out:0:400}"; fi
  assert_problem404 "$base" "container"
  assert_api "$base/api/commons/stats" '.drills == 60' -l "container: /api/commons/stats drills == 60 (before restart)"
  vol_stat() { docker run --rm -v "$vol:/data:ro" "$img" stat -c '%n inode=%i birth=%W' /data/app.db 2>&1; }
  local before after
  before=$(vol_stat)
  if [[ $before == "/data/app.db inode="* ]]; then pass "volume $vol holds /data/app.db ($before)"; else fail "volume $vol holds /data/app.db" "  $before"; fi
  docker logs "$cname" 2>&1 | grep -m1 '"msg":"seed loaded"' | jq -e '.drills.inserted == 60' >/dev/null 2>&1 \
    && pass "first boot seeded 60 drills into the volume DB" || fail "first boot seeded 60 drills into the volume DB"
  docker restart "$cname" >/dev/null 2>&1 || { fail "docker restart $cname"; return 0; }
  listened() { [ "$(docker logs "$cname" 2>&1 | grep -c '"msg":"listening"')" -ge 2 ] && curl -sf -o /dev/null --max-time 2 "$base/health"; }
  if wait_for 90 listened
  then pass "container answers /health again after docker restart"
  else fail "container answers /health again after docker restart" "$(docker logs --tail 30 "$cname" 2>&1 | cut -c1-300)"; return 0; fi
  after=$(vol_stat)
  assert_eq "$after" "$before" "app.db survived the restart (same inode and birth time: not recreated)"
  docker logs "$cname" 2>&1 | grep '"msg":"seed loaded"' | tail -n1 | jq -e '.drills.inserted == 0 and .drills.unchanged == 60' >/dev/null 2>&1 \
    && pass "after restart the seed log finds the 60 drills already in the DB (0 inserted, 60 unchanged)" \
    || fail "after restart the seed log finds the 60 drills already in the DB" "  $(docker logs "$cname" 2>&1 | grep '"msg":"seed loaded"' | tail -n1 | cut -c1-300)"
  assert_api "$base/api/commons/stats" '.drills == 60' -l "container: /api/commons/stats drills == 60 (after restart)"
  assert_api "$base/health" '.ok == true and .version == "gate" and .database == "ok"' -l "container: /health still {ok:true, version:\"gate\"} after restart"
}

step_clone
step_dev
step_stack
step_docker
# no explicit stop or summary: the EXIT handler runs the deferred cleanup, prints the summary, sets the exit code
