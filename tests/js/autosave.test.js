"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

test("markDirty debounces rapid edits into a single autosave POST", async () => {
  const calls = [];
  const app = loadApp({
    fetch: (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, row_count: 1 }) });
    },
  });

  app.state.projectId = "proj1";
  app.state.plan = "plan1";
  app.state.rows = [{
    id: "1", title: "Row One",
    tags: { hash: [], at: null, plus: ["backlog"], user: null, due: null, done: null },
  }];

  // two edits within the 400ms debounce window must collapse into ONE save
  app.markDirty("1");
  await new Promise(r => setTimeout(r, 100));
  app.markDirty("1");

  await new Promise(r => setTimeout(r, 700));

  assert.equal(calls.length, 1, `expected exactly one autosave POST, got ${calls.length}`);
  assert.equal(calls[0].url, "/api/tasks?project=proj1&plan=plan1");
  assert.deepEqual(calls[0].body, { rows: [{ id: "1", title: "Row One", tags: app.state.rows[0].tags }] });
});

test("a 409 conflict sets a persistent error status instead of throwing/blocking", async () => {
  const app = loadApp({
    fetch: () => Promise.resolve({
      ok: false, status: 409, json: async () => ({ error: "row id set does not match tasks.md on disk" }),
    }),
  });
  app.state.projectId = "proj1";
  app.state.plan = "plan1";
  app.state.rows = [{ id: "1", title: "x", tags: { plus: ["backlog"] } }];

  await app.saveTasks();

  const indicator = app.document.__registry.get("#dirty-indicator");
  assert.match(indicator.textContent, /conflict/i);
});
