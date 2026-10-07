"use strict";

/**
 * Design Token Studio — test suite.
 *
 * Run directly (node tools/design-token-studio/tests/run.js) or through the
 * repository runner (npm run test:tools). The library is required exactly as
 * the browser loads it, so these tests exercise the same code path the page
 * uses. A few tests are async, so assertions run through an explicit queue.
 */

const assert = require("node:assert");
const lib = require("../tool.js");

let passed = 0;
let failed = 0;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

test("parses every hex length", () => {
  assert.deepStrictEqual(lib.parseColor("#fff").hex, "#ffffff");
  assert.deepStrictEqual(lib.parseColor("#b3402a").hex, "#b3402a");
  assert.strictEqual(lib.parseColor("#ffff").a, 1);
  assert.strictEqual(lib.parseColor("#ffffff80").a, 128 / 255);
});

test("rejects malformed hex", () => {
  assert.strictEqual(lib.parseColor("#12345"), null);
  assert.strictEqual(lib.parseColor("#gggggg"), null);
  assert.strictEqual(lib.parseColor("b3402a"), null);
  assert.strictEqual(lib.parseColor(""), null);
  assert.strictEqual(lib.parseColor(null), null);
});

test("parses rgb() comma and space syntax", () => {
  assert.strictEqual(lib.parseColor("rgb(255, 0, 0)").hex, "#ff0000");
  assert.strictEqual(lib.parseColor("rgb(255 0 0)").hex, "#ff0000");
  assert.strictEqual(lib.parseColor("rgba(0, 0, 0, 0.5)").a, 0.5);
  assert.strictEqual(lib.parseColor("rgb(255 0 0 / 50%)").a, 0.5);
});

test("parses hsl()/hsla() and converts to rgb", () => {
  assert.strictEqual(lib.parseColor("hsl(0 100% 50%)").hex, "#ff0000");
  assert.strictEqual(lib.parseColor("hsl(120, 100%, 25%)").hex, "#008000");
  assert.strictEqual(lib.parseColor("hsla(0, 100%, 50%, 0.25)").a, 0.25);
});

test("round-trips rgb through hsl", () => {
  const hsl = lib.rgbToHsl(179, 64, 42);
  const back = lib.hslToRgb(hsl.h, hsl.s, hsl.l);
  assert.ok(Math.abs(back.r - 179) <= 1 && Math.abs(back.g - 64) <= 1 && Math.abs(back.b - 42) <= 1,
    JSON.stringify(back));
});

test("rgbToHex pads single digits and includes alpha", () => {
  assert.strictEqual(lib.rgbToHex(0, 0, 0), "#000000");
  assert.strictEqual(lib.rgbToHex(1, 2, 3), "#010203");
  assert.strictEqual(lib.rgbToHex(255, 0, 0, 0.5), "#ff000080");
});

test("blend composites a translucent foreground over a background", () => {
  const fg = lib.parseColor("rgba(0, 0, 0, 0.5)"); // 50% black
  const overWhite = lib.blend(fg, lib.parseColor("#ffffff"));
  assert.strictEqual(overWhite.hex, "#808080");
  const overBlack = lib.blend(fg, lib.parseColor("#000000"));
  assert.strictEqual(overBlack.hex, "#000000");
});

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

test("contrast ratio extremes and identity", () => {
  assert.strictEqual(lib.contrastRatio("#000000", "#ffffff"), 21);
  assert.strictEqual(lib.contrastRatio("#ffffff", "#ffffff"), 1);
  assert.strictEqual(lib.contrastRatio("#b3402a", "#ffffff"), lib.contrastRatio("#ffffff", "#b3402a"));
});

test("contrast ratio is null for unparseable input", () => {
  assert.strictEqual(lib.contrastRatio("not-a-color", "#fff"), null);
  assert.strictEqual(lib.contrastRatio("#000", "nope"), null);
});

