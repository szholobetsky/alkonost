"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, fakeElement } = require("./helpers");

test("setFitWidth toggles the .fit-width class on #board and persists to localStorage", () => {
  const stored = {};
  const app = loadApp({
    localStorage: {
      getItem: (k) => stored[k] ?? null,
      setItem: (k, v) => { stored[k] = v; },
    },
  });

  const boardEl = app.document.querySelector("#board");
  const toggleEl = app.document.querySelector("#fit-width-toggle");

  app.setFitWidth(true);
  assert.equal(stored["alkonost-fit-width"], "1");
  assert.deepEqual(boardEl.__classes, new Set(["fit-width"]));
  assert.equal(toggleEl.checked, true);

  app.setFitWidth(false);
  assert.equal(stored["alkonost-fit-width"], "0");
  assert.deepEqual(boardEl.__classes, new Set());
  assert.equal(toggleEl.checked, false);
});

test("fitWidth preference is read from localStorage on load", () => {
  const app = loadApp({
    localStorage: { getItem: (k) => (k === "alkonost-fit-width" ? "1" : null), setItem: () => {} },
  });
  assert.equal(app.state.fitWidth, true);
});
