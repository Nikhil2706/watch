/**
 * Tests for reloading once when a deploy has removed a page's code chunks.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/chunk-reload.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  isChunkLoadError,
  reloadOnceForChunkError,
  type ChunkReloadDeps,
} from "./chunk-reload.ts";

/** A tab: its sessionStorage survives the reloads it does, and its clock can be moved. */
function tab(start = 1_000_000) {
  const store = new Map<string, string>();
  let clock = start;
  let reloads = 0;
  const deps: ChunkReloadDeps = {
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
    },
    reload: () => void reloads++,
    now: () => clock,
  };
  return {
    deps,
    store,
    get reloads() {
      return reloads;
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

function chunkError(): Error {
  const e = new Error("Loading chunk 482 failed.\n(error: https://watch.example/_next/static/chunks/482.js)");
  e.name = "ChunkLoadError";
  return e;
}

test("recognises chunk-load failures from every engine and bundler", () => {
  assert.ok(isChunkLoadError(chunkError()));
  assert.ok(isChunkLoadError(new Error("Loading CSS chunk 12 failed.")));
  assert.ok(isChunkLoadError(new Error("Failed to load chunk /_next/static/chunks/src_abc.js from module 123")));
  assert.ok(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/_next/a.js")));
  assert.ok(isChunkLoadError(new TypeError("error loading dynamically imported module: https://x/a.js")));
  assert.ok(isChunkLoadError(new TypeError("Importing a module script failed.")));
  assert.ok(isChunkLoadError({ name: "ChunkLoadError", message: "" }));
});

test("does not mistake an ordinary bug for a missing chunk", () => {
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of null (reading 'source')")), false);
  assert.equal(isChunkLoadError(new Error("Failed to fetch")), false); // a network error on an API call
  assert.equal(isChunkLoadError(null), false);
  assert.equal(isChunkLoadError(undefined), false);
  assert.equal(isChunkLoadError(42), false);
});

test("a chunk failure reloads the page once and records when", () => {
  const t = tab();
  assert.equal(reloadOnceForChunkError(chunkError(), t.deps), true);
  assert.equal(t.reloads, 1);
  assert.equal(t.store.get(CHUNK_RELOAD_KEY), "1000000");
});

test("the same failure right after the reload does not reload again: no loop", () => {
  const t = tab();
  reloadOnceForChunkError(chunkError(), t.deps);
  // The page came back and failed the same way.
  t.advance(3_000);
  assert.equal(reloadOnceForChunkError(chunkError(), t.deps), false);
  t.advance(CHUNK_RELOAD_WINDOW_MS - 3_001);
  assert.equal(reloadOnceForChunkError(chunkError(), t.deps), false);
  assert.equal(t.reloads, 1);
});

test("a later deploy, long after the last reload, is recovered from again", () => {
  const t = tab();
  reloadOnceForChunkError(chunkError(), t.deps);
  t.advance(CHUNK_RELOAD_WINDOW_MS + 1);
  assert.equal(reloadOnceForChunkError(chunkError(), t.deps), true);
  assert.equal(t.reloads, 2);
});

test("anything that is not a chunk failure never reloads and leaves the guard alone", () => {
  const t = tab();
  assert.equal(reloadOnceForChunkError(new Error("boom"), t.deps), false);
  assert.equal(t.reloads, 0);
  assert.equal(t.store.has(CHUNK_RELOAD_KEY), false);
});

test("with no sessionStorage, or one that throws, it does not reload: no guard, no risk", () => {
  const none = tab();
  assert.equal(reloadOnceForChunkError(chunkError(), { ...none.deps, storage: null }), false);
  assert.equal(none.reloads, 0);

  const throwing = tab();
  const deps: ChunkReloadDeps = {
    ...throwing.deps,
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    },
  };
  assert.equal(reloadOnceForChunkError(chunkError(), deps), false);
  assert.equal(throwing.reloads, 0);
});

test("a garbage guard value is treated as no reload yet", () => {
  const t = tab();
  t.store.set(CHUNK_RELOAD_KEY, "not a number");
  assert.equal(reloadOnceForChunkError(chunkError(), t.deps), true);
});
