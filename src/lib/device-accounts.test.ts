import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addDeviceAccount,
  MAX_DEVICE_ACCOUNTS,
  parseDeviceAccounts,
  removeDeviceAccount,
  serializeDeviceAccounts,
  shouldAskWhoIsWatching,
} from "./device-accounts.ts";

const id = (n: number) => `session-id-number-${String(n).padStart(4, "0")}-abcdefghijklmnop`;

test("the list round-trips, and anything that is not a session id is dropped", () => {
  const ids = [id(1), id(2)];
  assert.deepEqual(parseDeviceAccounts(serializeDeviceAccounts(ids)), ids);
  assert.deepEqual(parseDeviceAccounts(`${id(1)}.not an id.${id(1)}.<script>`), [id(1)]);
  assert.deepEqual(parseDeviceAccounts(undefined), []);
  assert.deepEqual(parseDeviceAccounts(""), []);
});

test("signing in puts the new session first and keeps everyone else", () => {
  assert.deepEqual(addDeviceAccount([id(1), id(2)], id(3)), [id(3), id(1), id(2)]);
});

test("signing the same account in again replaces its old session", () => {
  const sameAccount = (other: string) => other === id(2);
  assert.deepEqual(addDeviceAccount([id(1), id(2)], id(3), sameAccount), [id(3), id(1)]);
});

test("a full list drops the account signed in longest ago", () => {
  const full = Array.from({ length: MAX_DEVICE_ACCOUNTS }, (_, i) => id(i));
  const after = addDeviceAccount(full, id(99));
  assert.equal(after.length, MAX_DEVICE_ACCOUNTS);
  assert.equal(after[0], id(99));
  assert.ok(!after.includes(id(MAX_DEVICE_ACCOUNTS - 1)));
});

test("signing out removes only that account", () => {
  assert.deepEqual(removeDeviceAccount([id(1), id(2), id(3)], id(2)), [id(1), id(3)]);
});

test("Who's watching? opens on Home on an idle TV with more than one account", () => {
  const base = { tvMode: true, savedAccounts: 2, recentlyUsed: false, pathname: "/" };
  assert.equal(shouldAskWhoIsWatching(base), true);
  assert.equal(shouldAskWhoIsWatching({ ...base, recentlyUsed: true }), false);
  assert.equal(shouldAskWhoIsWatching({ ...base, savedAccounts: 1 }), false);
  assert.equal(shouldAskWhoIsWatching({ ...base, tvMode: false }), false);
  assert.equal(shouldAskWhoIsWatching({ ...base, pathname: "/watch/abc" }), false);
});
