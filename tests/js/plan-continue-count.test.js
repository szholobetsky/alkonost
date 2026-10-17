"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

test("planContinueLayerCount() counts comma-separated labels", () => {
  const app = loadApp();
  const input = app.document.querySelector("#plan-continue-label-input");
  input.value = "modules, files, classes, methods";
  assert.equal(app.planContinueLayerCount(), 4);
});

test("planContinueLayerCount() defaults to 1 for a plain single label", () => {
  const app = loadApp();
  const input = app.document.querySelector("#plan-continue-label-input");
  input.value = "implementation details";
  assert.equal(app.planContinueLayerCount(), 1);
});

test("planContinueLayerCount() defaults to 1 for an empty field", () => {
  const app = loadApp();
  const input = app.document.querySelector("#plan-continue-label-input");
  input.value = "";
  assert.equal(app.planContinueLayerCount(), 1);
});

test("planContinueLayerCount() ignores stray trailing commas/whitespace", () => {
  const app = loadApp();
  const input = app.document.querySelector("#plan-continue-label-input");
  input.value = "modules, files, ";
  assert.equal(app.planContinueLayerCount(), 2);
});
