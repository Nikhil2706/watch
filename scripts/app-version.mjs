#!/usr/bin/env node
/**
 * The Android app's version, from the build rather than by hand.
 *
 * The installed app offers an update only when latest.json's versionCode is
 * higher than its own (UpdateChecker.java). versionCode used to be typed into
 * apps/mobile/android/app/build.gradle, so a merge that forgot to bump it
 * shipped the same number again and nobody was offered it: on 2026-10-14
 * PR #30 went out as 1.7 a second time, and only the manual bump in #33
 * reached anyone.
 *
 * Now the APK workflow stamps both numbers into build.gradle on the runner
 * (never committed) before building, and writes latest.json from the same
 * values:
 *   versionCode = OFFSET + the workflow's run number  (every build is higher)
 *   versionName = build.gradle's versionName + "." + run number  ("1.8.16")
 * build.gradle's versionName stays the human part: change it to "1.9" for a
 * release worth naming; the run number keeps counting either way.
 *
 *   node scripts/app-version.mjs <build.gradle> <runNumber>
 *     stamps the file, prints {"versionCode":…,"versionName":…}, and appends
 *     version_code= / version_name= to $GITHUB_OUTPUT when set.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Comfortably above every versionCode ever typed by hand (9 at the switch),
 * and above anything a hand bump would plausibly reach before someone notices.
 */
export const VERSION_CODE_OFFSET = 100;

/** Android's ceiling for versionCode. */
const MAX_VERSION_CODE = 2_100_000_000;

const CODE_LINE = /^(\s*)versionCode\s+(\d+)\s*$/m;
const NAME_LINE = /^(\s*)versionName\s+"([^"]+)"\s*$/m;

function only(gradle, re, what) {
  const all = gradle.match(new RegExp(re.source, "gm")) ?? [];
  if (all.length !== 1) throw new Error(`expected exactly one ${what} line in build.gradle, found ${all.length}`);
  return gradle.match(re);
}

export function readGradleVersion(gradle) {
  return {
    versionCode: Number(only(gradle, CODE_LINE, "versionCode")[2]),
    versionName: only(gradle, NAME_LINE, "versionName")[2],
  };
}

export function computeVersion({ gradle, runNumber, offset = VERSION_CODE_OFFSET }) {
  const run = Number(runNumber);
  if (!Number.isInteger(run) || run < 1) throw new Error(`run number must be a positive integer, got "${runNumber}"`);
  const base = readGradleVersion(gradle);
  const versionCode = offset + run;
  // A hand bump in build.gradle past the computed number would make this build
  // LOWER than what is installed: Android would refuse it as a downgrade and
  // the app would never offer it. Fail loudly instead.
  if (versionCode <= base.versionCode) {
    throw new Error(
      `computed versionCode ${versionCode} is not above build.gradle's ${base.versionCode}; ` +
        `set build.gradle's versionCode back below ${offset + 1} (it is no longer the source of truth) or raise VERSION_CODE_OFFSET`,
    );
  }
  if (versionCode > MAX_VERSION_CODE) throw new Error(`versionCode ${versionCode} is past Android's limit`);
  return { versionCode, versionName: `${base.versionName}.${run}` };
}

export function stampGradle(gradle, { versionCode, versionName }) {
  only(gradle, CODE_LINE, "versionCode");
  only(gradle, NAME_LINE, "versionName");
  return gradle
    .replace(CODE_LINE, (_, indent) => `${indent}versionCode ${versionCode}`)
    .replace(NAME_LINE, (_, indent) => `${indent}versionName "${versionName}"`);
}

/** The descriptor the installed app and the site's /app page read. */
export function latestJson({ versionCode, versionName }, apkUrl) {
  return JSON.stringify({ versionCode, versionName, apk: apkUrl }, null, 2) + "\n";
}

function main(argv) {
  const [gradlePath, runNumber] = argv;
  if (!gradlePath || !runNumber) {
    console.error("usage: node scripts/app-version.mjs <build.gradle> <runNumber>");
    process.exit(2);
  }
  const gradle = readFileSync(gradlePath, "utf8");
  const version = computeVersion({ gradle, runNumber });
  writeFileSync(gradlePath, stampGradle(gradle, version));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version_code=${version.versionCode}\nversion_name=${version.versionName}\n`);
  }
  console.log(JSON.stringify(version));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
