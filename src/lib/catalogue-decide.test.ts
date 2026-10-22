import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDecision, planDecision, type CatalogueWrite, type DecisionRequest } from "./catalogue-decide.ts";
import { deriveCatalogueState, isListed, type CatalogueFacts } from "./catalogue-state.ts";

const PATH = "/media/Films/Blow-Up (1966)/Blow-Up.mkv";

function film(over: Partial<CatalogueFacts> = {}): CatalogueFacts {
  return {
    path: PATH,
    itemId: "item-1",
    hasMetadata: true,
    whitelisted: false,
    excluded: null,
    damaged: null,
    ungroupedEpisode: null,
    group: null,
    specialFeature: null,
    alternateVersion: null,
    scheduled: null,
    folderSuggestion: null,
    duplicate: null,
    ...over,
  };
}

/**
 * Each write, as it changes the facts the derivation reads. A stand-in for the
 * real functions (which need the server's database): it is what each one is
 * documented to do to its table, kept to one line each so it can be checked by
 * reading.
 */
function apply(f: CatalogueFacts, writes: readonly CatalogueWrite[]): CatalogueFacts {
  let out = { ...f };
  for (const w of writes) {
    switch (w.op) {
      case "excludePath": out = { ...out, excluded: { note: w.note } }; break;
      case "unexcludePath": out = { ...out, excluded: null }; break;
      case "whitelistPath": out = { ...out, whitelisted: true }; break;
      case "unwhitelistPath": out = { ...out, whitelisted: false }; break;
      case "setDamagedAllowed": out = out.damaged ? { ...out, damaged: { ...out.damaged, allowed: w.allowed } } : out; break;
      case "requestRecheck": break; // the worker re-reads it later; nothing changes now
      case "keepAsFilm": out = { ...out, ungroupedEpisode: null }; break;
      case "removeFromGroup": out = { ...out, group: null }; break;
      case "addToGroup": out = { ...out, group: { groupId: w.groupId, groupName: w.groupId }, ungroupedEpisode: null }; break;
      case "groupSeriesNow": out = { ...out, group: { groupId: w.seriesKey, groupName: w.seriesKey }, ungroupedEpisode: null }; break;
      case "markSpecialFeature": out = { ...out, specialFeature: {} }; break;
      case "unmarkSpecialFeature": out = { ...out, specialFeature: null }; break;
      case "addTarget": out = { ...out, specialFeature: { ...out.specialFeature, of: w.targetId, mapped: true } }; break;
      case "removeFromVersionSet": out = { ...out, alternateVersion: null }; break;
      case "createVersionSet": out = { ...out, alternateVersion: { of: w.primaryPath } }; break;
      case "setVersionLabel": out = { ...out, alternateVersion: { ...out.alternateVersion, label: w.label } }; break;
      case "acceptFolderSuggestion": out = { ...out, hasMetadata: true, folderSuggestion: null }; break;
    }
  }
  return out;
}

function decide(f: CatalogueFacts, request: DecisionRequest): CatalogueFacts {
  const plan = planDecision(f, request);
  assert.ok(plan.ok, plan.ok ? "" : plan.message);
  return apply(f, plan.writes);
}

const stateOf = (f: CatalogueFacts) => deriveCatalogueState(f).state;

/* ---- the mapping ---- */

test("show anyway on a damaged file allows it; take off reverses it", () => {
  const damaged = film({ damaged: { allowed: false } });
  assert.deepEqual(planDecision(damaged, { action: "show_anyway" }), {
    ok: true,
    writes: [{ op: "setDamagedAllowed", path: PATH, allowed: true }],
  });
  const shown = decide(damaged, { action: "show_anyway" });
  assert.equal(stateOf(damaged), "needs_decision");
  assert.equal(stateOf(shown), "visible");
  assert.equal(isListed(deriveCatalogueState(shown), "discovery"), true);

  const back = decide(shown, { action: "take_off", reason: "damaged" });
  assert.deepEqual(back, damaged);
});

test("show anyway with no reason answers every reason that has it", () => {
  const both = film({ damaged: { allowed: false }, hasMetadata: false });
  const plan = planDecision(both, { action: "show_anyway" });
  assert.deepEqual(plan.ok && plan.writes.map((w) => w.op), ["setDamagedAllowed", "whitelistPath"]);
  assert.equal(stateOf(apply(both, plan.ok ? plan.writes : [])), "visible");
});

test("show anyway for no metadata whitelists it; take off unwhitelists", () => {
  const unknown = film({ hasMetadata: false });
  const shown = decide(unknown, { action: "show_anyway", reason: "no_metadata" });
  assert.equal(shown.whitelisted, true);
  assert.equal(stateOf(shown), "visible");
  assert.deepEqual(decide(shown, { action: "take_off", reason: "no_metadata" }), unknown);
});

