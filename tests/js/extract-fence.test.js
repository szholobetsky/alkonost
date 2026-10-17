"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

test("extractFence() pulls the content out of a fenced code block", () => {
  const app = loadApp();
  const text = 'some reasoning text before it\n\n```plaintext\nthe real prompt\n```';
  assert.equal(app.extractFence(text), "the real prompt");
});

test("extractFence() falls back to the full trimmed text when there is no fence", () => {
  const app = loadApp();
  assert.equal(app.extractFence("  just plain text, no fence  "), "just plain text, no fence");
});

test("extractFence() takes the LAST fence when a model fences more than one block", () => {
  // A reasoning model's think/draft phase can contain a genuine,
  // line-anchored fence of its own (an example sketched before the real
  // answer) — the actual final answer is whichever fence came last.
  const app = loadApp();
  const text = '```\na draft the model sketched while thinking\n```\n\nmore reasoning\n\n```\nthe actual final answer\n```';
  assert.equal(app.extractFence(text), "the actual final answer");
});

test("extractFence() ignores a ``` mentioned mid-sentence, not alone on its own line", () => {
  // Confirmed live: a reasoning model's own "Thinking Process" text said,
  // in plain prose, '...wrapped in a single ``` fenced code block...' —
  // an unanchored regex (1bcoder's own _extract_code_block included)
  // treats that as a fence marker. A real fence must be alone on its own
  // line.
  const app = loadApp();
  const text =
    'Thinking Process:\n' +
    '*   Output Requirement: wrapped in a single ``` fenced code block.\n' +
    'more reasoning\n' +
    '```\n' +
    'the real answer\n' +
    '```';
  assert.equal(app.extractFence(text), "the real answer");
});

test("extractFence() falls through a degenerate run of empty/malformed trailing fences", () => {
  // Confirmed live: qwen3:1.7b spiraled into repeating bare ``` lines
  // back-to-back forever after its real answer. A single greedy regex
  // ends up treating one of those malformed marker lines as CONTENT (it
  // has to consume something to find its next closing delimiter),
  // producing garbage like a lone "```" instead of falling through to the
  // real answer — this is why extraction pairs whole fence-marker LINES
  // up front instead.
  const app = loadApp();
  const text = 'reasoning\n\n```\nthe real answer\n```\n\n```  \n```  \n```  \n```  ';
  assert.equal(app.extractFence(text), "the real answer");
});
