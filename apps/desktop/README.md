# Watch — desktop app (Tauri shell)

Phase 1 of the [Desktop App Roadmap](https://claude.ai/code/artifact/5b1992c1-9dcc-4a03-8d25-b954fdd7498a) —
scaffolded, not built. Tauri (not Electron) — uses the OS's own WebView
(WebView2 on Windows, WKWebView on Mac) instead of bundling Chromium, so the
eventual installer lands around 5-15MB instead of hundreds.

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

## What's NOT done, and why

This machine has **no Rust/Cargo installed at all**. Confirmed by
`create-tauri-app` itself flagging it as a missing dependency during
scaffolding, and separately by `npm run tauri info` hanging/timing out
rather than completing — Tauri's CLI needs to inspect the Rust toolchain to
report on it, and no toolchain means no report.

- **No real build, at all.** `npm run tauri dev` / `npm run tauri build`
  both need a working `cargo`, `rustc`, and (on Windows) the MSVC build
  tools — none confirmed installed. This wasn't attempted.
- **No window/title-bar theming beyond the basics already in
  `tauri.conf.json`** (dark-mode-matching chrome, per the roadmap, is a
  "Build" item, not yet touched).
- **No menu bar config** (Mac-specific, per the roadmap).
- **No code signing** — flagged as blocked-on-you in the roadmap artifact
  (a paid cert for Windows SmartScreen, Apple Developer Program enrollment
  for Mac notarization).

## To actually build this later

Needs, at minimum: Rust (via [rustup](https://rustup.rs)), and on Windows,
the "Desktop development with C++" workload from the Visual Studio Build
Tools (Tauri's own prerequisites page has full per-OS instructions:
https://tauri.app/start/prerequisites/). Once installed:

```
cd apps/desktop
npm install
npm run tauri dev      # live dev window
npm run tauri build    # produces the real installer
```

See `AUTONOMOUS_WORK_LOG.md` at the repo root for the full session log this
was built under.
