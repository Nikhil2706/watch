import { test } from "node:test";
import assert from "node:assert/strict";

import { daysLeft, emailStatus, inviteRequest, inviteRows, peopleChips, suspendReport, visibleUsers, type Invite, type User } from "./invites-view.ts";

const NOW = Date.UTC(2026, 9, 15);
const inv = (id: string, status: Invite["status"]): Invite => ({
  id,
  label: id,
  max_uses: 1,
  use_count: 0,
  created_at: "2026-10-01T00:00:00Z",
  expires_at: "2026-10-20T00:00:00Z",
  revoked_at: null,
  status,
  redeemed_usernames: [],
  email: null,
  langlois_mode: false,
});

test("the default view keeps only active invites and counts the rest", () => {
  const all = [inv("a", "active"), inv("b", "revoked"), inv("c", "expired")];
  assert.deepEqual(inviteRows(all, "all", false).rows.map((i) => i.id), ["a"]);
  assert.equal(inviteRows(all, "all", false).hidden, 2);
  assert.equal(inviteRows(all, "all", false).count, "3 invites · 1 active");
  assert.equal(inviteRows(all, "all", true).rows.length, 3);
  assert.deepEqual(inviteRows(all, "revoked", false).rows.map((i) => i.id), ["b"]);
});

test("days left", () => {
  assert.equal(daysLeft("2026-10-16T00:00:00Z", NOW), "1 day left");
  assert.equal(daysLeft("2026-10-20T00:00:00Z", NOW), "5 days left");
  assert.equal(daysLeft("2026-10-14T00:00:00Z", NOW), "expired");
});

test("the create request sends only what differs from the defaults", () => {
  assert.deepEqual(inviteRequest({ label: " Mum ", uses: "1", days: "7", email: "", langlois: false }), { body: { label: "Mum" } });
  assert.deepEqual(inviteRequest({ label: "Club", uses: "5", days: "30", email: " a@b.c ", langlois: true }), {
    body: { label: "Club", max_uses: 5, expires_in_days: 30, email: "a@b.c", langlois_mode: true },
  });
  assert.deepEqual(inviteRequest({ label: "  ", uses: "1", days: "7", email: "", langlois: false }), { error: "Give it a label so you can tell them apart." });
});

test("email outcome lines", () => {
  assert.equal(emailStatus({}), null);
  assert.equal(emailStatus({ email: "a@b.c", email_sent: true })!.ok, true);
  assert.match(emailStatus({ email: "a@b.c", email_sent: false, email_error: "bounced" })!.text, /didn't send \(bounced\)/);
});

const user = (username: string, over: Partial<User> = {}): User => ({
  id: username,
  username,
  last_seen_at: NOW,
  langlois_mode: 0,
  parental_control: 0,
  suspended: 0,
  is_admin: 0,
  ...over,
});

test("people chips count and filter", () => {
  const users = [user("a"), user("b", { suspended: 1 }), user("c", { is_admin: 1 }), user("d", { langlois_mode: true })];
  const chips = Object.fromEntries(peopleChips(users, "all").map((c) => [c.key, c]));
  assert.equal(chips.all!.count, 4);
  assert.equal(chips.active!.count, 2);
  assert.equal(chips.suspended!.alert, true);
  assert.deepEqual(visibleUsers(users, "admin").map((u) => u.username), ["c"]);
  assert.equal(suspendReport(true, 2), "Access revoked — signed out of 2 sessions.");
  assert.equal(suspendReport(false, undefined), "Access restored. They can sign in again.");
});
