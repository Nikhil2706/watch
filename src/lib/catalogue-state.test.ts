/**
 * Tests for the catalogue state (docs/catalogue-state.md).
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/catalogue-state.test.ts
 *
 * The first test is the promise the migration rests on: the new rule lists
 * exactly what filterVisible listed before, for every combination of facts, in
 * every list context. LEGACY is the old rule copied out of media.ts as it stood
 * on 2026-10-14 (catalogue-legacy.ts); do not "fix" it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveCatalogueState,
  isListed,
  LIST_CONTEXTS,
  primaryReason,
  type CatalogueFacts,
  type ReasonCode,
} from "./catalogue-state.ts";
import { LEGACY_OPTIONS, legacyListed as LEGACY, type LegacyInputs } from "./catalogue-legacy.ts";

/* ------------------------------------------------------------------ *
 * Facts
 * ------------------------------------------------------------------ */

function facts(overrides: Partial<CatalogueFacts> = {}): CatalogueFacts {
  return {
    path: "/media/Films/Heat (1995).mkv",
    itemId: "item1",
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
    ...overrides,
  };
}

/** Every one of these is either on or off in a case; the last four must not change listing at all. */
const SWITCHES = [
  "specialFeature",
  "alternateVersion",
  "excluded",
  "damaged",
  "ungroupedEpisode",
  "noMetadata",
  "whitelisted",
  "scheduled",
  "grouped",
  "folderSuggestion",
  "damagedButAllowed",
  "duplicate",
] as const;
type Switch = (typeof SWITCHES)[number];

function caseFacts(on: Set<Switch>): CatalogueFacts {
  return facts({
    specialFeature: on.has("specialFeature") ? { of: "Tenet", mapped: true } : null,
    alternateVersion: on.has("alternateVersion") ? { label: "Director's cut", of: "Blade Runner" } : null,
    excluded: on.has("excluded") ? { note: null } : null,
    // "damaged" wins over "allowed" when both switches are on: one file has one verdict.
    damaged: on.has("damaged")
      ? { allowed: false, detail: "74 broken pieces of picture" }
      : on.has("damagedButAllowed")
        ? { allowed: true, detail: "3 broken pieces of picture" }
        : null,
    ungroupedEpisode: on.has("ungroupedEpisode") ? { seriesName: "Nirvanna the Band the Show" } : null,
    hasMetadata: !on.has("noMetadata"),
    whitelisted: on.has("whitelisted"),
    scheduled: on.has("scheduled") ? { releaseAt: Date.UTC(2026, 9, 21) } : null,
    group: on.has("grouped") ? { groupId: "g1", groupName: "E.R." } : null,
    folderSuggestion: on.has("folderSuggestion") ? { title: "Amblin", year: 1968, why: "Folder: Steven Spielberg" } : null,
    duplicate: on.has("duplicate") ? { copies: 2 } : null,
  });
}

function legacyInputs(on: Set<Switch>): LegacyInputs {
  return {
    specialFeature: on.has("specialFeature"),
    alternateVersion: on.has("alternateVersion"),
    excluded: on.has("excluded"),
    damaged: on.has("damaged"),
    ungroupedEpisode: on.has("ungroupedEpisode"),
    noMetadata: on.has("noMetadata"),
    whitelisted: on.has("whitelisted"),
    scheduled: on.has("scheduled"),
  };
}

/* ------------------------------------------------------------------ *
 * 1. Nothing moves
 * ------------------------------------------------------------------ */

test("lists exactly what the old filterVisible listed: every combination, every context", () => {
  let cases = 0;
  for (let mask = 0; mask < 1 << SWITCHES.length; mask++) {
    const on = new Set(SWITCHES.filter((_, bit) => mask & (1 << bit)));
    const state = deriveCatalogueState(caseFacts(on));
    for (const context of LIST_CONTEXTS) {
      const expected = LEGACY(legacyInputs(on), LEGACY_OPTIONS[context]);
      assert.equal(isListed(state, context), expected, `${[...on].join("+") || "(nothing)"} in ${context}`);
      cases++;
    }
  }
  assert.equal(cases, (1 << SWITCHES.length) * 3);
});

/* ------------------------------------------------------------------ *
 * 2. Each reason on its own
 * ------------------------------------------------------------------ */

interface Expect {
  state: string;
  code: ReasonCode | null;
  words?: string;
  needsYou: boolean;
  placement?: string;
}

