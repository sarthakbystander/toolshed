/* Toolshed Log Analyzer — tests. Run with: node tests/run.js
 * Uses Node's built-in assert and requires ../tool.js via its UMD export.
 */
"use strict";

const assert = require("node:assert");
const log = require("../tool.js");

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

console.log("log-analyzer tests");

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

test("parses ISO 8601 with Z", () => {
  const ts = log.parseTimestamp("2024-05-01T10:00:00Z hello");
  assert.ok(ts);
  assert.strictEqual(ts.timestamp.epoch, Date.UTC(2024, 4, 1, 10, 0, 0));
  assert.strictEqual(ts.timestamp.source, "iso");
  assert.strictEqual(ts.rest.trim(), "hello");
});

test("parses ISO 8601 with milliseconds and comma separator", () => {
  const ts = log.parseTimestamp("2024-05-01 10:00:00,250 message");
  assert.ok(ts);
  assert.strictEqual(ts.timestamp.epoch, Date.UTC(2024, 4, 1, 10, 0, 0, 250));
});

test("parses ISO 8601 with an explicit UTC offset", () => {
  const ts = log.parseTimestamp("2024-05-01T10:00:00+02:00 msg");
  assert.ok(ts);
  assert.strictEqual(ts.timestamp.epoch, Date.UTC(2024, 4, 1, 8, 0, 0));
});

test("parses slash-separated year/month/day", () => {
  const ts = log.parseTimestamp("2024/05/01 10:00:00 ok");
  assert.ok(ts);
  assert.strictEqual(ts.timestamp.epoch, Date.UTC(2024, 4, 1, 10, 0, 0));
});

test("parses Apache common log timestamps", () => {
  const ts = log.parseTimestamp("[01/May/2024:10:00:00 +0000] GET /");
  assert.ok(ts);
  assert.strictEqual(ts.timestamp.epoch, Date.UTC(2024, 4, 1, 10, 0, 0));
  assert.strictEqual(ts.timestamp.source, "common");
});

test("parses syslog timestamps without a year", () => {
  const ts = log.parseTimestamp("May  1 10:00:04 host sshd: hi");
  assert.ok(ts);
  assert.strictEqual(ts.timestamp.source, "syslog");
  assert.strictEqual(ts.timestamp.mo, 5);
  assert.strictEqual(ts.timestamp.d, 1);
});

test("parses bare time-only stamps", () => {
  const ts = log.parseTimestamp("10:00:00.500 plain");
  assert.ok(ts);
  assert.strictEqual(ts.timestamp.source, "time-only");
  assert.strictEqual(ts.timestamp.h, 10);
});

test("rejects impossible calendar values", () => {
  assert.strictEqual(log.parseTimestamp("2024-13-40T10:00:00Z x"), null);
  assert.strictEqual(log.parseTimestamp("2024-05-01T99:00:00Z x"), null);
});

test("returns null when no timestamp is present", () => {
  assert.strictEqual(log.parseTimestamp("INFO starting up"), null);
});

// ---------------------------------------------------------------------------
// Message normalization
// ---------------------------------------------------------------------------

test("normalizes numbers to a placeholder", () => {
  assert.strictEqual(log.normalizeMessage("Request took 250ms"), "Request took <n>");
});

test("normalizes UUIDs, IPs and timestamps", () => {
  assert.strictEqual(
    log.normalizeMessage("user 550e8400-e29b-41d4-a716-446655440000 from 10.0.0.7"),
    "user <uuid> from <ip>"
  );
  assert.strictEqual(
    log.normalizeMessage("at 2024-05-01T10:00:00Z done"),
    "at <ts> done"
  );
});

test("normalizes quoted strings", () => {
  assert.strictEqual(log.normalizeMessage('cannot open "/etc/app.conf"'), 'cannot open "<str>"');
});

test("collapses whitespace in templates", () => {
  assert.strictEqual(log.normalizeMessage("a   b\t\tc"), "a b c");
});

