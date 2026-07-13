"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

function sampleRow(overrides = {}) {
  return {
    id: "1", title: "Some task",
    tags: { hash: [], at: null, plus: ["active"], user: null, due: null, done: null },
    ...overrides,
  };
}

test("cardHtml() marks the card draggable and includes a dedicated drag handle", () => {
  // Regression: title-input/tag-input/lane-select span the full card width,
  // so a mousedown starting on them triggers native text-selection / the
  // select's own dropdown instead of the card's dragstart — leaving almost
  // no reliable grab area. A dedicated handle guarantees one regardless of
  // which lanes are configured (unrelated to the dashboard-flow filter).
  const app = loadApp();
  const html = app.cardHtml(sampleRow(), ["active", "paused"]);
  assert.match(html, /class="card [^"]*"\s+draggable="true"/);
  assert.match(html, /<span class="drag-handle"[^>]*>/);
  // the handle must be a plain span, not itself an interactive control that
  // would compete with drag the same way inputs/selects do
  assert.doesNotMatch(html.match(/<span class="drag-handle"[^>]*>[^<]*<\/span>/)[0], /<(input|select|a)\b/);
});

test("cardHtml() still renders the title/tag inputs and lane-select (drag handle is additive, not a replacement)", () => {
  const app = loadApp();
  const html = app.cardHtml(sampleRow(), ["active", "paused"]);
  assert.match(html, /class="title-input"/);
  assert.match(html, /class="tag-input"/);
  assert.match(html, /class="lane-select"/);
});

test("renderBoard() puts a drop marker on every lane title, including an empty lane with zero cards", () => {
  // Regression: drop listeners used to live only on .lane-body, which has
  // no min-height, so an empty lane (a configured dashboard-flow column
  // with no matching rows yet) was a near-zero-height sliver with nowhere
  // to actually drop a card. The lane title itself must also be a valid
  // drop target — the marker is the visible cue for that.
  const app = loadApp();
  app.state.rows = [sampleRow({ id: "1", tags: { plus: ["active"] } })];
  app.state.dashboardFlow = ["active", "paused"]; // "paused" has zero rows
  app.renderBoard();

  const html = app.document.__registry.get("#board").innerHTML;
  const laneBlocks = html.split('<div class="lane"').slice(1);
  assert.equal(laneBlocks.length, 2, "expected both configured lanes to render, including the empty one");
  for (const block of laneBlocks) {
    assert.match(block, /<span class="drop-marker"/);
  }
});
