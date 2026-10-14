import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addMember,
  excerpt,
  groupReactions,
  controllerWatching,
  pauseOrphaned,
  applyHeartbeat,
  applySync,
  canControl,
  cleanClientId,
  createRoom,
  currentPosition,
  dropLeaderIf,
  findOrigin,
  markReady,
  participantList,
  removeMember,
  stampTime,
  type Member,
  type PartyEvent,
  type RoomState,
} from "./party-room.ts";

const tester = { kind: "user" as const, id: "u-tester", displayName: "tester" };
const mammannii = { kind: "user" as const, id: "u-mam", displayName: "mammannii" };

/** tester created the room in every test here. */
function join(room: RoomState, identity: Member["identity"], clientId: string, watching = true) {
  const got: PartyEvent[] = [];
  const member: Member = { identity, clientId, isCreator: identity.id === tester.id, watching, send: (e) => void got.push(e) };
  addMember(room, member);
  return { member, got };
}

/**
 * A play (or a seek while playing) carried all the way through: every watching
 * screen says ready at once, and the start (scheduled START_LEAD_MIN_MS ahead)
 * lands exactly at `at`.
 */
function playNow(room: RoomState, origin: Member | undefined, by: Member["identity"], action: "play" | "seek", pos: number, at: number) {
  if (applySync(room, origin, by, action, pos, at, "start-1") === "waiting") {
    for (const m of [...room.pending!.waiting]) markReady(room, m, "start-1", 0, at - 300);
  }
}

/** Stand-in for the server's keyed hash: anything that is not the real id. */
const pub = (identity: { kind: string; id: string }) => `pub-${identity.kind}-${identity.id.length}`;

function leaders(events: PartyEvent[]) {
  return events.flatMap((e) => (e.type === "leader" ? [e.clientId] : []));
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

  assert.deepEqual(syncs(laptop.got), [
    { type: "sync", action: "pause", positionSeconds: 1234.5, paused: true, at: 1000, by: "mammannii" },
  ]);
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
  playNow(room, undefined, tester, "play", 10, 0);
  playNow(room, undefined, tester, "seek", 100, 2000);
  assert.equal(room.paused, false);
  assert.equal(currentPosition(room, 5000), 103);
});

test("heartbeats come from the leader only, and move everyone else", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const tv = join(room, mammannii, "tv-000001");
  const phone = join(room, mammannii, "phone-00001");

  playNow(room, laptop.member, tester, "play", 0, 0);
  assert.equal(room.leader, laptop.member);

  // The TV is also a controller, but it is not the one being followed.
  assert.equal(applyHeartbeat(room, tv.member, 3, 5000), false);
  assert.equal(applyHeartbeat(room, laptop.member, 5.2, 5000), true);
  assert.deepEqual(syncs(tv.got).at(-1), { type: "position", positionSeconds: 5.2, at: 5000 });
  assert.deepEqual(syncs(phone.got).at(-1), { type: "position", positionSeconds: 5.2, at: 5000 });
  assert.equal(laptop.got.filter((e) => e.type === "position").length, 0, "the leader is not sent its own heartbeat");
  assert.equal(currentPosition(room, 6000), 6.2);

  // Whoever acts last leads.
  playNow(room, tv.member, mammannii, "seek", 60, 7000);
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

  playNow(room, laptop.member, tester, "play", 40, 1000);
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
  const list = participantList(room, (identity) => identity.id === tester.id, pub);
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

test("the creator's stream leads from the start, and everyone joining is told who leads", () => {
  const room = createRoom(0);
  const tv = join(room, mammannii, "tv-000001");
  assert.deepEqual(leaders(tv.got), [null], "nobody leads before the creator arrives");
  const laptop = join(room, tester, "laptop-0001");
  assert.equal(room.leader, laptop.member);
  assert.deepEqual(leaders(tv.got), [null, "laptop-0001"]);
  const phone = join(room, mammannii, "phone-00001");
  assert.deepEqual(leaders(phone.got), ["laptop-0001"]);
});

test("the controller that acts takes the lead; losing control or leaving hands it back to the creator", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const tv = join(room, mammannii, "tv-000001");
  applySync(room, tv.member, mammannii, "pause", 10, 0);
  assert.equal(room.leader, tv.member);
  assert.deepEqual(leaders(laptop.got).at(-1), "tv-000001", "the laptop is told to stop sending heartbeats");

  dropLeaderIf(room, mammannii.id); // control revoked
  assert.equal(room.leader, laptop.member);

  playNow(room, tv.member, mammannii, "play", 10, 0);
  removeMember(room, tv.member);
  assert.equal(room.leader, laptop.member);
  dropLeaderIf(room, "someone-else");
  assert.equal(room.leader, laptop.member, "only the leader's own loss of control moves the lead");
});

