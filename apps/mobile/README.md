# Watch — mobile app (Capacitor shell)

Phase 2 of the [Phone App Roadmap](https://claude.ai/code/artifact/d348b540-6d87-402f-97ff-a1c47e155c4f) —
scaffolded, not built. This directory is a real Capacitor project: it wraps
the deployed site (`https://watch.abhigyanverma.com`, in **remote-URL
mode** per `capacitor.config.json`'s `server.url` — the app loads the actual
server-rendered pages through the WebView, not a bundled static copy) in a
native Android shell.

## What's actually done

- `npm install` (Capacitor core/CLI/android packages)
- `npx cap init` — `capacitor.config.json`, app id `com.abhigyanverma.watch`
  (**placeholder — confirm before ever publishing**; Android package IDs are
  effectively permanent once a build ships to the Play Store)
- `npx cap add android` — real Gradle project under `android/`

All of the above only needed Node, which is why it could be done tonight
(via `docker run node:22-alpine`, same pattern as this repo's own
typecheck). Session auth needs zero backend changes for this to work —
`jfg_session` is an ordinary cookie, and Capacitor's WebView keeps a normal
persistent cookie jar (see the roadmap artifact's "Session cookie survives
the wrapper" section).

## Building the APK

This machine still has no JDK, no Android SDK, no Gradle and no node on
PATH, and is deliberately not getting them. The toolchain lives in a
container instead — `Dockerfile.build`, JDK 21 (Android Gradle Plugin 8.7.2
supports 17–21) plus the SDK pinned to platform 35 / build-tools 35.0.0 to
match `android/variables.gradle`.

```bash
# once, ~2.5GB, and slow:
docker build -f apps/mobile/Dockerfile.build -t watch-android-build apps/mobile

# every time after that:
bash apps/mobile/build-apk.sh              # icons + cap sync + assembleDebug
bash apps/mobile/build-apk.sh --apk-only   # skip the node step
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

> **Do not run this while anyone is using the site.** The SDK download and a
> Gradle build are heavy sustained writes, and this host's boot SSD is
> failing. On 2026-09-06 the first toolchain build took the WSL distro's
> filesystem down with it — every binary in the distro started returning
> `Input/output error`, dockerd died, and the site served 502 until the
> watchdog recycled the WSL VM. Build when the library is idle, and check
> `docker ps` afterwards.

### Signing

`assembleDebug` signs with the debug keystore, which is what makes the APK
installable by sideload without a Play account. Two consequences worth
knowing before handing one to somebody:

- The keystore lives in the container's `~/.android`. It is **not**
  persisted, so a later rebuild is signed by a different key and Android
  will refuse to install it over the top — your friend has to uninstall
  first. If updates-in-place start mattering, generate a real keystore, keep
  it **outside this repo** (see the `.env.bak` incident in the root
  `PROJECT_KNOWLEDGE.md`) and wire a `signingConfig` into
  `android/app/build.gradle`.
- Debug builds carry `android:debuggable="true"`. Fine among friends, not
  something to put on a store listing.

## Staying aligned with the site

This is a **remote-URL** shell: it loads the deployed site through the
WebView, so web changes need no rebuild. Only these need one:

- `capacitor.config.json`'s `server.url` — the canonical host moved from
  `watch2.` to `watch.abhigyanverma.com` on 2026-09-05, and the copy Capacitor
  bakes into `android/app/src/main/assets/` has to be re-synced for that to
  reach the APK. `cap sync` does it; `build-apk.sh` runs it.
- Icons and splash, generated from the repo's real brand assets
  (`../../brand`) by `make-assets.js` + `@capacitor/assets`.
- The theme in `android/app/src/main/res/values/`. The shell was on
  Capacitor's default **Light** theme with a white adaptive-icon background,
  which flashed white on every launch of a very dark app.

## Still not done

- **No release signing** — see above.
- **No Play/TestFlight track** — needs your Google/Apple developer accounts,
  flagged as blocked-on-you in the roadmap artifact.
- **The app id `com.abhigyanverma.watch` is still the scaffold's placeholder.**
  Harmless for sideloading, effectively permanent once anything ships to a
  store.

See `AUTONOMOUS_WORK_LOG.md` at the repo root for the session log the
scaffold was built under.