test("hide then unhide comes back to where it was", () => {
  const f = film();
  const hidden = decide(f, { action: "hide", note: "  wrong file  " });
  assert.deepEqual(hidden.excluded, { note: "wrong file" });
  assert.equal(stateOf(hidden), "held");
  assert.deepEqual(decide(hidden, { action: "unhide" }), f);
});

test("an ungrouped episode placed as a film, then back into a show", () => {
  const episode = film({ ungroupedEpisode: { seriesName: "Twin Peaks" } });
  assert.equal(stateOf(episode), "needs_decision");

  const asFilm = decide(episode, { action: "place_as", placement: { as: "film" } });
  assert.equal(stateOf(asFilm), "visible");

  const inShow = decide(asFilm, { action: "place_as", placement: { as: "episode", groupId: "g-twin-peaks" } });
  assert.deepEqual(inShow.group, { groupId: "g-twin-peaks", groupName: "g-twin-peaks" });
  assert.equal(deriveCatalogueState(inShow).needsYou, false);
});

test("placing as one thing takes it out of the others, so a file is never in two places", () => {
  const feature = film({ specialFeature: { of: "x", mapped: true } });
  const plan = planDecision(feature, { action: "place_as", placement: { as: "version", of: "/media/Films/Other.mkv" } });
  assert.ok(plan.ok);
  assert.deepEqual(
    plan.writes.map((w) => w.op),
    ["removeFromGroup", "unmarkSpecialFeature", "createVersionSet"],
  );
  const after = apply(feature, plan.writes);
  assert.equal(after.specialFeature, null);
  assert.equal(stateOf(after), "placed");
});

test("a special feature with a target is mapped", () => {
  const plan = planDecision(film(), {
    action: "place_as",
    placement: { as: "special_feature", target: { kind: "film", id: "item-9" } },
  });
  assert.ok(plan.ok);
  assert.deepEqual(plan.writes.at(-1), { op: "addTarget", itemId: "item-1", kind: "film", targetId: "item-9" });
});

test("every action is idempotent: deciding twice changes nothing more", () => {
  const cases: Array<[CatalogueFacts, DecisionRequest]> = [
    [film({ damaged: { allowed: false } }), { action: "show_anyway" }],
    [film({ hasMetadata: false }), { action: "show_anyway", reason: "no_metadata" }],
    [film(), { action: "hide" }],
    [film({ excluded: {} }), { action: "unhide" }],
    [film({ ungroupedEpisode: {} }), { action: "place_as", placement: { as: "film" } }],
    [film(), { action: "place_as", placement: { as: "episode", groupId: "g" } }],
    [film(), { action: "place_as", placement: { as: "special_feature" } }],
    [film(), { action: "place_as", placement: { as: "version", of: "/other.mkv", label: "Director's cut" } }],
  ];
  for (const [f, request] of cases) {
    const once = decide(f, request);
    assert.deepEqual(decide(once, request), once, request.action);
  }
});

/* ---- refusals ---- */

test("what doesn't make sense is refused in words, not guessed", () => {
  const refuse = (f: CatalogueFacts, r: DecisionRequest) => {
    const plan = planDecision(f, r);
    assert.equal(plan.ok, false, r.action);
  };
  refuse(film({ path: null }), { action: "hide" });
  refuse(film(), { action: "show_anyway", reason: "damaged" });
  refuse(film(), { action: "show_anyway", reason: "no_metadata" });
  refuse(film(), { action: "take_off", reason: "damaged" });
  refuse(film(), { action: "replace_recheck" });
  refuse(film(), { action: "place_as", placement: { as: "episode" } });
  refuse(film(), { action: "place_as", placement: { as: "version", of: PATH } });
});

/* ---- reading a request ---- */

test("parseDecision reads each action and refuses the rest", () => {
  assert.deepEqual(parseDecision({ action: "show_anyway", reason: "damaged" }), { action: "show_anyway", reason: "damaged" });
  assert.deepEqual(parseDecision({ action: "place_as", as: "episode", seriesKey: "twin peaks" }), {
    action: "place_as",
    placement: { as: "episode", groupId: undefined, seriesKey: "twin peaks" },
  });
  assert.deepEqual(parseDecision({ action: "place_as", as: "version", of: "/a.mkv", label: "4K" }), {
    action: "place_as",
    placement: { as: "version", of: "/a.mkv", label: "4K" },
  });
  for (const bad of [
    { action: "take_off" },
    { action: "show_anyway", reason: "boredom" },
    { action: "place_as", as: "trailer" },
    { action: "place_as", as: "version" },
    { action: "place_as", as: "special_feature", target: "x" },
    { action: "release_now" },
    { action: "identify" },
    { action: "delete_everything" },
  ]) {
    assert.equal(typeof parseDecision(bad), "string", JSON.stringify(bad));
  }
});
