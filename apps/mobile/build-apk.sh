#!/usr/bin/env bash
# Builds a shareable debug APK, entirely in containers - this machine has no
# JDK, no Android SDK, no Gradle and no node on PATH, and deliberately keeps
# it that way (see README.md).
#
#   bash apps/mobile/build-apk.sh            # icons + sync + assembleDebug
#   bash apps/mobile/build-apk.sh --apk-only # skip the node step, just build
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

REPO=/mnt/c/Users/Dell/Downloads/jellyfin-gate
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

echo
echo "=== assembleDebug ==="
# GRADLE_USER_HOME on a named volume: without it every build re-downloads
# Gradle itself plus the whole dependency graph.
docker run --rm \
  -v "$MOBILE/android":/app \
  -v watch-gradle-home:/gradle \
  -e GRADLE_USER_HOME=/gradle \
  -w /app watch-android-build \
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
