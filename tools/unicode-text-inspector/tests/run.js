/* Toolshed Unicode & Text Inspector — tests. Run with: node tests/run.js
 * Uses Node's built-in assert and requires ../tool.js via its UMD export.
 */
"use strict";

const assert = require("node:assert");
const uni = require("../tool.js");

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

function ids(analysis) {
  return analysis.issues.map(function (i) { return i.id; });
}

console.log("unicode-text-inspector tests");

// ---------------------------------------------------------------------------
// Counting & encoding
// ---------------------------------------------------------------------------

test("counts ASCII characters and bytes", () => {
  const r = uni.analyze("abc");
  assert.strictEqual(r.summary.chars, 3);
  assert.strictEqual(r.summary.bytes, 3);
  assert.strictEqual(r.summary.utf16Units, 3);
  assert.strictEqual(r.summary.nonAscii, 0);
});

test("counts UTF-8 bytes for multi-byte characters", () => {
  const r = uni.analyze("café");
  assert.strictEqual(r.summary.chars, 4);
  assert.strictEqual(r.summary.bytes, 5); // é is 2 bytes
});

test("counts an astral character as one code point, two UTF-16 units", () => {
  const r = uni.analyze("😀"); // U+1F600
  assert.strictEqual(r.summary.chars, 1);
  assert.strictEqual(r.summary.utf16Units, 2);
  assert.strictEqual(r.summary.bytes, 4);
});

test("empty input reports zero counts and no issues", () => {
  const r = uni.analyze("");
  assert.strictEqual(r.summary.chars, 0);
  assert.strictEqual(r.summary.bytes, 0);
  assert.strictEqual(r.issues.length, 0);
  assert.strictEqual(r.risk, "none");
});

test("null and undefined input are handled as empty", () => {
  assert.strictEqual(uni.analyze(null).summary.chars, 0);
  assert.strictEqual(uni.analyze(undefined).summary.chars, 0);
});

test("non-string input is coerced", () => {
  assert.strictEqual(uni.analyze(12345).summary.chars, 5);
});

test("UTF-8 bytes are correct for a known character", () => {
  assert.strictEqual(uni.utf8HexOf(0x00e9), "C3 A9");
  assert.strictEqual(uni.utf8HexOf(0x20ac), "E2 82 AC");
  assert.strictEqual(uni.utf8HexOf(0x41), "41");
});

test("encodeUTF8 round-trips through decodeUTF8", () => {
  const s = "Grüße 😀 \u00a0";
  const bytes = uni.encodeUTF8(s);
  assert.strictEqual(uni.decodeUTF8(bytes), s);
});

test("code point iteration handles astral characters", () => {
  assert.deepStrictEqual(uni.toCodePoints("a😀b"), [0x61, 0x1f600, 0x62]);
});

test("escapeCodePoint formats BMP and astral points", () => {
  assert.strictEqual(uni.escapeCodePoint(0x41), "\\u0041");
  assert.strictEqual(uni.escapeCodePoint(0x1f600), "\\u{1F600}");
});

// ---------------------------------------------------------------------------
// Grapheme clustering
// ---------------------------------------------------------------------------

test("combining marks cluster with their base", () => {
  // e + combining acute should be one grapheme.
  assert.strictEqual(uni.countGraphemes("e\u0301"), 1);
});

test("emoji ZWJ sequence is one grapheme", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  assert.strictEqual(uni.countGraphemes(family), 1);
});

test("plain ASCII grapheme count equals character count", () => {
  assert.strictEqual(uni.countGraphemes("hello"), 5);
});