test("normalization is stable across differing values", () => {
  const a = log.normalizeMessage("processed 12 records for user 7");
  const b = log.normalizeMessage("processed 480 records for user 991");
  assert.strictEqual(a, b);
});

// ---------------------------------------------------------------------------
// Exception extraction
// ---------------------------------------------------------------------------

test("extracts exception class names", () => {
  assert.deepStrictEqual(
    log.extractExceptionTypes("java.lang.NullPointerException: boom"),
    ["java.lang.NullPointerException"]
  );
  assert.deepStrictEqual(
    log.extractExceptionTypes("TypeError: x is not a function"),
    ["TypeError"]
  );
});

test("extracts multiple distinct exception types without duplicates", () => {
  const found = log.extractExceptionTypes("TimeoutException then TimeoutException then IOError");
  assert.deepStrictEqual(found, ["TimeoutException", "IOError"]);
});

test("returns an empty array when no exception is named", () => {
  assert.deepStrictEqual(log.extractExceptionTypes("all good"), []);
});

// ---------------------------------------------------------------------------
// Line splitting
// ---------------------------------------------------------------------------

test("splits on LF, CRLF and lone CR", () => {
  assert.deepStrictEqual(log.splitLines("a\nb"), ["a", "b"]);
  assert.deepStrictEqual(log.splitLines("a\r\nb"), ["a", "b"]);
  assert.deepStrictEqual(log.splitLines("a\rb"), ["a", "b"]);
});

test("does not create a trailing empty line", () => {
  assert.deepStrictEqual(log.splitLines("a\nb\n"), ["a", "b"]);
});

test("handles empty and non-string input", () => {
  assert.deepStrictEqual(log.splitLines(""), []);
  assert.deepStrictEqual(log.splitLines(null), []);
});

// ---------------------------------------------------------------------------
// Plain-line parsing
// ---------------------------------------------------------------------------

test("parses a timestamp, level and dotted source from a plain line", () => {
  const e = log.parseLine("2024-05-01T10:00:00Z ERROR api.handler: request failed", 1);
  assert.strictEqual(e.level, "error");
  assert.strictEqual(e.source, "api.handler");
  assert.strictEqual(e.message, "request failed");
  assert.ok(e.timestamp);
});

test("parses a bracketed level", () => {
  const e = log.parseLine("[WARN] disk almost full", 2);
  assert.strictEqual(e.level, "warning");
  assert.strictEqual(e.message, "disk almost full");
});

test("parses a syslog-style bracket source after the level", () => {
  const e = log.parseLine("2024-05-01 10:00:00 INFO [worker-1] job done", 3);
  assert.strictEqual(e.level, "info");
  assert.strictEqual(e.source, "worker-1");
  assert.strictEqual(e.message, "job done");
});

test("marks unstructured plain lines as malformed", () => {
  const e = log.parseLine("just some words", 4);
  assert.strictEqual(e.malformed, true);
  assert.strictEqual(e.message, "just some words");
});

test("marks blank lines with the blank format", () => {
  const e = log.parseLine("   ", 5);
  assert.strictEqual(e.format, "blank");
});

test("strips a UTF-8 BOM from the first line", () => {
  const e = log.parseLine("\uFEFF2024-05-01T10:00:00Z INFO boot", 6);
  assert.strictEqual(e.level, "info");
});

// ---------------------------------------------------------------------------
// Structured lines
// ---------------------------------------------------------------------------

test("parses JSON lines with level, timestamp and logger", () => {
  const e = log.parseLine(
    '{"timestamp":"2024-05-01T10:00:03Z","level":"error","logger":"api.handler","message":"boom"}',
    7
  );
  assert.strictEqual(e.format, "json");
  assert.strictEqual(e.level, "error");
  assert.strictEqual(e.source, "api.handler");
  assert.strictEqual(e.message, "boom");
  assert.strictEqual(e.timestamp.iso, "2024-05-01T10:00:03");
});

test("parses JSON numeric severities and epoch timestamps", () => {
  const e = log.parseLine('{"level":50,"time":1714557603000,"msg":"kaboom"}', 8);
  assert.strictEqual(e.level, "fatal");
  assert.strictEqual(e.timestamp.epoch, 1714557603000);
  assert.strictEqual(e.message, "kaboom");
});

