# Watch — mobile app (Capacitor shell)

Phase 2 of the [Phone App Roadmap](https://claude.ai/code/artifact/d348b540-6d87-402f-97ff-a1c47e155c4f) —
scaffolded, not built. This directory is a real Capacitor project: it wraps
the deployed site (`https://watch2.abhigyanverma.com`, in **remote-URL
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

## What's NOT done, and why

This machine has **no Java/JDK, no Android SDK, no Gradle installed**.
Confirmed by actually running `./gradlew tasks` inside a plain Node
container — it fails immediately with `JAVA_HOME is not set and no 'java'
command could be found`. That means:

- **No real build.** `./gradlew assembleDebug` (or anything else Gradle)
  cannot run here at all, not even to check the scaffold compiles.
- **No app icon set yet.** Capacitor's default placeholder icons are still
  in `android/app/src/main/res/mipmap-*` — swapping in a real one (the site
  already has a placeholder brand icon at `public/icon-512.png`, one level
  up in the main repo) needs `@capacitor/assets` or manual per-density
  generation, deliberately skipped tonight rather than half-done.
- **No splash screen, no status-bar theming.**
- **No TestFlight/Play internal track — those need your Apple/Google
  developer accounts**, already flagged as blocked-on-you in the roadmap
  artifact itself.

## To actually build this later

Needs, at minimum: JDK 17+, Android SDK + command-line tools, Gradle (or
just Android Studio, which bundles all three). Once installed:

```
cd apps/mobile
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```

The resulting `.apk` can then be installed on a device or emulator for real
testing — none of that has happened yet.

See `AUTONOMOUS_WORK_LOG.md` at the repo root for the full session log this
was built under.
