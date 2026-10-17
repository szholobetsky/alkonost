"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

// { ...result } re-materializes the vm-sandbox's own foreign-realm object
// as a native one — assert.deepEqual otherwise fails on a same-content
// object literal built inside the vm context (same cross-realm gotcha as
// dashboard-flow.test.js's Array.from(), just for plain objects).
test("redoParentRef('plan', ...) points at the PARENT item's numbered section for a nested node", () => {
  const app = loadApp();
  assert.deepEqual({ ...app.redoParentRef("plan", "1.2.3") }, { file: "item_1.2.md", section: "3" });
});

test("redoParentRef('plan', ...) points at index.md for a top-level node", () => {
  const app = loadApp();
  assert.deepEqual({ ...app.redoParentRef("plan", "4") }, { file: "index.md", section: "4" });
});

test("redoParentRef('spec', ...) points at the originating leaf item's numbered section", () => {
  const app = loadApp();
  // unit id = "<leaf_id>.<sec_index>", split on the LAST dot — leaf_id
  // itself is dot-separated (e.g. leaf "1.2.1", section "3").
  assert.deepEqual({ ...app.redoParentRef("spec", "1.2.1.3") }, { file: "item_1.2.1.md", section: "3" });
});

test("redoParentRef('spec', ...) handles a top-level leaf", () => {
  const app = loadApp();
  assert.deepEqual({ ...app.redoParentRef("spec", "5.2") }, { file: "item_5.md", section: "2" });
});
