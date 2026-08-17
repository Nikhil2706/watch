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
# A separate target rather than a fatter runtime image: ffmpeg and its real
# codec libraries are ~141 MB, and the gateway — which only ever pipes bytes —
# has no use for them. Only the worker pays for it.
#
# Build with:  docker compose build worker
# ---------------------------------------------------------------------------
FROM node:22-alpine AS worker

WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning

# Software encode only: no VAAPI driver package is installed. This was tried
# (intel-media-driver + libva-utils + mesa-va-gallium) and measured to cost an
# extra ~266 MB, dominated by mesa-va-gallium pulling in llvm22-libs alone
# (182 MB) for AMD/nouveau drivers this host's Intel iGPU can't use anyway.
# The real blocker isn't the driver choice: WSL2 exposes GPUs to Docker
# Desktop's own host distro via /dev/dxg, not /dev/dri, and passing /dev/dri
# through into a *nested* container from there is an open, unresolved WSL bug
# (microsoft/WSL#11846) — confirmed locally, /dev/dri does not exist in this
# machine's docker-desktop WSL2 distro. media-worker.mjs's detectHardware()
# already checks for /dev/dri/renderD128 and falls back to libx264 when it's
# absent, so this is a real no-op removal, not a regression.
#
# If this ever runs on real Linux hardware with GPU passthrough: this host's
# iGPU is a 6th-gen (Skylake) Intel HD 530, which needs the OLDER i965 driver
# (libva-intel-driver), not intel-media-driver (iHD, for Gen11+) — re-check
# the actual GPU generation before reinstalling either package.
RUN apk add --no-cache ffmpeg

# The worker is a single dependency-free script; it needs no node_modules.
COPY --chown=node:node scripts/media-worker.mjs ./scripts/media-worker.mjs

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "/app/scripts/media-worker.mjs"]