test("wcagRating classifies by threshold", () => {
  assert.strictEqual(lib.wcagRating(21).level, "AAA");
  assert.strictEqual(lib.wcagRating(7).level, "AAA");
  assert.strictEqual(lib.wcagRating(4.5).level, "AA");
  assert.strictEqual(lib.wcagRating(3).level, "AA Large");
  assert.strictEqual(lib.wcagRating(2.9).level, "Fail");
  assert.strictEqual(lib.wcagRating(2.9).aa, false);
  assert.strictEqual(lib.wcagRating(null), null);
});

test("known contrast pair: #b3402a on #fbf8f1 fails AA normal text", () => {
  const r = lib.contrastRatio("#b3402a", "#fbf8f1");
  assert.ok(r > 4.5 && r < 6, "ratio " + r);
  assert.strictEqual(lib.wcagRating(r).aa, true);
  assert.strictEqual(lib.wcagRating(r).aaa, false);
});

// ---------------------------------------------------------------------------
// Value classification and references
// ---------------------------------------------------------------------------

test("parseValue classifies numbers, dimensions, colors and other", () => {
  assert.strictEqual(lib.parseValue("8px").kind, "dimension");
  assert.strictEqual(lib.parseValue("8px").unit, "px");
  assert.strictEqual(lib.parseValue("1.5rem").number, 1.5);
  assert.strictEqual(lib.parseValue("0.5").kind, "number");
  assert.strictEqual(lib.parseValue(42).kind, "number");
  assert.strictEqual(lib.parseValue("#fff").kind, "color");
  assert.strictEqual(lib.parseValue("600").kind, "number");
  assert.strictEqual(lib.parseValue("sans-serif").kind, "other");
  assert.strictEqual(lib.parseValue("").kind, "empty");
  assert.strictEqual(lib.parseValue(null).kind, "empty");
});

test("extractRefs finds DTCG and CSS references", () => {
  assert.deepStrictEqual(lib.extractRefs("{color.brand}"), ["color.brand"]);
  assert.deepStrictEqual(lib.extractRefs("var(--color-brand)"), ["--color-brand"]);
  assert.deepStrictEqual(lib.extractRefs("var(--a, #fff)"), ["--a"]);
  assert.deepStrictEqual(lib.extractRefs("{a} {b}"), ["a", "b"]);
  assert.deepStrictEqual(lib.extractRefs("#fff"), []);
});

test("normalizeName strips prefixes, braces and dots", () => {
  assert.strictEqual(lib.normalizeName("--color-brand"), "color-brand");
  assert.strictEqual(lib.normalizeName("$color-brand"), "color-brand");
  assert.strictEqual(lib.normalizeName("@color-brand"), "color-brand");
  assert.strictEqual(lib.normalizeName("{color.brand}"), "color-brand");
  assert.strictEqual(lib.normalizeName("color.brand"), "color-brand");
});

// ---------------------------------------------------------------------------
// Parsing — JSON
// ---------------------------------------------------------------------------

test("parses nested DTCG with inherited type and description", () => {
  const text = JSON.stringify({
    color: {
      $type: "color",
      brand: { $value: "#b3402a", $description: "Primary" },
      surface: { $value: "#fbf8f1" }
    },
    space: { $type: "dimension", md: { $value: "8px" } }
  });
  const out = lib.parseTokens(text);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.format, "json");
  const names = out.tokens.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ["color-brand", "color-surface", "space-md"]);
  const brand = out.tokens.find((t) => t.name === "color-brand");
  assert.strictEqual(brand.type, "color");
  assert.strictEqual(brand.description, "Primary");
  assert.strictEqual(brand.group, "color");
});

test("parses flat JSON and infers groups from dashes", () => {
  const out = lib.parseTokens(JSON.stringify({ "color-brand": "#b3402a", "space-md": "8px" }));
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.groups, ["color", "space"]);
});

test("parses a JSON array of { name, value } tokens", () => {
  const out = lib.parseTokens(JSON.stringify([{ name: "brand", value: "#000" }, { name: "gap", value: "4px" }]));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.tokens.length, 2);
});

