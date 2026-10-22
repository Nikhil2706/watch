import assert from "node:assert/strict";
import { test } from "node:test";

import { adminChangeProblem } from "./admin-grants.ts";

const base = { targetId: "u2", targetUsername: "rewati", actorUserId: "u1", ownerUsername: "mammannii" };

test("any admin may grant admin access, to anyone", () => {
  assert.equal(adminChangeProblem({ ...base, grant: true }), null);
  assert.equal(adminChangeProblem({ ...base, grant: true, actorUserId: "u2" }), null);
});

test("an admin may take it from someone else", () => {
  assert.equal(adminChangeProblem({ ...base, grant: false }), null);
});

test("the owner always keeps it, whatever the case of the name", () => {
  assert.match(adminChangeProblem({ ...base, grant: false, targetUsername: "Mammannii" }) ?? "", /owner/);
});

test("nobody removes their own", () => {
  assert.match(adminChangeProblem({ ...base, grant: false, actorUserId: "u2" }) ?? "", /your own/);
});

test("a script with the admin key is not anyone's own account", () => {
  assert.equal(adminChangeProblem({ ...base, grant: false, actorUserId: null }), null);
});
