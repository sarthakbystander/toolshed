/* Toolshed JSON Formatter — tests. Run with: node tests/run.js
 * Uses Node's built-in assert and requires ../tool.js via its UMD export.
 */
"use strict";

const assert = require("node:assert");
const json = require("../tool.js");

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

console.log("json-formatter tests");

// --- valid JSON --------------------------------------------------------------
test("formats valid JSON", () => {
  const result = json.formatText('{"a":1,"b":[true,null,"x"]}');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.text, '{\n  "a": 1,\n  "b": [\n    true,\n    null,\n    "x"\n  ]\n}');
});

test("formats empty object", () => {
  assert.strictEqual(json.formatText("{}").text, "{}");
});

test("formats primitive JSON values", () => {
  assert.strictEqual(json.formatText("42").text, "42");
  assert.strictEqual(json.formatText('"hello"').text, '"hello"');
  assert.strictEqual(json.formatText("true").text, "true");
  assert.strictEqual(json.formatText("null").text, "null");
});

test("parses valid JSON", () => {
  const parsed = json.parseJSON('{"ok": true}');
  assert.strictEqual(parsed.ok, true);
  assert.deepStrictEqual(parsed.value, { ok: true });
});

// --- malformed JSON ----------------------------------------------------------
test("rejects malformed JSON with useful error", () => {
  const result = json.formatText("{ this is not json }");
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.message.length > 0, "error should have a message");
  assert.ok(result.error.line >= 1);
  assert.ok(result.error.column >= 1);
});

test("rejects unbalanced braces", () => {
  const result = json.formatText('{"a": 1');
  assert.strictEqual(result.ok, false);
});

test("rejects trailing garbage", () => {
  const result = json.formatText('{"a":1} trailing');
  assert.strictEqual(result.ok, false);
});

// --- nested JSON -------------------------------------------------------------
test("handles deeply nested JSON", () => {
  const source = '{"a":{"b":{"c":[1,[2,[{"d":3}]]]}}}';
  const result = json.formatText(source);
  assert.strictEqual(result.ok, true);
  const reparsed = JSON.parse(result.text);
  assert.deepStrictEqual(reparsed, { a: { b: { c: [1, [2, [{ d: 3 }]]] } } });
});

// --- empty input -------------------------------------------------------------
test("rejects empty input", () => {
  const result = json.formatText("   \n  ");
  assert.strictEqual(result.ok, false);
  assert.match(result.error.message, /empty/i);
});

// --- minification ------------------------------------------------------------
test("minifies JSON", () => {
  const result = json.minifyText('{\n  "a": 1,\n  "b": [ 2, 3 ]\n}');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.text, '{"a":1,"b":[2,3]}');
});

test("minify failure reports error", () => {
  const result = json.minifyText("nope");
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
});

test("format then minify round-trips", () => {
  const source = '{"x":[1,2,3],"y":{"z":true}}';
  const formatted = json.formatText(source).text;
  const reparsed = JSON.parse(formatted);
  const minified = json.minify(reparsed);
  assert.strictEqual(minified, source);
});

// --- unicode & edge cases ----------------------------------------------------
test("preserves unicode strings", () => {
  const result = json.formatText('{"emoji":"👍","text":"héllo"}');
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(JSON.parse(result.text), { emoji: "👍", text: "héllo" });
});

test("escapes special strings deterministically", () => {
  const src = '{"s":"tab\\tquote\\"slash\\\\"}';
  const result = json.minifyText(src);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.text, JSON.stringify(JSON.parse(src)));
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);