const ALONE: Array<[string, Partial<CatalogueFacts>, Expect]> = [
  ["a plain film", {}, { state: "visible", code: null, needsYou: false, placement: "film" }],
  ["hidden by the curator", { excluded: { note: "bad rip" } }, { state: "held", code: "excluded", words: "Hidden by you: bad rip", needsYou: false }],
  [
    "damaged",
    { damaged: { allowed: false, detail: "74 broken pieces of picture" } },
    { state: "needs_decision", code: "damaged", words: "Damaged: 74 broken pieces of picture", needsYou: true },
  ],
  [
    "damaged, shown anyway",
    { damaged: { allowed: true, detail: "74 broken pieces of picture" } },
    { state: "visible", code: "damaged_allowed", words: "Shown despite damage: 74 broken pieces of picture", needsYou: false },
  ],
  [
    "an episode in no show",
    { ungroupedEpisode: { seriesName: "Nirvanna the Band the Show" } },
    { state: "needs_decision", code: "ungrouped_episode", words: "Episode of Nirvanna the Band the Show, in no show", needsYou: true },
  ],
  [
    "no metadata",
    { hasMetadata: false },
    { state: "needs_decision", code: "no_metadata", words: "Not identified: nothing knows what this file is", needsYou: true },
  ],
  ["no metadata, shown anyway", { hasMetadata: false, whitelisted: true }, { state: "visible", code: null, needsYou: false }],
  [
    "no metadata, folder matching has a guess",
    { hasMetadata: false, folderSuggestion: { title: "Amblin", year: 1968, why: "Folder: Steven Spielberg" } },
    { state: "identifying", code: "identifying", words: "Probably Amblin (1968): Folder: Steven Spielberg", needsYou: true },
  ],
  ["scheduled", { scheduled: { releaseAt: Date.UTC(2026, 9, 21, 18) } }, { state: "held", code: "scheduled", words: "Coming 21 Oct", needsYou: false }],
  [
    "a mapped special feature",
    { specialFeature: { of: "Tenet", mapped: true } },
    { state: "placed", code: "special_feature", words: "Extras for Tenet", needsYou: false, placement: "special_feature" },
  ],
  [
    "a special feature mapped to nothing",
    { specialFeature: { of: null, mapped: false } },
    { state: "needs_decision", code: "special_feature", needsYou: true, placement: "special_feature" },
  ],
  [
    "another cut",
    { alternateVersion: { label: "Director's cut", of: "Blade Runner" } },
    { state: "placed", code: "version", words: "Director's cut of Blade Runner", needsYou: false, placement: "version" },
  ],
  ["an episode in a show", { group: { groupId: "g", groupName: "E.R." } }, { state: "placed", code: "episode", words: "In E.R.", needsYou: false, placement: "episode" }],
  ["a duplicate", { duplicate: { copies: 2 } }, { state: "visible", code: "duplicate", words: "Duplicate: 2 copies", needsYou: true }],
];

for (const [name, f, expect] of ALONE) {
  test(`alone: ${name}`, () => {
    const s = deriveCatalogueState(facts(f));
    assert.equal(s.state, expect.state);
    assert.equal(primaryReason(s)?.code ?? null, expect.code);
    if (expect.words) assert.equal(primaryReason(s)?.words, expect.words);
    assert.equal(s.needsYou, expect.needsYou);
    if (expect.placement) assert.equal(s.placement.as, expect.placement);
  });
}

/* ------------------------------------------------------------------ *
 * 3. Combinations
 * ------------------------------------------------------------------ */

test("damaged with no metadata: needs a decision, and says both", () => {
  const s = deriveCatalogueState(facts({ hasMetadata: false, damaged: { allowed: false, detail: "x" } }));
  assert.equal(s.state, "needs_decision");
  assert.deepEqual(
    s.reasons.map((r) => r.code),
    ["damaged", "no_metadata"],
  );
  // Both sets of actions are on offer.
  assert.ok(s.reasons[0]!.actions.includes("replace_recheck"));
  assert.ok(s.reasons[1]!.actions.includes("identify"));
});

test("hidden by the curator silences everything else in the inbox", () => {
  const s = deriveCatalogueState(
    facts({ excluded: {}, damaged: { allowed: false }, hasMetadata: false, duplicate: { copies: 2 }, ungroupedEpisode: {} }),
  );
  assert.equal(s.state, "held");
  assert.equal(s.needsYou, false);
  assert.equal(primaryReason(s)?.code, "excluded");
  assert.equal(s.reasons.length, 5); // still all there to read
});

test("a grouped episode with no metadata is placed, listed in its show only, and asks nothing", () => {
  const s = deriveCatalogueState(facts({ group: { groupId: "g", groupName: "E.R." }, hasMetadata: false }));
  assert.equal(s.state, "placed");
  assert.equal(s.needsYou, false);
  assert.equal(isListed(s, "show_episodes"), true);
  assert.equal(isListed(s, "discovery"), false);
});

test("a damaged episode in a show still needs you; the show is not flagged here at all", () => {
  const s = deriveCatalogueState(facts({ group: { groupId: "g", groupName: "E.R." }, damaged: { allowed: false } }));
  assert.equal(s.state, "needs_decision");
  assert.equal(s.placement.as, "episode");
  assert.equal(isListed(s, "show_episodes"), false);
});

test("a scheduled special feature is held (the date matters more than the placing)", () => {
  const s = deriveCatalogueState(facts({ scheduled: { releaseAt: null }, specialFeature: { of: "Tenet", mapped: true } }));
  assert.equal(s.state, "held");
  assert.equal(s.placement.as, "special_feature");
});

test("special features and other cuts stay in Continue Watching", () => {
  for (const f of [facts({ specialFeature: { of: "Tenet", mapped: true } }), facts({ alternateVersion: {} })]) {
    const s = deriveCatalogueState(f);
    assert.equal(isListed(s, "discovery"), false);
    assert.equal(isListed(s, "resume"), true);
  }
});

test("a guess for a file someone already said to show anyway is not a question", () => {
  const s = deriveCatalogueState(facts({ hasMetadata: false, whitelisted: true, folderSuggestion: { title: "Amblin" } }));
  assert.equal(s.state, "visible");
  assert.equal(s.needsYou, false);
});
