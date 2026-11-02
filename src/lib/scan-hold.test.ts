import assert from "node:assert/strict";
import { test } from "node:test";

import { AFTER_SCAN_MS, newScanHold, SCAN_HOLD_MS, scanEnded, scanHolding, scanStarted } from "./scan-hold.ts";

test("nothing holds before any scan", () => {
  assert.equal(scanHolding(newScanHold(), 1_000), false);
});

test("a scan holds from its start until a little after it ends", () => {
  // 2026-11-02: scan asked for at 0, Jellyfin done at 10 s, console reloads at 14 s.
  const h = newScanHold();
  scanStarted(h, 0);
  assert.equal(scanHolding(h, 1_000), true, "the relinks right after the start must not fill the cache");
  assert.equal(scanHolding(h, 14_000), true, "nor the console's reload when the scan ends");
  scanEnded(h, 15_000);
  assert.equal(scanHolding(h, 15_000 + AFTER_SCAN_MS - 1), true);
  assert.equal(scanHolding(h, 15_000 + AFTER_SCAN_MS), false);
});

test("a hold nobody ends lapses after SCAN_HOLD_MS", () => {
  const h = newScanHold();
  scanStarted(h, 0);
  assert.equal(scanHolding(h, SCAN_HOLD_MS - 1), true);
  assert.equal(scanHolding(h, SCAN_HOLD_MS), false);
});

test("overlapping scans hold until the last one ends", () => {
  const h = newScanHold();
  scanStarted(h, 0);
  scanStarted(h, 5_000);
  scanEnded(h, 20_000);
  assert.equal(scanHolding(h, 20_000 + AFTER_SCAN_MS + 1), true, "the second scan is still running");
  scanEnded(h, 600_000);
  assert.equal(scanHolding(h, 600_000 + AFTER_SCAN_MS - 1), true);
  assert.equal(scanHolding(h, 600_000 + AFTER_SCAN_MS), false);
});

test("an extra end does not go below zero or reopen anything", () => {
  const h = newScanHold();
  scanEnded(h, 0);
  scanEnded(h, 0);
  assert.equal(h.open, 0);
  scanStarted(h, AFTER_SCAN_MS);
  scanEnded(h, AFTER_SCAN_MS);
  assert.equal(scanHolding(h, 2 * AFTER_SCAN_MS), false);
});
