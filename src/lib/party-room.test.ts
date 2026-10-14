import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyHeartbeat,
  applySync,
  canControl,
  cleanClientId,
  createRoom,
  currentPosition,
  findOrigin,
  participantList,
  removeMember,
  type Member,
  type PartyEvent,
  type RoomState,
} from "./party-room.ts";

const tester = { kind: "user" as const, id: "u-tester", displayName: "tester" };
const mammannii = { kind: "user" as const, id: "u-mam", displayName: "mammannii" };

function join(room: RoomState, identity: Member["identity"], clientId: string) {
  const got: PartyEvent[] = [];
  const member: Member = { identity, clientId, send: (e) => void got.push(e) };
  room.members.add(member);
  return { member, got };
}

function syncs(events: PartyEvent[]) {
  return events.filter((e) => e.type === "sync" || e.type === "position");
}

test("the creator controls; a granted user controls; anyone else does not", () => {
  const grants = { creatorUserId: "u-tester", userIds: [] as string[], guestTokens: [] as string[] };
  assert.equal(canControl(grants, tester), true);
  assert.equal(canControl(grants, mammannii), false);
  assert.equal(canControl({ ...grants, userIds: ["u-mam"] }, mammannii), true);
  // A guest token that happens to equal a user id is not that user.
  assert.equal(canControl({ ...grants, userIds: ["u-mam"] }, { kind: "guest", id: "u-mam" }), false);
  assert.equal(canControl({ ...grants, guestTokens: ["g1"] }, { kind: "guest", id: "g1" }), true);
});

test("a granted controller's pause on the TV reaches the host's laptop, with the TV's position", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const tv = join(room, mammannii, "tv-000001");

  applySync(room, findOrigin(room, mammannii.id, "tv-000001"), mammannii, "pause", 1234.5, 1000);

  assert.deepEqual(syncs(laptop.got), [{ type: "sync", action: "pause", positionSeconds: 1234.5, by: "mammannii" }]);
  assert.deepEqual(syncs(tv.got), [], "not echoed back at the TV");
  assert.equal(room.paused, true);
  assert.equal(currentPosition(room, 99_000), 1234.5, "a paused room stays put");
});

test("a sync is echoed to the sender's other device, but not to the sending stream", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const phone = join(room, mammannii, "phone-00001");
  const tv = join(room, mammannii, "tv-000001");

  // The TV joined second: matching by identity alone would have picked the phone as the origin.
  applySync(room, findOrigin(room, mammannii.id, "tv-000001"), mammannii, "seek", 50, 0);
  assert.equal(syncs(laptop.got).length, 1);
  assert.equal(syncs(phone.got).length, 1);
  assert.equal(syncs(tv.got).length, 0);
});

test("an old client with no client id falls back to its identity's first stream", () => {
  const room = createRoom(0);
  const a = join(room, mammannii, "aaaaaaaa1");
  assert.equal(findOrigin(room, mammannii.id, null), a.member);
  assert.equal(findOrigin(room, mammannii.id, "unknown-id"), a.member);
  assert.equal(findOrigin(room, tester.id, null), undefined);
});

test("a seek keeps the room's play state; play and pause set it", () => {
  const room = createRoom(0);
  join(room, tester, "laptop-0001");
  applySync(room, undefined, tester, "seek", 10, 0);
  assert.equal(room.paused, true, "a seek while paused does not start the room's clock");
  applySync(room, undefined, tester, "play", 10, 0);
  applySync(room, undefined, tester, "seek", 100, 2000);
  assert.equal(room.paused, false);
  assert.equal(currentPosition(room, 5000), 103);
});

test("heartbeats come from the leader only, and move everyone else", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const tv = join(room, mammannii, "tv-000001");
  const phone = join(room, mammannii, "phone-00001");

  applySync(room, laptop.member, tester, "play", 0, 0);
  assert.equal(room.leader, laptop.member);

  // The TV is also a controller, but it is not the one being followed.
  assert.equal(applyHeartbeat(room, tv.member, 3, 5000), false);
  assert.equal(applyHeartbeat(room, laptop.member, 5.2, 5000), true);
  assert.deepEqual(syncs(tv.got).at(-1), { type: "position", positionSeconds: 5.2 });
  assert.deepEqual(syncs(phone.got).at(-1), { type: "position", positionSeconds: 5.2 });
  assert.equal(syncs(laptop.got).length, 0);
  assert.equal(currentPosition(room, 6000), 6.2);

  // Whoever acts last leads.
  applySync(room, tv.member, mammannii, "seek", 60, 7000);
  assert.equal(room.leader, tv.member);
  assert.equal(applyHeartbeat(room, laptop.member, 8, 8000), false);
});

test("a heartbeat cannot restart a paused room, and a departed leader is replaced", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const tv = join(room, mammannii, "tv-000001");

  applySync(room, laptop.member, tester, "pause", 40, 0);
  assert.equal(applyHeartbeat(room, laptop.member, 41, 500), false, "a late heartbeat after a pause");
  assert.equal(room.paused, true);

  applySync(room, laptop.member, tester, "play", 40, 1000);
  removeMember(room, laptop.member);
  assert.equal(room.leader, null);
  assert.equal(applyHeartbeat(room, tv.member, 45, 6000), true);
  assert.equal(room.leader, tv.member);
});

test("the participant list shows a person once, however many screens they have", () => {
  const room = createRoom(0);
  join(room, tester, "laptop-0001");
  join(room, mammannii, "phone-00001");
  join(room, mammannii, "tv-000001");
  const list = participantList(room, (identity) => identity.id === tester.id);
  assert.deepEqual(
    list.map((p) => [p.displayName, p.isController]),
    [
      ["tester", true],
      ["mammannii", false],
    ],
  );
});

test("client ids are plain tokens or nothing", () => {
  assert.equal(cleanClientId("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"), "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
  assert.equal(cleanClientId("short"), null);
  assert.equal(cleanClientId("has spaces in it"), null);
  assert.equal(cleanClientId(42), null);
  assert.equal(cleanClientId("x".repeat(65)), null);
});