test("empty string has zero graphemes", () => {
  assert.strictEqual(uni.countGraphemes(""), 0);
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("classifies uppercase, lowercase, digit and space", () => {
  assert.strictEqual(uni.categoryOf(0x41), "Lu");
  assert.strictEqual(uni.categoryOf(0x61), "Ll");
  assert.strictEqual(uni.categoryOf(0x30), "Nd");
  assert.strictEqual(uni.categoryOf(0x20), "Zs");
});

test("classifies a control character", () => {
  assert.strictEqual(uni.categoryOf(0x0a), "Cc");
});

test("classifies a format control", () => {
  assert.strictEqual(uni.categoryOf(0x200b), "Cf");
});

test("blocks resolve correctly", () => {
  assert.strictEqual(uni.blockOf(0x41), "Basic Latin");
  assert.strictEqual(uni.blockOf(0x0430), "Cyrillic");
  assert.strictEqual(uni.blockOf(0x4e00), "CJK Unified Ideographs");
  assert.strictEqual(uni.blockOf(0x1f600), "Emoticons");
});

test("scripts resolve correctly", () => {
  assert.strictEqual(uni.scriptOf(0x41), "Latin");
  assert.strictEqual(uni.scriptOf(0x0430), "Cyrillic");
  assert.strictEqual(uni.scriptOf(0x03b1), "Greek");
  assert.strictEqual(uni.scriptOf(0x4e00), "Han");
  assert.strictEqual(uni.scriptOf(0x20), null);
});

test("names known code points", () => {
  assert.strictEqual(uni.codePointName(0x200b), "ZERO WIDTH SPACE");
  assert.strictEqual(uni.codePointName(0xfeff), "ZERO WIDTH NO-BREAK SPACE (BOM)");
  assert.strictEqual(uni.codePointName(0x20), "SPACE");
});

test("analyzeChar reports UTF-8, escapes and risk", () => {
  const c = uni.analyzeChar(0x200b, 0);
  assert.strictEqual(c.cp, 0x200b);
  assert.strictEqual(c.risk, "high");
  assert.ok(c.flags.indexOf("invisible") !== -1);
  assert.strictEqual(c.utf8, "E2 80 8B");
  assert.strictEqual(c.js, "\\u200B");
});

// ---------------------------------------------------------------------------
// Security scan
// ---------------------------------------------------------------------------

test("detects a zero-width space", () => {
  const r = uni.analyze("pay\u200bpal");
  assert.ok(ids(r).indexOf("zero-width") !== -1);
  assert.strictEqual(r.risk, "high");
});

test("detects bidi controls", () => {
  const r = uni.analyze("abc\u202edef\u202c");
  assert.ok(ids(r).indexOf("bidi") !== -1);
  assert.strictEqual(r.risk, "high");
});

test("detects a leading BOM", () => {
  const r = uni.analyze("\ufeffhello");
  assert.ok(ids(r).indexOf("bom") !== -1);
  assert.ok(ids(r).indexOf("bom-start") !== -1);
});

test("detects Cyrillic homoglyphs", () => {
  const r = uni.analyze("p\u0430ypal");
  assert.ok(ids(r).indexOf("homoglyph") !== -1);
  const issue = r.issues.find(function (i) { return i.id === "homoglyph"; });
  assert.strictEqual(issue.codePoints[0].looksLike, "a");
});

test("detects a mixed-script word", () => {
  const r = uni.analyze("pаypal");
  assert.ok(ids(r).indexOf("mixed-script") !== -1);
});

test("pure Latin and pure Cyrillic do not trigger mixed-script", () => {
  assert.strictEqual(uni.analyze("paypal").issues.length, 0);
  assert.strictEqual(uni.analyze("привет").issues.length, 0);
});

test("pure Greek text is not flagged as homoglyphs", () => {
  // These are ordinary Greek words; their letters merely resemble Latin ones.
  assert.strictEqual(uni.analyze("αβγδε").issues.length, 0);
});

test("detects hidden tag characters", () => {
  const r = uni.analyze("safe\u{e0061}\u{e0062}");
  assert.ok(ids(r).indexOf("tag") !== -1);
});

test("detects curly quotes", () => {
  const r = uni.analyze("\u201chi\u201d");
  assert.ok(ids(r).indexOf("smart-quotes") !== -1);
});

test("detects unusual spaces", () => {
  const r = uni.analyze("a\u00a0b");
  assert.ok(ids(r).indexOf("odd-space") !== -1);
});

test("detects replacement characters", () => {
  const r = uni.analyze("a\ufffdb");
  assert.ok(ids(r).indexOf("replacement-char") !== -1);
});

test("detects a lone surrogate", () => {
  const r = uni.analyze("a\ud800b");
  assert.ok(ids(r).indexOf("lone-surrogate") !== -1);
  assert.strictEqual(r.risk, "high");
});

test("detects text that is not NFC", () => {
  const r = uni.analyze("cafe\u0301");
  assert.ok(ids(r).indexOf("not-normalized") !== -1);
});

test("NFC text does not report a normalization issue", () => {
  assert.strictEqual(uni.analyze("caf\u00e9").issues.length, 0);
});

test("issues are ordered by severity", () => {
  const r = uni.analyze("\u201cx\u201d\u200b");
  const levels = r.issues.map(function (i) { return i.level; });
  const order = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < levels.length; i++) {
    assert.ok(order[levels[i]] >= order[levels[i - 1]]);
  }
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test("NFC composes a decomposed sequence", () => {
  assert.strictEqual(uni.normalize("cafe\u0301", "NFC"), "caf\u00e9");
});

test("NFD decomposes a precomposed character", () => {
  assert.strictEqual(uni.normalize("caf\u00e9", "NFD"), "cafe\u0301");
});

test("NFKC folds compatibility characters", () => {
  assert.strictEqual(uni.normalize("\uff21", "NFKC"), "A"); // fullwidth A
});

test("an unknown normalization form falls back to NFC", () => {
  assert.strictEqual(uni.normalize("cafe\u0301", "XYZ"), "caf\u00e9");
});

test("normalized text compares equal to its precomposed form", () => {
  assert.strictEqual(uni.normalize("cafe\u0301", "NFC") === "caf\u00e9", true);
});

// ---------------------------------------------------------------------------
// Escape conversion
// ---------------------------------------------------------------------------

test("decodes hex HTML entities", () => {
  assert.strictEqual(uni.decodeEscapes("caf&#xE9;", "html"), "caf\u00e9");
});

test("decodes decimal HTML entities", () => {
  assert.strictEqual(uni.decodeEscapes("caf&#233;", "html"), "caf\u00e9");
});

test("decodes named HTML entities", () => {
  assert.strictEqual(uni.decodeEscapes("a &amp; b &lt;c&gt;", "html"), "a & b <c>");
});

test("leaves unknown named entities untouched", () => {
  assert.strictEqual(uni.decodeEscapes("&notanentity;", "html"), "&notanentity;");
});

test("decodes JavaScript \\uXXXX escapes", () => {
  assert.strictEqual(uni.decodeEscapes("caf\\u00E9", "js"), "caf\u00e9");
});

test("decodes JavaScript \\u{...} escapes", () => {
  assert.strictEqual(uni.decodeEscapes("\\u{1F600}", "js"), "\u{1F600}");
});

test("decodes URL percent-encoding as UTF-8", () => {
  assert.strictEqual(uni.decodeEscapes("caf%C3%A9", "percent"), "caf\u00e9");
  assert.strictEqual(uni.decodeEscapes("a%20b", "percent"), "a b");
});

test("decodes CSS escapes", () => {
  assert.strictEqual(uni.decodeEscapes("\\E9", "css"), "\u00e9");
});

test("decodes a JSON string", () => {
  assert.strictEqual(uni.decodeEscapes('"a\\nb"', "json"), "a\nb");
});

test("auto decoding resolves nested escapes", () => {
  // HTML entity producing a JS escape producing a character.
  assert.strictEqual(uni.decodeEscapes("&#92;u0041", "auto"), "A");
});

test("malformed escapes are left alone", () => {
  assert.strictEqual(uni.decodeEscapes("\\uZZZZ", "js"), "\\uZZZZ");
  assert.strictEqual(uni.decodeEscapes("&;#x;", "html"), "&;#x;");
});

test("encodes JavaScript escapes for non-ASCII", () => {
  assert.strictEqual(uni.encodeEscapes("caf\u00e9", "js"), "caf\\u00E9");
});

test("encodes HTML entities for non-ASCII", () => {
  assert.strictEqual(uni.encodeEscapes("caf\u00e9", "html"), "caf&#xE9;");
});

test("encodes URL percent-encoding", () => {
  assert.strictEqual(uni.encodeEscapes("caf\u00e9", "percent"), "caf%C3%A9");
});

test("encode/decode round-trips in every format", () => {
  const s = "Grüße — 😀";
  ["js", "css", "html", "percent"].forEach(function (fmt) {
    const encoded = uni.encodeEscapes(s, fmt);
    const decoded = uni.decodeEscapes(encoded, fmt);
    assert.strictEqual(decoded, s, fmt + " round-trip");
  });
});

test("codepoints encoding lists U+ values", () => {
  assert.strictEqual(uni.encodeEscapes("AB", "codepoints"), "U+0041 U+0042");
});

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

test("removes zero-width, bidi and BOM characters", () => {
  assert.strictEqual(uni.removeInvisible("a\u200bb\u202ec\ufeffd"), "abcd");
});

test("removes soft hyphen and tag characters", () => {
  assert.strictEqual(uni.removeInvisible("a\u00adb\u{e0061}c"), "abc");
});

test("replaceOddSpaces turns unusual spaces into U+0020", () => {
  assert.strictEqual(uni.replaceOddSpaces("a\u00a0b\u2003c"), "a b c");
});

test("replaceSmartQuotes straightens quotes and dashes", () => {
  assert.strictEqual(uni.replaceSmartQuotes("\u201chi\u201d \u2014 ok\u2026"), "\"hi\" - ok...");
});

test("sanitize applies the requested transforms", () => {
  const out = uni.sanitize("cafe\u0301\u200b\u00a0\u201cx\u201d", {
    replaceSpaces: true,
    replaceQuotes: true,
    normalize: true
  });
  assert.strictEqual(out, "caf\u00e9 \"x\"");
});

test("sanitize leaves text unchanged when no options are set beyond invisible removal", () => {
  assert.strictEqual(uni.sanitize("hello"), "hello");
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

test("exportCSV produces a header and one row per character", () => {
  const r = uni.analyze("ab");
  const lines = uni.exportCSV(r).trim().split("\n");
  assert.strictEqual(lines.length, 3); // header + 2
  assert.ok(lines[0].startsWith("index,code_point,char,name"));
});

test("exportCSV quotes fields that contain a comma", () => {
  // U+002C's name is ASCII ',' — the comma inside it must be quoted.
  const r = uni.analyze(",");
  const csv = uni.exportCSV(r);
  assert.ok(csv.indexOf('"ASCII \',\'"') !== -1);
});

test("exportJSON is valid JSON with the expected shape", () => {
  const r = uni.analyze("p\u0430ypal\u200b");
  const parsed = JSON.parse(uni.exportJSON(r));
  assert.strictEqual(parsed.risk, "high");
  assert.ok(Array.isArray(parsed.characters));
  assert.ok(parsed.issues.length >= 1);
  assert.strictEqual(parsed.characters[1].confusableWith, "a");
});

// ---------------------------------------------------------------------------
// Limits & adversarial input
// ---------------------------------------------------------------------------

test("detail table is capped on very large input", () => {
  const big = "a".repeat(25000);
  const r = uni.analyze(big);
  assert.strictEqual(r.summary.chars, 25000);
  assert.strictEqual(r.chars.length, uni.MAX_DETAIL_CHARS);
  assert.strictEqual(r.detailTruncated, true);
});

test("a custom maxDetail option is respected", () => {
  const r = uni.analyze("abcdef", { maxDetail: 3 });
  assert.strictEqual(r.chars.length, 3);
  assert.strictEqual(r.detailTruncated, true);
});

test("control characters do not throw", () => {
  const r = uni.analyze("a\u0000b\u0007c\u001b[31m");
  assert.strictEqual(r.summary.chars, 10);
});

test("a lone surrogate does not throw during analysis or export", () => {
  const r = uni.analyze("\ud800");
  uni.exportCSV(r);
  uni.exportJSON(r);
});

test("long input with mixed issues analyzes without throwing", () => {
  const nasty = [
    "\u200b".repeat(1000),
    "\u202e".repeat(500),
    "\ud800".repeat(50),
    "&#x41;".repeat(500),
    "\\u0041".repeat(500),
    "%C3%A9".repeat(500)
  ].join("\n");
  const r = uni.analyze(nasty);
  uni.exportCSV(r);
  uni.exportJSON(r);
  assert.ok(r.summary.chars > 0);
});

test("escape decoding terminates on deeply nested input", () => {
  // Repeated HTML-encoding of an ampersand must not loop forever.
  let s = "&amp;";
  for (let i = 0; i < 20; i++) s = s.replace(/&/g, "&amp;");
  const out = uni.decodeEscapes(s, "auto");
  assert.strictEqual(typeof out, "string");
});

test("text is never evaluated as code", () => {
  const r = uni.analyze("${process.exit(1)} <script>alert(1)</script>");
  assert.ok(r.text.indexOf("${process.exit(1)}") !== -1);
  assert.strictEqual(uni.decodeEscapes("&#x3C;script&#x3E;", "html"), "<script>");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
if (failed > 0) {
  console.error(passed + " passed, " + failed + " failed");
  process.exit(1);
}
console.log(passed + " passed");
