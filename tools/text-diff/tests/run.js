"use strict";

const assert = require("node:assert");
const diff = require("../tool.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (err) {
    failed++;
    console.error("  FAIL - " + name);
    console.error("         " + (err && err.message));
  }
}

function types(result) {
  return result.blocks.map((b) => b.type);
}

console.log("text-diff tests");

// --- identical ---

test("identical text yields a single equal block", () => {
  const r = diff.diffLines("a\nb\nc\n", "a\nb\nc\n");
  assert.deepStrictEqual(types(r), ["equal"]);
  assert.deepStrictEqual(r.blocks[0].lines, ["a", "b", "c", ""]);
});

// --- pure additions / deletions ---

test("all additions", () => {
  const r = diff.diffLines("", "x\ny\n");
  assert.deepStrictEqual(types(r), ["insert"]);
  assert.deepStrictEqual(r.blocks[0].lines, ["x", "y", ""]);
});

test("all deletions", () => {
  const r = diff.diffLines("x\ny\n", "");
  assert.deepStrictEqual(types(r), ["delete"]);
  assert.deepStrictEqual(r.blocks[0].lines, ["x", "y", ""]);
});

// --- basic mutations ---

test("one line replaced", () => {
  const r = diff.diffLines("line one\nOLD\nline three", "line one\nNEW\nline three");
  assert.deepStrictEqual(types(r), ["equal", "delete", "insert", "equal"]);
  assert.deepStrictEqual(r.blocks[1].lines, ["OLD"]);
  assert.deepStrictEqual(r.blocks[2].lines, ["NEW"]);
});

test("middle line removed", () => {
  const r = diff.diffLines("a\nb\nc", "a\nc");
  assert.deepStrictEqual(types(r), ["equal", "delete", "equal"]);
});

test("middle line added", () => {
  const r = diff.diffLines("a\nc", "a\nb\nc");
  assert.deepStrictEqual(types(r), ["equal", "insert", "equal"]);
});

// --- empty inputs ---

test("both empty yields no blocks", () => {
  const r = diff.diffLines("", "");
  assert.deepStrictEqual(r.blocks, []);
});

test("nullish inputs treated as empty strings", () => {
  const r = diff.diffLines(null, undefined);
  assert.deepStrictEqual(r.blocks, []);
});

// --- CRLF normalization ---

test("CRLF normalized to LF", () => {
  const r = diff.diffLines("a\r\nb\r\n", "a\r\nb\r\n");
  assert.deepStrictEqual(r.blocks[0].lines, ["a", "b", ""]);
  const same = diff.diffLines("a\r\nb", "a\nb");
  assert.deepStrictEqual(types(same), ["equal"]);
});

// --- stats ---

test("countStats counts added and removed", () => {
  const s = diff.countStats("a\nb\nc", "a\nX\nc\nd");
  // a, c equal; b removed; X, d"" added
  assert.strictEqual(s.added, 2);
  assert.strictEqual(s.removed, 1);
});

test("countStats zero for identical", () => {
  const s = diff.countStats("same", "same");
  assert.strictEqual(s.added, 0);
  assert.strictEqual(s.removed, 0);
});

// --- large input ---

test("large identical input stays deterministic and fast", () => {
  const big = new Array(3000).fill(0).map((_, i) => "line " + i).join("\n");
  const start = Date.now();
  const r = diff.diffLines(big, big + "\nextra");
  assert.ok(Date.now() - start < 8000, "finished quickly");
  assert.deepStrictEqual(types(r), ["equal", "insert"]);
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
