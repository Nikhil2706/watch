import assert from "node:assert/strict";
import { test } from "node:test";

import { browserProfile, H264_MAX_LEVEL, playbackClient, type PlaybackClient } from "./playback-profile.ts";

const UA = {
  androidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  androidPhoneApp:
    "Mozilla/5.0 (Linux; Android 14; SM-S921B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  iPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  // The Watch app on a TV: its WebView's agent with " AndroidTV" appended (MainActivity.java).
  watchAppOnTv:
    "Mozilla/5.0 (Linux; Android 11; BRAVIA 4K VH2 Build/RTT2.220118.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 AndroidTV",
  fireTv:
    "Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7233; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36",
  tizen:
    "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
};

const client = (userAgent: string | null, cookieValue?: string) => playbackClient({ userAgent, cookieValue });

function videoLevel(c: PlaybackClient): string | undefined {
  return browserProfile(c)
    .CodecProfiles.find((p) => p.Codec === "h264")
    ?.Conditions.find((x) => x.Property === "VideoLevel")?.Value;
}

test("phones and tablets are phones", () => {
  for (const ua of [UA.androidPhone, UA.androidPhoneApp, UA.androidTablet, UA.iPhone]) assert.equal(client(ua), "phone", ua);
});

test("TVs are TVs, the Watch app on a TV included", () => {
  for (const ua of [UA.watchAppOnTv, UA.fireTv, UA.tizen]) assert.equal(client(ua), "tv", ua);
});

test("desktop browsers are desktops", () => {
  for (const ua of [UA.windowsChrome, UA.macSafari, UA.linuxFirefox]) assert.equal(client(ua), "desktop", ua);
});

test("the tv-mode cookie decides, either way", () => {
  // A TV browser with an ordinary agent, put in TV mode by the site's own detection.
  assert.equal(client(UA.windowsChrome, "1"), "tv");
  // A TV switched out of TV mode (?tv=0) is judged by its agent like anything else.
  assert.equal(client(UA.watchAppOnTv, "0"), "phone");
  assert.equal(client(UA.tizen, "0"), "desktop");
});

test("no agent at all gets the phone's (always safe) profile", () => {
  assert.equal(client(null), "phone");
  assert.equal(client(""), "phone");
});

test("H.264 level: 4.1 for phones, 5.2 for TVs and desktops", () => {
  assert.equal(videoLevel("phone"), "41");
  assert.equal(videoLevel("tv"), "52");
  assert.equal(videoLevel("desktop"), "52");
  // The Social Network, High@5.1: over the phone's ceiling, within the others'.
  assert.ok(51 > H264_MAX_LEVEL.phone);
  assert.ok(51 <= H264_MAX_LEVEL.tv && 51 <= H264_MAX_LEVEL.desktop);
});

test("only the level differs between clients", () => {
  const strip = (c: PlaybackClient) => {
    const p = browserProfile(c);
    return JSON.stringify({
      ...p,
      CodecProfiles: p.CodecProfiles.map((cp) => ({ ...cp, Conditions: cp.Conditions.filter((x) => x.Property !== "VideoLevel") })),
    });
  };
  assert.equal(strip("tv"), strip("phone"));
  assert.equal(strip("desktop"), strip("phone"));
  // The 1080p transcode ceiling is unchanged for every client.
  const conds = browserProfile("desktop").CodecProfiles[0]!.Conditions;
  assert.deepEqual(
    conds.filter((x) => x.Property !== "VideoLevel").map((x) => [x.Property, x.Value]),
    [["Width", "1920"], ["Height", "1080"], ["VideoBitrate", "8000000"]],
  );
});
