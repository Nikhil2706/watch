const sharp = require('sharp'); const fs = require('fs');
const D = '/tmp/brand/';
const jobs = [
  ['icon.svg', 512, 'icon-512.png'], ['icon.svg', 192, 'icon-192.png'],
  ['icon.svg', 180, 'apple-touch-icon.png'], ['icon.svg', 64, 'preview-icon-64.png'],
  ['icon-maskable.svg', 512, 'icon-maskable-512.png'],
  ['favicon.svg', 32, 'favicon-32.png'], ['favicon.svg', 16, 'preview-favicon-16.png'],
  ['mark.svg', 512, 'mark-512.png'],
  ['mark-solid.svg', 512, 'mark-solid-512.png'],
];
(async () => {
  for (const [src, size, out] of jobs) {
    await sharp(fs.readFileSync(D + src), { density: 512 })
      .resize(size, size).png({ compressionLevel: 9 }).toFile(D + out);
    console.log(out);
  }
})();
