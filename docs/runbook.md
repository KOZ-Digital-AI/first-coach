# FIRST COACH operations runbook

How to deploy, run, back up, restore and recover the FIRST COACH server on Railway.

This document describes what the repository does today. Every environment variable, path and command in it
exists in the repo, and `test/runbook.test.ts` checks that mechanically (`bun test test/runbook.test.ts`).
What has never been run against a real Railway project is listed in [Not yet verified](#not-yet-verified).

The deployment is one service built from the [Dockerfile](../Dockerfile) and configured by
[railway.json](../railway.json): a single Bun process (the Hono API) that also serves the built web app from
its own origin, with one SQLite database on a volume mounted at `/data`.

## Volume layout

Everything writable lives under `/data`. The Dockerfile sets these paths as image defaults, so a Railway
variable is needed only to override them.

| Path | Variable | What is in it |
| --- | --- | --- |
| `/data/app.db` | `APP_DB_PATH` | The application database (commons, players, sessions, contributions, settings, Better Auth tables). WAL mode, so `app.db-wal` and `app.db-shm` appear next to it. |
| `/data/media` | `MEDIA_DIR` | Uploaded contribution attachments, one flat directory of server-named files. `/health` reports whether it is writable; the `30-uploads` hook reconciles it at every start. |
| `/data/backups` | `BACKUP_DIR` | Nightly database backups, `first-coach-YYYY-MM-DD.sqlite`. |
| `/data/mastra.db` | `MASTRA_DB_PATH` | Reserved for the AI framework. Validated, but no code writes it at this revision. |

The web build is in the image at `apps/web/dist` and the seed content at `config/commons`; neither is on the
volume.

## Creating the Railway project and the /data volume (human step)

This needs a person with a Railway account. Nothing in the repo can do it.

1. Create a Railway project and one service from this repository. Railway builds from the Dockerfile because
   `railway.json` sets `"builder": "DOCKERFILE"` with `"dockerfilePath": "Dockerfile"`.
2. Add a volume to that service and mount it at `/data`. A service can have one volume. Volume size follows the
   Railway plan. Confirm the mount before the first deploy: without it the image's own `/data` is used, the data
   is lost on every deploy, and the uploads sweep (see [What happens on restart](#what-happens-on-restart))
   would treat every attachment as missing.
3. Generate the service's public domain (Networking settings). You need it for `BETTER_AUTH_URL`.
4. Set the variables from the next section **before the first deploy**. Without `BETTER_AUTH_SECRET` and
   `BETTER_AUTH_URL` the server refuses to start (see below), so the first deploy would fail its healthcheck.
5. Turn on Railway's own volume backups (Daily at least). The nightly app backups are written to the same volume
   as the database, so they do not survive losing the volume.
6. Deploy, then work through the [first-deploy checklist](#first-deploy-checklist).

Railway injects `PORT`; the server listens on it (`apps/api/src/index.ts` reads `process.env.PORT`), and Railway
uses the same value for the healthcheck. Do not set `PORT` yourself.

## Environment variables (required and optional)

The first block is validated by `apps/api/src/env.ts` (`ENV_VARIABLES`) at boot; the second block is read
elsewhere in the API. No value belongs in the repo: `.env.example` holds placeholders only.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | Optional | `4111` | HTTP port. Railway injects it; leave it alone on Railway. Must be an integer from 1 to 65535. |
| `APP_DB_PATH` | Optional | `./data/app.db` (image: `/data/app.db`) | SQLite database file. The parent directory is created if missing. |
| `MEDIA_DIR` | Optional | `./data/media` (image: `/data/media`) | Upload directory. The `30-uploads` hook creates it if missing and sweeps it at boot. `/health` `mediaWritable` is true only when the variable is set, the directory exists and it is writable. |
| `MASTRA_DB_PATH` | Optional | unset (image: `/data/mastra.db`) | Validated only; nothing writes it yet. |
| `BACKUP_DIR` | Optional | `backups` next to the database file (image: `/data/backups`) | Where the nightly backup is written. |
| `WEB_DIST` | Optional | `apps/web/dist` | Built web app served by the API. |
| `BUILD_VERSION` | Optional | image default `dev` | Reported as `version` by `/health`, read on every request. Set it to the git SHA of the deploy so you can tell builds apart. |
| `BETTER_AUTH_SECRET` | Required in production | none | Signs sessions. At least 32 characters; generate with `openssl rand -hex 32`. Never commit it. |
| `BETTER_AUTH_URL` | Required in production | none | Public base URL of the app, `https://` plus the Railway domain. Railway can fill it from a reference to its public-domain variable. |
| `OPENAI_API_KEY` | Optional | unset | Leave unset and the AI features are off; the product works without it. `/health` `aiAvailable` shows whether it is set (never the key). |
| `OPENAI_MODEL` | Optional | unset | Text model name. Validated only; no code reads it yet. |
| `OPENAI_VISION_MODEL` | Optional | unset | Image-understanding model name. Validated only; no code reads it yet. |
| `VITE_CONTACT_EMAIL` | Optional | unset | Contact address for the web app, read at web build time. The Dockerfile declares no build argument for it and the web code does not use it yet, so setting it on Railway has no effect at this revision. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Optional | none | Comma-separated extra origins Better Auth accepts (for example a custom domain next to the Railway one). Read by `apps/api/src/auth/better-auth.ts`, not by `env.ts`. Wildcards are rejected in production. |
| `SEED_DIR` | Optional | `config/commons` (image: `/app/config/commons`) | Directory the seed loader reads. Read by the `20-seed` boot hook, not by `env.ts`. If you set it, it must exist or the boot aborts. |
| `ADMIN_PASSWORD` | CLI only | none | Read only by the admin CLI. Do not store it as a service variable. |
| `NODE_ENV` | Set by the image | `production` | The Dockerfile sets `production`. Auth treats anything other than exactly `development` or `test` as production. |

### Production rules for the auth variables

- **Fail closed.** With `NODE_ENV=production` the server does not start without `BETTER_AUTH_SECRET` (at least
  32 characters) and `BETTER_AUTH_URL`. `00-env` reports which variable is wrong, never its value. There is no
  fallback secret in production, and the dev origins (`http://localhost:5173`, `http://127.0.0.1:5173`) are not
  trusted there.
- **Wildcards are rejected.** A `*` anywhere in `BETTER_AUTH_TRUSTED_ORIGINS` aborts the start in production.
  List every origin explicitly.
- **Secure cookies and rate limiting are on** in production and off only for `development` and `test`. See
  [Rate limiting behind Railway's proxy](#rate-limiting-behind-railways-proxy).
- `OPENAI_API_KEY` is the only optional secret. Without it nothing fails; `/health` says `aiAvailable: false`.

## Volume permissions: RAILWAY_RUN_UID=0

Railway mounts volumes owned by root, and a container that runs as a non-root user cannot write to them. The
Dockerfile deliberately has no `USER` instruction, so the process runs as root and the database can be written.
As a safeguard against a future base-image change, set the service variable `RAILWAY_RUN_UID=0` on the
service. It is a Railway variable, not read by the app. If the server ever logs a permission error opening
`/data/app.db`, this is the first thing to check.

## Exactly one instance (SQLite and the scheduler)

Run one instance, never more. `railway.json` pins `"numReplicas": 1`, and Railway does not allow replicas on a
service with a volume. Reasons:

- SQLite is a single file on one volume. Two writers on two machines would corrupt it, and the API keeps one
  synchronous connection.
- The nightly backup is scheduled inside the process (`40-backup`). Two instances would both run it.
- The auth rate limiter counts in memory, so a second instance would have its own counters.

Because of the volume, Railway never runs the old and new deployment at the same time, so every deploy has a
short downtime while the new container boots and passes its healthcheck.

## Creating the first admin

There is no sign-up for admins and no email. The only way to get one, or to recover one, is the admin CLI. Run
it inside the running container, where the service variables (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`NODE_ENV=production`, `APP_DB_PATH`) are set: on Railway open a shell with `railway ssh`; in the local Docker
drill use `docker exec`.

```bash
bun apps/api/src/cli/admin.ts create --email admin@example.org --name "First Admin"
bun apps/api/src/cli/admin.ts list
bun apps/api/src/cli/admin.ts reset-password --email admin@example.org
```

- **Password.** Read from `ADMIN_PASSWORD` if it is set. Otherwise, in a terminal, you are prompted (hidden,
  typed twice). With a pipe, one line is read from stdin. The password is never a command-line argument, so it
  stays out of shell history and `ps`, and it is redacted from the CLI's output. Prefer the prompt on Railway,
  so the password is not stored anywhere.
- `create` refuses when a user with that email already exists; it never promotes or changes an existing account.
- `reset-password` works for admins only and revokes all of that admin's sessions.
- `list` prints the admins: email, name, created date.
- Exit codes: 0 done, 1 failure, 2 usage error. A usage error prints the usage text and touches nothing.
- The CLI opens the same database file the server uses. That is safe while the server runs (WAL mode, 5 second
  busy timeout).

In the local drill the equivalent is `docker exec -it first-coach bun apps/api/src/cli/admin.ts create --email
admin@example.org --name "First Admin"`, using the container from the restore drill below.

## Deploy and rollback

**Deploy.** Push to the branch the service is connected to, or trigger a redeploy in the Railway dashboard.
Railway builds the image (the build runs `bun run typecheck` and the web build, see the Dockerfile), starts the
container and polls `/health` for up to 120 seconds (`healthcheckTimeout`). The new deployment takes traffic
only after `/health` answers 2xx. If the container crashes, `ON_FAILURE` restarts it up to 10 times.

Before a deploy that adds a migration (a new file in `apps/api/src/db/migrations`), take a manual backup (next
section). Migrations only go forward; there are no down scripts.

**Rollback, code only.** If the bad deploy did not apply a new migration, redeploy the previous good
deployment from the service's deployment list in the dashboard and check `/health`.

**Rollback after a migration ran.** An older build refuses to start on a database that a newer build migrated
(the migration runner stops with `applied migration ... has no file`). So redeploying old code is not enough:
also restore the pre-deploy backup with the restore procedure below, then start the old deployment. Expect to
lose whatever was written between the backup and the restore.

**Rollback of seed content.** Redeploy the previous deployment. The seed loader writes a new patch-bumped
version from the older content; nothing is deleted. See [Updating the seed](#updating-the-seed).

## Backups and restoring

**What runs.** The `40-backup` boot hook schedules a backup at 03:00 UTC every night (cron `0 3 * * *`). It does
not run at boot. The backup is a consistent SQLite snapshot (`VACUUM INTO`) taken while the server is running,
written to `/data/backups` as `first-coach-YYYY-MM-DD.sqlite` (one file per UTC day; a second run on the same
day replaces that day's file). After each run it keeps the newest 14 files and deletes older ones. A failed
backup is logged as `backup failed` and never stops the server; a good one is logged as `backup done`.

**What is not covered.** Only the SQLite application database. `/data/media` and `/data/mastra.db` are not in
these backups, and the backups sit on the same volume as the database. That is why Railway's volume backups
should be on too.

**Manual backup** (before a risky deploy, a rotation or a restore). Run inside the container. It uses the same
function as the nightly job and writes today's file:

```bash
bun -e "import { Database } from 'bun:sqlite'; import { backupDatabase } from './apps/api/src/ops/backup'; const db = new Database(process.env.APP_DB_PATH); console.log(backupDatabase(db, process.env.BACKUP_DIR).path)"
```

**Restore.** The restore CLI replaces the live database with a backup file:

```bash
bun apps/api/src/cli/restore.ts /data/backups/first-coach-2026-09-20.sqlite
```

- It takes exactly one argument, the backup file. It reads `APP_DB_PATH` (the file to replace) and `PORT` from
  the environment, and does not need the auth secrets.
- It refuses (exit 1) while the server is up: it tries a TCP connection to `127.0.0.1` on `PORT`, and any answer
  or hang counts as up. It can only see a server in the same container or network namespace. A one-off
  container next to a running one sees nothing, so stop the server yourself first.
- It copies the backup next to the live database, checks the copy with `PRAGMA integrity_check`, and refuses a
  missing, empty, unreadable or corrupt file. Nothing changes until that passes.
- It keeps the database it replaces as `<APP_DB_PATH>.pre-restore-<UTC timestamp>` (plus its `-wal`), removes the
  live `-wal` and `-shm` files, and renames the checked copy into place. It prints `restored ... from ...;
  previous database kept at ...`. Exit codes: 0 restored, 1 refused or failed, 2 usage.
- After a restore, start the server. Boot runs the migrations, so a backup from an older schema is brought up to
  date, and then the seed loader runs. The backup holds no media files, and the uploads sweep at start deletes
  files in `/data/media` that the restored database no longer references (older than 10 minutes), so an
  attachment added after the backup is lost with it.

**Restore on Railway.** The server is the container's main process, so it has to be stopped without losing the
container. The plan (never rehearsed, see [Not yet verified](#not-yet-verified)):

1. Take a manual backup or a Railway volume backup first.
2. In the service settings set the Start Command to `sleep infinity` and redeploy. `railway.json` does not set a
   start command, so the dashboard value applies. The container starts, the volume is mounted, and no server runs.
3. Open `railway ssh` and run the restore command above with the chosen backup file.
4. Remove the Start Command override, redeploy, and check `/health`.
5. Delete the `.pre-restore-*` copy when you are sure it is no longer needed.

**Restore from Railway's volume backups** (whole volume, includes media): use the Backups tab of the service, as
described in Railway's documentation. It mounts a new volume with the backup at the same path and stages the
change for you to review and deploy.

## Restore-from-backup drill

Run this on your machine with Docker before you rely on backups, and again after any change to `backup.ts` or
`restore.ts`. It uses a named Docker volume as `/data`.

```bash
docker build --build-arg BUILD_VERSION=local -t first-coach:local .
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
docker run --rm --name first-coach -p 4111:4111 -v first-coach-data:/data -e BETTER_AUTH_SECRET -e BETTER_AUTH_URL=http://localhost:4111 first-coach:local
```

In a second terminal:

```bash
docker exec -it first-coach bun apps/api/src/cli/admin.ts create --email admin@example.org --name "First Admin"
docker exec first-coach bun -e "import { Database } from 'bun:sqlite'; import { backupDatabase } from './apps/api/src/ops/backup'; const db = new Database(process.env.APP_DB_PATH); console.log(backupDatabase(db, process.env.BACKUP_DIR).path)"
docker exec -it first-coach bun apps/api/src/cli/admin.ts create --email second@example.org --name "Second Admin"
docker stop first-coach
docker run --rm -v first-coach-data:/data first-coach:local bun apps/api/src/cli/restore.ts /data/backups/first-coach-2026-09-20.sqlite
```

Use the backup file name the manual backup printed (today's UTC date) in the restore command. Then start the
server again with the same `docker run` as above and check:

- the restore printed `restored /data/app.db from ...` and named a `.pre-restore-` copy;
- `docker exec first-coach bun apps/api/src/cli/admin.ts list` shows the first admin and not the second;
- `/health` answers `ok: true` with the same `migration` as before.

The drill passes when all three hold. Clean up with `docker stop first-coach`; the named volume
`first-coach-data` stays until you remove it.

## What happens on restart

Every start (deploy, crash restart, redeploy) runs the same sequence, in this order (`apps/api/src/boot.ts`):

1. Open the database at `APP_DB_PATH` (parent directory created, WAL, foreign keys on) and apply pending
   migrations. Each migration file runs in its own transaction; a failure aborts the start.
2. Run the boot hooks in `apps/api/src/boot`, one at a time, in filename order:
   - `00-env` validates the environment (the rules above). A bad or missing required value aborts the start with
     the variable name in the error.
   - `20-seed` loads the commons seed from `SEED_DIR` or `config/commons`. An invalid seed aborts the start with
     the file and path. An unchanged seed writes nothing.
   - `30-uploads` reconciles `MEDIA_DIR` (default `./data/media`, `/data/media` in the image) with the
     `contribution_attachments` table, once per start. If the directory does not exist it is created and not
     swept (logged as `uploads sweep skipped`): a mis-mounted volume must not be answered by deleting every
     attachment row. Otherwise it deletes the regular files directly in the directory that no row references,
     unless they were modified less than 10 minutes ago (an upload may still be inserting its row), and deletes
     the rows whose file is missing; symlinks and subdirectories are left alone. The counts are logged as
     `uploads sweep` (`removedFiles`, `removedRows`). A failure is logged as `uploads sweep failed` and the boot
     continues. The image creates `/data/media` itself, so the "not swept" protection does not cover a volume
     that is simply not mounted; see the mount check in the Railway setup.
   - `40-backup` registers the 03:00 UTC backup schedule.
3. Mount the routes (`apps/api/src/http/routes`, alphabetical, request log first), create the Better Auth tables,
   mount the static web app after them, and listen on `PORT`.

On SIGTERM or SIGINT the server stops the backup schedule, stops accepting requests, closes the database and
exits; Railway sends SIGTERM when it replaces a deployment.

The upload store (`apps/api/src/contributions/uploads.ts`) exists, but no HTTP route calls it yet, so
`/data/media` stays empty until an upload endpoint ships.

## Health endpoint

`GET /health` is what Railway polls. It needs no login and returns no secrets.

| Field (200) | Meaning |
| --- | --- |
| `ok` | `true`. |
| `version` | `BUILD_VERSION` (trimmed, read per request), else the API package version. |
| `database` | `"ok"` when a probe query succeeded. |
| `publishedDrills` | Number of published drills. Greater than 0 once the seed has loaded. |
| `migration` | Name of the latest applied migration, for example `006_contributions`. |
| `aiAvailable` | `true` when `OPENAI_API_KEY` is set and not blank. |
| `mediaWritable` | `true` when `MEDIA_DIR` is set, exists and is writable. Expect `true` on Railway. |

When the database probe or any database read fails, the answer is HTTP 503 with only `ok: false`, `version` and
`database: "error"`; the reason is logged, never returned. Railway checks `/health` while a deployment starts;
it does not monitor it afterwards, so use an uptime monitor for that.

## Rotating BETTER_AUTH_SECRET and the OpenAI key

**BETTER_AUTH_SECRET.** Take a manual backup first. Generate a new value (`openssl rand -hex 32`), set it on the
service and redeploy. Sessions are signed with this secret, so every existing session stops being valid:
admins and contributors sign in again, and players (anonymous sessions last 90 days) lose access to the progress
tied to their old session. Password hashes are stored in the database and are not derived from the secret, so
sign in as an admin afterwards to confirm. If someone is locked out, `reset-password` in the admin CLI recovers
an admin. Rotate only when the secret may have leaked.

**OPENAI_API_KEY.** Create the new key at OpenAI, set it on the service, redeploy, check `/health` shows
`aiAvailable: true`, then revoke the old key at OpenAI. Deleting the variable turns the AI features off.

## Content takedown request

Someone asks for a drill to be removed (rights, safety, a child's image, a mistake).

1. Record who asked, when, which drill slug and why.
2. Take a manual backup.
3. Unpublish the drill. The intended tool is the admin action `POST /api/admin/drills/:slug/unpublish` with a
   `reason`. It exists as a contract in `apps/api/src/shared/admin.ts` but is not implemented or mounted as a
   route at this revision, so it cannot be used yet. What the read side honours today is the
   `drills.unpublished_at` column: a drill is published when it is `NULL` and has a current version, and the
   commons API and the export leave out any drill where it is set. Setting it is a database change made by a
   developer with the backup in hand; do not improvise it on production.
4. Take the content out of the source too. Remove or edit the drill under `config/commons` and ship it, or a
   restored database or a fresh volume would publish it again. The seed loader never deletes a drill, and it
   does not clear `unpublished_at`.
5. Uploaded media lives under `/data/media`, and a file is kept only while a `contribution_attachments` row
   references it. When uploads are in use, once the rows are gone the next start's `30-uploads` sweep deletes
   the files (after the 10 minute grace). No route stores uploads yet, so today the directory is empty.
6. Check that the drill is gone from the commons API and from `/api/commons/export.json`.

## Turning AI and video off

Two independent switches:

- **From admin settings.** Send an admin request to `/api/admin/settings` (PUT, signed in as an admin) with:

```json
{ "aiPlannerEnabled": false, "videoCoachEnabled": false }
```

  The values are stored in the database and read on every request, so no restart is needed. There is no settings
  screen in the web app yet, and the AI and video routes that would read these flags are not in the API at this
  revision, so today they are stored but nothing consumes them.
- **By key.** Delete `OPENAI_API_KEY` from the service and redeploy. `/health` then reports
  `aiAvailable: false`.

## Updating the seed

The seed is the commons content in `config/commons/<sport>/`: `skill-graph.json`, `tests.json`, and drill files
in `drills/`. It is baked into the image and loaded at every start by `20-seed`.

1. Edit the JSON under `config/commons`. Run the seed checks before you commit:

```bash
bun test apps/api/test/seed
bun test apps/api/src/commons/seed-loader.test.ts
```

2. Commit and deploy. On the next start the loader validates everything first and writes nothing if anything is
   invalid, so a bad edit stops the boot with the file and path instead of half-loading. Roll back by redeploying
   the previous deployment.
3. What the loader does with a changed drill: it compares a content hash with the drill's current version. Equal
   means nothing is touched, moderation status included. Different means a new version with a **patch-bumped**
   semver (1.0.9 becomes 1.0.10), status `COMMUNITY`, and it becomes the current version. Old versions are
   never changed. A verified drill whose text you edit therefore loses its verification on the new version and
   has to be reviewed again. Bump `version` in `skill-graph.json` when the graph changes; the stored graph
   version also carries a hash, so it moves either way.
4. Nothing is ever deleted. A drill removed from the seed stays in the database; use the takedown steps to hide
   it.
5. `SEED_DIR` points the loader at another directory. It must exist: a missing explicit directory aborts the
   boot, so a typo cannot start an empty commons.

**Known caveat, fc-9s7 (community edits).** The loader compares the seed with the drill's current version. If
that version came from somewhere else, such as a community contribution approved through moderation, the next
start sees a difference and writes a new `COMMUNITY` version from the seed text, which becomes current and hides
the community edit. Until fc-9s7 is resolved, do not approve a community edit to a seeded drill without putting
the same change in `config/commons`.

## First-deploy checklist

Tick these in order on the first deploy, and again after any change to the Railway setup.

- [ ] The repository is on GitHub and the Railway service is connected to it (or the first deploy was made with
      the Railway CLI).
- [ ] One service, built from the Dockerfile, with one volume mounted at `/data`.
- [ ] Variables are set: `BETTER_AUTH_SECRET` (32 or more random characters), `BETTER_AUTH_URL` (the `https://`
      public origin), `RAILWAY_RUN_UID=0`, optionally `OPENAI_API_KEY` and `BUILD_VERSION`. `PORT` is not set
      by hand.
- [ ] `BETTER_AUTH_TRUSTED_ORIGINS` lists any other origin the site is served from (a custom domain), without
      wildcards.
- [ ] The deploy passed its healthcheck on `/health` within 120 seconds, and the dashboard shows exactly one
      replica.
- [ ] `/health` answers `ok: true`, `database: "ok"`, `migration` equal to the newest file in
      `apps/api/src/db/migrations`, `publishedDrills` above 0, `mediaWritable: true`, and `aiAvailable`
      matching whether you set a key.
- [ ] The volume holds `/data/app.db` and `/data/media` (check with `railway ssh`).
- [ ] The first admin exists (`create`, then `list`) and can sign in.
- [ ] Redeploy once and confirm the admin, and a player's progress, are still there: data survives on the volume.
- [ ] Rate limiter and the `X-Forwarded-For` header verified behind Railway's proxy (section below).
- [ ] Railway volume backups are switched on.
- [ ] The day after the first deploy, `/data/backups` holds a `first-coach-YYYY-MM-DD.sqlite` file and the logs
      show `backup done`.
- [ ] The restore drill was run once on a machine with Docker.

## Rate limiting behind Railway's proxy

In production Better Auth rate-limits its auth endpoints in memory, keyed by client IP (anonymous sign-in has a roomier
rule of 30 per minute so a classroom behind one NAT can start together). It reads the client IP from the
`X-Forwarded-For` header set by the platform proxy. That is only safe if the proxy sets or overwrites the
header. If Railway passes a client-supplied `X-Forwarded-For` through, a caller that rotates the header value
evades the limiter, and a caller with no header shares one bucket with everyone.

This has **not been verified** and must be checked at deploy time, on the real Railway domain: send repeated
sign-in attempts with different spoofed `X-Forwarded-For` values and confirm the limiter still throttles them
by the real client address. If it does not, treat the sign-in endpoints as unthrottled and raise it as a bug
before opening registration to the public.

## Keeping this runbook honest

`bun test test/runbook.test.ts` fails when this file names an environment variable that is not in `env.ts`,
`.env.example` or the API source, leaves one out, shows a `bun` or `docker` command that references a script,
file or admin command that does not exist, or when `railway.json` disagrees with the Dockerfile or the health
route. Run it, and `bun run typecheck`, after editing either file.

## Not yet verified

Everything above is derived from the repository. These things have not been done or checked against reality:

- **GitHub push.** The repository has not been pushed, so the CI workflow in `.github/workflows/ci.yml` has never
  run on GitHub and Railway has nothing to build from.
- **Railway project.** No Railway project, service, volume or domain exists yet. So none of these has run:
  the build from the Dockerfile on Railway, the 120 second healthcheck, `RAILWAY_RUN_UID=0` and volume
  write access, whether the `railway ssh` shell has the service variables that the admin CLI needs (otherwise
  export `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` for that shell), the Start Command override used for the
  Railway restore, the deployment rollback, and Railway volume backups.
- **Rate limiter.** Railway's `X-Forwarded-For` behaviour is an open deploy-time check (section above).
- **Restore.** The restore CLI is tested in the repo, but the drill above has not been run end to end, and the
  restore on Railway has never been rehearsed.
- **OpenAI key.** No key has been provisioned. The AI features have not been exercised, and the API has no AI
  code path yet.
- **Native Kazakh review.** The Kazakh (`kk`) text in the app and in the seed drills was drafted with AI and has
  not been read by a native Kazakh speaker. It carries the status `COMMUNITY` until real coaches review it.
- **Not built yet.** The unpublish admin endpoint, an admin settings screen, an HTTP route that stores uploads
  (the store and its startup sweep exist) and a command-line backup entry point do not exist at this revision.
  The startup sweep itself has never run against a real Railway volume.
- **Railway config format.** Railway's documentation marks config as code (`railway.json`) as deprecated in
  favour of Infrastructure as Code; existing files keep working until 2026-12-01. The keys used here were
  checked against Railway's JSON schema on 2026-09-21. Migrate before that date.
