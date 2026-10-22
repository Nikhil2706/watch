import assert from "node:assert/strict";
import { test } from "node:test";

import { decideAdmin, type AdminRequestFacts } from "./admin-access.ts";

const ADMIN = { username: "mammannii", isAdmin: true, suspended: false };
const VIEWER = { username: "tester", isAdmin: false, suspended: false };
const OWN = ["https://watch.abhigyanverma.com", "http://127.0.0.1:3100"];

const facts = (over: Partial<AdminRequestFacts>): AdminRequestFacts => ({
  method: "GET",
  keyHeader: "absent",
  session: null,
  secFetchSite: null,
  origin: null,
  ownOrigins: OWN,
  ...over,
});

test("the key still works on its own, from anywhere (scripts, the Mac's helpers, the old console)", () => {
  assert.deepEqual(decideAdmin(facts({ keyHeader: "valid", method: "POST", secFetchSite: "cross-site" })), { ok: true, via: "key" });
});

test("a wrong key is refused even with an admin session", () => {
  assert.deepEqual(decideAdmin(facts({ keyHeader: "invalid", session: ADMIN, secFetchSite: "same-origin" })), { ok: false, reason: "bad-key" });
});

test("an admin's session works from the site itself", () => {
  for (const method of ["GET", "POST", "DELETE", "PATCH"]) {
    assert.deepEqual(decideAdmin(facts({ method, session: ADMIN, secFetchSite: "same-origin" })), {
      ok: true,
      via: "session",
      username: "mammannii",
    });
  }
  // Typed into the address bar.
  assert.equal(decideAdmin(facts({ session: ADMIN, secFetchSite: "none" })).ok, true);
});

test("a viewer's session, a suspended admin, and no credentials are refused", () => {
  assert.deepEqual(decideAdmin(facts({ session: VIEWER, secFetchSite: "same-origin" })), { ok: false, reason: "not-admin" });
  assert.deepEqual(decideAdmin(facts({ session: { ...ADMIN, suspended: true }, secFetchSite: "same-origin" })), { ok: false, reason: "not-admin" });
  assert.deepEqual(decideAdmin(facts({})), { ok: false, reason: "no-credentials" });
});

test("an admin's cookie riding along from another site is refused (CSRF), reads included", () => {
  for (const site of ["cross-site", "same-site"]) {
    for (const method of ["GET", "POST"]) {
      assert.deepEqual(decideAdmin(facts({ method, session: ADMIN, secFetchSite: site })), { ok: false, reason: "cross-site" });
    }
  }
});

test("browsers without Sec-Fetch-Site: reads pass, writes need our Origin", () => {
  assert.equal(decideAdmin(facts({ method: "GET", session: ADMIN })).ok, true);
  assert.equal(decideAdmin(facts({ method: "POST", session: ADMIN })).ok, false);
  assert.equal(decideAdmin(facts({ method: "POST", session: ADMIN, origin: "https://evil.example" })).ok, false);
  assert.equal(decideAdmin(facts({ method: "POST", session: ADMIN, origin: "https://watch.abhigyanverma.com" })).ok, true);
  assert.equal(decideAdmin(facts({ method: "POST", session: ADMIN, origin: "http://127.0.0.1:3100" })).ok, true);
  assert.equal(decideAdmin(facts({ method: "POST", session: ADMIN, origin: "null" })).ok, false);
});
