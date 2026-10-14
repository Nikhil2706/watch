import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { computeVersion, latestJson, readGradleVersion, stampGradle, VERSION_CODE_OFFSET } from "./app-version.mjs";

const REAL_GRADLE = readFileSync(new URL("../apps/mobile/android/app/build.gradle", import.meta.url), "utf8");

const gradle = (code, name) => `android {
    defaultConfig {
        applicationId "com.abhigyanverma.watch"
        versionCode ${code}
        versionName "${name}"
    }
    buildTypes {
        debug {
            versionNameSuffix "-dev"
        }
    }
}
`;

test("the repo's build.gradle parses", () => {
  const v = readGradleVersion(REAL_GRADLE);
  assert.ok(Number.isInteger(v.versionCode));
  assert.match(v.versionName, /^\d+(\.\d+)*$/);
});

test("versionCode is the run number plus the offset; versionName gains the run number", () => {
  assert.deepEqual(computeVersion({ gradle: gradle(9, "1.8"), runNumber: "16" }), { versionCode: 116, versionName: "1.8.16" });
  assert.equal(VERSION_CODE_OFFSET, 100);
});

test("every later run is a higher versionCode, so installed apps are always offered it", () => {
  const codes = [16, 17, 18, 40, 1000].map((run) => computeVersion({ gradle: gradle(9, "1.8"), runNumber: run }).versionCode);
  for (let i = 1; i < codes.length; i++) assert.ok(codes[i] > codes[i - 1]);
  // Above every hand-typed code so far (9), from the very first run.
  assert.ok(computeVersion({ gradle: gradle(9, "1.8"), runNumber: 1 }).versionCode > 9);
});

test("renaming the release keeps the code climbing", () => {
  const before = computeVersion({ gradle: gradle(9, "1.8"), runNumber: 20 });
  const after = computeVersion({ gradle: gradle(9, "1.9"), runNumber: 21 });
  assert.equal(after.versionName, "1.9.21");
  assert.ok(after.versionCode > before.versionCode);
});

test("the forgotten-bump case: same build.gradle, next merge, still a higher number", () => {
  // PR #30: merged without touching build.gradle and shipped as 1.7 again.
  const first = computeVersion({ gradle: gradle(8, "1.7"), runNumber: 14 });
  const second = computeVersion({ gradle: gradle(8, "1.7"), runNumber: 15 });
  assert.notEqual(first.versionName, second.versionName);
  assert.ok(second.versionCode > first.versionCode);
});

test("a hand bump past the computed number fails instead of shipping a downgrade", () => {
  assert.throws(() => computeVersion({ gradle: gradle(500, "2.0"), runNumber: 16 }), /not above build\.gradle's 500/);
});

test("bad run numbers are refused", () => {
  for (const bad of ["", "0", "-3", "1.5", "abc", undefined]) {
    assert.throws(() => computeVersion({ gradle: gradle(9, "1.8"), runNumber: bad }), /positive integer/);
  }
});

test("stamping changes only the two version lines", () => {
  const before = gradle(9, "1.8");
  const after = stampGradle(before, { versionCode: 116, versionName: "1.8.16" });
  assert.deepEqual(readGradleVersion(after), { versionCode: 116, versionName: "1.8.16" });
  assert.equal(after.replace(/versionCode \d+/, "").replace(/versionName "[^"]+"/, ""), before.replace(/versionCode \d+/, "").replace(/versionName "[^"]+"/, ""));
  assert.match(after, /versionNameSuffix "-dev"/); // the dev suffix line is not a versionName line
  // The real file too.
  const real = stampGradle(REAL_GRADLE, { versionCode: 116, versionName: "1.8.16" });
  assert.deepEqual(readGradleVersion(real), { versionCode: 116, versionName: "1.8.16" });
  assert.equal(real.split("\n").length, REAL_GRADLE.split("\n").length);
});

test("a build.gradle without exactly one of each line is refused", () => {
  assert.throws(() => readGradleVersion("android {}"), /exactly one versionCode/);
  assert.throws(() => readGradleVersion(gradle(9, "1.8") + gradle(9, "1.8")), /exactly one versionCode line.*found 2/);
});

test("latest.json carries the same numbers", () => {
  const v = computeVersion({ gradle: gradle(9, "1.8"), runNumber: 16 });
  const json = JSON.parse(latestJson(v, "https://github.com/x/y/releases/latest/download/watch-release.apk"));
  assert.deepEqual(json, {
    versionCode: 116,
    versionName: "1.8.16",
    apk: "https://github.com/x/y/releases/latest/download/watch-release.apk",
  });
});

test("the CLI stamps the file and writes GITHUB_OUTPUT", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-version-"));
  const file = join(dir, "build.gradle");
  const out = join(dir, "out");
  writeFileSync(file, gradle(9, "1.8"));
  writeFileSync(out, "");
  const printed = execFileSync(process.execPath, [new URL("./app-version.mjs", import.meta.url).pathname, file, "16"], {
    env: { ...process.env, GITHUB_OUTPUT: out },
  }).toString();
  assert.deepEqual(JSON.parse(printed), { versionCode: 116, versionName: "1.8.16" });
  assert.deepEqual(readGradleVersion(readFileSync(file, "utf8")), { versionCode: 116, versionName: "1.8.16" });
  assert.equal(readFileSync(out, "utf8"), "version_code=116\nversion_name=1.8.16\n");
});
