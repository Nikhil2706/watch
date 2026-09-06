// Renders the 1024px source that `tauri icon` expands into every Windows/Mac
// icon size, from the SAME brand mark the website uses (../../brand/icon.svg).
//
// The icons committed under src-tauri/icons were generated on 2026-08-19 from
// the old placeholder — a blue "W" in the interaction accent, which
// brand/README.md is explicit is the one colour the mark must never be. The
// real aperture mark landed on 2026-08-28 and the desktop app never got it, so
// the title bar and taskbar were still showing the wrong logo. Regenerating
// here at build time means brand/ stays the single source and this cannot
// drift again.
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const SRC = process.env.BRAND_ICON || path.join(__dirname, "..", "..", "brand", "icon.svg");
const OUT = path.join(__dirname, "icon-1024.png");

// density: rasterise large before resizing, or the gradients in the mark band.
sharp(fs.readFileSync(SRC), { density: 1024 })
  .resize(1024, 1024)
  .png({ compressionLevel: 9 })
  .toFile(OUT)
  .then(() => console.log("wrote", OUT))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
