# Watch — desktop app (Tauri shell)

Phase 1 of the [Desktop App Roadmap](https://claude.ai/code/artifact/5b1992c1-9dcc-4a03-8d25-b954fdd7498a) —
**built and running as of 2026-09-06**, v1.0.0. Tauri (not Electron) — uses
the OS's own WebView (WebView2 on Windows, WKWebView on Mac) instead of
bundling Chromium, which is why the installer is 1.9MB rather than hundreds.

## What's actually done

- `npm create tauri-app` — vanilla template, package manager npm, identifier
  `com.abhigyanverma.watch` (**placeholder — same caveat as the mobile app**,
  confirm before distributing)
- `src-tauri/tauri.conf.json` configured for **remote-URL mode**: the main
  window's `url` points straight at `https://watch.abhigyanverma.com` — the
  app loads the real deployed site, not a bundled copy. `src/` (the default
  vanilla template's placeholder HTML) is unused for the same reason
  `apps/mobile/www/index.html` is — Tauri's tooling expects `frontendDist`
  to point at a real directory, so it stays as scaffolding, not a fallback
  screen.
- **Real app icons generated and wired in** — this one step *didn't* need
  Rust: `npm run tauri icon` is a pure image-processing command (ships as a
  precompiled binary via the npm package, no cargo/rustc invoked), so it
  actually ran successfully against the same placeholder brand SVG used for
  the PWA icons (`../../scripts/icon-source.svg`) and produced real
  Windows/Mac/iOS/Android icon sets under `src-tauri/icons/`. Still the same
  placeholder "W" monogram pending real branding — just no longer the
  generic default Tauri logo.

Session auth needs zero backend changes here either — same `jfg_session`
cookie reasoning as the mobile app, WebView2/WKWebView both keep a normal
persistent cookie jar.

## Building it

Still no Rust, no MSVC build tools and no node on this machine, and that
stays true on purpose — its boot drive is failing, and a large toolchain
download already took the WSL filesystem down once (see
`../mobile/README.md`). The build runs on a **Windows** GitHub Actions
runner instead: `.github/workflows/desktop-app.yml`.

Windows specifically, not Linux — a Windows installer cannot be
cross-compiled. Tauri links against WebView2 and packages through WiX and
NSIS, both Windows-only.

Push anything under `apps/desktop/`, or run the workflow by hand, and the
run's artifacts contain:

| File | What it is |
| --- | --- |
| `Watch_<version>_x64-setup.exe` | NSIS installer. Per-user, installs to `%LOCALAPPDATA%\Watch`. |
| `Watch_<version>_x64_en-US.msi` | The same app as an MSI, for anyone who prefers it. |

To ship a new version, bump `version` in `src-tauri/tauri.conf.json` (and
`src-tauri/Cargo.toml`, kept in step so `cargo` does not report something
different — the installer takes its number from the former).

### The icon comes from `brand/`, every build

`make-icon.js` renders `../../brand/icon.svg` to 1024px and `tauri icon`
expands it into every size the bundle needs. This is regenerated on each
build rather than trusted from the repo, because the icons committed under
`src-tauri/icons/` were generated on 2026-08-19 from the old placeholder —
a blue **W** in the interaction accent, which `brand/README.md` says is the
one colour the mark must never be — and were never updated when the real
aperture mark landed on 2026-08-28. The app shipped that wrong logo in its
title bar until 2026-09-06.

### Verified

v1.0.0 was installed and launched on this machine: the window opens titled
"Watch", WebView2 starts, and it loads the real login page at
`https://watch.abhigyanverma.com` on the site's own dark ground. The
scaffold had been pointing at `watch2.` — retired 2026-09-05 — so the
workflow asserts the hostname before it builds anything.

## Not signed

Neither installer is code-signed. Windows SmartScreen will show a blue
"Windows protected your PC" box on first run; **More info → Run anyway**
gets past it. That warning is about the absence of a certificate, not about
anything detected in the app.

Fixing it properly needs a paid code-signing certificate (OV runs roughly
$200-400/yr, and SmartScreen reputation still takes time to accumulate; an
EV cert buys instant reputation for considerably more). For a handful of
friends installing something you handed them directly, the warning is
usually the better trade — but it is the thing to expect a question about.

## Still not done

- **No auto-update.** The Android app updates itself from GitHub releases;
  the desktop app does not yet. Tauri has an updater plugin that works the
  same way, and it needs its own signing keypair — separate from code
  signing, and a separate thing to back up.
- **No Mac build.** The same workflow would need a `macos-latest` runner and
  Apple Developer enrollment for notarization.
- **No menu bar config** (Mac-specific, per the roadmap).

See `AUTONOMOUS_WORK_LOG.md` at the repo root for the session log the
scaffold was built under, and the
[Desktop App Roadmap](https://claude.ai/code/artifact/5b1992c1-9dcc-4a03-8d25-b954fdd7498a).
