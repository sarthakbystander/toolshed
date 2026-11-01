/* Toolshed Subtitle Studio — tests. Run with: node tests/run.js
 * Uses Node's built-in assert and requires ../tool.js via its UMD export.
 */
"use strict";

const assert = require("node:assert");
const lib = require("../tool.js");

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

console.log("subtitle-studio tests");

// ---------------------------------------------------------------------------
// Timecodes
// ---------------------------------------------------------------------------

test("parses an SRT timestamp with comma milliseconds", () => {
  assert.strictEqual(lib.parseTimestamp("00:00:01,500"), 1500);
});

test("parses a VTT timestamp with dot milliseconds", () => {
  assert.strictEqual(lib.parseTimestamp("00:01:02.250"), 62250);
});

test("parses a timestamp without milliseconds", () => {
  assert.strictEqual(lib.parseTimestamp("01:02:03"), 3723000);
});

test("parses an MM:SS timestamp", () => {
  assert.strictEqual(lib.parseTimestamp("02:03"), 123000);
});

test("parses a timestamp with a single-digit hour", () => {
  assert.strictEqual(lib.parseTimestamp("1:02:03,004"), 3723004);
});

test("parses a negative timestamp", () => {
  assert.strictEqual(lib.parseTimestamp("-00:00:02,000"), -2000);
});

test("rejects a timestamp with an out-of-range minute or second", () => {
  assert.strictEqual(lib.parseTimestamp("00:99:00,000"), null);
  assert.strictEqual(lib.parseTimestamp("00:00:99,000"), null);
});

test("rejects non-timecode input", () => {
  assert.strictEqual(lib.parseTimestamp("hello"), null);
  assert.strictEqual(lib.parseTimestamp(""), null);
  assert.strictEqual(lib.parseTimestamp(null), null);
  assert.strictEqual(lib.parseTimestamp(1500), null);
});

test("formats an SRT timestamp with comma and hours", () => {
  assert.strictEqual(lib.formatTimestamp(1500, "srt"), "00:00:01,500");
});

test("formats a VTT timestamp with a dot", () => {
  assert.strictEqual(lib.formatTimestamp(62250, "vtt"), "00:01:02.250");
});

test("formats hours beyond 99 correctly", () => {
  assert.strictEqual(lib.formatTimestamp(360000000, "srt"), "100:00:00,000");
});

test("formats a negative timestamp with a leading sign", () => {
  assert.strictEqual(lib.formatTimestamp(-1500, "srt"), "-00:00:01,500");
});

test("round-trips a timestamp through parse and format", () => {
  const values = [0, 1, 999, 1000, 59999, 3600000, 86399999];
  for (const v of values) {
    assert.strictEqual(lib.parseTimestamp(lib.formatTimestamp(v, "srt")), v);
    assert.strictEqual(lib.parseTimestamp(lib.formatTimestamp(v, "vtt")), v);
  }
});

test("formats durations in ms, seconds and minutes", () => {
  assert.strictEqual(lib.formatDuration(500), "500 ms");
  assert.strictEqual(lib.formatDuration(2000), "2 s");
  assert.strictEqual(lib.formatDuration(90000), "1m 30s");
});

// ---------------------------------------------------------------------------
// Format detection and SRT parsing
// ---------------------------------------------------------------------------

const SRT_SAMPLE = [
  "1",
  "00:00:01,000 --> 00:00:04,000",
  "Hello there.",
  "",
  "2",
  "00:00:05,000 --> 00:00:08,500",
  "General Kenobi.",
  "You are a bold one.",
  ""
].join("\n");

test("detects SRT", () => {
  assert.strictEqual(lib.detectFormat(SRT_SAMPLE), "srt");
});

test("detects VTT", () => {
  assert.strictEqual(lib.detectFormat("WEBVTT\n\n00:00.000 --> 00:02.000\nhi"), "vtt");
});

test("reports unknown for text without timecodes", () => {
  assert.strictEqual(lib.detectFormat("just some words"), "unknown");
});