test("a position is stamped with when the sender measured it, if that is plausible", () => {
  assert.equal(stampTime(9_800, 10_000), 9_800);
  assert.equal(stampTime(10_500, 10_000), 10_000, "a little in the future: now");
  assert.equal(stampTime(20_000, 10_000), 10_000, "far in the future: a bad clock");
  assert.equal(stampTime(1_000, 10_000), 10_000, "too old to believe");
  assert.equal(stampTime("x", 10_000), 10_000);
});

test("joining a playing room: the state's stamp lets the joiner carry it forward", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  playNow(room, laptop.member, tester, "play", 100, 1000);
  assert.equal(currentPosition(room, 4000), 103);
});

test("play, pause and seek are told to the room as chat lines, the sender included", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const tv = join(room, mammannii, "tv-000001");
  applySync(room, tv.member, mammannii, "pause", 3733.4, 0);
  applySync(room, tv.member, mammannii, "seek", 65, 0);
  const lines = (events: PartyEvent[]) =>
    events.flatMap((e) => (e.type === "chat" && e.message.kind === "system" ? [e.message.body] : []));
  assert.deepEqual(lines(laptop.got), ["mammannii paused at 1:02:13", "mammannii jumped to 1:05"]);
  assert.deepEqual(lines(tv.got), lines(laptop.got), "the TV sees its own actions in the chat too");
});

test("a playing room with no controller watching pauses where it is, and says why", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const phoneChat = join(room, tester, "chat-tab-01", false); // the host's chat-only tab
  const tv = join(room, mammannii, "tv-000001");
  const hostOnly = (identity: Member["identity"]) => identity.id === tester.id;
  playNow(room, laptop.member, tester, "play", 100, 0);

  assert.equal(controllerWatching(room, hostOnly), true);
  removeMember(room, laptop.member);
  assert.equal(controllerWatching(room, hostOnly), false, "a chat-only tab cannot press play");

  assert.equal(pauseOrphaned(room, 10_000), true);
  assert.equal(room.paused, true);
  assert.equal(currentPosition(room, 99_000), 110);
  assert.deepEqual(syncs(tv.got).at(-1), { type: "sync", action: "pause", positionSeconds: 110, paused: true, at: 10_000, by: "" });
  const notice = tv.got.findLast((e) => e.type === "chat");
  assert.ok(notice?.type === "chat" && notice.message.body.startsWith("Paused at 1:50"));
  assert.equal(pauseOrphaned(room, 11_000), false, "already paused: nothing to do");
  void phoneChat;
});

test("a jump of more than 30 s tells everyone, the sender included, where the room was", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const tv = join(room, mammannii, "tv-000001");
  playNow(room, laptop.member, tester, "play", 3700, 0);
  playNow(room, tv.member, mammannii, "seek", 1200, 10_000); // a stray press
  const jumps = (events: PartyEvent[]) => events.filter((e) => e.type === "jumped");
  assert.deepEqual(jumps(tv.got).at(-1), { type: "jumped", from: 3710, to: 1200, by: "mammannii" });
  assert.deepEqual(jumps(laptop.got).at(-1), jumps(tv.got).at(-1));
  const count = jumps(tv.got).length;
  playNow(room, tv.member, mammannii, "seek", 1220, 10_000);
  assert.equal(jumps(tv.got).length, count, "a 20 s nudge is not a jump");
});

test("drift beside each name: from the furthest-out screen, only while both are playing", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const tv = join(room, mammannii, "tv-000001");
  const phone = join(room, mammannii, "phone-00001");
  const chat = join(room, mammannii, "chat-tab-01", false);
  playNow(room, laptop.member, tester, "play", 100, 0); // room at 100 + t
  tv.member.report = { positionSeconds: 109.6, paused: false, at: 10_000 }; // 0.4 s behind
  phone.member.report = { positionSeconds: 108.8, paused: false, at: 10_000 }; // 1.2 s behind
  const list = participantList(room, () => false, pub, 12_000);
  assert.equal(list.find((p) => p.id === pub(mammannii))?.driftSeconds, -1.2, "the worse of the TV and the phone");
  assert.equal(list.find((p) => p.id === pub(tester))?.driftSeconds, null, "nothing reported");

  phone.member.report = { positionSeconds: 108.8, paused: true, at: 10_000 };
  assert.equal(participantList(room, () => false, pub, 12_000).find((p) => p.id === pub(mammannii))?.driftSeconds, -0.4, "a paused screen is not 'behind'");
  assert.equal(participantList(room, () => false, pub, 40_000).find((p) => p.id === pub(mammannii))?.driftSeconds, null, "stale reports say nothing");
  void chat;
});

