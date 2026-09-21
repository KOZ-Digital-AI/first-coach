# E2E harness library

`lib.sh` is the shared bash library for slice gate scripts (`apps/web/e2e/<slice>.sh`). It boots the real
API on a throw-away database (the API also serves the real built web app, same origin), drives a real
browser through `playwright-cli`, asserts against the real API and the real SQLite file, and reports
honestly. `lib.test.sh` is its own test.

```bash
bash apps/web/e2e/lib.test.sh      # exit 0 = the harness works (about 15 s, any cwd)
```

`lib.test.sh` boots the real stack, so it needs bun, curl and jq. Its core (API boot, `/health`,
`assert_api`, `sqlite_count`, stop/restart, port/temp-dir/process cleanup, signals, exit codes) needs **no
browser** and must exit 0 on a machine without one. The browser checks (`pw_open`, `assert_text` on a page)
run only when `playwright-cli` and a usable browser exist; otherwise they are recorded **BLOCKED** and
`lib.test.sh` sets `E2E_ALLOW_BLOCKED` for its own exit code only. The summary still prints the blocked
count: BLOCKED is never a pass.

## The honesty rule

Nothing is mocked: no stubbed API, no fake browser, no canned DB rows. A step that needs something outside
the repository cannot pass without it:

- The **OpenAI key** (`OPENAI_API_KEY`) and **`apps/web/e2e/fixtures/dribble.mp4`** (the demo video) are
  external. A step that needs them calls `blocked "<step>" "<reason>"` when they are absent. It is never
  `pass`, never skipped silently.
- No `playwright-cli` / no installed browser is also BLOCKED (`pw_open` records it).
- Exit codes: `0` every step passed, `1` at least one FAIL (or the script aborted), `3` nothing failed but
  at least one step was BLOCKED. A gate script keeps exit 3 unless it opts in with `E2E_ALLOW_BLOCKED=1`.
- The summary line always names the topology: `--- e2e summary: 12 passed, 0 failed, 1 blocked, web=api -- ...`.
  `web=off` (API only, see `E2E_WEB`) can therefore never pass silently as a full run.

## Writing a gate script

```bash
#!/usr/bin/env bash
# apps/web/e2e/boot-healthy.sh: slice "a developer boots the stack and sees it healthy"
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$HERE/lib.sh"                  # installs the EXIT/INT/TERM/HUP handling

scratch=$(mktemp -d); e2e_defer 'rm -rf "$scratch"'   # extra cleanup: e2e_defer, see the warning below
start_stack                            # temp DB + media dir, real API on a free port, built web

assert_api /health '.ok == true and .database == "ok"'
assert_eq "$(sqlite_count sqlite_master "name = 'schema_migrations'")" 1 "migrations table exists"

if pw_open /; then                     # BLOCKED (not FAIL) when no browser is available
  assert_text "FIRST COACH" title
  pw snapshot                          # then: pw click e3, pw fill e5 "text", ...
fi

if [ ! -f "$HERE/fixtures/dribble.mp4" ]; then
  blocked "analyse the demo video" "apps/web/e2e/fixtures/dribble.mp4 is not present (external)"
elif [ -z "${OPENAI_API_KEY:-}" ]; then
  blocked "coach answers a question" "OPENAI_API_KEY is not set (external)"
else
  assert_api -X POST -H 'content-type: application/json' -d '{"q":"hi"}' /api/coach '.answer | length > 0'
fi

# no explicit stop or summary: the EXIT handler stops the stack, prints the summary, sets the exit code
```

> **WARNING: never write `trap ... EXIT` after sourcing `lib.sh`.** It replaces the library's EXIT handler:
> the API process, the temp dir and the browser session leak, no summary is printed, and the script exits
> **0** even when steps failed. Use `e2e_defer '<command>'` for extra cleanup. An EXIT trap set **before**
> sourcing is fine: it is chained and runs after the stack is stopped.

Run it from any directory: `bash apps/web/e2e/boot-healthy.sh`. The library finds the repo root from its
own path (`E2E_REPO_ROOT`), never from `$PWD`. It needs **bash >= 4** (run with `bash`; sourcing it from
zsh or plain sh is refused with a message), `curl`, `jq`, `bun`; `playwright-cli` for browser steps.

## Functions

