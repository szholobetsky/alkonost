"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

function row(id, plus, overrides = {}) {
  return { id, title: `Task ${id}`, depth: id.split(".").length, checked: false, tags_raw: "",
    tags: { hash: [], at: null, plus, user: null, due: null, done: null, ...overrides } };
}

test("computeNewTaskId: root mode picks one past the highest existing root id", () => {
  const app = loadApp();
  app.state.rows = [row("1", ["backlog"]), row("3", ["backlog"]), row("2.1", ["backlog"])];
  assert.equal(app.computeNewTaskId({ mode: "root" }), "4");
});

test("computeNewTaskId: root mode with no rows starts at 1", () => {
  const app = loadApp();
  app.state.rows = [];
  assert.equal(app.computeNewTaskId({ mode: "root" }), "1");
});

test("computeNewTaskId: subtask mode counts only DIRECT children, ignoring deeper descendants", () => {
  const app = loadApp();
  app.state.rows = [
    row("1.1.1.4", ["backlog"]),
    row("1.1.1.4.1", ["backlog"]),
    row("1.1.1.4.2", ["backlog"]),
    row("1.1.1.4.2.1", ["backlog"]), // grandchild — must not bump the direct-child count
  ];
  assert.equal(app.computeNewTaskId({ mode: "subtask", parentId: "1.1.1.4" }), "1.1.1.4.3");
});

test("computeNewTaskId: subtask mode with no existing children starts at .1", () => {
  const app = loadApp();
  app.state.rows = [row("1.1.1.4", ["backlog"])];
  assert.equal(app.computeNewTaskId({ mode: "subtask", parentId: "1.1.1.4" }), "1.1.1.4.1");
});

test("computeInsertIndex: root mode always appends at the very end", () => {
  const app = loadApp();
  app.state.rows = [row("1", ["backlog"]), row("2", ["backlog"])];
  assert.equal(app.computeInsertIndex({ mode: "root" }), 2);
});

test("computeInsertIndex: subtask mode lands after the parent's entire existing subtree (incl. grandchildren)", () => {
  const app = loadApp();
  app.state.rows = [
    row("1", ["backlog"]),           // 0
    row("1.1", ["backlog"]),         // 1  <- parent
    row("1.1.1", ["backlog"]),       // 2  child
    row("1.1.2", ["backlog"]),       // 3  child
    row("1.1.2.1", ["backlog"]),     // 4  grandchild (deepest descendant)
    row("2", ["backlog"]),           // 5  unrelated sibling of "1"
  ];
  // must insert at index 5 — right after 1.1.2.1, before the unrelated "2"
  assert.equal(app.computeInsertIndex({ mode: "subtask", parentId: "1.1" }), 5);
});

test("computeInsertIndex: subtask mode with no existing children lands right after the parent itself", () => {
  const app = loadApp();
  app.state.rows = [row("1", ["backlog"]), row("1.1", ["backlog"]), row("2", ["backlog"])];
  assert.equal(app.computeInsertIndex({ mode: "subtask", parentId: "1.1" }), 2);
});

test("collectDistinctTagValues extracts sorted distinct values, excluding 'urgent' from +status, plus %user", () => {
  const app = loadApp();
  app.state.rows = [
    row("1", ["active", "urgent"], { hash: ["backend"], at: "backend", user: "alice" }),
    row("2", ["testing"], { hash: ["api"], at: "frontend", user: "bob" }),
  ];
  const suggestions = app.collectDistinctTagValues(app.state.rows);
  assert.deepEqual(Array.from(suggestions.hash), ["api", "backend"]);
  assert.deepEqual(Array.from(suggestions.at), ["backend", "frontend"]);
  assert.deepEqual(Array.from(suggestions.plus), ["active", "testing"]); // no "urgent"
  assert.deepEqual(Array.from(suggestions.user), ["alice", "bob"]);
});

test("hasSpec / navLinks: shows the view link when a spec exists, an Add-spec button otherwise", () => {
  const app = loadApp();
  app.state.specIds = new Set(["1.1.1.1"]);
  assert.equal(app.hasSpec({ id: "1.1.1.1" }), true);
  assert.equal(app.hasSpec({ id: "9.9" }), false);

  assert.match(app.navLinks({ id: "1.1.1.1" }), /class="spec-link"/);
  assert.match(app.navLinks({ id: "9.9" }), /class="add-spec-btn"/);
});

