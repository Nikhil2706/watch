/**
 * The mark: a camera aperture.
 *
 * Six chords across a circle, each running from one point on the rim to the
 * point 120° away. They cross to leave a hexagonal opening in the middle —
 * which is exactly how a real iris diaphragm reads. A play triangle would have
 * said "video"; an aperture says "film", which is the club this is.
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
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9.4" stroke="currentColor" strokeWidth="1.3" />
      <g
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity="0.9"
      >
        <path d="M21 12 7.5 19.8" />
        <path d="M16.5 19.8 3 12" />
        <path d="M7.5 19.8 7.5 4.2" />
        <path d="M3 12 16.5 4.2" />
        <path d="M7.5 4.2 21 12" />
        <path d="M16.5 4.2 16.5 19.8" />
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