| Function | Contract |
| --- | --- |
| `start_stack` | `mktemp -d` dir (one per call); optional web build into it (`bun run build --outDir <temp>/web-dist` in `apps/web`); the real API (`bun apps/api/src/index.ts`) on a free kernel-assigned port with `APP_DB_PATH`, `MEDIA_DIR`, `MASTRA_DB_PATH`, `BACKUP_DIR`, `WEB_DIST` pointing into the temp dir, and the temp dir as its working directory. Ready when the API process is alive, its log has a `"msg":"listening"` line announcing the chosen port, and `GET /health` is 200 (bounded by `E2E_BOOT_TIMEOUT`). Losing the port race (unpinned port only) is retried up to 3 times. On any failure: records a FAIL, prints the server log tail, cleans up, returns 1. Call it in the main shell, not in `$(...)` or a pipeline. |
| `stop_stack` | Idempotent. Closes this run's browser session, sends SIGTERM (then SIGKILL after `E2E_STOP_TIMEOUT`) to the one API pid `start_stack` recorded, removes the temp dir, unsets every generated variable. `start_stack` can be called again afterwards: it starts from scratch (**temp dirs are per `start_stack`: data written before a stop is gone**). |
| `pw <args>` | `playwright-cli -s=<this run's session> --json <args>`, run from a fixed per-run directory. Prints the JSON reply. `playwright-cli` exits 0 even when a command failed (bad ref, JS error), so an `{"isError":true}` reply becomes exit status 1; a real non-zero status passes through; 127 = not installed. Refuses (status 1) when no stack is running and `E2E_ARTIFACTS_DIR` is unset. |
| `pw_open [path-or-url]` | Opens `STACK_URL<path>` and records pass / FAIL / BLOCKED (no `playwright-cli`, or no installed browser). Returns 0 only when the page opened. |
| `pw_eval <js>` | Value of a JS expression on the page (strings raw, other values as JSON). Exit 1 on a JS/CLI error. |
| `assert_text <needle> [source]` | Fixed-string, case-sensitive containment. `source`: `page` (default, `document.body.innerText`), `title`, `eval:<js>` (all polled up to `E2E_TEXT_TIMEOUT`), or `url:<path>` (raw body of a GET on `STACK_URL<path>`, no JS, no polling). |
| `assert_api <path> <jq> [-X method] [-d body] [-H header]... [-s status] [-l label]` | Requests `API_URL<path>` (a full URL also works). Passes when the status is 2xx (or exactly `-s`) and `jq -e '<jq>'` is truthy (not `false`/`null`) on the body. On failure prints the status and the payload. Options may come before or after the positionals; `--` ends option parsing (a jq expression that starts with `-` needs it). |
| `api_get <path>` | Body of a GET on `API_URL` (curl `-f`), for extracting values: `id=$(api_get /api/x \| jq -r .id)`. |
| `sqlite_count <table> [where]` | Prints `COUNT(*)` from the stack's DB, opened read-only through `bun:sqlite`. `where` is raw SQL from the gate author and may not contain `;`. Non-zero on an SQL error, an unsafe table name or no stack. |
| `pass <label>` / `fail <label> [detail]` / `blocked <label> <reason>` / `assert_eq <actual> <expected> [label]` | Record a result. `fail` and failed assertions return 1. Counters: `E2E_PASS`, `E2E_FAIL`, `E2E_BLOCKED`. |
| `e2e_defer <command>` | Runs `<command>` at exit, newest first, before `stop_stack`. |
| `e2e_finish` | Prints the summary once and sets `E2E_EXIT`; the EXIT handler calls it. |
| `port_open <port>` | Exit 0 when something accepts TCP connections on `127.0.0.1:<port>`. |
| `pw_available` | Exit 0 when `playwright-cli` is on `PATH`. |

Assertions record their result and **return 1 on failure**. Do not call them inside `$(...)` or a pipeline:
the counters live in the main shell. To check a helper's own failure detection, run it as one command in a
subshell, `if ( assert_api /health '.nope' ); then ...; fi` (see `expect_fail` in `lib.test.sh`).

### Variables generated by `start_stack`

Exported by `start_stack`, unset by `stop_stack`: `STACK_URL`, `API_URL` (equal: one origin), `DB_PATH`,
`MEDIA_DIR`, `E2E_TMP`, `E2E_API_PORT_USED`, `E2E_WEB_MODE` (`api` or `off`), `E2E_WEB_DIST_USED`. The API pid
is in `E2E_API_PID` (not exported). The input knobs below are never rewritten.