test("parses SRT cues with indices and multi-line text", () => {
  const parsed = lib.parseSubtitle(SRT_SAMPLE);
  assert.strictEqual(parsed.format, "srt");
  assert.strictEqual(parsed.cues.length, 2);
  assert.strictEqual(parsed.cues[0].start, 1000);
  assert.strictEqual(parsed.cues[0].end, 4000);
  assert.strictEqual(parsed.cues[0].text, "Hello there.");
  assert.strictEqual(parsed.cues[1].text, "General Kenobi.\nYou are a bold one.");
  assert.strictEqual(parsed.errors.length, 0);
});

test("tolerates CRLF line endings and a BOM", () => {
  const text = "\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n";
  const parsed = lib.parseSubtitle(text);
  assert.strictEqual(parsed.cues.length, 1);
  assert.strictEqual(parsed.cues[0].text, "Hi");
});

test("skips blocks without a timecode line and records an error", () => {
  const text = "1\n00:00:01,000 --> 00:00:02,000\nok\n\nnot a cue at all\n\n2\n00:00:03,000 --> 00:00:04,000\nfine";
  const parsed = lib.parseSubtitle(text);
  assert.strictEqual(parsed.cues.length, 2);
  assert.strictEqual(parsed.errors.length, 1);
});

test("parses a cue with no numeric index line", () => {
  const text = "00:00:01,000 --> 00:00:02,000\nno index";
  const parsed = lib.parseSubtitle(text);
  assert.strictEqual(parsed.cues.length, 1);
  assert.strictEqual(parsed.cues[0].text, "no index");
});

test("returns no cues for empty input", () => {
  assert.strictEqual(lib.parseSubtitle("").cues.length, 0);
  assert.strictEqual(lib.parseSubtitle("   \n\n  ").cues.length, 0);
});

// ---------------------------------------------------------------------------
// VTT parsing
// ---------------------------------------------------------------------------

const VTT_SAMPLE = [
  "WEBVTT - Test file",
  "",
  "NOTE This is a comment",
  "",
  "STYLE",
  "::cue { color: yellow }",
  "",
  "intro",
  "00:00:01.000 --> 00:00:04.000 align:start",
  "Hello.",
  "",
  "00:00:05.000 --> 00:00:08.000",
  "World."
].join("\n");

test("parses VTT with header, NOTE, STYLE, cue id and settings", () => {
  const parsed = lib.parseSubtitle(VTT_SAMPLE);
  assert.strictEqual(parsed.format, "vtt");
  assert.strictEqual(parsed.header, "WEBVTT - Test file");
  assert.strictEqual(parsed.cues.length, 2);
  assert.strictEqual(parsed.cues[0].cueId, "intro");
  assert.strictEqual(parsed.cues[0].settings, "align:start");
  assert.strictEqual(parsed.cues[1].text, "World.");
  assert.strictEqual(parsed.extras.length, 2);
});

test("force-parses a VTT body as SRT when requested", () => {
  const parsed = lib.parseSubtitle(SRT_SAMPLE, "vtt");
  assert.strictEqual(parsed.format, "vtt");
  assert.strictEqual(parsed.cues.length, 2);
});

test("parses a timecode line and separates trailing settings", () => {
  const t = lib.parseTimecodeLine("00:00:01,000 --> 00:00:04,000 line:90% position:50%");
  assert.strictEqual(t.start, 1000);
  assert.strictEqual(t.end, 4000);
  assert.strictEqual(t.settings, "line:90% position:50%");
});

test("returns null for a malformed timecode line", () => {
  assert.strictEqual(lib.parseTimecodeLine("00:00:01,000 00:00:04,000"), null);
});

// ---------------------------------------------------------------------------
// Tag stripping and text helpers
// ---------------------------------------------------------------------------

test("strips HTML-ish tags but keeps the text", () => {
  assert.strictEqual(lib.stripTags("<i>Hello</i> <b>there</b>"), "Hello there");
});