test("parses JSON epoch seconds", () => {
  const e = log.parseLine('{"ts":1714557603,"msg":"hi"}', 9);
  assert.strictEqual(e.timestamp.epoch, 1714557603000);
});

test("parses logfmt lines", () => {
  const e = log.parseLine('level=warn msg="disk almost full" service=storage', 10);
  assert.strictEqual(e.format, "logfmt");
  assert.strictEqual(e.level, "warning");
  assert.strictEqual(e.source, "storage");
  assert.strictEqual(e.message, "disk almost full");
});

test("does not misread ordinary text as logfmt", () => {
  const e = log.parseLine("GET /a=b and /c=d from a browser", 11);
  assert.notStrictEqual(e.format, "logfmt");
});

test("keeps malformed JSON on the plain path", () => {
  const e = log.parseLine('{"level": "error", broken', 12);
  assert.notStrictEqual(e.format, "json");
});

// ---------------------------------------------------------------------------
// analyze()
// ---------------------------------------------------------------------------

test("analyze reports line totals and processes every line", () => {
  const res = log.analyze("INFO a\nWARN b\n\nerror c\n");
  assert.strictEqual(res.totalLines, 4);
  assert.strictEqual(res.processedLines, 4);
  assert.strictEqual(res.truncated, false);
  assert.strictEqual(res.entries.length, 4);
});

test("analyze re-anchors year-less timestamps onto the file's year", () => {
  const res = log.analyze("2024-05-01T10:00:00Z INFO a\nMay  1 10:00:05 host sshd: b");
  const syslog = res.entries[1];
  assert.strictEqual(syslog.timestamp.y, 2024);
  assert.strictEqual(syslog.timestamp.iso, "2024-05-01T10:00:05");
});

test("analyze handles empty input", () => {
  const res = log.analyze("");
  assert.strictEqual(res.totalLines, 0);
  assert.deepStrictEqual(res.entries, []);
});

// ---------------------------------------------------------------------------
// summarize()
// ---------------------------------------------------------------------------

function sampleLog() {
  return [
    "2024-05-01T10:00:00Z INFO  app: started",
    "2024-05-01T10:00:01Z INFO  app: processed 12 records",
    "2024-05-01T10:00:02Z INFO  app: processed 480 records",
    "2024-05-01T10:00:03Z ERROR db: connection to 10.0.0.5 failed",
    "2024-05-01T10:00:04Z ERROR db: connection to 10.0.0.9 failed",
    "2024-05-01T10:00:05Z ERROR api: java.lang.NullPointerException at /users/7",
    "2024-05-01T10:00:06Z WARN  cache: hit ratio 0.42",
    "2024-05-01T10:00:07Z DEBUG cache: lookup key 991",
    ""
  ].join("\n");
}

test("summarize counts levels and computes the error rate", () => {
  const res = log.analyze(sampleLog());
  const stats = log.summarize(res.entries, {});
  assert.strictEqual(stats.total, 8);
  assert.strictEqual(stats.levels.info, 3);
  assert.strictEqual(stats.levels.error, 3);
  assert.strictEqual(stats.levels.warning, 1);
  assert.strictEqual(stats.levels.debug, 1);
  assert.strictEqual(stats.errorRate, 3 / 8);
});

test("summarize groups similar messages by template", () => {
  const res = log.analyze(sampleLog());
  const stats = log.summarize(res.entries, {});
  const processed = stats.groups.find((g) => /processed/.test(g.template));
  assert.ok(processed, "the two processed lines should group together");
  assert.strictEqual(processed.count, 2);
});

test("summarize lists top errors only", () => {
  const res = log.analyze(sampleLog());
  const stats = log.summarize(res.entries, {});
  assert.ok(stats.errors.length > 0);
  assert.ok(stats.errors.every((g) => g.severity >= log.SEVERITY_RANK.error));
});

