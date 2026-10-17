"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

// Array.from(...) re-materializes the vm-sandbox's own foreign-realm Array
// as a native one — assert.deepEqual otherwise fails a same-content array
// built inside the vm context (see dashboard-flow.test.js's own comment
// on this exact gotcha).
test("ancestorChain() returns every prefix id from root to the node, inclusive", () => {
  const app = loadApp();
  assert.deepEqual(Array.from(app.ancestorChain("1.3.2.4")), ["1", "1.3", "1.3.2", "1.3.2.4"]);
});

test("ancestorChain() of a top-level id is just itself", () => {
  const app = loadApp();
  assert.deepEqual(Array.from(app.ancestorChain("5")), ["5"]);
});
