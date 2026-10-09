"use strict";

/**
 * Text Case Lab — test suite.
 *
 * Run directly (node tools/text-case-lab/tests/run.js) or through the
 * repository runner (npm run test:tools). The library is required exactly as
 * the browser loads it, so these tests exercise the same code path the page
 * uses.
 */

const assert = require("node:assert");
const lib = require("../tool.js");

let passed = 0;
let failed = 0;

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Word splitting
// ---------------------------------------------------------------------------

test("splits camelCase and PascalCase boundaries", () => {
  assert.deepStrictEqual(lib.splitWords("userProfileId"), ["user", "Profile", "Id"]);
  assert.deepStrictEqual(lib.splitWords("UserProfileId"), ["User", "Profile", "Id"]);
});

test("splits acronym boundaries without losing letters", () => {
  assert.deepStrictEqual(lib.splitWords("getHTTPResponseCode"), ["get", "HTTP", "Response", "Code"]);
  assert.deepStrictEqual(lib.splitWords("parseJSONData"), ["parse", "JSON", "Data"]);
});

test("splits on separators and collapses runs of them", () => {
  assert.deepStrictEqual(lib.splitWords("user__profile--id"), ["user", "profile", "id"]);
  assert.deepStrictEqual(lib.splitWords("a.b/c\\d"), ["a", "b", "c", "d"]);
});

test("splits letters from trailing digits", () => {
  assert.deepStrictEqual(lib.splitWords("user2"), ["user", "2"]);
  assert.deepStrictEqual(lib.splitWords("utf8String"), ["utf", "8", "String"]);
});

test("keeps apostrophes inside a word instead of splitting", () => {
  assert.deepStrictEqual(lib.splitWords("don't stop"), ["dont", "stop"]);
  assert.deepStrictEqual(lib.splitWords("it\u2019s fine"), ["its", "fine"]);
});

test("empty and separator-only input yields no words", () => {
  assert.deepStrictEqual(lib.splitWords(""), []);
  assert.deepStrictEqual(lib.splitWords("___"), []);
  assert.deepStrictEqual(lib.splitWords("   "), []);
  assert.deepStrictEqual(lib.splitWords(null), []);
});

// ---------------------------------------------------------------------------
// Conversion — wordlist cases
// ---------------------------------------------------------------------------

test("converts a phrase into each wordlist case", () => {
  const input = "hello world example";
  assert.strictEqual(lib.convertTo(input, "camel"), "helloWorldExample");
  assert.strictEqual(lib.convertTo(input, "pascal"), "HelloWorldExample");
  assert.strictEqual(lib.convertTo(input, "snake"), "hello_world_example");
  assert.strictEqual(lib.convertTo(input, "constant"), "HELLO_WORLD_EXAMPLE");
  assert.strictEqual(lib.convertTo(input, "kebab"), "hello-world-example");
  assert.strictEqual(lib.convertTo(input, "train"), "Hello-World-Example");
  assert.strictEqual(lib.convertTo(input, "dot"), "hello.world.example");
  assert.strictEqual(lib.convertTo(input, "path"), "hello/world/example");
  assert.strictEqual(lib.convertTo(input, "ada"), "Hello_World_Example");
});

test("converts between identifier styles round-trip safely", () => {
  assert.strictEqual(lib.convertTo("userProfileId", "snake"), "user_profile_id");
  assert.strictEqual(lib.convertTo("user_profile_id", "camel"), "userProfileId");
  assert.strictEqual(lib.convertTo("USER_PROFILE_ID", "kebab"), "user-profile-id");
  assert.strictEqual(lib.convertTo("getHTTPResponse", "constant"), "GET_HTTP_RESPONSE");
});

test("conversion on empty or wordless input returns an empty string", () => {
  assert.strictEqual(lib.convertTo("", "camel"), "");
  assert.strictEqual(lib.convertTo("___", "snake"), "");
  assert.strictEqual(lib.convertTo(null, "kebab"), "");
});

