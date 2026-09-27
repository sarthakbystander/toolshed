"use strict";

const assert = require("node:assert");
const dp = require("../tool.js");

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

console.log("dataset-profiler tests");

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

test("parses simple rows", () => {
  assert.deepStrictEqual(dp.parseDelimited("a,b,c\n1,2,3"), [["a", "b", "c"], ["1", "2", "3"]]);
});

test("handles CRLF", () => {
  assert.deepStrictEqual(dp.parseDelimited("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

test("parses quoted fields with commas", () => {
  assert.deepStrictEqual(dp.parseDelimited('a,"b,c",d'), [["a", "b,c", "d"]]);
});

test("parses escaped quotes", () => {
  assert.deepStrictEqual(dp.parseDelimited('a,"say ""hi""",c'), [["a", 'say "hi"', "c"]]);
});

test("parses embedded newlines inside quotes", () => {
  assert.deepStrictEqual(dp.parseDelimited('a,"line1\nline2",c'), [["a", "line1\nline2", "c"]]);
});

test("strips UTF-8 BOM", () => {
  assert.deepStrictEqual(dp.parseDelimited("\uFEFFa,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("empty input yields no rows", () => {
  assert.deepStrictEqual(dp.parseDelimited(""), []);
});

test("detects semicolon delimiter", () => {
  assert.strictEqual(dp.detectDelimiter("a;b;c\n1;2;3"), ";");
});

test("detects tab delimiter", () => {
  assert.strictEqual(dp.detectDelimiter("a\tb\n1\t2"), "\t");
});

test("defaults to comma", () => {
  assert.strictEqual(dp.detectDelimiter("a,b,c"), ",");
});

// ---------------------------------------------------------------------------
// Header normalization and dataset assembly
// ---------------------------------------------------------------------------

test("normalizeHeaders fills blanks", () => {
  assert.deepStrictEqual(dp.normalizeHeaders(["a", "", "c"]), ["a", "column_2", "c"]);
});

test("normalizeHeaders de-duplicates", () => {
  assert.deepStrictEqual(dp.normalizeHeaders(["x", "x", "x", "x_1"]), ["x", "x_1", "x_2", "x_1_1"]);
});

test("readDelimited uses first row as header", () => {
  const ds = dp.readDelimited("name,age\nalice,30\nbob,25");
  assert.deepStrictEqual(ds.columns, ["name", "age"]);
  assert.deepStrictEqual(ds.rows, [["alice", "30"], ["bob", "25"]]);
});

test("readDelimited pads short rows", () => {
  const ds = dp.readDelimited("a,b,c\n1,2");
  assert.deepStrictEqual(ds.rows, [["1", "2", ""]]);
});

test("readDelimited can skip the header", () => {
  const ds = dp.readDelimited("1,2\n3,4", { header: false });
  assert.deepStrictEqual(ds.columns, ["column_1", "column_2"]);
  assert.deepStrictEqual(ds.rows, [["1", "2"], ["3", "4"]]);
});

// ---------------------------------------------------------------------------
// JSON datasets
// ---------------------------------------------------------------------------

test("reads an array of objects", () => {
  const ds = dp.readJSONDataset('[{"a":1,"b":"x"},{"a":2,"c":true}]');
  assert.deepStrictEqual(ds.columns, ["a", "b", "c"]);
  assert.deepStrictEqual(ds.rows, [[1, "x", null], [2, null, true]]);
});

test("reads an array of arrays", () => {
  const ds = dp.readJSONDataset("[[1,2],[3,4]]");
  assert.deepStrictEqual(ds.columns, ["column_1", "column_2"]);
  assert.deepStrictEqual(ds.rows, [[1, 2], [3, 4]]);
});

test("reads an array of primitives", () => {
  const ds = dp.readJSONDataset("[1,2,3]");
  assert.deepStrictEqual(ds.columns, ["value"]);
  assert.deepStrictEqual(ds.rows, [[1], [2], [3]]);
});

test("unwraps a single-array object", () => {
  const ds = dp.readJSONDataset('{"data":[{"a":1}]}');
  assert.deepStrictEqual(ds.columns, ["a"]);
  assert.deepStrictEqual(ds.rows, [[1]]);
});

test("empty JSON array yields an empty dataset", () => {
  const ds = dp.readJSONDataset("[]");
  assert.deepStrictEqual(ds.columns, []);
  assert.deepStrictEqual(ds.rows, []);
});

test("malformed JSON is reported, not thrown", () => {
  const out = dp.profileText("[{bad json");
  assert.strictEqual(out.ok, false);
  assert.ok(out.error.length > 0);
});

test("JSON errors are sanitized with a line/column hint", () => {
  const out = dp.profileText('[{"a": 1, bad}]');
  assert.strictEqual(out.ok, false);
  assert.ok(/^Invalid JSON: /.test(out.error), out.error);
  assert.ok(/line 1, column \d+/.test(out.error), out.error);
  assert.ok(!/position \d+/.test(out.error), out.error);
});

test("JSON error text never leaks the raw source snippet", () => {
  const out = dp.profileText('[\n  {"a": 1},\n  {"a": }\n]');
  assert.strictEqual(out.ok, false);
  assert.ok(/^Invalid JSON: /.test(out.error), out.error);
  assert.ok(!/is not valid JSON/i.test(out.error), out.error);
  assert.ok(out.error.indexOf('{"a"') === -1, out.error);
});

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

test("infers integer, number, boolean, date and text columns", () => {
  const ds = dp.readDelimited(
    "n,dec,flag,when,label\n1,1.5,true,2024-01-02,hello\n2,2.5,false,2024-03-04,world"
  );
  const profile = dp.profileDataset(ds);
  const byName = {};
  profile.columns.forEach(c => { byName[c.name] = c; });
  assert.strictEqual(byName.n.type, "integer");
  assert.strictEqual(byName.dec.type, "number");
  assert.strictEqual(byName.flag.type, "boolean");
  assert.strictEqual(byName.when.type, "date");
  assert.strictEqual(byName.label.type, "text");
});

test("a column of all nulls is type empty", () => {
  const ds = dp.readDelimited("a\n\n\n");
  const profile = dp.profileDataset(ds);
  assert.strictEqual(profile.columns[0].type, "empty");
  assert.strictEqual(profile.columns[0].count, 0);
});

test("mixed numeric and text falls back to text", () => {
  const ds = dp.readDelimited("a\n1\nhello\n3");
  const profile = dp.profileDataset(ds);
  assert.strictEqual(profile.columns[0].type, "text");
});

test("null-token strings count as missing", () => {
  const ds = dp.readDelimited("a\n1\nN/A\nnull\n3");
  const profile = dp.profileDataset(ds);
  assert.strictEqual(profile.columns[0].nulls, 2);
});

test("blank cells count as missing", () => {
  const ds = dp.readDelimited("a,b\n1,x\n,y\n3,");
  const profile = dp.profileDataset(ds);
  const byName = {};
  profile.columns.forEach(c => { byName[c.name] = c; });
  assert.strictEqual(byName.a.nulls, 1);
  assert.strictEqual(byName.b.nulls, 1);
});

// ---------------------------------------------------------------------------
// Numeric statistics
// ---------------------------------------------------------------------------

test("percentile matches linear interpolation", () => {
  const sorted = [1, 2, 3, 4];
  assert.strictEqual(dp.percentile(sorted, 0), 1);
  assert.strictEqual(dp.percentile(sorted, 0.5), 2.5);
  assert.strictEqual(dp.percentile(sorted, 1), 4);
  assert.strictEqual(dp.percentile(sorted, 0.25), 1.75);
});

test("summarizeNumbers computes core stats", () => {
  const s = dp.summarizeNumbers([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.strictEqual(s.min, 2);
  assert.strictEqual(s.max, 9);
  assert.strictEqual(s.mean, 5);
  assert.strictEqual(s.median, 4.5);
  assert.strictEqual(s.q1, 4);
  assert.strictEqual(s.q3, 5.5);
  assert.strictEqual(s.iqr, 1.5);
});

test("summarizeNumbers handles a single value", () => {
  const s = dp.summarizeNumbers([42]);
  assert.strictEqual(s.mean, 42);
  assert.strictEqual(s.stdev, 0);
  assert.strictEqual(s.outliers, 0);
});

test("summarizeNumbers detects outliers with 1.5*IQR", () => {
  const s = dp.summarizeNumbers([1, 2, 3, 4, 5, 100]);
  assert.strictEqual(s.outliers, 1);
});

test("stdev uses the sample formula", () => {
  const s = dp.summarizeNumbers([2, 4, 4, 4, 5, 5, 7, 9]);
  // sample stdev of this classic set is ~2.138
  assert.ok(Math.abs(s.stdev - 2.1381) < 0.001);
});

test("binary histogram for zero-variance data", () => {
  const s = dp.buildHistogram([5, 5, 5], 10);
  assert.deepStrictEqual(s.edges, [5, 5]);
  assert.deepStrictEqual(s.counts, [3]);
  assert.strictEqual(s.maxCount, 3);
});

test("histogram bins sum to the sample count", () => {
  const values = [];
  for (let i = 0; i < 100; i++) values.push(i);
  const h = dp.buildHistogram(values, 10);
  const total = h.counts.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 100);
  assert.strictEqual(h.counts.length, 10);
  assert.strictEqual(h.maxCount, 10);
});

test("histogram handles negative ranges", () => {
  const h = dp.buildHistogram([-10, -5, 0, 5, 10], 4);
  const total = h.counts.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 5);
  assert.strictEqual(h.edges.length, 5);
});

// ---------------------------------------------------------------------------
// Top values and distinct
// ---------------------------------------------------------------------------

test("top values are ordered by frequency", () => {
  const ds = dp.readDelimited("fruit\napple\nbanana\napple\ncherry\napple\nbanana");
  const profile = dp.profileDataset(ds);
  const top = profile.columns[0].top;
  assert.strictEqual(top[0].value, "apple");
  assert.strictEqual(top[0].count, 3);
  assert.strictEqual(top[1].value, "banana");
  assert.strictEqual(top[1].count, 2);
  assert.strictEqual(profile.columns[0].distinct, 3);
});

test("distinct counts unique values", () => {
  const ds = dp.readJSONDataset('[{"a":1},{"a":1},{"a":2},{"a":null}]');
  const profile = dp.profileDataset(ds);
  assert.strictEqual(profile.columns[0].distinct, 2);
  assert.strictEqual(profile.columns[0].nulls, 1);
});

// ---------------------------------------------------------------------------
// Dataset-level metrics
// ---------------------------------------------------------------------------

test("counts duplicate rows", () => {
  const ds = dp.readDelimited("a,b\n1,x\n1,x\n2,y\n1,x");
  const profile = dp.profileDataset(ds);
  assert.strictEqual(profile.duplicateRows, 2);
  assert.strictEqual(profile.rowCount, 4);
});

test("missing ratio aggregates across columns", () => {
  const ds = dp.readDelimited("a,b\n1,\n,2");
  const profile = dp.profileDataset(ds);
  assert.strictEqual(profile.cellCount, 4);
  assert.strictEqual(profile.missingCells, 2);
  assert.strictEqual(profile.missingRatio, 0.5);
});

test("empty dataset profiles without error", () => {
  const out = dp.profileText("");
  assert.strictEqual(out.ok, false);
});

test("header-only dataset yields zero rows", () => {
  const out = dp.profileText("a,b,c");
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.profile.rowCount, 0);
  assert.strictEqual(out.profile.columnCount, 3);
});

// ---------------------------------------------------------------------------
// Correlations
// ---------------------------------------------------------------------------

test("pearson correlation of perfectly correlated series is 1", () => {
  const r = dp.pearson([1, 2, 3, 4], [2, 4, 6, 8]);
  assert.ok(Math.abs(r - 1) < 1e-9);
});

test("pearson correlation of inversely correlated series is -1", () => {
  const r = dp.pearson([1, 2, 3, 4], [4, 3, 2, 1]);
  assert.ok(Math.abs(r + 1) < 1e-9);
});

test("pearson returns null for constant series", () => {
  assert.strictEqual(dp.pearson([1, 1, 1], [1, 2, 3]), null);
});

test("pearson ignores null pairs", () => {
  const r = dp.pearson([1, null, 3, 4], [2, 100, 6, 8]);
  assert.ok(Math.abs(r - 1) < 1e-9);
});

test("correlation matrix built for two numeric columns", () => {
  const ds = dp.readDelimited("x,y\n1,2\n2,4\n3,6\n4,8");
  const profile = dp.profileDataset(ds);
  assert.ok(profile.correlations);
  assert.deepStrictEqual(profile.correlations.columns, ["x", "y"]);
  assert.strictEqual(profile.correlations.matrix[0][0], 1);
  assert.ok(Math.abs(profile.correlations.matrix[0][1] - 1) < 1e-9);
});

test("no correlation matrix with one numeric column", () => {
  const ds = dp.readDelimited("x,y\n1,a\n2,b");
  const profile = dp.profileDataset(ds);
  assert.strictEqual(profile.correlations, null);
});

// ---------------------------------------------------------------------------
// Formatting and reporting
// ---------------------------------------------------------------------------

test("formatNumber keeps integers and rounds decimals", () => {
  assert.strictEqual(dp.formatNumber(42), "42");
  assert.strictEqual(dp.formatNumber(3.14159), "3.142");
  assert.strictEqual(dp.formatNumber(null), "—");
});

test("toMarkdown includes a section per column", () => {
  const out = dp.profileText("name,score\nalice,3\nbob,5");
  const md = dp.toMarkdown(out.profile);
  assert.ok(md.indexOf("# Dataset profile") === 0);
  assert.ok(md.indexOf("## name (text)") !== -1);
  assert.ok(md.indexOf("## score (integer)") !== -1);
  assert.ok(md.indexOf("Mean: 4") !== -1);
});

test("profile is JSON-serializable without internal helpers", () => {
  const out = dp.profileText("a,b\n1,x\n2,y");
  const json = JSON.stringify(out.profile);
  assert.ok(json.indexOf("sorted") === -1);
  assert.deepStrictEqual(JSON.parse(json).rowCount, 2);
});

// ---------------------------------------------------------------------------
// Realistic / edge inputs
// ---------------------------------------------------------------------------

test("profiles a realistic CSV with mixed types", () => {
  const csv = [
    "id,name,age,joined,active,score",
    "1,Alice,30,2024-01-15,true,88.5",
    "2,Bob,25,2023-11-02,false,72.0",
    "3,Carol,,2024-03-20,true,91.2",
    "4,Dave,41,2022-07-08,true,65.4",
    "5,Eve,29,2024-05-01,false,"
  ].join("\n");
  const out = dp.profileText(csv);
  assert.strictEqual(out.ok, true);
  const p = out.profile;
  assert.strictEqual(p.rowCount, 5);
  assert.strictEqual(p.columnCount, 6);
  const byName = {};
  p.columns.forEach(c => { byName[c.name] = c; });
  assert.strictEqual(byName.id.type, "integer");
  assert.strictEqual(byName.name.type, "text");
  assert.strictEqual(byName.joined.type, "date");
  assert.strictEqual(byName.active.type, "boolean");
  assert.strictEqual(byName.age.nulls, 1);
  assert.strictEqual(byName.score.nulls, 1);
  assert.strictEqual(byName.joined.min, "2022-07-08");
  assert.strictEqual(byName.joined.max, "2024-05-01");
  assert.strictEqual(byName.active.trueCount, 3);
  assert.strictEqual(byName.active.falseCount, 2);
});

test("profiles a larger generated dataset", () => {
  const lines = ["i,x,y"];
  for (let i = 0; i < 5000; i++) lines.push(i + "," + (i % 7) + "," + (i * 2));
  const out = dp.profileText(lines.join("\n"));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.profile.rowCount, 5000);
  const h = out.profile.columns[0].numeric.histogram;
  assert.strictEqual(h.counts.reduce((a, b) => a + b, 0), 5000);
});

test("semicolon-separated data is detected", () => {
  const out = dp.profileText("a;b\n1;2\n3;4");
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.profile.columns.map(c => c.name), ["a", "b"]);
});

test("tab-separated data is detected", () => {
  const out = dp.profileText("a\tb\n1\t2\n3\t4");
  assert.deepStrictEqual(out.profile.columns.map(c => c.name), ["a", "b"]);
});

test("JSON object dataset with nested-free values", () => {
  const out = dp.profileText('[{"city":"Oslo","pop":709000},{"city":"Bergen","pop":286000}]');
  assert.strictEqual(out.profile.format, "json");
  const byName = {};
  out.profile.columns.forEach(c => { byName[c.name] = c; });
  assert.strictEqual(byName.city.type, "text");
  assert.strictEqual(byName.pop.numeric.min, 286000);
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