test("confirmAddTask (root) inserts a new row at the end with the expected shape and saves", async () => {
  const calls = [];
  const app = loadApp({
    fetch: (url, opts) => {
      if (opts && opts.method === "POST") calls.push({ url, body: JSON.parse(opts.body) });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, row_count: 2 }) });
    },
  });
  app.state.projectId = "p1";
  app.state.plan = "plan1";
  app.state.rows = [row("1", ["backlog"])];

  app.openAddTaskModal({ mode: "root" });
  app.document.querySelector("#task-modal-text").value = "New task text";
  app.document.querySelector("#task-modal-hash").value = "backend";
  app.document.querySelector("#task-modal-at").value = "backend";
  app.document.querySelector("#task-modal-plus").value = "selected";
  app.document.querySelector("#task-modal-user").value = "alice";
  app.document.querySelector("#task-modal-urgent").checked = true;

  await app.confirmAddTask();

  assert.equal(app.state.rows.length, 2);
  const added = app.state.rows[1];
  assert.equal(added.id, "2");
  assert.equal(added.title, "New task text");
  assert.equal(added.depth, 1);
  assert.deepEqual(Array.from(added.tags.hash), ["backend"]);
  assert.equal(added.tags.at, "backend");
  assert.deepEqual(Array.from(added.tags.plus), ["selected", "urgent"]);
  assert.equal(added.tags.user, "alice");

  const savePost = calls.find(c => c.url.startsWith("/api/tasks"));
  assert.ok(savePost, "expected confirmAddTask to trigger a save");
  assert.equal(savePost.body.rows.length, 2);
});

test("confirmAddTask defaults +backlog when no lane flag/urgent is given", async () => {
  const app = loadApp({ fetch: () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) }) });
  app.state.projectId = "p1";
  app.state.plan = "plan1";
  app.state.rows = [];

  app.openAddTaskModal({ mode: "root" });
  app.document.querySelector("#task-modal-text").value = "Bare task";

  await app.confirmAddTask();

  assert.deepEqual(Array.from(app.state.rows[0].tags.plus), ["backlog"]);
});

test("confirmAddTask rejects an empty task text without touching state.rows", async () => {
  const app = loadApp();
  app.state.rows = [row("1", ["backlog"])];
  app.openAddTaskModal({ mode: "root" });
  app.document.querySelector("#task-modal-text").value = "   "; // whitespace only

  await app.confirmAddTask();

  assert.equal(app.state.rows.length, 1); // unchanged
  const err = app.document.querySelector("#task-modal-error");
  assert.equal(err.__classes.has("hidden"), false);
});

test("confirmAddTask rejects a duplicate id", async () => {
  const app = loadApp();
  app.state.rows = [row("1", ["backlog"])];
  app.openAddTaskModal({ mode: "root" });
  app.document.querySelector("#task-modal-id").value = "1"; // collides with existing row
  app.document.querySelector("#task-modal-text").value = "Whatever";

  await app.confirmAddTask();

  assert.equal(app.state.rows.length, 1);
  const err = app.document.querySelector("#task-modal-error");
  assert.equal(err.__classes.has("hidden"), false);
  assert.match(err.textContent, /already in use/);
});

test("confirmAddTask (subtask) inserts after the parent's whole subtree with the correctly derived id/depth", async () => {
  const app = loadApp({ fetch: () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) }) });
  app.state.projectId = "p1";
  app.state.plan = "plan1";
  app.state.rows = [row("1", ["backlog"]), row("1.1", ["backlog"]), row("2", ["backlog"])];

  app.openAddTaskModal({ mode: "subtask", parentId: "1" });
  app.document.querySelector("#task-modal-text").value = "Sub of 1";

  await app.confirmAddTask();

  const ids = app.state.rows.map(r => r.id);
  assert.deepEqual(ids, ["1", "1.1", "1.2", "2"]);
  const added = app.state.rows.find(r => r.id === "1.2");
  assert.equal(added.depth, 2);
});

test("addSpecForRow POSTs to /api/spec/create, records the new spec id, and opens the panel in edit mode", async () => {
  const calls = [];
  const app = loadApp({
    fetch: (url, opts) => {
      if (opts && opts.method === "POST") {
        calls.push({ url, body: JSON.parse(opts.body) });
        return Promise.resolve({
          ok: true,
          json: async () => ({
            spec_id: "5", title: "New root task", raw: "# X-5: New root task\n\n<start writing the spec here>\n",
            source_leaf_id: "5", source_sec_index: 1,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });
  app.state.projectId = "p1";
  app.state.plan = "plan1";
  app.state.rows = [row("5", ["backlog"])];
  app.state.specIds = new Set();

  await app.addSpecForRow("5", "New root task");

  assert.equal(calls[0].url, "/api/spec/create?project=p1&plan=plan1");
  assert.deepEqual(calls[0].body, { task_id: "5", title: "New root task" });
  assert.ok(app.state.specIds.has("5"));
  assert.equal(app.state.sidePanel.editing, true);
  assert.equal(app.state.sidePanel.kind, "spec");
  assert.equal(app.state.sidePanel.id, "5");
});