test("strips font tags with attributes", () => {
  assert.strictEqual(lib.stripTags('<font color="#fff">Hi</font>'), "Hi");
});

test("strips ASS override blocks", () => {
  assert.strictEqual(lib.stripTags("{\\an8}Top line"), "Top line");
});

test("strips WebVTT timestamp tags", () => {
  assert.strictEqual(lib.stripTags("Hi <00:00:02.000>there"), "Hi there");
});

test("decodes HTML entities after removing tags", () => {
  assert.strictEqual(lib.stripTags("Tom &amp; Jerry &lt;3"), "Tom & Jerry <3");
});

test("does not treat decoded entities as tags", () => {
  assert.strictEqual(lib.stripTags("&lt;b&gt;not bold&lt;/b&gt;"), "<b>not bold</b>");
});

test("counts characters without counting newlines", () => {
  assert.strictEqual(lib.countChars("ab\ncd"), 4);
});

test("counts words across whitespace", () => {
  assert.strictEqual(lib.countWords("  one   two\nthree "), 3);
  assert.strictEqual(lib.countWords("   "), 0);
});

test("computes reading speed", () => {
  const speed = lib.readingSpeed({ start: 0, end: 2000, text: "abcdefghij" });
  assert.strictEqual(speed.chars, 10);
  assert.strictEqual(speed.cps, 5);
});

test("reading speed is null for a zero-length cue", () => {
  assert.strictEqual(lib.readingSpeed({ start: 1000, end: 1000, text: "x" }), null);
});

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

const CUES = lib.parseSubtitle(SRT_SAMPLE).cues;

test("shiftCues moves every cue by the offset", () => {
  const shifted = lib.shiftCues(CUES, 2500);
  assert.strictEqual(shifted[0].start, 3500);
  assert.strictEqual(shifted[0].end, 6500);
  assert.strictEqual(shifted[1].start, 7500);
});

test("shiftCues does not mutate the input", () => {
  lib.shiftCues(CUES, 1000);
  assert.strictEqual(CUES[0].start, 1000);
});

test("scaleCues stretches around the first cue", () => {
  const scaled = lib.scaleCues(CUES, 2);
  assert.strictEqual(scaled[0].start, 1000);
  assert.strictEqual(scaled[0].end, 7000);
  assert.strictEqual(scaled[1].start, 9000);
});

test("scaleCues compresses around an explicit anchor", () => {
  const scaled = lib.scaleCues(CUES, 0.5, 0);
  assert.strictEqual(scaled[0].start, 500);
  assert.strictEqual(scaled[1].start, 2500);
});

test("fixOverlaps removes an overlap and reports the change", () => {
  const overlapping = [
    { id: "a", start: 0, end: 5000, text: "one" },
    { id: "b", start: 3000, end: 6000, text: "two" }
  ];
  const result = lib.fixOverlaps(overlapping, 0);
  assert.strictEqual(result.changed, 1);
  assert.strictEqual(result.cues[1].start, 5000);
});

test("fixOverlaps enforces a minimum gap", () => {
  const tight = [
    { id: "a", start: 0, end: 1000, text: "one" },
    { id: "b", start: 1000, end: 2000, text: "two" }
  ];
  const result = lib.fixOverlaps(tight, 200);
  assert.strictEqual(result.cues[1].start, 1200);
});

test("applyTimingRules enforces a minimum duration", () => {
  const tiny = [{ id: "a", start: 1000, end: 1100, text: "x" }];
  const result = lib.applyTimingRules(tiny, { minDurationMs: 800 });
  assert.strictEqual(result.cues[0].end, 1800);
});

test("applyTimingRules clamps negative times", () => {
  const negative = [{ id: "a", start: -500, end: 1000, text: "x" }];
  const result = lib.applyTimingRules(negative, {});
  assert.strictEqual(result.cues[0].start, 0);
});