test("start together: a play with others watching prepares everyone, then starts all at one moment", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const tv = join(room, mammannii, "tv-000001");
  const phone = join(room, mammannii, "phone-00001");
  const chat = join(room, mammannii, "chat-tab-01", false);
  const waits = (events: PartyEvent[]) => events.flatMap((e) => (e.type === "waiting" ? [e.names] : []));

  assert.equal(applySync(room, tv.member, mammannii, "play", 600, 1000, "s1"), "waiting");
  assert.equal(room.paused, true, "nothing moves until everyone is ready");
  for (const m of [laptop, tv, phone]) {
    assert.deepEqual(m.got.find((e) => e.type === "prepare"), { type: "prepare", id: "s1", positionSeconds: 600, by: "mammannii" });
  }
  assert.equal(chat.got.some((e) => e.type === "prepare"), true, "told, but not waited for");
  assert.deepEqual(waits(laptop.got).at(-1), ["tester", "mammannii"]);

  assert.equal(markReady(room, tv.member, "s1", 120, 2000), false);
  assert.equal(markReady(room, laptop.member, "wrong-id", 0, 2000), false, "an answer to an older prepare is ignored");
  assert.equal(markReady(room, laptop.member, "s1", 40, 2100), false);
  assert.deepEqual(waits(tv.got).at(-1), ["mammannii"], "still waiting for the phone");
  assert.equal(markReady(room, phone.member, "s1", 900, 2500), true);

  // Slowest round trip 900 ms + 200 ms margin: the start is set for 3600, for everyone, the TV included.
  for (const m of [laptop, tv, phone]) {
    assert.deepEqual(syncs(m.got).at(-1), { type: "sync", action: "play", positionSeconds: 600, paused: false, at: 3600, by: "mammannii" });
  }
  assert.deepEqual(waits(phone.got).at(-1), []);
  assert.equal(currentPosition(room, 3000), 600, "not moving before the start");
  assert.equal(currentPosition(room, 5600), 602);
});

test("start together: nobody waits for a screen that leaves; a lone screen just plays; a pause cancels the wait", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  const tv = join(room, mammannii, "tv-000001");
  applySync(room, laptop.member, tester, "play", 10, 0, "s1");
  markReady(room, laptop.member, "s1", 0, 100);
  removeMember(room, tv.member, 200);
  assert.equal(room.pending, null);
  assert.equal(room.paused, false, "the TV left: the laptop starts on its own");

  const solo = createRoom(0);
  const only = join(solo, tester, "laptop-0001");
  assert.equal(applySync(solo, only.member, tester, "play", 10, 0), "applied");
  assert.equal(solo.paused, false);

  const third = createRoom(0);
  const a = join(third, tester, "laptop-0001");
  join(third, mammannii, "tv-000001");
  applySync(third, a.member, tester, "play", 10, 0, "s1");
  applySync(third, a.member, tester, "pause", 10, 500);
  assert.equal(third.pending, null);
  assert.equal(third.paused, true);
});

test("start together: a seek while playing waits too; a seek while paused does not", () => {
  const room = createRoom(0);
  const laptop = join(room, tester, "laptop-0001");
  join(room, mammannii, "tv-000001");
  assert.equal(applySync(room, laptop.member, tester, "seek", 50, 0), "applied", "paused room: just a seek");
  playNow(room, laptop.member, tester, "play", 50, 1000);
  assert.equal(applySync(room, laptop.member, tester, "seek", 900, 5000), "waiting");
});

test("reactions are grouped per emoji with who reacted; a reply quotes a short excerpt", () => {
  assert.deepEqual(
    groupReactions([
      { emoji: "😂", displayName: "tester" },
      { emoji: "👍", displayName: "mammannii" },
      { emoji: "😂", displayName: "mammannii" },
      { emoji: "😂", displayName: "mammannii" }, // the same name twice (two people called that) shows once
    ]),
    [
      { emoji: "😂", by: ["tester", "mammannii"] },
      { emoji: "👍", by: ["mammannii"] },
    ],
  );
  assert.equal(excerpt("  did   you see\nthat  "), "did you see that");
  assert.equal(excerpt("x".repeat(100)).length, 80);
  assert.ok(excerpt("x".repeat(100)).endsWith("…"));
});

test("the participant list never carries a guest's token (it is their way in), only the public id", () => {
  const room = createRoom(0);
  const token = "g7Qx2-secret-guest-link-token";
  const guest = { kind: "guest" as const, id: token, displayName: "Guest 1" };
  join(room, tester, "laptop-0001");
  join(room, guest, "guest-phone-1", false);
  const sent = JSON.stringify(participantList(room, () => false, pub));
  assert.equal(sent.includes(token), false);
  assert.ok(sent.includes(pub(guest)));
});

test("a TV hears when the same person opens the chat on their phone (the QR), and when they close it", () => {
  const room = createRoom(0);
  const tv = join(room, mammannii, "tv-000001");
  const laptop = join(room, tester, "laptop-0001");
  const flags = (events: PartyEvent[]) => events.flatMap((e) => (e.type === "chatElsewhere" ? [e.value] : []));
  assert.deepEqual(flags(tv.got), [false]);
  const phoneChat = join(room, mammannii, "phone-chat-01", false);
  assert.deepEqual(flags(tv.got), [false, true]);
  assert.deepEqual(flags(phoneChat.got), [], "the chat page itself is not told");
  assert.deepEqual(flags(laptop.got), [false], "nobody else's chat counts");
  removeMember(room, phoneChat.member);
  assert.deepEqual(flags(tv.got), [false, true, false]);
});
