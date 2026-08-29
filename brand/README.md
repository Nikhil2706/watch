# The Watch mark

An iris with the light on. Six leaves around a hexagonal opening, in the app's
own `--warm` (`#ffd9a0`) on `--bg` (`#06070a`).

This is not a new identity. `src/components/Brand.tsx` already draws an
aperture, and the reasoning in that file still holds — a play triangle says
video, an aperture says film. What was missing is that the app icon and
favicon never got the memo: they shipped a blue **W**, in the interaction
accent, which is the one colour the mark should never be. These files finish
the mark that was already there and make every surface agree.

## Geometry

Six chords cross a circle of radius `R`. Where they cross they leave a regular
hexagon of circumradius `R / √3`, apothem `R / 2` — each chord is trisected by
it, so the outer thirds are leaf edges and the middle third is an edge of the
opening. Each leaf is the circular segment its chord cuts off; the six of them
union to exactly the disc minus the opening, which is why they tile with no
seam and no gap.

All six leaves lean the same way. **Never mirror the mark** — flipped, it is a
different lens.

`gen.py` is the construction, not an export. The aperture is one parameter
(`alpha`, the half-span of a leaf's chord; 60° is the logo, 90° is shut), so
the whole system can be re-rendered at any size:

```bash
python brand/gen.py
```

## Files

| File | Use |
| --- | --- |
| `mark.svg` | Full colour, transparent ground. 48px and up. |
| `mark-line.svg` | `currentColor` strokes, for the app. 18px and up. |
| `mark-small.svg` | Ring and opening only. Under 24px. |
| `mark-solid.svg` | One ink, leaf cuts masked out. Print and light grounds. |
| `icon.svg` / `icon-maskable.svg` / `favicon.svg` | App icon sources. |
| `public/*.png` | Rasterised drop-ins for `../public/`. |

PNGs are rendered with sharp inside the `jellyfin-gate` container (libvips has
the SVG loader; the host has no node on PATH):

```bash
docker cp brand jellyfin-gate:/tmp/brand
docker exec -e NODE_PATH=/app/node_modules jellyfin-gate node /tmp/brand/raster.js
```

## Installing

1. Copy `brand/public/*.png` over `public/`. No code change needed —
   `layout.tsx` and `manifest.json` already point at those filenames.
2. Add `icon-maskable-512.png` to `manifest.json` and split the `purpose`
   entries, so Android stops padding the square icon inside its own mask.
3. Replace `Mark()` in `src/components/Brand.tsx` with the six-seam version
   (same export, same `currentColor` behaviour, 24 viewBox, 1.25 stroke).

## Rules

- The opening is warm. `--accent` blue is for things you can press and never
  touches the mark.
- Nothing enters the clear space of `R / 2` on every side.
- No play triangle inside the opening.
- On a light ground use `mark-solid.svg`; the full mark's halo turns to smear.
