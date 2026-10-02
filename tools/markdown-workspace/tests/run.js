"use strict";

const assert = require("node:assert");
const md = require("../tool.js");

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

console.log("markdown-workspace tests");

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

test("renders emphasis and strong", () => {
  assert.strictEqual(md.renderInline("*a*"), "<em>a</em>");
  assert.strictEqual(md.renderInline("**a**"), "<strong>a</strong>");
  assert.strictEqual(md.renderInline("_a_"), "<em>a</em>");
  assert.strictEqual(md.renderInline("__a__"), "<strong>a</strong>");
});

test("renders strikethrough", () => {
  assert.strictEqual(md.renderInline("~~gone~~"), "<del>gone</del>");
});

test("renders inline code and preserves its characters", () => {
  assert.strictEqual(md.renderInline("`a < b`"), "<code>a &lt; b</code>");
  assert.strictEqual(md.renderInline("`code with *stars*`"), "<code>code with *stars*</code>");
});

test("handles multi-backtick code spans", () => {
  assert.strictEqual(md.renderInline("``a ` b``"), "<code>a ` b</code>");
});

test("escapes HTML in plain text", () => {
  assert.strictEqual(md.renderInline("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.strictEqual(md.renderInline('a & b "quoted"'), 'a &amp; b "quoted"');
});

test("backslash escapes punctuation", () => {
  assert.strictEqual(md.renderInline("\\*not emphasis\\*"), "*not emphasis*");
  assert.strictEqual(md.renderInline("\\<tag\\>"), "&lt;tag&gt;");
});

test("renders links and sanitises the href", () => {
  const html = md.renderInline("[x](https://example.com)");
  assert.ok(html.includes('href="https://example.com"'), html);
  assert.ok(html.includes('rel="noopener noreferrer"'), html);
});

test("drops javascript: URLs to a harmless fragment", () => {
  const html = md.renderInline("[click](javascript:alert(1))");
  assert.ok(html.includes('href="#"'), html);
  assert.ok(!/javascript:/i.test(html), html);
});

test("defeats scheme smuggling with control characters", () => {
  // A tab inside the scheme prevents the link being recognised; either way
  // no href may carry a javascript: scheme.
  const html = md.renderInline("[x](java\tscript:alert(1))");
  assert.ok(!/<a[^>]*href="javascript:/i.test(html), html);
  assert.ok(!/<a[^>]*href="[^"]*\tscript:/i.test(html), html);
});

test("neutralises data: image sources", () => {
  const html = md.renderInline("![x](data:text/html,<script>alert(1)</script>)");
  assert.ok(!/data:/i.test(html), html);
  assert.ok(html.includes('src="#"'), html);
});

test("renders images with alt text and escapes attributes", () => {
  const html = md.renderInline('![a "b"](https://example.com/i.png "t")');
  assert.ok(html.startsWith('<img src="https://example.com/i.png"'), html);
  assert.ok(html.includes('alt="a &quot;b&quot;"'), html);
  assert.ok(html.includes('title="t"'), html);
  assert.ok(html.includes('loading="lazy"'), html);
});

test("autolinks bare http(s) URLs", () => {
  const html = md.renderInline("see https://example.com now");
  assert.ok(html.includes('<a href="https://example.com"'), html);
});

test("does not autolink javascript: or data: URLs", () => {
  // The text may survive as inert, escaped plain text, but it must not
  // become a link.
  assert.ok(!/<a[^>]*href="javascript:/i.test(md.renderInline("javascript:alert(1)")));
  assert.ok(!/<a[^>]*href="data:/i.test(md.renderInline("data:text/html,hi")));
});

test("strips trailing punctuation from autolinks", () => {
  const html = md.renderInline("go to https://example.com.");
  assert.ok(html.includes('href="https://example.com"'), html);
  assert.ok(html.endsWith("."), html);
});

test("escapes quotes in link destinations", () => {
  const html = md.renderInline('[x](https://example.com/?a="b")');
  assert.ok(html.includes("&quot;"), html);
});

test("renders hard line breaks", () => {
  assert.strictEqual(md.renderInline("a\nb"), "a<br>b");
});

test("does not treat unmatched emphasis as emphasis", () => {
  assert.strictEqual(md.renderInline("a * b"), "a * b");
});

test("handles empty and null input", () => {
  assert.strictEqual(md.renderInline(""), "");
  assert.strictEqual(md.renderInline(null), "");
  assert.strictEqual(md.renderInline(undefined), "");
});

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

test("renders ATX headings at every level", () => {
  assert.strictEqual(md.renderDocument("# A"), '<h1 id="a">A</h1>');
  assert.strictEqual(md.renderDocument("###### F"), '<h6 id="f">F</h6>');
});

test("ignores seven hashes (not a heading)", () => {
  assert.strictEqual(md.renderDocument("####### nope"), "<p>####### nope</p>");
});

test("renders paragraphs", () => {
  assert.strictEqual(md.renderDocument("one\n\ntwo"), "<p>one</p><p>two</p>");
});

test("renders fenced code with a language class", () => {
  const html = md.renderDocument("```js\nconst a = 1;\n```");
  assert.ok(html.includes('<pre><code class="language-js">'), html);
  assert.ok(html.includes("const a = 1;"), html);
});

test("escapes code block contents", () => {
  const html = md.renderDocument("```\n<script>alert(1)</script>\n```");
  assert.ok(html.includes("&lt;script&gt;"), html);
  assert.ok(!html.includes("<script>"), html);
});

test("does not parse markdown inside code fences", () => {
  const html = md.renderDocument("```\n# not a heading\n**not bold**\n```");
  assert.ok(!html.includes("<h1"), html);
  assert.ok(!html.includes("<strong>"), html);
});

test("renders tilde fences", () => {
  assert.ok(md.renderDocument("~~~\ncode\n~~~").includes("<pre><code>"));
});

test("renders thematic breaks", () => {
  assert.strictEqual(md.renderDocument("---"), "<hr>");
  assert.strictEqual(md.renderDocument("***"), "<hr>");
  assert.strictEqual(md.renderDocument("___"), "<hr>");
});

test("renders blockquotes, including nested blocks", () => {
  const html = md.renderDocument("> quote\n> **bold**");
  assert.ok(html.startsWith("<blockquote><p>"), html);
  assert.ok(html.includes("<strong>bold</strong>"), html);
});

test("renders nested blockquotes", () => {
  const html = md.renderDocument("> outer\n> > inner");
  assert.ok((html.match(/<blockquote>/g) || []).length >= 2, html);
});

test("renders unordered lists tightly", () => {
  assert.strictEqual(md.renderDocument("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
});

test("renders ordered lists with a start attribute", () => {
  assert.strictEqual(md.renderDocument("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
});

test("renders nested lists", () => {
  const html = md.renderDocument("- a\n  - b\n- c");
  assert.ok(html.includes("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>"), html);
});

test("keeps loose list items wrapped in paragraphs", () => {
  const html = md.renderDocument("- a\n\n- b");
  assert.ok(html.includes("<li><p>a</p></li>"), html);
});

test("renders GFM tables with alignment", () => {
  const html = md.renderDocument("| a | b |\n| :-- | --: |\n| 1 | 2 |");
  assert.ok(html.includes("<table><thead><tr><th"), html);
  assert.ok(html.includes('style="text-align:left"'), html);
  assert.ok(html.includes('style="text-align:right"'), html);
  assert.ok(html.includes("<td"), html);
});

test("pads short table rows", () => {
  const html = md.renderDocument("| a | b | c |\n| - | - | - |\n| 1 |");
  assert.ok((html.match(/<td/g) || []).length === 3, html);
});

test("escapes table cell content", () => {
  const html = md.renderDocument("| a |\n| - |\n| <script> |");
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script&gt;"), html);
});

test("does not treat a lone pipe paragraph as a table", () => {
  assert.strictEqual(md.renderDocument("a | b"), "<p>a | b</p>");
});

// ---------------------------------------------------------------------------
// Heading slugs and outline
// ---------------------------------------------------------------------------

test("slugifies headings", () => {
  assert.strictEqual(md.slugify("Hello, World!"), "hello-world");
  assert.strictEqual(md.slugify("**Bold** heading"), "bold-heading");
  assert.strictEqual(md.slugify("`code` here"), "code-here");
});

test("numbers duplicate heading slugs", () => {
  const html = md.renderDocument("# Same\n\n# Same");
  assert.ok(html.includes('id="same"'), html);
  assert.ok(html.includes('id="same-1"'), html);
});

test("outline lists headings with levels and line numbers", () => {
  const headings = md.outline("# One\n\ntext\n\n## Two");
  assert.strictEqual(headings.length, 2);
  assert.deepStrictEqual(
    headings.map((h) => ({ level: h.level, text: h.text, line: h.line })),
    [
      { level: 1, text: "One", line: 1 },
      { level: 2, text: "Two", line: 5 },
    ]
  );
});

test("outline detects setext headings", () => {
  const headings = md.outline("Title\n=====\n\nSub\n---");
  assert.deepStrictEqual(
    headings.map((h) => h.level),
    [1, 2]
  );
});

test("outline ignores hashes inside fenced code", () => {
  const headings = md.outline("# real\n\n```\n# fake\n```\n\n## also real");
  assert.deepStrictEqual(
    headings.map((h) => h.text),
    ["real", "also real"]
  );
});

test("outline returns an empty array for empty input", () => {
  assert.deepStrictEqual(md.outline(""), []);
  assert.deepStrictEqual(md.outline(null), []);
});

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

test("counts words excluding markdown syntax", () => {
  assert.strictEqual(md.countWords("hello world"), 2);
  assert.strictEqual(md.countWords("**hello** _world_"), 2);
  assert.strictEqual(md.countWords("# Heading\n\nsome body text"), 4);
});

test("does not count code-block contents as words", () => {
  assert.strictEqual(md.countWords("```\nnot words at all here\n```"), 0);
});

test("analyze reports counts and reading time", () => {
  const a = md.analyze("# Title\n\nHello world.\n\n- one\n- two");
  assert.strictEqual(a.headings, 1);
  assert.strictEqual(a.words, 5);
  assert.ok(a.readingTime.length > 0);
  assert.strictEqual(a.taskItems, 0);
});

test("analyze counts links and images separately", () => {
  const a = md.analyze("[a](https://a.com) and ![i](https://a.com/i.png)");
  assert.strictEqual(a.links, 1);
  assert.strictEqual(a.images, 1);
});

test("analyze counts task list items", () => {
  const a = md.analyze("- [x] done\n- [ ] todo\n- [X] also done");
  assert.strictEqual(a.taskItems, 3);
  assert.strictEqual(a.checkedTasks, 2);
});

test("analyze tallies code languages and lines", () => {
  const a = md.analyze("```js\nline1\nline2\n```\n\n```python\nx = 1\n```");
  assert.strictEqual(a.codeBlocks, 2);
  assert.strictEqual(a.codeLines, 3);
  assert.strictEqual(a.languages.js, 1);
  assert.strictEqual(a.languages.python, 1);
});

test("analyze handles empty input", () => {
  const a = md.analyze("");
  assert.strictEqual(a.words, 0);
  assert.strictEqual(a.characters, 0);
  assert.strictEqual(a.headings, 0);
  assert.strictEqual(a.longestLine, 0);
});

test("analyze handles null input", () => {
  const a = md.analyze(null);
  assert.strictEqual(a.words, 0);
  assert.strictEqual(a.lines, 1);
});

// ---------------------------------------------------------------------------
// Document health
// ---------------------------------------------------------------------------

test("flags heading level jumps", () => {
  const h = md.checkDocument("# A\n\n### C");
  assert.ok(h.issues.some((i) => i.code === "heading-jump"));
});

test("flags multiple H1 headings", () => {
  const h = md.checkDocument("# A\n\n# B");
  assert.ok(h.issues.some((i) => i.code === "multiple-h1"));
});

test("flags an unclosed fence", () => {
  const h = md.checkDocument("```\nnever closed");
  assert.ok(h.issues.some((i) => i.code === "unclosed-fence"));
});

test("does not flag a closed fence", () => {
  const h = md.checkDocument("```\nclosed\n```");
  assert.ok(!h.issues.some((i) => i.code === "unclosed-fence"));
});

test("flags duplicate headings", () => {
  const h = md.checkDocument("# Same\n\n## Same");
  assert.ok(h.issues.some((i) => i.code === "duplicate-heading"));
});

test("flags images without alt text", () => {
  const h = md.checkDocument("![](https://example.com/i.png)");
  assert.ok(h.issues.some((i) => i.code === "image-no-alt"));
});

test("flags unused link reference definitions", () => {
  const h = md.checkDocument("[unused]: https://example.com\n\nplain text");
  assert.ok(h.issues.some((i) => i.code === "unused-reference"));
});

test("clean document produces no warnings", () => {
  const h = md.checkDocument("# Title\n\nA paragraph with [a link](https://example.com).\n\n## Section\n\nMore text.");
  assert.deepStrictEqual(h.issues, []);
});

test("empty document produces no issues", () => {
  assert.deepStrictEqual(md.checkDocument("").issues, []);
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test("trimTrailing removes trailing whitespace", () => {
  assert.strictEqual(md.normalize("a   \nb\t\n", { trimTrailing: true }), "a\nb\n");
});

test("collapseBlankLines squeezes runs of blank lines", () => {
  assert.strictEqual(md.normalize("a\n\n\n\nb", { collapseBlankLines: true }), "a\n\nb");
});

test("headings adds a space after the hashes", () => {
  assert.strictEqual(md.normalize("#Title", { headings: true }), "# Title");
  assert.strictEqual(md.normalize("###   Spaced   ", { headings: true }), "### Spaced");
});

test("listMarkers unifies bullets to a dash", () => {
  assert.strictEqual(md.normalize("* a\n+ b\n- c", { listMarkers: true }), "- a\n- b\n- c");
});

test("blankLinesAroundHeadings separates headings", () => {
  assert.strictEqual(md.normalize("text\n# Heading\ntext", { blankLinesAroundHeadings: true }), "text\n\n# Heading\n\ntext");
});

test("ensureFinalNewline appends exactly one newline", () => {
  assert.strictEqual(md.normalize("a", { ensureFinalNewline: true }), "a\n");
  assert.strictEqual(md.normalize("a\n\n\n", { ensureFinalNewline: true }), "a\n");
});

test("normalize converts CRLF line endings", () => {
  assert.strictEqual(md.normalize("a\r\nb"), "a\nb");
});

test("normalize with no options is a line-ending normalisation only", () => {
  assert.strictEqual(md.normalize("  a  \r\n\r\n\r\nb"), "  a  \n\n\nb");
});

// ---------------------------------------------------------------------------
// process() — the top-level entry point
// ---------------------------------------------------------------------------

test("process returns html, analysis, outline and health", () => {
  const result = md.process("# Hi\n\nHello");
  assert.strictEqual(result.ok, true);
  assert.ok(result.html.includes("<h1"));
  assert.strictEqual(result.analysis.headings, 1);
  assert.strictEqual(result.outline.length, 1);
  assert.ok(Array.isArray(result.health.issues));
});

test("process rejects documents over the size limit", () => {
  const big = "a".repeat(md.MAX_SOURCE + 1);
  const result = md.process(big);
  assert.strictEqual(result.ok, false);
  assert.ok(/too large/i.test(result.error));
});

test("process tolerates empty input", () => {
  const result = md.process("");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.html, "");
});

// ---------------------------------------------------------------------------
// Security regressions
// ---------------------------------------------------------------------------

test("never emits a raw script tag from any input", () => {
  const inputs = [
    "<script>alert(1)</script>",
    "**<script>alert(1)</script>**",
    "[x](<script>alert(1)</script>)",
    "![x](<script>alert(1)</script>)",
    "| <script> |\n| --- |\n| x |",
    "> <script>alert(1)</script>",
    "```\n<script>alert(1)</script>\n```",
  ];
  for (const input of inputs) {
    const html = md.renderDocument(input);
    assert.ok(!/<script/i.test(html), input + " -> " + html);
  }
});

test("treats an event-handler string in a title as inert text", () => {
  const html = md.renderDocument('[x](https://example.com/ "onmouseover=alert(1)")');
  // The text may appear inside a quoted title attribute, but it must never
  // become an attribute of the anchor itself.
  assert.ok(html.includes('title="onmouseover=alert(1)"'), html);
  assert.ok(!/<a[^>]*\sonmouseover\s*=/i.test(html), html);
});

test("does not execute dynamic code (no eval/Function in source)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "tool.js"), "utf8");
  assert.ok(!/\beval\s*\(/.test(src), "eval found");
  assert.ok(!/new\s+Function\s*\(/.test(src), "Function constructor found");
});

test("a link cannot break out of its href attribute", () => {
  const html = md.renderInline('[x](https://example.com/" onmouseover="alert(1))');
  assert.ok(!/<a[^>]*\sonmouseover\s*=/i.test(html), html);
  assert.ok(!/&quot;\s+onmouseover/.test(html) || html.includes("&quot;"), html);
});

test("an image alt cannot break out of its attribute", () => {
  const html = md.renderInline('!["><script>](https://example.com/i.png)');
  assert.ok(!/<script/i.test(html), html);
});

test("sample document renders without error", () => {
  const result = md.process(md.sampleDocument());
  assert.strictEqual(result.ok, true);
  assert.ok(result.html.includes("<h1"), "sample should have a heading");
  assert.ok(result.analysis.words > 20, "sample should have words");
});

// ---------------------------------------------------------------------------

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
