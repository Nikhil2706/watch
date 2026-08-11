# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# jellyfin-gate
#
# Node 22 is required, not preferred: the app uses the built-in `node:sqlite`,
# which is what lets it run without a C++ toolchain anywhere — including in a
# slim Alpine image with no build-base installed.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` needs the dev dependencies here because the next stage builds.
RUN npm ci --no-audit --no-fund


FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# `next build` imports every route to collect page data, which would otherwise
# trip the runtime environment validation. This flag skips validation for the
# build only — no placeholder secret is ever written into an image layer, and
# the runtime checks are untouched.
ENV SKIP_ENV_VALIDATION=1
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Silences the "SQLite is an experimental feature" line on every boot.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning

# Runs as the non-root `node` user that the base image already provides.
# /app/data holds the database, which contains live Jellyfin access tokens.
RUN mkdir -p /app/data && chown -R node:node /app

# The standalone build carries its own trimmed node_modules, so the full
# dependency tree never reaches the final image.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000
VOLUME ["/app/data"]

# No shell form: this way the process is PID 1 and receives SIGTERM directly,
# so `docker compose down` shuts it down cleanly instead of waiting to kill it.
CMD ["node", "server.js"]


# ---------------------------------------------------------------------------
# Watch-folder worker.
#
# A separate target rather than a fatter runtime image: ffmpeg and its codec
# libraries are around 100 MB, and the gateway — which only ever pipes bytes —
# has no use for them. Only the worker pays for it.
#
# Build with:  docker compose build worker
# ---------------------------------------------------------------------------
FROM node:22-alpine AS worker

WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning

# ffmpeg-libs carries the VAAPI/libva support that makes hardware encoding
# usable when /dev/dri is passed through.
# intel-media-driver is the iHD driver, required by Gen11 and newer Intel
# graphics. libva-intel-driver is the older i965 one, which on a 12th-gen
# chip fails to open the device at all — ffmpeg reports a bare
# "I/O error" on -vaapi_device, which looks like a permissions problem
# and is not.
RUN apk add --no-cache ffmpeg ffmpeg-libs intel-media-driver libva-utils mesa-va-gallium
ENV LIBVA_DRIVER_NAME=iHD

# The worker is a single dependency-free script; it needs no node_modules.
COPY --chown=node:node scripts/media-worker.mjs ./scripts/media-worker.mjs

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "/app/scripts/media-worker.mjs"]
