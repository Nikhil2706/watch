/**
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/app-mirror-rules.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { byteRange, parseDescriptor } from "./app-mirror-rules.ts";

test("a GitHub latest.json is read; anything else is not", () => {
  assert.deepEqual(parseDescriptor('{"versionCode":127,"versionName":"1.8.27","apk":"x"}'), { versionCode: 127, versionName: "1.8.27" });
  assert.deepEqual(parseDescriptor('{"versionCode":"128"}'), { versionCode: 128, versionName: "128" });
  assert.equal(parseDescriptor("<html>"), null);
  assert.equal(parseDescriptor('{"versionCode":0}'), null);
  assert.equal(parseDescriptor('{"versionName":"1.0"}'), null);
});

test("byte ranges for resuming a download", () => {
  assert.equal(byteRange(null, 100), null);
  assert.deepEqual(byteRange("bytes=10-", 100), { start: 10, end: 99 });
  assert.deepEqual(byteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(byteRange("bytes=90-200", 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange("bytes=-30", 100), { start: 70, end: 99 });
  assert.equal(byteRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(byteRange("items=1-2", 100), null);
});