test("invalid JSON returns a readable error, not a throw", () => {
  const out = lib.parseTokens("{ not json");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /Invalid JSON/);
});

test("empty JSON object reports no tokens", () => {
  const out = lib.parseTokens("{}");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /No tokens/);
});

test("empty input reports a friendly message", () => {
  const out = lib.parseTokens("   ");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /Nothing to parse/);
});

test("undetectable input asks for a format", () => {
  const out = lib.parseTokens("just some prose with no tokens");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /Could not detect/);
});

// ---------------------------------------------------------------------------
// Parsing — CSS / SCSS / Less
// ---------------------------------------------------------------------------

test("parses a :root block with comments and var references", () => {
  const css = [
    ":root {",
    "  /* color */",
    "  --color-brand: #b3402a;",
    "  --color-brand-strong: var(--color-brand);",
    "  --space-md: 8px;",
    "}"
  ].join("\n");
  const out = lib.parseTokens(css);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.format, "css");
  assert.strictEqual(out.tokens.length, 3);
  const strong = out.tokens.find((t) => t.name === "color-brand-strong");
  assert.deepStrictEqual(strong.refs, ["--color-brand"]);
});

test("parses SCSS variables and ignores other declarations", () => {
  const scss = [
    "$color-brand: #b3402a;",
    "$space-md: 8px !default;",
    ".btn { color: red; }"
  ].join("\n");
  const out = lib.parseTokens(scss);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.format, "scss");
  const names = out.tokens.map((t) => t.name);
  assert.deepStrictEqual(names, ["color-brand", "space-md"]);
  assert.match(out.tokens[1].value, /!default/);
});

test("parses Less variables and keeps nested blocks as groups", () => {
  const less = ["@brand: #b3402a;", "@size: {", "  @md: 8px;", "}"].join("\n");
  const out = lib.parseTokens(less);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.format, "less");
  const md = out.tokens.find((t) => t.name === "md");
  assert.strictEqual(md.group, "size");
});

test("detects format from a bare CSS variable line", () => {
  assert.strictEqual(lib.detectFormat("--brand: #000;"), "css");
  assert.strictEqual(lib.detectFormat("$brand: #000;"), "scss");
  assert.strictEqual(lib.detectFormat("@brand: #000;"), "less");
  assert.strictEqual(lib.detectFormat("{ \"a\": 1 }"), "json");
  assert.strictEqual(lib.detectFormat(""), "");
});

test("an explicit format override is honored", () => {
  const out = lib.parseTokens("{ \"color-brand\": \"#000\" }", { format: "json" });
  assert.strictEqual(out.format, "json");
});