test("summarize extracts exception types from error lines", () => {
  const res = log.analyze(sampleLog());
  const stats = log.summarize(res.entries, {});
  assert.deepStrictEqual(stats.exceptions, [{ name: "java.lang.NullPointerException", count: 1 }]);
});

test("summarize ranks sources by volume", () => {
  const res = log.analyze(sampleLog());
  const stats = log.summarize(res.entries, {});
  const db = stats.sources.find((s) => s.name === "db");
  assert.ok(db);
  assert.strictEqual(db.count, 2);
});

test("summarize computes the time range and buckets", () => {
  const res = log.analyze(sampleLog());
  const stats = log.summarize(res.entries, {});
  assert.strictEqual(stats.timeRange.durationMs, 7000);
  assert.ok(stats.buckets.length >= 1);
  const total = stats.buckets.reduce((n, b) => n + b.count, 0);
  assert.strictEqual(total, 8);
});

test("summarize on empty input yields zeroed stats", () => {
  const stats = log.summarize([], {});
  assert.strictEqual(stats.total, 0);
  assert.strictEqual(stats.errorRate, 0);
  assert.strictEqual(stats.timeRange, null);
  assert.deepStrictEqual(stats.groups, []);
});

test("summarize respects the top limit", () => {
  const res = log.analyze(sampleLog());
  const stats = log.summarize(res.entries, { top: 2 });
  assert.ok(stats.groups.length <= 2);
  assert.ok(stats.sources.length <= 2);
});

// ---------------------------------------------------------------------------
// buildBuckets
// ---------------------------------------------------------------------------

test("buildBuckets places each stamp in exactly one bucket", () => {
  const stamps = [0, 1000, 2000, 3000, 4000];
  const buckets = log.buildBuckets(stamps, 0, 4000, 4);
  const total = buckets.reduce((n, b) => n + b.count, 0);
  assert.strictEqual(total, stamps.length);
});

test("buildBuckets handles a single instant", () => {
  const buckets = log.buildBuckets([5000], 5000, 5000, 40);
  assert.strictEqual(buckets.length, 1);
  assert.strictEqual(buckets[0].count, 1);
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const filterEntries = log.analyze(sampleLog()).entries;

test("filters by substring case-insensitively by default", () => {
  const out = log.filterEntries(filterEntries, { text: "PROCESSED" });
  assert.strictEqual(out.length, 2);
});

test("filters by substring case-sensitively when asked", () => {
  const out = log.filterEntries(filterEntries, { text: "processed", caseSensitive: true });
  assert.strictEqual(out.length, 2);
  const none = log.filterEntries(filterEntries, { text: "PROCESSED", caseSensitive: true });
  assert.strictEqual(none.length, 0);
});

test("filters by regular expression", () => {
  const out = log.filterEntries(filterEntries, { regex: "connection to \\d+" });
  assert.strictEqual(out.length, 2);
});

test("filters by severity level", () => {
  const out = log.filterEntries(filterEntries, { levels: ["error"] });
  assert.strictEqual(out.length, 3);
});

test("filters by source", () => {
  const out = log.filterEntries(filterEntries, { source: "cache" });
  assert.strictEqual(out.length, 2);
});

test("filters by time window", () => {
  const since = Date.UTC(2024, 4, 1, 10, 0, 4);
  const out = log.filterEntries(filterEntries, { since });
  assert.ok(out.length >= 3);
  assert.ok(out.every((e) => e.timestamp.epoch >= since));
});

test("combines filters with AND", () => {
  const out = log.filterEntries(filterEntries, { levels: ["error"], text: "10.0.0" });
  assert.strictEqual(out.length, 2);
});

test("returns an empty list for an invalid regex", () => {
  const out = log.filterEntries(filterEntries, { regex: "(" });
  assert.deepStrictEqual(out, []);
});

// ---------------------------------------------------------------------------
// UI query adapter (regex is a mode flag, not the pattern)
// ---------------------------------------------------------------------------

test("query filters by substring when regex mode is off", () => {
  const r = log.query(filterEntries, { text: "PROCESSED", regex: false });
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.regexValid, true);
  assert.deepStrictEqual(r.highlight, { text: "PROCESSED", regex: "", caseSensitive: false });
});

test("query applies a regular expression when regex mode is on", () => {
  const r = log.query(filterEntries, { text: "connection to \\d+", regex: true });
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.regexValid, true);
  assert.deepStrictEqual(r.highlight, { text: "", regex: "connection to \\d+", caseSensitive: false });
});

