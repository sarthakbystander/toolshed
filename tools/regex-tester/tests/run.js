"use strict";

const assert = require("assert");
const regex = require("../tool.js");

let passed = 0;
let failed = 0;

function onlyMatches(res) {
  return res.segments.filter(function (s) { return s.type === "match"; });
}

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok - " + name);
  } catch (err) {
    failed += 1;
    console.log("  FAIL - " + name);
    console.log("         " + String(err.message || err).split("\n").join("\n         "));
  }
}

function expectInvalid(pattern, flags) {
  const result = regex.compilePattern(pattern, flags);
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.length > 0);
}

// --- compilePattern ---------------------------------------------------------------
test("compiles a valid pattern", () => {
  const result = regex.compilePattern("a+", "gi");
  assert.strictEqual(result.ok, true);
  assert.ok(result.regex instanceof RegExp);
  assert.strictEqual(result.regex.flags.indexOf("g") >= 0, true);
});

test("rejects an empty pattern", () => {
  const result = regex.compilePattern("", "g");
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.length > 0);
});

test("rejects whitespace-only pattern", () => {
  const result = regex.compilePattern("   ", "g");
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.length > 0);
});

test("rejects invalid flags", () => {
  const result = regex.compilePattern("a", "q");
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.length > 0);
});

test("rejects an invalid pattern", () => {
  const result = regex.compilePattern("(unclosed", "g");
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.length > 0);
});

test("accepts every supported flag individually", () => {
  for (const flag of ["d", "g", "i", "m", "s", "u", "v", "y"]) {
    const result = regex.compilePattern("a", flag);
    assert.strictEqual(result.ok, true);
  }
});

test("flags default to empty when omitted", () => {
  const result = regex.compilePattern("a");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.regex.flags, "");
});

// --- collectSegments -------------------------------------------------------------
test("splits text into gaps and matches", () => {
  const res = regex.collectSegments(/a/g, "banana");
  const matches = onlyMatches(res);
  assert.strictEqual(matches.length, 3);
  assert.deepStrictEqual(matches.map(m => m.match), ["a", "a", "a"]);
  assert.strictEqual(res.segments[0].type, "gap");
  assert.deepStrictEqual([res.segments[0].start, res.segments[0].end], [0, 1]);
});

test("preserves capture groups", () => {
  const res = regex.collectSegments(/(a)(b)?/g, "ab a");
  const matches = onlyMatches(res);
  assert.strictEqual(matches[0].match, "ab");
  assert.deepStrictEqual(matches[0].captures, ["a", "b"]);
  assert.strictEqual(matches[1].match, "a");
});

test("collects named groups", () => {
  const res = regex.collectSegments(/(?<word>\w+)/g, "hi there");
  const matches = onlyMatches(res);
  assert.strictEqual(matches[0].groups.word, "hi");
});

test("non-global patterns match every occurrence", () => {
  const res = regex.collectSegments(/a/, "banana");
  assert.strictEqual(onlyMatches(res).length, 3);
});

test("anchored patterns still anchor", () => {
  const res = regex.collectSegments(/^b/, "banana");
  assert.strictEqual(onlyMatches(res).length, 1);
  const res2 = regex.collectSegments(/^a/, "banana");
  assert.strictEqual(onlyMatches(res2).length, 0);
});

test("zero-width matches handled without looping", () => {
  const res = regex.collectSegments(/x*/g, "abx");
  assert.strictEqual(res.truncated, false);
  const matches = onlyMatches(res);
  assert.strictEqual(matches.length, 4);
  assert.strictEqual(res.segments[0].start, 0);
});

test("empty subject yields no segments", () => {
  const res = regex.collectSegments(/a/g, "");
assert.strictEqual(res.segments.length, 0);
});

test("null subject treated as empty", () => {
  const res = regex.collectSegments(/a/g, null);
assert.strictEqual(res.segments.length, 0);
});

test("handles unicode with u flag", () => {
  const res = regex.collectSegments(/\p{L}+/gu, "héllo 世界");
const matches = onlyMatches(res);
assert.strictEqual(matches.length, 2);
assert.strictEqual(matches[0].match, "héllo");
});

test("truncates pathological match counts at 5000", () => {
  const res = regex.collectSegments(/(?:)/g, "x".repeat(25000));
assert.strictEqual(res.truncated, true);
assert.strictEqual(res.segments.length, 5000);
});

test("large realistic input stays bounded", () => {
  const body = "word ".repeat(20000);
const res = regex.collectSegments(/\b\w+\b/g, body);
assert.strictEqual(res.truncated, true);
assert.strictEqual(res.segments.length, 5001);
assert.strictEqual(onlyMatches(res).length, 2501);
});

// --- countMatches ------------------------------------------------------------------
test("counts matches and matched chars", () => {
  const stats = regex.countMatches(/a/g, "banana");
assert.strictEqual(stats.count, 3);
assert.strictEqual(stats.chars, 3);
});

test("countMatches reports zero with no matches", () => {
  const res = regex.countMatches(/z/g, "banana");
assert.strictEqual(res.count, 0);
assert.strictEqual(res.chars, 0);
});

test("countMatches counts multi-char matches", () => {
  const res = regex.countMatches(/ab/g, "ababab");
assert.strictEqual(res.count,  3);
assert.strictEqual(res.chars, 6);
});

test("countMatches reports truncation", () => {
  const res = regex.countMatches(/(?:)/g, "x".repeat(25000));
assert.strictEqual(res.truncated, true);
assert.strictEqual(res.count, 5000);
});

test("MAX_MATCHES is exposed for the UI", () => {
  assert.strictEqual(typeof regex.MAX_MATCHES, "number");
  assert.ok(regex.MAX_MATCHES >= 1000);
});

if (failed > 0) {
  console.log(failed + " failed," + passed + " passed");
  process.exit(1);
} else {
  console.log(passed + " passed");
}