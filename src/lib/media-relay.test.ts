/**
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/media-relay.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { mediaBase, viaMediaRelay } from "./media-relay.ts";

const BASE = "http://127.0.0.1:41234/abcdefghijklmnop1234";

test("only a 127.0.0.1 relay with a secret path is accepted", () => {
  assert.equal(mediaBase({ __watchMediaBase: BASE }), BASE);
  assert.equal(mediaBase({}), null);
  assert.equal(mediaBase(undefined), null);
  assert.equal(mediaBase({ __watchMediaBase: "http://127.0.0.1:41234" }), null);
  assert.equal(mediaBase({ __watchMediaBase: "http://evil.test:41234/abcdefghijklmnop1234" }), null);
  assert.equal(mediaBase({ __watchMediaBase: "https://127.0.0.1:41234/abcdefghijklmnop1234" }), null);
  assert.equal(mediaBase({ __watchMediaBase: 42 }), null);
});

test("only the site's own /jf/ addresses go through the relay", () => {
  assert.equal(viaMediaRelay("/jf/Videos/abc/stream?static=true", BASE), BASE + "/jf/Videos/abc/stream?static=true");
  assert.equal(viaMediaRelay("/jf/videos/abc/master.m3u8?x=1", BASE), BASE + "/jf/videos/abc/master.m3u8?x=1");
  assert.equal(viaMediaRelay("/jf/Videos/abc/stream", null), "/jf/Videos/abc/stream");
  assert.equal(viaMediaRelay("https://elsewhere.test/v.mp4", BASE), "https://elsewhere.test/v.mp4");
  assert.equal(viaMediaRelay("/api/thing", BASE), "/api/thing");
});