test("query reports an invalid regex and returns no matches", () => {
  const r = log.query(filterEntries, { text: "([unclosed", regex: true });
  assert.deepStrictEqual(r.entries, []);
  assert.strictEqual(r.regexValid, false);
});

test("query treats an empty pattern as no filter in either mode", () => {
  const plain = log.query(filterEntries, { text: "", regex: false });
  assert.strictEqual(plain.entries.length, filterEntries.length);
  const regex = log.query(filterEntries, { text: "", regex: true });
  assert.strictEqual(regex.entries.length, filterEntries.length);
  assert.strictEqual(regex.regexValid, true);
});

test("query combines a regex with level and source filters", () => {
  const r = log.query(filterEntries, { text: "10\\.0\\.0", regex: true, levels: ["error"] });
  assert.strictEqual(r.entries.length, 2);
  assert.ok(r.entries.every((e) => e.level === "error"));
});

test("query honours the case-sensitivity flag in regex mode", () => {
  const insensitive = log.query(filterEntries, { text: "PROCESSED", regex: true });
  const sensitive = log.query(filterEntries, { text: "PROCESSED", regex: true, caseSensitive: true });
  assert.ok(insensitive.entries.length > sensitive.entries.length);
  assert.strictEqual(sensitive.entries.length, 0);
});

test("query highlight config drives highlightRanges in both modes", () => {
  const plain = log.query(filterEntries, { text: "timed out", regex: false });
  const plainRanges = log.highlightRanges("connection timed out", plain.highlight);
  assert.deepStrictEqual(plainRanges, [[11, 20]]);

  const regex = log.query(filterEntries, { text: "timed|connection", regex: true });
  const regexRanges = log.highlightRanges("connection timed out", regex.highlight);
  assert.deepStrictEqual(regexRanges, [[0, 10], [11, 16]]);

  const invalid = log.query(filterEntries, { text: "([unclosed", regex: true });
  assert.deepStrictEqual(log.highlightRanges("anything", invalid.highlight), []);
});

// ---------------------------------------------------------------------------
// Regex safety
// ---------------------------------------------------------------------------

test("compileRegex rejects invalid patterns", () => {
  assert.strictEqual(log.compileRegex("("), null);
  assert.strictEqual(log.compileRegex(""), null);
});

test("compileRegex rejects over-long patterns", () => {
  assert.strictEqual(log.compileRegex("a".repeat(3000)), null);
});

test("compileRegex honours the case-sensitivity flag", () => {
  assert.ok(log.compileRegex("abc", true).test("ABC") === false);
  assert.ok(log.compileRegex("abc", false).test("ABC") === true);
});

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

test("highlightRanges finds every occurrence of the search text", () => {
  const ranges = log.highlightRanges("error error", { text: "error" });
  assert.deepStrictEqual(ranges, [[0, 5], [6, 11]]);
});

test("highlightRanges is case-insensitive by default", () => {
  const ranges = log.highlightRanges("ERROR", { text: "error" });
  assert.deepStrictEqual(ranges, [[0, 5]]);
});

test("highlightRanges merges overlapping matches", () => {
  const ranges = log.highlightRanges("aaaa", { regex: "aa" });
  assert.deepStrictEqual(ranges, [[0, 4]]);
});

test("highlightRanges returns nothing without a query", () => {
  assert.deepStrictEqual(log.highlightRanges("text", {}), []);
});

// ---------------------------------------------------------------------------
// Formatting & export
// ---------------------------------------------------------------------------

