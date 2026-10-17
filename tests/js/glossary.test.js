"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

const ROWS = [
  { term: "dbt-templater", kind: "domain", seen: 5, definitions: 1, facts: 2, links: 1, words: 2 },
  { term: "or", kind: "noise", seen: 9, definitions: 0, facts: 0, links: 0, words: 1 },
  { term: "jinja", kind: null, seen: 2, definitions: 1, facts: 4, links: 0, words: 1 },
];

const terms = (rows) => Array.from(rows, r => r.term);

test("filterGlossaryRows() sorts by support by default and filters by name with spaces", () => {
  const app = loadApp();
  assert.deepEqual(terms(app.filterGlossaryRows(ROWS, { sort: "seen" })), ["or", "dbt-templater", "jinja"]);
  assert.deepEqual(terms(app.filterGlossaryRows(ROWS, { text: "dbt templ", sort: "seen" })), ["dbt-templater"]);
});

test("filterGlossaryRows() by kind, unjudged, support and multi-word", () => {
  const app = loadApp();
  assert.deepEqual(terms(app.filterGlossaryRows(ROWS, { kind: "domain" })), ["dbt-templater"]);
  assert.deepEqual(terms(app.filterGlossaryRows(ROWS, { kind: "unjudged" })), ["jinja"]);
  assert.deepEqual(terms(app.filterGlossaryRows(ROWS, { minSeen: "3", sort: "name" })), ["dbt-templater", "or"]);
  assert.deepEqual(terms(app.filterGlossaryRows(ROWS, { multiword: true })), ["dbt-templater"]);
  assert.deepEqual(terms(app.filterGlossaryRows(ROWS, { sort: "facts" })), ["jinja", "dbt-templater", "or"]);
});

test("filterGlossaryRows() does not reorder the rows it was given", () => {
  const app = loadApp();
  const rows = ROWS.slice();
  app.filterGlossaryRows(rows, { sort: "name" });
  assert.deepEqual(terms(rows), terms(ROWS));
});

test("glossaryArticleMd() shows the sections that have entries, sources and terms as links", () => {
  const app = loadApp();
  const md = app.glossaryArticleMd({
    term: "dbt-templater", kind_verdict: "domain",
    definition: ["Renders SQL through dbt. [file: docs/a.md:3]"], facts: [], link: ["templater"], synonym: [],
    kind: [], seen: ["file: docs/a.md:3"], history: [],
  });
  assert.match(md, /^# dbt templater/);
  assert.match(md, /Kind: domain/);
  assert.match(md, /- Renders SQL through dbt\. \[docs\/a\.md:3\]\(src:docs\/a\.md:3\)/);
  assert.match(md, /- \[templater\]\(templater\.md\)/);
  assert.match(md, /^- \[docs\/a\.md:3\]\(src:docs\/a\.md:3\)$/m);   // SEEN:
  assert.doesNotMatch(md, /<span/);                                  // md() escapes HTML: none emitted
  assert.doesNotMatch(md, /## Facts/);
  assert.doesNotMatch(md, /## History/);
});

test("md() renders links: relative and src: stay in the page, http opens a tab, other schemes stay text", () => {
  const app = loadApp();
  const html = app.md("[a](templater.md) [b](src:docs/a.md:3) [c](https://x.org) [d](javascript:alert(1))");
  assert.match(html, /<a href="templater\.md" data-local-link>a<\/a>/);
  assert.match(html, /<a href="src:docs\/a\.md:3" data-local-link>b<\/a>/);
  assert.match(html, /<a href="https:\/\/x\.org" target="_blank" rel="noopener">c<\/a>/);
  assert.doesNotMatch(html, /href="javascript/);
});

test("parseSourceRef() / sourceExcerptMd(): the source view of an article", () => {
  const app = loadApp();
  assert.deepEqual({ ...app.parseSourceRef("docs/a.md:12") }, { path: "docs/a.md", line: 12 });
  assert.deepEqual({ ...app.parseSourceRef("docs/a.md") }, { path: "docs/a.md", line: 0 });
  const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const ex = app.sourceExcerptMd(text, 20, 2, 2);
  assert.match(ex, /^```\n  18 │ line 18\n/);
  assert.match(ex, /▶ 20 │ line 20/);
  assert.match(ex, /  22 │ line 22\n```$/);
});

test("clampPanelWidth(): the drawer stays between its minimum and 92% of the window", () => {
  const app = loadApp();
  assert.equal(app.clampPanelWidth(100, 1600), 320);
  assert.equal(app.clampPanelWidth(900, 1600), 900);
  assert.equal(app.clampPanelWidth(5000, 1600), 1472);
});
