"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

// Array.from(...) below is not decorative: arrays *constructed* inside the
// vm context (array literals, .split/.filter/.map called through the vm
// realm's own built-ins) come back as foreign-realm Arrays, which
// assert.deepStrictEqual treats as structurally-equal-but-not-identical to
// a same-content native array and fails on. Arrays merely passed through
// by reference (e.g. .map() applied to an already-native array) don't
// need this. Array.from() re-materializes a foreign array as a native one.
function sampleRows() {
  return [
    { id: "1", tags: { plus: ["backlog"] } },
    { id: "2", tags: { plus: ["active"] } },
    { id: "3", tags: { plus: ["complete"] } },
    { id: "4", tags: { plus: ["testing"] } },
    { id: "5", tags: { plus: ["canceled"] } },
  ];
}

test("parseDashboardFlowInput strips '+' and whitespace", () => {
  const app = loadApp();
  assert.deepEqual(
    Array.from(app.parseDashboardFlowInput("+selected, +active, +paused, +testing, +done, +releasing")),
    ["selected", "active", "paused", "testing", "done", "releasing"]
  );
});

test("no flow configured -> every row/lane shows (backward compatible default)", () => {
  const app = loadApp();
  app.state.dashboardFlow = [];
  const rows = sampleRows();
  assert.deepEqual(app.dashboardRows(rows).map(r => r.id), ["1", "2", "3", "4", "5"]);
  assert.deepEqual(Array.from(app.dashboardLanes(rows)), ["backlog", "active", "complete", "testing", "canceled"]);
});

test("configured flow hides rows in other lanes from the board", () => {
  const app = loadApp();
  const rows = sampleRows();
  app.state.dashboardFlow = ["selected", "active", "paused", "testing", "done", "releasing"];
  // backlog(1), complete(3), canceled(5) are NOT in the configured flow -> hidden
  assert.deepEqual(app.dashboardRows(rows).map(r => r.id), ["2", "4"]);
});

test("configured flow lanes render in the configured order, including empty columns", () => {
  const app = loadApp();
  const rows = sampleRows();
  app.state.dashboardFlow = ["selected", "active", "paused", "testing", "done", "releasing"];
  assert.deepEqual(
    Array.from(app.dashboardLanes(app.dashboardRows(rows))),
    ["selected", "active", "paused", "testing", "done", "releasing"]
  );
});

test("allLaneOptions unions real lanes with configured (possibly empty) ones, for the move-to-lane dropdown", () => {
  const app = loadApp();
  app.state.rows = sampleRows();
  app.state.dashboardFlow = ["selected", "active", "paused", "testing", "done", "releasing"];
  const options = Array.from(app.allLaneOptions());
  // real lanes present in data
  for (const l of ["backlog", "active", "complete", "testing", "canceled"]) {
    assert.ok(options.includes(l), `expected ${l} in options`);
  }
  // configured lanes with no current rows yet must still be selectable
  for (const l of ["selected", "paused", "done", "releasing"]) {
    assert.ok(options.includes(l), `expected ${l} in options`);
  }
});
