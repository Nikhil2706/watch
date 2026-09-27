/**
 * The downward arrow on download buttons, drawn rather than typed. "⬇"
 * (U+2B07) is missing from the Android system font, where it rendered as a
 * thin bar. Same path as the Downloads tab in MobileTabBar.
 */
export function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      aria-hidden="true"
      style={{ verticalAlign: "-0.125em", marginRight: "0.35em" }}
    >
      <path
        d="M12 3v12M7 10l5 5 5-5M4 20h16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