## Web topology (`E2E_WEB`)

| Value | Behaviour |
| --- | --- |
| `api` (default) | Builds the web app into the temp dir (or uses a prebuilt `E2E_WEB_DIST`) and starts the API with `WEB_DIST` pointing at it: the API serves the built app, so `STACK_URL == API_URL`. |
| `off` | API only: nothing is built, the API's `WEB_DIST` points at a nonexistent path (a stale `apps/web/dist` is never served). `start_stack` prints a WARNING and the summary says `web=off`. Browser steps cannot pass. |

Any other value is refused. There is no `vite preview` mode: static serving is part of the API.

## Env knobs (inputs)

| Variable | Default | Meaning |
| --- | --- | --- |
| `E2E_WEB` | `api` | see above |
| `E2E_WEB_DIST` | (build) | prebuilt web dist to serve, skips the build. Never modified or deleted. Only its `index.html` is checked: a dist whose assets are missing still passes the checks and serves a broken app. A relative path is relative to the cwd |
| `E2E_API_PORT` | free port | pin the API port. No retry: a busy pinned port fails fast |
| `E2E_API_ENTRY` | `apps/api/src/index.ts` | the API entry to run. Only for `lib.test.sh` (stand-in servers for readiness tests); a gate must not set it, it would mock the API |
| `E2E_BOOT_TIMEOUT` | `30` | seconds to wait for the API to be ready |
| `E2E_STOP_TIMEOUT` | `5` | seconds from SIGTERM to SIGKILL |
| `E2E_HTTP_TIMEOUT` | `10` | curl `--max-time` for `assert_api`, `api_get`, `assert_text url:` |
| `E2E_TEXT_TIMEOUT` | `5` | polling window of `assert_text` on a live page |
| `E2E_KEEP` | `0` | `1` = keep the temp dir (`api.log`, `build.log`, `app.db`, browser artifacts) |
| `E2E_ALLOW_BLOCKED` | `0` | `1` = BLOCKED steps do not turn the exit code into 3 (still counted in the summary) |
| `E2E_ARTIFACTS_DIR` | inside the temp dir | working dir of `playwright-cli` (snapshots, screenshots). Set it to `apps/web/e2e-artifacts` to keep evidence; `e2e-artifacts/` and `.playwright-cli/` are git-ignored |
| `E2E_SESSION` | `e2e-$$-$RANDOM` | browser session name, unique per run |

Other environment variables you export (for example `OPENAI_API_KEY`) are inherited by the API. `PORT`,
`APP_DB_PATH`, `MEDIA_DIR`, `MASTRA_DB_PATH`, `BACKUP_DIR` and `WEB_DIST` are always overridden, so a gate can
never touch `./data/app.db` or the repo's `apps/web/dist`.

## Failure behaviour, traps, limits

- With `set -e` the first failed assertion aborts the script; the EXIT handler still stops the stack, prints
  the summary and exits non-zero (fail fast). Without `set -e` (use `set -uo pipefail`) every step runs and
  the summary lists all of them.
- The library installs `EXIT`, `INT`, `TERM` and `HUP` handlers when sourced (non-interactive shells). A
  signal makes the script `exit` with 128+n (130, 143, 129) and the EXIT handler cleans up. A failing run
  prints the tail of the API log before the temp dir is removed.
- **`kill -9` of the harness cannot be trapped**: it orphans the API process, the temp dir and the browser
  daemon.
- **bash defers a trapped signal while a foreground command runs**: a `TERM` sent during a long `sleep 60`
  in a gate takes effect (and cleanup starts) only when that command ends. Prefer short polling loops.
- Only the pid `start_stack` recorded is ever signalled. Unrelated `bun`, `vite` or `node` processes, and
  other browser sessions, are never touched.
- The web build writes the generated, git-ignored `apps/web/src/routeTree.gen.ts`, as any `vite build`
  does. Its output goes to the temp dir, never to `apps/web/dist`.
- `apps/web/e2e/*.sh` is never collected by `bun test` (it only collects `*.test.{ts,tsx,js,jsx}`), and the
  web tsconfig includes only `src/` and `test/`.
