// Renders the app icon and splash sources for @capacitor/assets, from the
// SAME brand SVGs the website uses (../../brand). The shell shipped with
// Capacitor's default placeholder icons; this is what makes the launcher
// icon and the site agree.
//
// Run it through apps/mobile/build-apk.sh, which supplies the container and
// the sharp install - the host has no node on PATH.
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

// Defaults are the container mount points used by build-apk.sh; CI checks the
// repo out somewhere else and passes real paths instead.
const BRAND = process.env.BRAND_DIR || "/brand";
const OUT = process.env.OUT_DIR || "/app/assets";
const BG = "#06070a";              // --bg, the site's ground
const ICON = 1024;                 // what @capacitor/assets wants
const SPLASH = 2732;

fs.mkdirSync(OUT, { recursive: true });

// density: rasterise the SVG at a high internal resolution before resizing,
// otherwise the gradients in the mark band badly at 1024.
const svg = (name) => sharp(fs.readFileSync(path.join(BRAND, name)), { density: 1024 });

(async () => {
  // Square icon: icon.svg already carries its own ground.
  await svg("icon.svg").resize(ICON, ICON).png({ compressionLevel: 9 })
    .toFile(path.join(OUT, "icon.png"));

  // Adaptive icon. Android masks the foreground to a circle/squircle and only
  // the middle ~72% survives, so the maskable variant - which is drawn with
  // that padding - is the right source. Background is flat brand ground.
  await svg("icon-maskable.svg").resize(ICON, ICON).png({ compressionLevel: 9 })
    .toFile(path.join(OUT, "icon-foreground.png"));

  await sharp({ create: { width: ICON, height: ICON, channels: 4, background: BG } })
    .png({ compressionLevel: 9 }).toFile(path.join(OUT, "icon-background.png"));

  // Splash: the mark small and centred on the ground, not stretched to fill.
  // Clear space matters - brand/README.md asks for R/2 on every side.
  const markSize = Math.round(SPLASH * 0.22);
  const mark = await svg("mark.svg").resize(markSize, markSize).png().toBuffer();
  const splash = await sharp({
    create: { width: SPLASH, height: SPLASH, channels: 4, background: BG },
  }).composite([{ input: mark, gravity: "centre" }]).png({ compressionLevel: 9 }).toBuffer();

  fs.writeFileSync(path.join(OUT, "splash.png"), splash);
  // The app is dark in both schemes, so the dark splash is the same image.
  fs.writeFileSync(path.join(OUT, "splash-dark.png"), splash);

  for (const f of fs.readdirSync(OUT)) {
    const m = await sharp(path.join(OUT, f)).metadata();
    console.log(`  ${f}  ${m.width}x${m.height}`);
  }
})();
