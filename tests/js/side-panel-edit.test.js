"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

test("showSidePanel with an editable doc shows the pencil button and records kind/id", () => {
  const app = loadApp();
  app.showSidePanel("spec 1.1.1.1", "# Title\n\nbody", null, { kind: "spec", id: "1.1.1.1" });

  assert.equal(app.state.sidePanel.kind, "spec");
  assert.equal(app.state.sidePanel.id, "1.1.1.1");
  assert.equal(app.state.sidePanel.raw, "# Title\n\nbody");
  assert.equal(app.document.querySelector("#side-panel-edit-btn").__classes.has("hidden"), false);
});

test("showSidePanel with no editable (not-found fallback) hides the pencil button", () => {
  const app = loadApp();
  app.showSidePanel("spec 9.9.9", "No spec found for this row yet.");

  assert.equal(app.state.sidePanel.kind, null);
  assert.equal(app.document.querySelector("#side-panel-edit-btn").__classes.has("hidden"), true);
});

test("enterEditMode populates the textarea and swaps content for the editor", () => {
  const app = loadApp();
  app.showSidePanel("item 1.1.1", "# Leaf\n\nbody", null, { kind: "item", id: "1.1.1" });
  app.enterEditMode();

  assert.equal(app.state.sidePanel.editing, true);
  assert.equal(app.document.querySelector("#side-panel-textarea").value, "# Leaf\n\nbody");
  assert.equal(app.document.querySelector("#side-panel-content").__classes.has("hidden"), true);
  assert.equal(app.document.querySelector("#side-panel-editor").__classes.has("hidden"), false);
});

test("exitEditMode without unsaved changes switches back to the read-only view", () => {
  const app = loadApp();
  app.showSidePanel("item 1.1.1", "# Leaf\n\nbody", null, { kind: "item", id: "1.1.1" });
  app.enterEditMode();
  app.exitEditMode();

  assert.equal(app.state.sidePanel.editing, false);
  assert.equal(app.document.querySelector("#side-panel-content").__classes.has("hidden"), false);
  assert.equal(app.document.querySelector("#side-panel-editor").__classes.has("hidden"), true);
});

test("exitEditMode with unsaved changes asks for confirmation, and respects a cancel", () => {
  let confirmCalls = 0;
  const app = loadApp({ confirm: () => { confirmCalls++; return false; } });
  app.showSidePanel("item 1.1.1", "# Leaf\n\nbody", null, { kind: "item", id: "1.1.1" });
  app.enterEditMode();
  app.state.sidePanel.dirty = true;

  app.exitEditMode(); // user cancels the confirm -> must stay in edit mode
  assert.equal(confirmCalls, 1);
  assert.equal(app.state.sidePanel.editing, true);
});

test("showSidePanel navigating away from a dirty edit also asks for confirmation", () => {
  let confirmCalls = 0;
  const app = loadApp({ confirm: () => { confirmCalls++; return true; } });
  app.showSidePanel("spec 1.1.1.1", "raw a", null, { kind: "spec", id: "1.1.1.1" });
  app.enterEditMode();
  app.state.sidePanel.dirty = true;

  app.showSidePanel("spec 2.2.2.2", "raw b", null, { kind: "spec", id: "2.2.2.2" });
  assert.equal(confirmCalls, 1);
  assert.equal(app.state.sidePanel.id, "2.2.2.2"); // confirmed -> navigation proceeded
});

test("saveSidePanelEdit POSTs to the spec route and returns to read-only view on success", async () => {
  const calls = [];
  const app = loadApp({
    fetch: (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    },
  });
  app.state.projectId = "proj1";
  app.state.plan = "plan1";
  app.showSidePanel("spec 1.1.1.1", "old raw", null, { kind: "spec", id: "1.1.1.1" });
  app.enterEditMode();
  app.document.querySelector("#side-panel-textarea").value = "old raw\n\n**Note:** added by hand.";
  app.state.sidePanel.dirty = true;

  await app.saveSidePanelEdit();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/spec?project=proj1&plan=plan1&spec_id=1.1.1.1");
  assert.equal(calls[0].body.raw, "old raw\n\n**Note:** added by hand.");
  assert.equal(app.state.sidePanel.dirty, false);
  assert.equal(app.state.sidePanel.editing, false);
});

test("saveSidePanelEdit POSTs to the item route when editing an item, not a spec", async () => {
  const calls = [];
  const app = loadApp({
    fetch: (url, opts) => {
      calls.push(url);
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    },
  });
  app.state.projectId = "proj1";
  app.state.plan = "plan1";
  app.showSidePanel("item 1.1.1", "raw", null, { kind: "item", id: "1.1.1" });
  app.enterEditMode();

  await app.saveSidePanelEdit();

  assert.equal(calls[0], "/api/item?project=proj1&plan=plan1&item_id=1.1.1");
});

test("saveSidePanelEdit surfaces a persistent error status on failure, without throwing", async () => {
  const app = loadApp({
    fetch: () => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "boom" }) }),
  });
  app.state.projectId = "proj1";
  app.state.plan = "plan1";
  app.showSidePanel("spec 1.1.1.1", "raw", null, { kind: "spec", id: "1.1.1.1" });
  app.enterEditMode();

  await app.saveSidePanelEdit();

  assert.equal(app.state.sidePanel.editing, true); // stays open so the user doesn't lose their edit
  const status = app.document.querySelector("#side-panel-edit-status");
  assert.match(status.textContent, /save failed/i);
});