test("formatDuration renders sub-second and multi-unit values", () => {
  assert.strictEqual(log.formatDuration(450), "450ms");
  assert.strictEqual(log.formatDuration(1000), "1s");
  assert.strictEqual(log.formatDuration(90000), "1m 30s");
  assert.strictEqual(log.formatDuration(3723000), "1h 2m 3s");
  assert.strictEqual(log.formatDuration(90061000), "1d 1h 1m");
  assert.strictEqual(log.formatDuration(-5), "—");
});

test("formatEpoch renders a UTC label", () => {
  assert.strictEqual(log.formatEpoch(Date.UTC(2024, 4, 1, 10, 0, 0)), "2024-05-01 10:00:00Z");
  assert.strictEqual(log.formatEpoch(null), "—");
});

test("exportCSV escapes commas, quotes and newlines", () => {
  const entries = log.analyze('INFO app: said "hi, there"').entries;
  const csv = log.exportCSV(entries);
  const lines = csv.split("\n");
  assert.strictEqual(lines[0], "line,timestamp,level,source,message");
  assert.ok(lines[1].includes('"said ""hi, there"""'));
});

test("exportJSONL emits one parseable object per line", () => {
  const entries = log.analyze("2024-05-01T10:00:00Z INFO app: hi").entries;
  const out = log.exportJSONL(entries);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.level, "info");
  assert.strictEqual(parsed.source, "app");
  assert.strictEqual(parsed.message, "hi");
});

// ---------------------------------------------------------------------------
// Scale and truncation
// ---------------------------------------------------------------------------

test("analyze caps pathological input and reports truncation", () => {
  const over = log.MAX_LINES + 25;
  const lines = new Array(over);
  for (let i = 0; i < over; i++) lines[i] = "2024-05-01T10:00:00Z INFO app: line " + i;
  const res = log.analyze(lines.join("\n"));
  assert.strictEqual(res.totalLines, over);
  assert.strictEqual(res.processedLines, log.MAX_LINES);
  assert.strictEqual(res.truncated, true);
  assert.strictEqual(res.entries.length, log.MAX_LINES);
});

test("handles a large realistic dataset without error", () => {
  const n = 50000;
  const lines = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = new Date(Date.UTC(2024, 4, 1, 10, 0, 0) + i * 500).toISOString().replace(".000Z", "Z");
    lines[i] = i % 50 === 0
      ? t + " ERROR db.pool: connection to 10.0.0." + (i % 20) + " timed out"
      : t + " INFO app: processed " + i + " records";
  }
  const res = log.analyze(lines.join("\n"));
  assert.strictEqual(res.processedLines, n);
  const stats = log.summarize(res.entries, {});
  assert.strictEqual(stats.levels.error, 1000);
  assert.strictEqual(stats.levels.info, n - 1000);
  assert.strictEqual(stats.buckets.reduce((s, b) => s + b.count, 0), n);
});

// ---------------------------------------------------------------------------
// Robustness / security-oriented input
// ---------------------------------------------------------------------------

test("does not throw on adversarial input", () => {
  const nasty = [
    "{\"level\":\"error\",\"message\":\"" + "x".repeat(10000) + "\"}",
    "=".repeat(5000),
    "\u0000\u0001\u0002",
    "a=b ".repeat(500),
    "2024-05-01T10:00:00Z ".repeat(50),
    '"'.repeat(1000),
    "{{{{{{{{{{",
    "level=" + "9".repeat(5000)
  ].join("\n");
  const res = log.analyze(nasty);
  assert.strictEqual(res.totalLines, 8);
  log.summarize(res.entries, {});
});

test("escaped values in JSON messages are preserved as text", () => {
  const e = log.parseLine('{"level":"info","msg":"<script>alert(1)</script>"}', 1);
  assert.strictEqual(e.message, "<script>alert(1)</script>");
  assert.strictEqual(e.format, "json");
});

test("never evaluates embedded expressions", () => {
  const e = log.parseLine('{"level":"info","msg":"${process.exit(1)}"}', 1);
  assert.strictEqual(e.message, "${process.exit(1)}");
});
