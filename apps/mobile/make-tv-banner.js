// The Android TV launcher shows a 320x180 banner per app, not the launcher
// icon — an app without one either does not appear in the TV app row or
// appears blank. Built from the same brand/ mark as every other surface.
//
// Committed rather than generated in CI, unlike the phone icons: it composites
// text, so it depends on a font being installed, and that is worth eyeballing
// once rather than trusting a build machine to render the same way.
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const BRAND = process.env.BRAND_DIR || "/brand";
const OUT = process.env.OUT_FILE || "/out/tv_banner.png";
const W = 320;
const H = 180;
const BG = "#06070a";      // --bg, the site's ground
const WARM = "#ffd9a0";    // --warm, the aperture

(async () => {
  const mark = await sharp(fs.readFileSync(path.join(BRAND, "mark.svg")), { density: 512 })
    .resize(104, 104)
    .png()
    .toBuffer();

  // Serif to match the site's own wordmark, which is ui-serif everywhere.
  const text = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
       <text x="150" y="99" font-family="DejaVu Serif, Georgia, serif"
             font-size="46" fill="${WARM}">Watch</text>
       <text x="152" y="126" font-family="DejaVu Sans, sans-serif"
             font-size="14" fill="#9c9284">film library</text>
     </svg>`
  );

  await sharp({ create: { width: W, height: H, channels: 4, background: BG } })
    .composite([
      { input: mark, top: 38, left: 28 },
      { input: text, top: 0, left: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toFile(OUT);

  const m = await sharp(OUT).metadata();
  console.log(`wrote ${OUT} ${m.width}x${m.height}`);
})();
