"use strict";
// Loads ui/app.js into a fresh vm context per call (so `state` and DOM
// stubs never leak between tests) and returns that context — every
// top-level function/const app.js declares (state, md, dashboardRows,
// moduleColor, debounce, ...) is a property on the returned object.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(__dirname, "..", "..", "alkonost", "ui", "app.js");

function fakeElement() {
  const classes = new Set();
  const el = {
    disabled: false,
    textContent: "",
    value: "",
    href: "",
    // __classes exposes the real backing Set so a test can assert on it —
    // toggle/add/remove/contains all operate on the same Set, unlike a
    // bare no-op stub that can't answer "is this class currently set?".
    __classes: classes,
    classList: {
      toggle(cls, force) {
        const on = force === undefined ? !classes.has(cls) : force;
        if (on) classes.add(cls); else classes.delete(cls);
        return on;
      },
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
    },
    style: {},
    addEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => fakeElement(),
    querySelectorAll: () => [],
    appendChild() {},
    closest: () => fakeElement(),
    remove() {},
    focus() {},
    scrollTop: 0,
    scrollHeight: 0,
  };
  return el;
}

// document.querySelector returns a STABLE fake element per selector (same
// object on repeated calls, matching real DOM semantics) so a test can
// grab e.g. document.__registry.get("#dirty-indicator") and observe what
// app.js wrote into it (textContent, classList state, etc.).
function makeDocumentStub() {
  const registry = new Map();
  return {
    __registry: registry,
    querySelector(sel) {
      if (!registry.has(sel)) registry.set(sel, fakeElement());
      return registry.get(sel);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement: () => fakeElement(),
    createTextNode: (s) => ({ nodeType: 3, textContent: s }),
    documentElement: fakeElement(),
  };
}

function loadApp(overrides = {}) {
  const code = fs.readFileSync(APP_JS, "utf8");
  const sandbox = {
    document: makeDocumentStub(),
    localStorage: { getItem: () => null, setItem: () => {} },
    katex: { renderToString: (t) => `<span>${t}</span>` },
    mermaid: undefined,
    navigator: { clipboard: { writeText: () => {} } },
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    confirm: () => true,
    console,
    setTimeout,
    clearTimeout,
    ...overrides,
  };
  vm.createContext(sandbox);
  // Top-level `const`/`let` bindings (state, AUTOSAVE_MS, the autosave*
  // wrappers) do NOT become properties of the vm context object the way
  // `function` declarations do (same as a plain <script> in a browser) —
  // alias the ones tests need onto globalThis, which IS the sandbox here.
  vm.runInContext(code + "\nglobalThis.state = state;", sandbox, { filename: "app.js" });
  return sandbox;
}

module.exports = { loadApp, fakeElement };
