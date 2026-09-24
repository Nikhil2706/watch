#!/usr/bin/env bash
# Builds a shareable debug APK, entirely in containers - this machine has no
# JDK, no Android SDK, no Gradle and no node on PATH, and deliberately keeps
# it that way (see README.md).
#
#   bash apps/mobile/build-apk.sh            # icons + sync + assembleDebug
#   bash apps/mobile/build-apk.sh --apk-only # skip the node step, just build
#
#   DEV_SERVER_URL=http://localhost:3100 bash apps/mobile/build-apk.sh
#       point the (.dev, debug-signed) build at a dev server instead of the
#       live site — same rewrite the CI workflow's dev_server_url input does.
#
# Run it from anywhere; paths below are absolute inside the containers.
#
# IMPORTANT, and learned the hard way on 2026-09-06: the Android SDK download
# and a Gradle build are heavy sustained writes, and this host's boot SSD is
# failing. The first run of this script took the WSL distro's filesystem down
# with it and the site went 502 until the watchdog recycled the VM. Do not run
# this while anyone is using the site, and prefer to have already built the
# toolchain image (Dockerfile.build) so this run is only Gradle.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MOBILE="$REPO/apps/mobile"
APK_ONLY="${1:-}"

cd "$REPO"

if [ "$APK_ONLY" != "--apk-only" ]; then
  echo "=== icons + splash from brand/, then cap sync ==="
  # node:22 (not alpine): @capacitor/assets pulls sharp, and the glibc build is
  # the one that reliably has a prebuilt binary.
  docker run --rm \
    -v "$MOBILE":/app \
    -v "$REPO/brand":/brand:ro \
    -v watch-npm-cache:/root/.npm \
    -w /app node:22 sh -c '
      set -e
      npm install --no-audit --no-fund --silent
      npm install --no-save --no-audit --no-fund --silent sharp @capacitor/assets
      node make-assets.js
      npx --yes @capacitor/assets generate --android \
        --iconBackgroundColor "#06070a" \
        --iconBackgroundColorDark "#06070a" \
        --splashBackgroundColor "#06070a" \
        --splashBackgroundColorDark "#06070a"
      npx cap sync android
    '
fi

if [ -n "${DEV_SERVER_URL:-}" ]; then
  echo
  echo "=== pointing this build at $DEV_SERVER_URL ==="
  # After cap sync, into the packaged copy only (gitignored). cleartext
  # because a dev server is plain http, which Android blocks by default.
  docker run --rm \
    -v "$MOBILE":/app \
    -e DEV_URL="$DEV_SERVER_URL" \
    -w /app node:22-alpine node -e '
      const fs = require("fs");
      const p = "android/app/src/main/assets/capacitor.config.json";
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      c.server = { url: process.env.DEV_URL, cleartext: true, androidScheme: "http" };
      fs.writeFileSync(p, JSON.stringify(c, null, 2));
      console.log("dev build will load", c.server.url);
    '
fi

echo
echo "=== assembleDebug ==="
# GRADLE_USER_HOME on a named volume: without it every build re-downloads
# Gradle itself plus the whole dependency graph.
#
# The whole mobile dir, not just android/: capacitor.settings.gradle points
# at ../node_modules/@capacitor/android, and without it Gradle finds an empty
# project and fails with "No variants exist".
# ~/.android in a named volume too: that is where the debug keystore lives,
# and a fresh one per build means every dev APK refuses to install over the
# last ("signatures do not match") until the old one is uninstalled.
docker run --rm \
  -v "$MOBILE":/app \
  -v watch-gradle-home:/gradle \
  -v watch-android-debug-key:/root/.android \
  -e GRADLE_USER_HOME=/gradle \
  -w /app/android watch-android-build \
  sh ./gradlew --no-daemon assembleDebug

APK="$MOBILE/android/app/build/outputs/apk/debug/app-debug.apk"
echo
if [ -f "$APK" ]; then
  echo "APK: $APK"
  ls -la "$APK"
else
  echo "NO APK PRODUCED"
  exit 1
fi
