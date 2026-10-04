/**
 * How big subtitles are, on every screen.
 *
 * The player's own sheet sets them by the width of the window in fixed steps
 * — 13px, 15px, 18px, 21px in fullscreen — and the TV sheet said 48px. Those
 * are five unrelated sizes: against the picture they were 1.4% of its width
 * on a wide desktop window, 1.1% in fullscreen on a laptop, 2.5% on a TV and
 * 3.3% on a phone held upright, so the same film read differently on every
 * device.
 *
 * One rule instead: text is a fixed share of the picture's width. Width, not
 * height, so a 2.39:1 film does not get smaller text than a 16:9 one on the
 * same screen. The share is the TV's, which was chosen by eye at couch
 * distance and is the one size nobody complained about.
 */

/** Text height as a share of the picture's width: 48px on a 1920-wide TV. */
export const CAPTION_SHARE = 0.025;

/**
 * Below this the letters stop being readable whatever the ratio says — a
 * phone held upright has a 390px picture, and 2.5% of that is under 10px.
 */
export const CAPTION_MIN_PX = 14;

/**
 * The width of the picture inside the video element's box. The element is
 * `object-fit: contain`, so in fullscreen the box is the screen and the
 * picture is letterboxed or pillarboxed inside it. Before the video's own
 * size is known the box is the best answer there is.
 */
export function pictureWidth(
  box: { width: number; height: number },
  video: { width: number; height: number } | null,
): number {
  if (!video || video.width <= 0 || video.height <= 0 || box.height <= 0) return box.width;
  return Math.min(box.width, box.height * (video.width / video.height));
}

export function captionFontPx(
  box: { width: number; height: number },
  video: { width: number; height: number } | null,
): number {
  return Math.max(CAPTION_MIN_PX, Math.round(pictureWidth(box, video) * CAPTION_SHARE));
}
