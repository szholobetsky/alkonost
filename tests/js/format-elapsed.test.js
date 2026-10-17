"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

test("formatElapsedHMS() formats seconds as H:MM:SS", () => {
  const app = loadApp();
  assert.equal(app.formatElapsedHMS(1970), "0:32:50");
  assert.equal(app.formatElapsedHMS(0), "0:00:00");
  assert.equal(app.formatElapsedHMS(59), "0:00:59");
  assert.equal(app.formatElapsedHMS(60), "0:01:00");
  assert.equal(app.formatElapsedHMS(3661), "1:01:01");
  assert.equal(app.formatElapsedHMS(7325), "2:02:05");
});
