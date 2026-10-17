"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

test("projectPathInto() / projectPathUp() walk relative folder paths", () => {
  const app = loadApp();
  assert.equal(app.projectPathInto("", "docs"), "docs");
  assert.equal(app.projectPathInto("docs", "concepts"), "docs/concepts");
  assert.equal(app.projectPathUp("docs/concepts"), "docs");
  assert.equal(app.projectPathUp("docs"), "");
  assert.equal(app.projectPathUp(""), "");
});

test("parseOtherParams() / formatOtherParams(): the Settings 'other params' row", () => {
  const app = loadApp();
  assert.deepEqual({ ...app.parseOtherParams(" think=false, temperature = 0.2 ,") }, { think: "false", temperature: "0.2" });
  assert.deepEqual({ ...app.parseOtherParams("timeout=9, seed=1") }, { seed: "1" });      // own inputs win
  assert.throws(() => app.parseOtherParams("think"));
  assert.throws(() => app.parseOtherParams("bad key=1"));
  assert.equal(app.formatOtherParams({ timeout: 300, think: false, seed: 1 }), "think=false, seed=1");
});