test("CSS input without variables reports a helpful error", () => {
  const out = lib.parseTokens(".btn { color: red; }");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /No CSS variables/);
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function tokensFrom(obj) {
  return Object.keys(obj).map((name) => ({ name, value: obj[name], refs: lib.extractRefs(obj[name]), group: "" }));
}

test("resolves a transitive reference chain", () => {
  const r = lib.resolveAll(tokensFrom({
    "color-brand": "#b3402a",
    "color-accent": "{color.brand}",
    "color-cta": "{color.accent}"
  }));
  assert.strictEqual(r.map["color-cta"].value, "#b3402a");
  assert.deepStrictEqual(r.issues.broken, []);
});

test("resolves CSS var references to a dash-normalized name", () => {
  const r = lib.resolveAll(tokensFrom({
    "color-brand": "#b3402a",
    "color-accent": "var(--color-brand)"
  }));
  assert.strictEqual(r.map["color-accent"].value, "#b3402a");
});

test("reports a broken reference without throwing", () => {
  const r = lib.resolveAll(tokensFrom({ "color-accent": "{color.missing}" }));
  assert.strictEqual(r.map["color-accent"].ok, false);
  assert.deepStrictEqual(r.issues.broken, ["color-accent"]);
  assert.match(r.map["color-accent"].error, /Unknown reference/);
});

test("reports a circular reference without hanging", () => {
  const r = lib.resolveAll(tokensFrom({ a: "{b}", b: "{a}" }));
  assert.ok(r.issues.cycles.length > 0);
  assert.strictEqual(r.map["a"].ok, false);
});

test("reports duplicate names and keeps the first definition", () => {
  const tokens = [
    { name: "brand", value: "#111", refs: [] },
    { name: "brand", value: "#222", refs: [] }
  ];
  const r = lib.resolveAll(tokens);
  assert.deepStrictEqual(r.issues.duplicates, ["brand"]);
  assert.strictEqual(r.map["brand"].value, "#111");
});

test("a value mixing literals and references resolves the reference part", () => {
  const r = lib.resolveAll(tokensFrom({
    "size-base": "8",
    "space-lg": "{size.base}px"
  }));
  assert.strictEqual(r.map["space-lg"].value, "8px");
});

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

test("analyzeTokens counts kinds and tracks usage", () => {
  const parsed = lib.parseTokens(lib.getSample("dtcg-json"));
  const a = lib.analyzeTokens(parsed.tokens);
  assert.strictEqual(a.counts.color, 6);
  assert.strictEqual(a.counts.dimension, 7);
  const brand = a.tokens.find((t) => t.name === "color-brand");
  assert.ok(brand.usedBy >= 1, "brand should be referenced");
  const strong = a.tokens.find((t) => t.name === "color-brand-strong");
  assert.strictEqual(strong.resolved, true);
  assert.strictEqual(strong.value, "#b3402a");
});

test("analyzeTokens does not mutate the input tokens", () => {
  const parsed = lib.parseTokens(JSON.stringify({ "color-brand": "#000" }));
  const before = JSON.stringify(parsed.tokens);
  lib.analyzeTokens(parsed.tokens);
  assert.strictEqual(JSON.stringify(parsed.tokens), before);
});

test("analyzeTokens tolerates an empty list", () => {
  const a = lib.analyzeTokens([]);
  assert.strictEqual(a.tokens.length, 0);
  assert.strictEqual(a.groups.length, 0);
});

test("analyzeTokens keeps raw value when a reference is broken", () => {
  const parsed = lib.parseTokens(JSON.stringify({ "color-accent": "{color.nope}" }));
  const a = lib.analyzeTokens(parsed.tokens);
  const t = a.tokens[0];
  assert.strictEqual(t.resolved, false);
  assert.strictEqual(t.value, "{color.nope}");
  assert.match(t.error, /Unknown reference/);
});

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function analyzedSample(sample) {
  const parsed = lib.parseTokens(lib.getSample(sample || "dtcg-json"));
  return lib.analyzeTokens(parsed.tokens);
}

test("JSON export nests by name and is valid JSON", () => {
  const out = lib.serialize("json", analyzedSample().tokens, { nested: true });
  assert.strictEqual(out.ok, true);
  const data = JSON.parse(out.output);
  assert.strictEqual(data.color.brand._value, "#b3402a");
  assert.strictEqual(data.color.brand.strong, "#b3402a");
  assert.strictEqual(data.space.md, "8px");
});

test("JSON export flattens with the requested key style", () => {
  const tokens = analyzedSample().tokens;
  assert.ok(JSON.parse(lib.serialize("json", tokens, { nested: false, nameCase: "kebab" }).output)["color-brand"]);
  assert.ok(JSON.parse(lib.serialize("json", tokens, { nested: false, nameCase: "snake" }).output)["color_brand"]);
  assert.ok(JSON.parse(lib.serialize("json", tokens, { nested: false, nameCase: "camel" }).output)["colorBrand"]);
  assert.ok(JSON.parse(lib.serialize("json", tokens, { nested: false, nameCase: "pascal" }).output)["ColorBrand"]);
});

test("DTCG export round-trips through the parser", () => {
  const out = lib.serialize("dtcg", analyzedSample().tokens);
  assert.strictEqual(out.ok, true);
  const reparsed = lib.parseTokens(out.output);
  assert.strictEqual(reparsed.ok, true);
  const names = reparsed.tokens.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ["color-brand", "color-brand-strong", "color-danger", "color-ink",
    "color-ink-muted", "color-surface", "font-size-base", "font-size-lg", "radius-md", "radius-sm",
    "space-lg", "space-md", "space-sm"]);
});

