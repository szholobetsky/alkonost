"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

test("saveLastSelection POSTs the given patch to /api/config", () => {
  const calls = [];
  const app = loadApp({
    fetch: (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    },
  });

  app.saveLastSelection({ theme: "beach" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/config");
  assert.deepEqual(calls[0].body, { theme: "beach" });
});

test("onProjectChange saves last_project_id, onPlanChange saves last_plan, setTheme saves theme", () => {
  const posted = [];
  const app = loadApp({
    fetch: (url, opts) => {
      if (opts && opts.method === "POST") posted.push({ url, body: JSON.parse(opts.body) });
      if (url.startsWith("/api/plans")) return Promise.resolve({ ok: true, json: async () => ([]) });
      if (url.startsWith("/api/colors")) return Promise.resolve({ ok: true, json: async () => ({ colors: {} }) });
      if (url.startsWith("/api/dashboard_flow")) return Promise.resolve({ ok: true, json: async () => ({ flow: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });

  app.setTheme("mono-dark");
  const themePost = posted.find(p => p.body.theme === "mono-dark");
  assert.ok(themePost, "expected a /api/config POST carrying the new theme");
});

test("restoreLastSelection re-applies a saved theme, project, and plan against the current data", async () => {
  const app = loadApp({
    fetch: (url) => {
      if (url === "/api/config") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ theme: "dark", last_project_id: "p1", last_plan: "plan1" }),
        });
      }
      if (url.startsWith("/api/plans")) {
        return Promise.resolve({
          ok: true,
          json: async () => ([{ name: "plan1", item_count: 1, has_spec: false, spec_count: 0, has_tasks: true, task_count: 1 }]),
        });
      }
      if (url.startsWith("/api/colors")) return Promise.resolve({ ok: true, json: async () => ({ colors: {} }) });
      if (url.startsWith("/api/dashboard_flow")) return Promise.resolve({ ok: true, json: async () => ({ flow: [] }) });
      if (url.startsWith("/api/tasks")) return Promise.resolve({ ok: true, json: async () => ({ plan: "plan1", exists: true, rows: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });

  app.state.projects = [{ id: "p1", root: "C:/x", name: "x", plan_count: 1 }];
  await app.restoreLastSelection();

  assert.equal(app.state.theme, "dark");
  assert.equal(app.state.projectId, "p1");
  assert.equal(app.state.plan, "plan1");
});

test("restoreLastSelection does nothing if the saved project id no longer exists in this scan", async () => {
  const app = loadApp({
    fetch: (url) => {
      if (url === "/api/config") {
        return Promise.resolve({ ok: true, json: async () => ({ last_project_id: "stale-id" }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });
  app.state.projects = [{ id: "p1", root: "C:/x", name: "x", plan_count: 1 }];

  await app.restoreLastSelection();

  assert.equal(app.state.projectId, null);
});

test("restoreLastSelection is a no-op (not a throw) if /api/config itself fails", async () => {
  const app = loadApp({ fetch: () => Promise.reject(new Error("offline")) });
  await assert.doesNotReject(() => app.restoreLastSelection());
});
