# One live-session model for parties, the phone remote and screenings

Status: design, 2026-10-15. Nothing here is built yet; each step below is
its own pull request off `platform-additions`.

## Why

Three features keep devices in step with each other, and each was built
on its own:

| | Watch party | Phone as remote | Screening Room |
|---|---|---|---|
| Code | `party-bus.ts` (593 lines), `party-room.ts` (609), `party-sync.ts` (251), `usePartySocket.ts`, `PartyRoomClient.tsx` | `remote-bus.ts` (339), `api/remote/*`, `ScreenAgent.tsx`, `RemoteClient.tsx` | `screening.ts` (437), `screening-scope.ts`, `screening-playback.ts` |
| What it is | Many devices, many people, one film, kept in step; chat | One phone drives one TV on the same account | One stranger, one film, an expiring link, no account |
| Transport | SSE out, POST in, in-memory rooms | SSE out (to the TV), POST in, in-memory screens | Ordinary page loads; no live channel |
| Who may act | Creator, people they grant, and (since #37) whoever is left when the creator has gone 60 s | Same account owns the screen | The link holder, on their own device |
| Clock | Server-stamped position + paused, extrapolated; drift steered by rate nudges and seeks (`party-sync.ts`) | None: commands fire and forget; the TV reports its own position every few seconds | Resume point stored per screening |

The bugs fixed on 2026-10-14 (#19, #20, #27, #32, #37) were all in the sync
and control logic, and each fix applied only to parties. A phone driving a
TV still has none of it: no clock, no echo suppression, no "who acted last"
rule, and it shares no code for the TV's remote keys with the party player.

**The Screening Room is not a sync feature.** It is an access scope: what a
link holder may see (`screening-scope.ts` is an allow-list) and their own
resume point. Folding it into a live-session model would be the wrong
merge. What it needs from this work is narrower: a screening can host a
session (watch it with the person you sent it to) without its scope rules
changing. That is the last step, and optional.

## The model

```
Session
  id, film (itemId), kind: "party" | "remote"
  clock     { positionSeconds, paused, rate, at (server ms) }   // one source of truth
  leader    the member whose heartbeats move the clock (party-room.ts's rule)
  members   Member[]
Member
  stream    one open SSE stream (clientId), so two tabs on one account are two members
  identity  account or guest (party-identity.ts)
  role      "player"  — has the film open and plays it (TV, a tab, a phone watching)
            "remote"  — controls but plays nothing (a phone used as a remote, a chat tab)
  canControl          creator / granted / inherited (party-room.ts's canControl, #37's handover)
```

- **A party** is a session with any number of members; chat and reactions
  stay party features on top of it.
- **The phone remote** becomes a session of two: the TV as a `player`, the
  phone as a `remote`, both on the owner's account, `canControl` true for
  both. The TV then gets the party's clock and echo rules for free, and the
  phone shows a position extrapolated from the shared clock instead of
  waiting for the next report.
- **A screening** stays an access scope. Later, "watch together" can open a
  party whose film is the screening's film and whose guest is the link
  holder, with the screening's scope still deciding what they can load.

## What is shared, as modules

1. `live-hub.ts`: the in-memory registry of open streams, keyed by
   session: subscribe and unsubscribe, broadcast with a failing stream
   skipped, a single sweep at boot (both buses run their own today; the
   party one only since #41), per-owner caps (remote-bus's
   `MAX_SCREENS_PER_USER`), and heartbeats with a TTL. No product rules.
2. `session-clock.ts`: today's `party-sync.ts` rules, unchanged and
   already tested: the stamped target position, the clock offset, the
   leader's heartbeat, drift steering, cooldown and echo suppression.
   Renamed, not rewritten.
3. `session-commands.ts`: one command vocabulary. The remote's
   `play | pause | playPause | seekTo | seekBy` become the party's
   `play | pause | seek` with a position, stamped by the server; `navigate`,
   `back`, `reload` and `ping` stay remote-only commands, because they
   move a page, not a clock.
4. `session-control.ts`: who may act (`canControl`, grants, the 60 s
   handover from #37, the creator sharing control on return) as one function
   of (session, identity), so the TV remote and a party ask the same
   question.
5. The player's key handling (TV OK, media keys from #30, one action per
   press from #32) is already shared by `Player.tsx`; it stays there and is
   used by both.

## Steps (one PR each)

1. **`live-hub.ts`.** Extract the stream registry from both buses behind
   their existing exports; no behaviour change. Tests: subscribe,
   broadcast skipping a throwing stream, sweep rules (a screen with a live
   stream is never swept; an idle one after its TTL), per-owner cap.
2. **Rename `party-sync.ts` to `session-clock.ts`** (re-exported under the
   old name), and **move the remote's commands onto the clock**: the TV
   keeps a session clock, `seekBy` becomes a server-stamped `seek`, and the
   phone extrapolates. Tests: the remote's commands produce the same plans
   as a party's play/pause/seek; a TV report no longer overwrites a newer
   command (the echo rule).
3. **The remote as a two-member session.** `remote-bus.ts`'s screens become
   sessions of kind `remote`; pairing codes and screen names stay. URLs and
   the phone and TV screens are unchanged.
4. **`session-control.ts`.** Parties and the remote ask one function who
   may act. Tests: today's party cases (creator, grant, handover, guest)
   plus "same account owns the screen".
5. **Optional: watch a screening together.** A button on a screening that
   opens a party for its film with the link holder as a guest; the
   screening's scope still decides what their device may load. Needs its
   own decision first (does a stranger get chat?).

Each step keeps every current URL and screen working and every existing
test passing. Steps 2 and 3 change behaviour you can see on the TV, and
need a check on the real TV and phone over adb after deploy:

- the phone's play, pause and seek by 10 s, and that the TV doesn't jump
  back after a seek;
- the phone's progress bar moving smoothly between reports;
- a party still syncing as on 2026-10-14 (TV 0.1–0.3 s behind the host).

## Risks

- **Restarts.** Both buses are in memory. Sessions rebuild as streams
  reconnect, as now; step 1 must not add a persistence assumption.
- **One process.** The single-gate-process assumption (`ratelimit.ts`,
  both buses) stays; if the gate is ever scaled out, the hub needs a
  shared backend, but that is not planned.
- **The TV app.** The remote's TV side runs in the Android WebView; any
  change to its stream handling needs testing there, not just in a browser.