test("applyTimingRules sorts cues by start", () => {
  const unordered = [
    { id: "b", start: 5000, end: 6000, text: "two" },
    { id: "a", start: 1000, end: 2000, text: "one" }
  ];
  const result = lib.applyTimingRules(unordered, {});
  assert.strictEqual(result.cues[0].id, "a");
  assert.strictEqual(result.cues[1].id, "b");
});

test("setCueTime updates only the target cue", () => {
  const updated = lib.setCueTime(CUES, CUES[0].id, 2000, 3000);
  assert.strictEqual(updated[0].start, 2000);
  assert.strictEqual(updated[1].start, CUES[1].start);
});

test("updateCueText replaces the text of one cue", () => {
  const updated = lib.updateCueText(CUES, CUES[1].id, "Changed");
  assert.strictEqual(updated[1].text, "Changed");
  assert.strictEqual(updated[0].text, CUES[0].text);
});

test("deleteCue removes the cue and reindexes", () => {
  const remaining = lib.reindex(lib.deleteCue(CUES, CUES[0].id));
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].index, 1);
});

test("nudgeCue adjusts both edges independently", () => {
  const nudged = lib.nudgeCue(CUES, CUES[0].id, 500, -500);
  assert.strictEqual(nudged[0].start, CUES[0].start + 500);
  assert.strictEqual(nudged[0].end, CUES[0].end - 500);
});

// ---------------------------------------------------------------------------
// Find and replace
// ---------------------------------------------------------------------------

test("literal replacement is case-insensitive by default", () => {
  const cues = [{ id: "a", start: 0, end: 1000, text: "Hello hello" }];
  const result = lib.replaceInCues(cues, "hello", "hi");
  assert.strictEqual(result.cues[0].text, "hi hi");
  assert.strictEqual(result.count, 2);
});

test("case-sensitive replacement honours the flag", () => {
  const cues = [{ id: "a", start: 0, end: 1000, text: "Hello hello" }];
  const result = lib.replaceInCues(cues, "hello", "hi", { caseSensitive: true });
  assert.strictEqual(result.cues[0].text, "Hello hi");
  assert.strictEqual(result.count, 1);
});

test("regex replacement works and reports a count", () => {
  const cues = [{ id: "a", start: 0, end: 1000, text: "run 12 and 34" }];
  const result = lib.replaceInCues(cues, "\\d+", "N", { regex: true });
  assert.strictEqual(result.cues[0].text, "run N and N");
  assert.strictEqual(result.count, 2);
});

test("an invalid regular expression is reported, not thrown", () => {
  const cues = [{ id: "a", start: 0, end: 1000, text: "x" }];
  const result = lib.replaceInCues(cues, "(", "y", { regex: true });
  assert.ok(result.error);
  assert.strictEqual(result.cues[0].text, "x");
  // The UI adds its own "Invalid regular expression:" prefix, so the library
  // must return the engine message alone rather than doubling the prefix.
  assert.ok(!/^Invalid regular expression: Invalid/.test(result.error),
    "error message should not repeat the prefix: " + result.error);
});

test("whole-word replacement does not match inside a word", () => {
  const cues = [{ id: "a", start: 0, end: 1000, text: "cat category cat" }];
  const result = lib.replaceInCues(cues, "cat", "dog", { wholeWord: true });
  assert.strictEqual(result.cues[0].text, "dog category dog");
});

test("an empty find string changes nothing", () => {
  const cues = [{ id: "a", start: 0, end: 1000, text: "x" }];
  assert.strictEqual(lib.replaceInCues(cues, "", "y").count, 0);
});

test("regex replacement expands capture groups and special tokens", () => {
  const cues = [{ id: "a", start: 0, end: 1000, text: "name: Ada, name: Grace" }];
  const groups = lib.replaceInCues(cues, "name: (\\w+)", "[$1]", { regex: true });
  assert.strictEqual(groups.cues[0].text, "[Ada], [Grace]");
  assert.strictEqual(groups.count, 2);

  const whole = lib.replaceInCues(
    [{ id: "b", start: 0, end: 1000, text: "run" }], "r", "<$&>", { regex: true });
  assert.strictEqual(whole.cues[0].text, "<r>un");

  // A missing group becomes an empty string, not the literal "$2".
  const missing = lib.replaceInCues(
    [{ id: "c", start: 0, end: 1000, text: "ab" }], "(a)(b)?", "$1$2!", { regex: true });
  assert.strictEqual(missing.cues[0].text, "ab!");
});

