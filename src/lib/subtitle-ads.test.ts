import assert from "node:assert/strict";
import { test } from "node:test";

import { isAdCue, stripSubtitleAds } from "./subtitle-ads.ts";

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Official YIFY movies site:
YTS.BZ

2
00:00:10.000 --> 00:00:12.000
- No!

00:00:20.000 --> 00:00:22.000
Advertise your product or brand here
contact www.OpenSubtitles.org today

00:00:30.000 --> 00:00:32.000
I never read the subtitles anyway.
`;

test("drops ad cues and keeps dialogue", () => {
  const out = stripSubtitleAds(VTT);
  assert.ok(out.startsWith("WEBVTT"));
  assert.ok(out.includes("- No!"));
  assert.ok(out.includes("I never read the subtitles anyway."));
  assert.ok(!/YIFY|YTS|OpenSubtitles|Advertise/.test(out));
});

test("the stock credit lines count, dialogue about subtitles does not", () => {
  assert.equal(isAdCue("Subtitles by explosiveskull"), true);
  assert.equal(isAdCue("Synced and corrected by VitoSilans"), true);
  assert.equal(isAdCue("Support us and become VIP member"), true);
  assert.equal(isAdCue("Put the subtitles on, would you?"), false);
  assert.equal(isAdCue("Why did you sync by hand?"), false);
  assert.equal(isAdCue("It's in the yard."), false);
});

test("leaves anything that is not WebVTT, or has no ads, byte-for-byte", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nYTS.MX\n";
  assert.equal(stripSubtitleAds(srt), srt);
  const clean = "WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHello.\r\n";
  assert.equal(stripSubtitleAds(clean), clean);
});
