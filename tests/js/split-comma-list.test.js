"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

test("splitCommaList() trims and drops empty segments", () => {
  const app = loadApp();
  assert.deepEqual(Array.from(app.splitCommaList("kotlin, spring boot,  postgres ,,")),
    ["kotlin", "spring boot", "postgres"]);
});

test("splitCommaList() of an empty string is an empty list", () => {
  const app = loadApp();
  assert.deepEqual(Array.from(app.splitCommaList("")), []);
});