test("literal replacement leaves dollar signs alone", () => {
  const cues = [{ id: "a", start: 0, end: 1000, text: "price" }];
  const result = lib.replaceInCues(cues, "price", "$5.00");
  assert.strictEqual(result.cues[0].text, "$5.00");
  assert.strictEqual(result.count, 1);
});

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

test("wrapText breaks a long line at the character limit", () => {
  const wrapped = lib.wrapText("the quick brown fox jumps over the lazy dog", 20, 3);
  for (const line of wrapped.split("\n")) assert.ok(line.length <= 20, line);
});

test("wrapText collapses to the line limit", () => {
  const wrapped = lib.wrapText("one two three four five six seven eight nine ten", 10, 2);
  assert.strictEqual(wrapped.split("\n").length, 2);
});

test("wrapText strips tags before wrapping", () => {
  assert.strictEqual(lib.wrapText("<i>Hi there</i>", 40, 2), "Hi there");
});

test("wrapText handles an empty string", () => {
  assert.strictEqual(lib.wrapText("", 40, 2), "");
});

test("rewrapCues reports how many cues changed", () => {
  const cues = [{ id: "a", start: 0, end: 1000, text: "a very long line that must wrap somewhere sensible" }];
  const result = lib.rewrapCues(cues, 20, 2);
  assert.strictEqual(result.changed, 1);
  assert.ok(result.cues[0].text.includes("\n"));
});

// ---------------------------------------------------------------------------
// Split and merge
// ---------------------------------------------------------------------------

test("splitCue divides a cue at a given time", () => {
  const cues = [{ id: "a", index: 1, start: 0, end: 4000, text: "one two three four" }];
  const result = lib.splitCue(cues, "a", 2000);
  assert.strictEqual(result.split, true);
  assert.strictEqual(result.cues.length, 2);
  assert.strictEqual(result.cues[0].end, 2000);
  assert.strictEqual(result.cues[1].start, 2000);
  assert.notStrictEqual(result.cues[0].id, result.cues[1].id);
});

test("splitCue ignores a time outside the cue", () => {
  const cues = [{ id: "a", start: 0, end: 4000, text: "x" }];
  const result = lib.splitCue(cues, "a", 9000);
  assert.strictEqual(result.split, false);
  assert.strictEqual(result.cues.length, 1);
});

test("splitCue splits multi-line text by line", () => {
  const cues = [{ id: "a", start: 0, end: 4000, text: "line one\nline two" }];
  const result = lib.splitCue(cues, "a", 2000);
  assert.strictEqual(result.cues[0].text, "line one");
  assert.strictEqual(result.cues[1].text, "line two");
});

test("mergeCues joins two cues and spans their times", () => {
  const cues = [
    { id: "a", index: 1, start: 0, end: 1000, text: "one" },
    { id: "b", index: 2, start: 2000, end: 3000, text: "two" }
  ];
  const result = lib.mergeCues(cues, "a", "b");
  assert.strictEqual(result.merged, true);
  assert.strictEqual(result.cues.length, 1);
  assert.strictEqual(result.cues[0].start, 0);
  assert.strictEqual(result.cues[0].end, 3000);
  assert.strictEqual(result.cues[0].text, "one\ntwo");
});

test("mergeCues returns unchanged cues for an unknown id", () => {
  const cues = [{ id: "a", start: 0, end: 1000, text: "one" }];
  const result = lib.mergeCues(cues, "a", "zzz");
  assert.strictEqual(result.merged, false);
  assert.strictEqual(result.cues.length, 1);
});

// ---------------------------------------------------------------------------
// QA validation
// ---------------------------------------------------------------------------

