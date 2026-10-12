import assert from "node:assert/strict";
import { test } from "node:test";

import { peopleHere, publishComments, subscribeComments } from "./comment-bus.ts";

function page(userId: string) {
  const seen = { changed: 0, here: [] as number[] };
  return { seen, listener: { userId, onChanged: () => void (seen.changed += 1), onPresence: (n: number) => void seen.here.push(n) } };
}

test("a change reaches every page on that film and no other", () => {
  const a = page("ann");
  const b = page("bob");
  const elsewhere = page("cat");
  const stops = [
    subscribeComments("tt1", a.listener),
    subscribeComments("tt1", b.listener),
    subscribeComments("tt2", elsewhere.listener),
  ];
  publishComments("tt1");
  assert.deepEqual([a.seen.changed, b.seen.changed, elsewhere.seen.changed], [1, 1, 0]);
  stops.forEach((stop) => stop());
});

test("people are counted once however many screens they have open", () => {
  const phone = page("ann");
  const tv = page("ann");
  const bob = page("bob");
  const stopPhone = subscribeComments("tt3", phone.listener);
  const stopTv = subscribeComments("tt3", tv.listener);
  assert.equal(peopleHere("tt3"), 1);
  const stopBob = subscribeComments("tt3", bob.listener);
  assert.equal(peopleHere("tt3"), 2);
  // Everyone already there is told when somebody arrives, and when they go.
  assert.deepEqual(phone.seen.here, [1, 1, 2]);
  stopBob();
  stopBob();
  assert.deepEqual(phone.seen.here, [1, 1, 2, 1]);
  stopTv();
  stopPhone();
  assert.equal(peopleHere("tt3"), 0);
});