test("CSS export emits :root custom properties and alias references", () => {
  const tokens = analyzedSample().tokens;
  const resolver = (t) => (t.refs.length === 1 && t.resolved ? "var(--" + t.name.replace(/-strong$/, "") + ")" : null);
  const out = lib.serialize("css", tokens, { resolver });
  assert.strictEqual(out.ok, true);
  assert.match(out.output, /^:root \{/);
  assert.match(out.output, /--color-brand: #b3402a;/);
  assert.match(out.output, /--color-brand-strong: var\(--color-brand\);/);
  assert.match(out.output, /\}$/);
});

test("SCSS and Less exports use their variable sigils", () => {
  const tokens = analyzedSample().tokens;
  assert.match(lib.serialize("scss", tokens).output, /^\$color-brand: #b3402a;/m);
  assert.match(lib.serialize("less", tokens).output, /^@color-brand: #b3402a;/m);
});

test("Tailwind export is a namespace-keyed theme.extend object", () => {
  const out = lib.serialize("tailwind", analyzedSample().tokens);
  assert.strictEqual(out.ok, true);
  assert.match(out.output, /module\.exports = \{/);
  assert.match(out.output, /"color": \{/);
  assert.match(out.output, /"brand": \{/);
  assert.match(out.output, /"strong": "#b3402a"/);
});

test("Swift export produces UIColor constants for colors", () => {
  const out = lib.serialize("swift", analyzedSample().tokens);
  assert.strictEqual(out.ok, true);
  assert.match(out.output, /import UIKit/);
  assert.match(out.output, /public static let colorBrand = UIColor\(red: 0\.702/);
});

test("Android export splits colors, dimens and strings and escapes XML", () => {
  const tokens = [
    { name: "color-brand", value: "#b3402a", kind: "color", color: lib.parseColor("#b3402a"), group: "color", refs: [] },
    { name: "space-md", value: "8px", kind: "dimension", group: "space", refs: [] },
    { name: "label-danger", value: "<b>Boom</b> & \"quoted\"", kind: "other", group: "label", refs: [] }
  ];
  const out = lib.serialize("android", tokens);
  assert.strictEqual(out.ok, true);
  assert.match(out.output, /<color name="color_brand">#b3402a<\/color>/);
  assert.match(out.output, /<dimen name="space_md">8px<\/dimen>/);
  assert.match(out.output, /&lt;b&gt;Boom&lt;\/b&gt; &amp; &quot;quoted&quot;/);
  assert.ok(!out.output.includes("<b>Boom"), "raw markup must be escaped");
});

test("serialize rejects unknown formats and empty token lists", () => {
  assert.strictEqual(lib.serialize("bogus", analyzedSample().tokens).ok, false);
  assert.strictEqual(lib.serialize("css", []).ok, false);
});

test("serialization is deterministic for identical input", () => {
  const tokens = analyzedSample().tokens;
  assert.strictEqual(lib.serialize("css", tokens).output, lib.serialize("css", tokens).output);
  assert.strictEqual(lib.serialize("json", tokens).output, lib.serialize("json", tokens).output);
});

test("leaf/group name collisions keep both values", () => {
  const tokens = analyzedSample("flat-json").tokens;
  const data = JSON.parse(lib.serialize("json", tokens, { nested: true }).output);
  assert.strictEqual(data.color.brand._value, "#b3402a");
  assert.strictEqual(data.color.brand.strong, "#b3402a");
});

test("listFormats exposes all eight formats with labels", () => {
  const ids = lib.listFormats().map((f) => f.id).sort();
  assert.deepStrictEqual(ids, ["android", "css", "dtcg", "json", "less", "scss", "swift", "tailwind"]);
  lib.listFormats().forEach((f) => {
    assert.strictEqual(typeof f.label, "string");
    assert.ok(f.label.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Filtering, grouping, samples
// ---------------------------------------------------------------------------

test("filterTokens matches name, group and value, and filters by kind", () => {
  const tokens = analyzedSample().tokens;
  assert.ok(lib.filterTokens(tokens, { query: "brand" }).every((t) => /brand/.test(t.name)));
  assert.strictEqual(lib.filterTokens(tokens, { query: "brand" }).length, 2);
  assert.ok(lib.filterTokens(tokens, { kind: "color" }).every((t) => t.kind === "color"));
  assert.strictEqual(lib.filterTokens(tokens, { query: "" }).length, tokens.length);
});

test("groupTokens groups by prefix and labels ungrouped tokens", () => {
  const tokens = [
    { name: "a-b", group: "a", value: "1" },
    { name: "a-c", group: "a", value: "2" },
    { name: "lonely", group: "", value: "3" }
  ];
  const groups = lib.groupTokens(tokens);
  assert.deepStrictEqual(groups.map((g) => g.group), ["(ungrouped)", "a"]);
});

test("every sample parses cleanly and produces tokens", () => {
  lib.listSamples().forEach((s) => {
    const text = lib.getSample(s.id);
    assert.strictEqual(typeof text, "string", s.id);
    const out = lib.parseTokens(text);
    assert.strictEqual(out.ok, true, s.id + ": " + out.error);
    assert.ok(out.tokens.length > 0, s.id);
  });
});

test("getSample returns null for an unknown id", () => {
  assert.strictEqual(lib.getSample("nope"), null);
});

// ---------------------------------------------------------------------------
// Larger / adversarial inputs
// ---------------------------------------------------------------------------

test("handles a large generated token set quickly", () => {
  const obj = {};
  for (let i = 0; i < 600; i++) {
    obj["color-shade-" + i] = i % 2 ? "{color.base}" : "#0" + (i % 10) + "0000";
  }
  obj["color-base"] = "#123456";
  const parsed = lib.parseTokens(JSON.stringify(obj));
  assert.strictEqual(parsed.ok, true);
  const a = lib.analyzeTokens(parsed.tokens);
  assert.strictEqual(a.tokens.length, 601);
  assert.strictEqual(a.counts.color, 601);
  assert.strictEqual(lib.serialize("css", a.tokens).ok, true);
});

test("deeply nested JSON does not throw", () => {
  let node = { leaf: { $value: "#000" } };
  for (let i = 0; i < 60; i++) node = { ["g" + i]: node };
  const out = lib.parseTokens(JSON.stringify(node));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.tokens.length, 1);
  assert.strictEqual(out.tokens[0].name.split("-").length, 61);
});

test("token values containing markup are treated as plain text", () => {
  const out = lib.parseTokens(JSON.stringify({ "copy-danger": "<script>alert(1)</script>" }));
  const a = lib.analyzeTokens(out.tokens);
  const xml = lib.serialize("android", a.tokens).output;
  assert.ok(!xml.includes("<script>"), "markup must not appear unescaped");
  assert.match(xml, /&lt;script&gt;/);
});

test("a reference cycle does not hang and is reported", () => {
  const out = lib.parseTokens(JSON.stringify({ "a-x": "{b.x}", "b-x": "{a.x}" }));
  const a = lib.analyzeTokens(out.tokens);
  assert.ok(a.issues.cycles.length >= 1);
});

test("quoted CSS values with braces and semicolons parse correctly", () => {
  const css = ':root {\n  --font-stack: "Menlo, monospace";\n  --content: "a; b {c}";\n}';
  const out = lib.parseTokens(css);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.tokens.length, 2);
  assert.strictEqual(out.tokens[0].value, '"Menlo, monospace"');
  assert.strictEqual(out.tokens[1].value, '"a; b {c}"');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  console.log("design-token-studio tests");
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log("  ok - " + name);
    } catch (err) {
      failed++;
      console.error("  FAIL - " + name);
      console.error("         " + (err && err.message));
    }
  }
  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