test("validate reports an overlap as an error", () => {
  const cues = [
    { id: "a", start: 0, end: 5000, text: "one" },
    { id: "b", start: 3000, end: 6000, text: "two" }
  ];
  const report = lib.validate(cues);
  assert.ok(report.errors >= 1);
  assert.ok(report.issues.some((i) => i.type === "overlap"));
});

test("validate reports a zero-length cue", () => {
  const report = lib.validate([{ id: "a", start: 1000, end: 1000, text: "x" }]);
  assert.ok(report.issues.some((i) => i.type === "duration"));
});

test("validate flags reading speed above the limit", () => {
  const report = lib.validate([{ id: "a", start: 0, end: 1000, text: "x".repeat(100) }], { maxCps: 10 });
  assert.ok(report.issues.some((i) => i.type === "cps"));
});

test("validate flags too many lines and long lines", () => {
  const report = lib.validate(
    [{ id: "a", start: 0, end: 5000, text: "aaaa\nbbbb\ncccc\ndddd" }],
    { maxLines: 2, maxLineChars: 3 }
  );
  assert.ok(report.issues.some((i) => i.type === "lines"));
  assert.ok(report.issues.some((i) => i.type === "line-length"));
});

test("validate flags an empty cue", () => {
  const report = lib.validate([{ id: "a", start: 0, end: 2000, text: "<i></i>" }]);
  assert.ok(report.issues.some((i) => i.type === "empty"));
});

test("validate reports a clean file with no issues", () => {
  const cues = [
    { id: "a", start: 0, end: 2000, text: "Hello there." },
    { id: "b", start: 2500, end: 4500, text: "General Kenobi." }
  ];
  const report = lib.validate(cues, { maxCps: 40 });
  assert.strictEqual(report.clean, true);
  assert.strictEqual(report.errors, 0);
});

