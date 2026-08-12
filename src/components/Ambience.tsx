/**
 * The room the app sits in.
 *
 * Film grain and a warm wash at the top of the frame — the same two devices
 * that carry the sign-in page, at a fraction of the strength. Signing in should
 * feel like walking further into the same building, not like leaving it.
 *
 * Both layers sit at `z-index: -1`, behind page content. The grain is therefore
 * only visible where the background is: between rows, around posters, in the
 * margins. Over artwork it is hidden, which is exactly right — the art does not
 * need help, and text stays perfectly crisp.
 *
 * Rendered by the app bar rather than the root layout, because the front door
 * draws its own, heavier version and two grains stacked would read as noise.
 */
export function Ambience() {
  return (
    <>
      <div className="ambience-top" aria-hidden="true" />
      <svg className="ambience-grain" aria-hidden="true" focusable="false">
        <filter id="ambience-grain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.8"
            numOctaves="3"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#ambience-grain)" />
      </svg>
    </>
  );
}
