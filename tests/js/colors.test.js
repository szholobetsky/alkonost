"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

test("normalizeModuleName strips a leading '@' (and repeats/whitespace)", () => {
  const app = loadApp();
  assert.equal(app.normalizeModuleName("@backend"), "backend");
  assert.equal(app.normalizeModuleName("backend"), "backend");
  assert.equal(app.normalizeModuleName(" @@foo "), "foo");
});

test("moduleColor matches a bare-name legend entry against tags.at", () => {
  const app = loadApp();
  app.state.colors = { backend: "#4A90D9" };
  assert.equal(app.moduleColor({ tags: { at: "backend" } }), "#4A90D9");
});

test("regression: a literal '@backend' legend key never matches tags.at='backend'", () => {
  // reproduces the exact bug reported: typing '@backend' into the module
  // name field (before normalizeModuleName existed) created a key that
  // could never match any card, since tags.at is always stored bare.
  const app = loadApp();
  app.state.colors = { "@backend": "#111111" };
  assert.equal(app.moduleColor({ tags: { at: "backend" } }), undefined);
});