test("validate reports a short gap when a minimum is set", () => {
  const cues = [
    { id: "a", start: 0, end: 1000, text: "one" },
    { id: "b", start: 1050, end: 3000, text: "two" }
  ];
  const report = lib.validate(cues, { minGapMs: 200 });
  assert.ok(report.issues.some((i) => i.type === "gap"));
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

test("stats summarises a cue list", () => {
  const s = lib.stats(CUES);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.minStart, 1000);
  assert.strictEqual(s.maxEnd, 8500);
  assert.strictEqual(s.spanMs, 7500);
  assert.ok(s.words >= 6);
});

test("stats on an empty list is all zeros", () => {
  const s = lib.stats([]);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.words, 0);
  assert.strictEqual(s.avgCps, 0);
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

test("toSRT writes a well-formed file with sequential indices", () => {
  const out = lib.toSRT(CUES);
  assert.ok(out.startsWith("1\n00:00:01,000 --> 00:00:04,000\nHello there."));
  assert.ok(out.includes("\n\n2\n00:00:05,000 --> 00:00:08,500\n"));
  assert.ok(out.endsWith("\n"));
});

test("toSRT clamps negative times to zero", () => {
  const out = lib.toSRT([{ start: -1000, end: -500, text: "x" }]);
  assert.ok(out.includes("00:00:00,000 --> 00:00:00,000"));
});

test("toVTT writes a header and dot-separated timecodes", () => {
  const out = lib.toVTT(CUES);
  assert.ok(out.startsWith("WEBVTT\n"));
  assert.ok(out.includes("00:00:01.000 --> 00:00:04.000"));
});

test("toVTT can include cue ids and preserves settings", () => {
  const cues = [{ id: "a", cueId: "intro", start: 0, end: 2000, settings: "align:start", text: "hi" }];
  const out = lib.toVTT(cues, { includeIds: true });
  assert.ok(out.includes("intro\n00:00:00.000 --> 00:00:02.000 align:start"));
});

test("toTXT writes plain text with optional timecodes", () => {
  const plain = lib.toTXT(CUES);
  assert.ok(plain.includes("Hello there."));
  assert.ok(!plain.includes("-->"));
  const timed = lib.toTXT(CUES, { withTimecodes: true });
  assert.ok(timed.includes("-->"));
});

test("toCSV quotes commas and newlines in text", () => {
  const out = lib.toCSV([{ start: 0, end: 1000, text: "a, b\nc" }]);
  assert.ok(out.startsWith("index,start,end,duration_ms,chars,cps,text"));
  assert.ok(out.includes("\"a, b c\""));
});

test("SRT round-trips through parse and export", () => {
  const parsed = lib.parseSubtitle(SRT_SAMPLE);
  const exported = lib.toSRT(parsed.cues);
  const reparsed = lib.parseSubtitle(exported);
  assert.strictEqual(reparsed.cues.length, parsed.cues.length);
  assert.deepStrictEqual(reparsed.cues.map((c) => c.start), parsed.cues.map((c) => c.start));
  assert.deepStrictEqual(reparsed.cues.map((c) => c.text), parsed.cues.map((c) => c.text));
});

test("VTT round-trips through parse and export", () => {
  const parsed = lib.parseSubtitle(VTT_SAMPLE);
  const exported = lib.toVTT(parsed.cues, { includeIds: true });
  const reparsed = lib.parseSubtitle(exported);
  assert.strictEqual(reparsed.cues.length, parsed.cues.length);
  assert.deepStrictEqual(reparsed.cues.map((c) => c.text), parsed.cues.map((c) => c.text));
});

// ---------------------------------------------------------------------------
// Integration: a realistic edit pipeline
// ---------------------------------------------------------------------------

test("a realistic pipeline: shift, fix overlaps, rewrap, validate and export", () => {
  const messy = [
    "1",
    "00:00:00,500 --> 00:00:01,000",
    "a very long line that clearly needs to be wrapped somewhere",
    "",
    "2",
    "00:00:00,900 --> 00:00:03,000",
    "<i>overlapping</i>",
    ""
  ].join("\n");

  const parsed = lib.parseSubtitle(messy);
  assert.strictEqual(parsed.cues.length, 2);

  let cues = lib.shiftCues(parsed.cues, 1000);
  cues = lib.fixOverlaps(cues, 100).cues;
  cues = lib.rewrapCues(cues, 20, 2).cues;
  cues = lib.stripTagsInCues(cues).cues;
  cues = lib.reindex(cues);

  const report = lib.validate(cues, { maxCps: 60 });
  assert.strictEqual(report.errors, 0);

  const out = lib.toSRT(cues);
  const reparsed = lib.parseSubtitle(out);
  assert.strictEqual(reparsed.cues.length, 2);
  assert.strictEqual(reparsed.cues[0].start, 1500);
  assert.ok(!reparsed.cues[1].text.includes("<i>"));
  // The long line was wrapped across at most two lines, balanced rather than
  // dumped onto the last line.
  const wrappedLines = reparsed.cues[0].text.split("\n");
  assert.ok(wrappedLines.length <= 2, "expected at most two lines");
  const longest = Math.max(...wrappedLines.map((l) => l.length));
  const shortest = Math.min(...wrappedLines.map((l) => l.length));
  assert.ok(longest - shortest <= 6, "expected balanced lines, got " + JSON.stringify(wrappedLines));
});

test("handles a file with 2000 cues without error", () => {
  const blocks = [];
  for (let i = 0; i < 2000; i++) {
    blocks.push(
      String(i + 1) + "\n" +
      lib.formatTimestamp(i * 3000, "srt") + " --> " + lib.formatTimestamp(i * 3000 + 2000, "srt") + "\n" +
      "Cue number " + (i + 1)
    );
  }
  const parsed = lib.parseSubtitle(blocks.join("\n\n"));
  assert.strictEqual(parsed.cues.length, 2000);
  assert.strictEqual(lib.validate(parsed.cues).errors, 0);
  assert.strictEqual(lib.stats(parsed.cues).count, 2000);
});

console.log("");
console.log(passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
