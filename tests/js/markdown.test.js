"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

test("md() renders headings, bold, and inline code", () => {
  const app = loadApp();
  const html = app.md("# Title\n\nSome **bold** text with `inline code`.");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>inline code<\/code>/);
});

test("md() converts a pipe table into an HTML table", () => {
  const app = loadApp();
  const html = app.md("| A | B |\n|---|---|\n| 1 | 2 |\n");
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th[^>]*>A<\/th>/);
  assert.match(html, /<td[^>]*>2<\/td>/);
});

test("md() turns a deepagent_spec SOURCE line into a clickable item link", () => {
  const app = loadApp();
  const html = app.md("DESCRIPTION:\nsomething\n\nSOURCE: [src: item_1.1.1.md#1]\n");
  assert.match(html, /<a class="source-link" onclick="openItemPanel\('1\.1\.1'\)"/);
  assert.match(html, />SOURCE: item_1\.1\.1\.md #1<\/a>/);
});

test("md() handles a multi-dot leaf id in the SOURCE line", () => {
  const app = loadApp();
  const html = app.md("SOURCE: [src: item_1.1.1.2.md#3]");
  assert.match(html, /onclick="openItemPanel\('1\.1\.1\.2'\)"/);
});
