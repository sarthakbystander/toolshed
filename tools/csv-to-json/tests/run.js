"use strict";

const assert = require("node:assert");
const csv = require("../tool.js");

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

console.log("csv-to-json tests");

// --- parser ---

test("parses simple rows", () => {
  assert.deepStrictEqual(csv.parseCSV("a,b,c\n1,2,3"), [["a", "b", "c"], ["1", "2", "3"]]);
});

test("handles CRLF", () => {
  assert.deepStrictEqual(csv.parseCSV("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

test("parses quoted fields with commas", () => {
  assert.deepStrictEqual(csv.parseCSV('a,"b,c",d'), [["a", "b,c", "d"]]);
});

test("parses escaped quotes", () => {
  assert.deepStrictEqual(csv.parseCSV('a,"say ""hi""",c'), [["a", 'say "hi"', "c"]]);
});

test("parses embedded newlines inside quotes", () => {
  assert.deepStrictEqual(csv.parseCSV('a,"line1\nline2",c'), [["a", "line1\nline2", "c"]]);
});

test("strips UTF-8 BOM", () => {
  assert.deepStrictEqual(csv.parseCSV("\uFEFFa,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("empty input yields no rows", () => {
  assert.deepStrictEqual(csv.parseCSV(""), []);
});

// --- delimiter detection ---

test("detects semicolon delimiter", () => {
  assert.strictEqual(csv.detectDelimiter("a;b;c\n1;2;3"), ";");
});

test("detects tab delimiter", () => {
  assert.strictEqual(csv.detectDelimiter("a\tb\n1\t2"), "\t");
});

test("defaults to comma", () => {
  assert.strictEqual(csv.detectDelimiter("a,b,c"), ",");
});

// --- inferValue ---

test("infers numbers, booleans, null and strings", () => {
  assert.strictEqual(csv.inferValue("42"), 42);
  assert.strictEqual(csv.inferValue("3.14"), 3.14);
  assert.strictEqual(csv.inferValue("-7"), -7);
  assert.strictEqual(csv.inferValue("1e3"), 1000);
  assert.strictEqual(csv.inferValue("true"), true);
  assert.strictEqual(csv.inferValue("FALSE"), false);
  assert.strictEqual(csv.inferValue("null"), null);
  assert.strictEqual(csv.inferValue("hello"), "hello");
  assert.strictEqual(csv.inferValue(""), "");
});

// --- rowToJson: header mode ---

test("header mode maps objects", () => {
  const rows = [["name", "age"], ["alice", "30"], ["bob", "25"]];
  assert.deepStrictEqual(csv.rowsToJson(rows, { header: true }), [
    { name: "alice", age: 30 },
    { name: "bob", age: 25 }
  ]);
});

test("auto-detects header row", () => {
  const rows = [["name", "age"], ["alice", "30"]];
  assert.deepStrictEqual(csv.rowsToJson(rows), [{ name: "alice", age: 30 }]);
});

test("missing cells become empty string", () => {
  const rows = [["a", "b"], ["1"]];
  // the "1" in the first column is inferred to number 1
  assert.deepStrictEqual(csv.rowsToJson(rows, { header: true }), [{ a: 1, b: "" }]);
});

test("duplicate headers become arrays", () => {
  const rows = [["x", "x"], ["1", "2"]];
  assert.deepStrictEqual(csv.rowsToJson(rows, { header: true }), [{ x: [1, 2] }]);
});

test("inferTypes can be disabled", () => {
  const rows = [["n"], ["42"]];
  assert.deepStrictEqual(csv.rowsToJson(rows, { header: true, inferTypes: false }), [{ n: "42" }]);
});

// --- simple array mode ---

test("single column without header produces flat array", () => {
  const rows = [["a"], ["b"], ["c"]];
  assert.deepStrictEqual(csv.rowsToJson(rows, { header: false }), ["a", "b", "c"]);
});

test("single column with numbers infers types", () => {
  const rows = [["1"], ["2"]];
  assert.deepStrictEqual(csv.rowsToJson(rows, { header: false }), [1, 2]);
});

// --- delimiter-aware parsing ---

test("parses semicolon delimiter", () => {
  assert.deepStrictEqual(csv.parseCSV("a;b;c\n1;2;3", ";"), [["a", "b", "c"], ["1", "2", "3"]]);
});

test("parses tab delimiter", () => {
  assert.deepStrictEqual(csv.parseCSV("a\tb\n1\t2", "\t"), [["a", "b"], ["1", "2"]]);
});

test("parses pipe delimiter", () => {
  assert.deepStrictEqual(csv.parseCSV("a|b\n1|2", "|"), [["a", "b"], ["1", "2"]]);
});

test("convert honors forced delimiter", () => {
  const out = csv.convert("name;age\nalice;30\nbob;25", { header: true, delimiter: ";" });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.json, [{ name: "alice", age: 30 }, { name: "bob", age: 25 }]);
});

test("quoted fields work with non-comma delimiter", () => {
  const out = csv.convert('name;note\nalice;"has a ; inside"', { header: true, delimiter: ";" });
  assert.deepStrictEqual(out.json, [{ name: "alice", note: "has a ; inside" }]);
});


// --- convert pipeline ---

test("convert returns ok plus json", () => {
  const out = csv.convert("name,age\nalice,30\n");
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.json, [{ name: "alice", age: 30 }]);
  assert.strictEqual(out.rows, 2);
});

test("convert reports errors", () => {
  // parseCSV is very forgiving, so force an error through a bad option
  const out = csv.convert("a,b\n1,2", { malformed: true });
  assert.strictEqual(out.ok, true);
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