test("an unknown case id returns an empty string rather than throwing", () => {
  assert.strictEqual(lib.convertTo("hello", "not-a-case"), "");
});

// ---------------------------------------------------------------------------
// Conversion — literal cases
// ---------------------------------------------------------------------------

test("lower and UPPER preserve punctuation and spacing", () => {
  assert.strictEqual(lib.convertTo("Hello, World!", "lower"), "hello, world!");
  assert.strictEqual(lib.convertTo("Hello, World!", "upper"), "HELLO, WORLD!");
});

test("title case capitalises every word and preserves punctuation", () => {
  assert.strictEqual(lib.titleCase("the quick brown fox"), "The Quick Brown Fox");
  assert.strictEqual(lib.titleCase("hello-world's end"), "Hello-World's End");
  assert.strictEqual(lib.titleCase("one, two; three"), "One, Two; Three");
});

test("sentence case lowercases then capitalises sentence starts", () => {
  assert.strictEqual(lib.sentenceCase("HELLO WORLD. HOW ARE YOU?"), "Hello world. How are you?");
  assert.strictEqual(lib.sentenceCase("first line\nsecond line"), "First line\nSecond line");
  assert.strictEqual(lib.sentenceCase(""), "");
});

test("sentence case restarts after terminal punctuation", () => {
  assert.strictEqual(lib.sentenceCase("one. two! three?"), "One. Two! Three?");
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("detects wordlist cases", () => {
  assert.strictEqual(lib.detectCase("user_profile_id").id, "snake");
  assert.strictEqual(lib.detectCase("user-profile-id").id, "kebab");
  assert.strictEqual(lib.detectCase("USER_PROFILE_ID").id, "constant");
  assert.strictEqual(lib.detectCase("user.profile.id").id, "dot");
  assert.strictEqual(lib.detectCase("user/profile/id").id, "path");
  assert.strictEqual(lib.detectCase("User-Profile-Id").id, "train");
});

test("detects camel and pascal from a single token", () => {
  assert.strictEqual(lib.detectCase("userProfileId").id, "camel");
  assert.strictEqual(lib.detectCase("UserProfileId").id, "pascal");
});

test("detects prose cases", () => {
  assert.strictEqual(lib.detectCase("hello world").id, "lower");
  assert.strictEqual(lib.detectCase("HELLO WORLD").id, "upper");
  assert.strictEqual(lib.detectCase("Hello World").id, "title");
  assert.strictEqual(lib.detectCase("Hello world here").id, "sentence");
});

test("empty input is reported as empty, not guessed", () => {
  assert.strictEqual(lib.detectCase("").id, "empty");
  assert.strictEqual(lib.detectCase("   ").id, "empty");
});

test("a sentence containing a full stop is not mistaken for dot.case", () => {
  assert.strictEqual(lib.detectCase("This is a sentence.").id, "sentence");
  assert.strictEqual(lib.detectCase("hello world.").id, "lower");
  assert.strictEqual(lib.detectCase("hello.world.example").id, "dot");
});

test("ambiguous or mixed input is reported as unknown", () => {
  assert.strictEqual(lib.detectCase("!!!").id, "unknown");
  assert.strictEqual(lib.detectCase("user Profile").id, "unknown");
  assert.strictEqual(lib.detectCase("HELLO_world").id, "unknown");
});

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

test("trim lines removes leading and trailing whitespace per line", () => {
  assert.strictEqual(lib.applyTransform("  a  \n\tb\t\n c ", "trim-lines"), "a\nb\nc");
});

test("collapse spaces squeezes runs of spaces and tabs", () => {
  assert.strictEqual(lib.applyTransform("a   b\t\tc", "collapse-spaces"), "a b c");
  assert.strictEqual(lib.applyTransform("word", "collapse-spaces"), "word");
});

test("single line joins wrapped text", () => {
  assert.strictEqual(lib.applyTransform("one\n  two\nthree", "single-line"), "one two three");
});

test("remove blank lines drops empty and whitespace-only lines", () => {
  assert.strictEqual(lib.applyTransform("a\n\n   \nb", "remove-blank-lines"), "a\nb");
});

test("strip diacritics folds accented latin letters", () => {
  assert.strictEqual(lib.applyTransform("café naïve résumé", "strip-diacritics"), "cafe naive resume");
});

test("ascii punctuation replaces curly quotes, dashes and ellipses", () => {
  assert.strictEqual(
    lib.applyTransform("\u201cHi\u201d \u2014 it\u2019s fine\u2026", "ascii-punctuation"),
    "\"Hi\" - it's fine..."
  );
});

test("dedupe lines keeps first occurrences only", () => {
  assert.strictEqual(lib.applyTransform("a\nb\na\nb\nc", "dedupe-lines"), "a\nb\nc");
});

test("sort lines is case-insensitive and stable enough for display", () => {
  assert.strictEqual(lib.applyTransform("banana\nApple\ncherry", "sort-lines"), "Apple\nbanana\ncherry");
});

test("reverse lines flips the order", () => {
  assert.strictEqual(lib.applyTransform("a\nb\nc", "reverse-lines"), "c\nb\na");
});

test("an unknown transform id returns the input unchanged", () => {
  assert.strictEqual(lib.applyTransform("keep me", "nope"), "keep me");
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

test("counts words, sentences and lines", () => {
  assert.strictEqual(lib.countWords("one two three"), 3);
  assert.strictEqual(lib.countWords("   "), 0);
  assert.strictEqual(lib.countWords(""), 0);
  assert.strictEqual(lib.countSentences("One. Two! Three? Four"), 4);
  assert.strictEqual(lib.countSentences("no terminal punctuation"), 1);
  assert.strictEqual(lib.countSentences(""), 0);
  assert.strictEqual(lib.countLines("a\nb\nc"), 3);
  assert.strictEqual(lib.countLines(""), 0);
});

test("counts unique words case-insensitively", () => {
  assert.strictEqual(lib.uniqueWords("Cat cat CAT dog"), 2);
  assert.strictEqual(lib.uniqueWords(""), 0);
  // Unique words never exceed the word count, even across newlines.
  const text = "one two\nthree one\ntwo four";
  assert.strictEqual(lib.countWords(text), 6);
  assert.strictEqual(lib.uniqueWords(text), 4);
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

test("analyze returns detected case, stats, every case and every transform", () => {
  const a = lib.analyze("Hello world");
  assert.strictEqual(a.detected.id, "sentence");
  assert.strictEqual(a.stats.words, 2);
  assert.strictEqual(a.cases.length, lib.CASES.length);
  assert.strictEqual(a.transforms.length, lib.TRANSFORMS.length);
  assert.ok(a.cases.some((c) => c.id === "snake" && c.value === "hello_world"));
});

test("toJSON produces parseable JSON with the same shape", () => {
  const parsed = JSON.parse(lib.toJSON("userProfileId"));
  assert.strictEqual(parsed.detected.id, "camel");
  assert.strictEqual(parsed.stats.characters, 13);
});

test("toMarkdown renders a table and escapes pipe characters", () => {
  const md = lib.toMarkdown("a|b");
  assert.ok(md.includes("# Text Case Lab"));
  assert.ok(md.includes("| Case | Result |"));
  assert.ok(md.includes("\\|"));
});

test("analyze handles non-string input without throwing", () => {
  const a = lib.analyze(null);
  assert.strictEqual(a.detected.id, "empty");
  assert.strictEqual(a.stats.characters, 0);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(function run() {
  for (const t of tests) {
    try {
      t.fn();
      passed++;
    } catch (err) {
      failed++;
      console.error(`FAIL — ${t.name}`);
      console.error(`       ${err.message}`);
    }
  }
  console.log(`Text Case Lab: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
