# Single-image deployment: the Hono API serves the built web app from its own origin.
#
# Layout inside the image matters: apps/api/src/http/static.ts locates the web build
# from its own path (apps/api/src/http -> repo root -> apps/web/dist), so the runtime
# stage keeps the repo layout under /app: /app/apps/api/src and /app/apps/web/dist.

# ---------------------------------------------------------------- build
FROM oven/bun:1.4.2 AS build
WORKDIR /app

# Manifests and lockfile first: the dependency layer is rebuilt only when they change.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps ./apps
RUN bun run typecheck
RUN bun run --filter @first-coach/web build

# ---------------------------------------------------------------- runtime
FROM oven/bun:1.4.2
WORKDIR /app

# Production dependencies of the API only (the web app is already built). The web
# manifest is still copied: the frozen lockfile describes the whole workspace.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --production --frozen-lockfile --filter @first-coach/api

COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
COPY --from=build /app/apps/web/dist apps/web/dist

# Everything writable lives under /data. No VOLUME instruction: Railway attaches its
# volume at run time, and a plain `docker run -v` works the same way. The mkdir only
# makes the paths exist when nothing is mounted.
RUN mkdir -p /data/media /data/backups
# NODE_ENV=production lives only here: the build stage needs devDependencies, and
# `bun install` skips them under NODE_ENV=production. Env validation and secure
# cookies read it at run time.
ENV NODE_ENV=production \
    APP_DB_PATH=/data/app.db \
    MEDIA_DIR=/data/media \
    MASTRA_DB_PATH=/data/mastra.db \
    BACKUP_DIR=/data/backups

# Reported by GET /health (the route reads process.env.BUILD_VERSION).
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=$BUILD_VERSION

# No USER instruction on purpose: a mounted Railway volume is root-owned, so an
# unprivileged user could not write the database to it.

EXPOSE 4111

# bun itself does the probe: the image has no curl or wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||4111)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun","apps/api/src/index.ts"]
