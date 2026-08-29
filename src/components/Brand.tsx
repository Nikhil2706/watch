/**
 * The mark: a camera aperture.
 *
 * Six chords across a circle, each running from one point on the rim to the
 * point 120° away. They cross to leave a hexagonal opening in the middle —
 * which is exactly how a real iris diaphragm reads. A play triangle would have
 * said "video"; an aperture says "film", which is the club this is.
 *
 * The opening is drawn explicitly rather than left as the accident of six
 * crossing lines. Six leading edges instead of twelve half-chords: the earlier
 * version showed both halves of every chord, which reads as a hex lattice
 * rather than as six leaves. All six lean the same way — that chirality is
 * what stops it looking like a snowflake, so it must never be mirrored.
 * See `brand/` for the construction and the filled variants.
 *
 * Drawn rather than imported: an SVG this small costs less than the request an
 * icon font or image file would make, and it inherits `currentColor` so it
 * lights up with the text beside it.
 */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="8.6" />
      <path d="M 16.3 9.52 L 12 7.03 L 7.7 9.52 L 7.7 14.48 L 12 16.97 L 16.3 14.48 Z" />
      <g opacity="0.8">
        <path d="M 20.6 12 12 7.03" />
        <path d="M 16.3 4.55 7.7 9.52" />
        <path d="M 7.7 4.55 7.7 14.48" />
        <path d="M 3.4 12 12 16.97" />
        <path d="M 7.7 19.45 16.3 14.48" />
        <path d="M 16.3 19.45 16.3 9.52" />
      </g>
    </svg>
  );
}

/**
 * Wordmark: the mark plus the name.
 *
 * Set in a serif against the app's sans UI. One typeface doing something
 * different from everything around it is the cheapest way to make a name read
 * as a name rather than as another label — and a serif carries the right
 * connotation here without costing a webfont download, since every platform
 * already ships one.
 */
export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <span className="wordmark">
      <Mark size={size} />
      <span className="wordmark-text">Watch</span>
    </span>
  );
}
