"use strict";

const assert = require("node:assert");
const svg = require("../tool.js");

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

console.log("svg-optimizer tests");

// ---------------------------------------------------------------------------
// XML parsing
// ---------------------------------------------------------------------------

test("parses a minimal SVG into a tree", () => {
  const p = svg.parseXML('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(svg.localName(p.root.name), "svg");
  assert.strictEqual(p.root.children.length, 1);
  assert.strictEqual(p.root.children[0].name, "rect");
});

test("decodes named and numeric entities in text and attributes", () => {
  const p = svg.parseXML('<svg><title>a &amp; b &#65; &#x42;</title><text x="1">x &lt; y</text></svg>');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.root.children[0].children[0].value, "a & b A B");
  assert.strictEqual(p.root.children[1].children[0].value, "x < y");
});

test("reports a mismatched closing tag with a line and column", () => {
  const p = svg.parseXML('<svg>\n  <g>\n  </defs>\n</svg>');
  assert.strictEqual(p.ok, false);
  assert.match(p.error.message, /Mismatched closing tag/);
  assert.strictEqual(p.error.line, 3);
  assert.ok(p.error.column > 0);
});

test("reports an unclosed element", () => {
  const p = svg.parseXML('<svg><g><rect/></svg>');
  assert.strictEqual(p.ok, false);
  assert.match(p.error.message, /Mismatched closing tag|Unclosed element/);
});

test("reports unterminated comments and CDATA", () => {
  assert.match(svg.parseXML("<svg><!-- oops</svg>").error.message, /Unterminated comment/);
  assert.match(svg.parseXML("<svg><![CDATA[oops</svg>").error.message, /Unterminated CDATA/);
});

test("rejects unquoted attribute values", () => {
  const p = svg.parseXML("<svg width=10></svg>");
  assert.strictEqual(p.ok, false);
  assert.match(p.error.message, /must be quoted/);
});

test("handles DOCTYPE with an internal subset", () => {
  const p = svg.parseXML('<!DOCTYPE svg [<!ENTITY x "y">]><svg><rect/></svg>');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.nodes[0].type, "doctype");
  assert.strictEqual(svg.localName(p.root.name), "svg");
});

test("an empty string is not valid XML", () => {
  const p = svg.parseXML("");
  assert.strictEqual(p.ok, false);
  assert.match(p.error.message, /No root element/);
});

// ---------------------------------------------------------------------------
// Number and path formatting
// ---------------------------------------------------------------------------

test("formats numbers with trailing zeros removed", () => {
  assert.strictEqual(svg.formatNumber(12.5, 2), "12.5");
  assert.strictEqual(svg.formatNumber(12.0, 2), "12");
  assert.strictEqual(svg.formatNumber(0, 2), "0");
  assert.strictEqual(svg.formatNumber(-0.0001, 2), "0");
  assert.strictEqual(svg.formatNumber(2.345, 2), "2.35");
  assert.strictEqual(svg.formatNumber(1.005, 2), "1"); // (1.005).toFixed(2) is "1.00"
});

test("rounds numbers inside an attribute value but keeps units", () => {
  assert.strictEqual(svg.roundAttributeValue("10.12345px", 2), "10.12px");
  assert.strictEqual(svg.roundAttributeValue("0 0 24.98765 24.98765", 2), "0 0 24.99 24.99");
  assert.strictEqual(svg.roundAttributeValue("50%", 2), "50%");
});

test("normalizes path data spacing and rounds coordinates", () => {
  const out = svg.optimizePathData("M 10.0000,20.0000  L30.1234,40.5678 Z", 2);
  assert.strictEqual(out, "M10 20 L30.12 40.57Z");
});

test("keeps the command sequence of a path intact", () => {
  const input = "M0 0h10v10h-10z";
  const out = svg.optimizePathData(input, 2);
  assert.strictEqual(out.replace(/\s+/g, ""), "M0 0h10v10h-10z".replace(/\s+/g, ""));
});

test("handles an empty or whitespace path", () => {
  assert.strictEqual(svg.optimizePathData("", 2), "");
  assert.strictEqual(svg.optimizePathData("   ", 2), "");
});

test("compacts arc flag syntax without changing the numbers", () => {
  const out = svg.optimizePathData("M0 0 A 5 5 0 1 1 10 10", 2);
  assert.match(out, /A5 5 0 11 10 10/);
});

test("keeps the space before an arc flag when the rotation is fractional", () => {
  const out = svg.optimizePathData("M0 0 A 5 5 0.5 1 1 10 10", 2);
  assert.match(out, /A5 5 0\.5 11 10 10/);
});

// ---------------------------------------------------------------------------
// Colors and contrast
// ---------------------------------------------------------------------------

test("parses hex, short hex, rgb() and named colors", () => {
  assert.deepStrictEqual(svg.parseColor("#f00"), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepStrictEqual(svg.parseColor("#ff0000"), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepStrictEqual(svg.parseColor("rgb(255, 0, 0)"), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepStrictEqual(svg.parseColor("red"), { r: 255, g: 0, b: 0, a: 1 });
  assert.strictEqual(svg.parseColor("none"), null);
  assert.strictEqual(svg.parseColor("currentColor"), null);
  assert.strictEqual(svg.parseColor("not-a-color"), null);
});

test("minifies a color to the shortest hex form", () => {
  assert.strictEqual(svg.shortestHex(svg.parseColor("#ffffff")), "#fff");
  assert.strictEqual(svg.shortestHex(svg.parseColor("#ff0000")), "#f00");
  assert.strictEqual(svg.shortestHex(svg.parseColor("#123456")), "#123456");
});

test("computes WCAG contrast ratios", () => {
  const black = svg.parseColor("#000");
  const white = svg.parseColor("#fff");
  assert.strictEqual(svg.contrastRatio(black, white).toFixed(2), "21.00");
  assert.strictEqual(svg.contrastRatio(black, black).toFixed(2), "1.00");
});

// ---------------------------------------------------------------------------
// Optimize: structure
// ---------------------------------------------------------------------------

test("removes comments, metadata and the XML declaration", () => {
  const input = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><!-- note --><metadata>x</metadata><rect width="1" height="1"/></svg>';
  const r = svg.optimize(input);
  assert.strictEqual(r.ok, true);
  assert.ok(!r.output.includes("<!--"));
  assert.ok(!r.output.includes("<metadata"));
  assert.ok(!r.output.includes("<?xml"));
  assert.strictEqual(r.stats.removedComments, 1);
  assert.strictEqual(r.stats.removedMetadata, 1);
  assert.strictEqual(r.stats.removedProlog, 1);
});

test("keeps <title> and <desc> for accessibility", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><title>Logo</title><desc>Round mark</desc><rect width="1" height="1"/></svg>';
  const r = svg.optimize(input);
  assert.ok(r.output.includes("<title>Logo</title>"));
  assert.ok(r.output.includes("<desc>Round mark</desc>"));
  assert.strictEqual(r.audit.hasTitle, true);
  assert.strictEqual(r.audit.hasDesc, true);
});

test("removes editor namespaces and their elements", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd"><sodipodi:namedview id="x"/><rect width="1" height="1"/></svg>';
  const r = svg.optimize(input);
  assert.ok(!r.output.includes("sodipodi"));
  assert.strictEqual(r.stats.removedEditorData, 1);
});

test("keeps a namespace prefix that is still used", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/><defs><rect id="a"/></defs></svg>';
  const r = svg.optimize(input);
  assert.ok(r.output.includes('xmlns:xlink'));
  assert.ok(r.output.includes('xlink:href="#a"'));
});

test("drops an empty container", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><defs></defs><g/><rect width="1" height="1"/></svg>';
  const r = svg.optimize(input);
  assert.ok(!r.output.includes("<defs"));
  assert.ok(!r.output.includes("<g"));
  assert.strictEqual(r.stats.removedEmptyContainers, 2);
});

test("collapses a plain group holding one element", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="1" height="1"/></g></svg>';
  const r = svg.optimize(input);
  assert.ok(!r.output.includes("<g"));
  assert.strictEqual(r.stats.collapsedGroups, 1);
  assert.ok(r.output.includes("<rect"));
});

test("keeps a group that carries its own attributes", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><g fill="#f00"><rect width="1" height="1"/></g></svg>';
  const r = svg.optimize(input);
  assert.ok(r.output.includes("<g"));
  assert.strictEqual(r.stats.collapsedGroups, 0);
});

test("keeps a group with multiple children", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="1" height="1"/><rect width="2" height="2"/></g></svg>';
  const r = svg.optimize(input);
  assert.ok(r.output.includes("<g"));
});

test("removes attributes set to their own default", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="4" height="4"/></svg>';
  const r = svg.optimize(input);
  assert.ok(!/ x="0"/.test(r.output));
  assert.ok(!/ y="0"/.test(r.output));
  assert.ok(r.output.includes('width="4"'));
  assert.strictEqual(r.stats.removedDefaults, 2);
});

test("removes whitespace between elements but keeps text content", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg">\n  <text x="1" y="2">  hello  </text>\n  <rect width="1" height="1"/>\n</svg>';
  const r = svg.optimize(input);
  assert.ok(r.output.includes(">  hello  <"));
  assert.strictEqual(r.stats.removedWhitespace, 3);
});

test("rounds numeric attributes to the configured precision", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="1.23456" y="2.34567" width="3.45678" height="4.56789"/></svg>';
  const r = svg.optimize(input, { numberPrecision: 2 });
  assert.ok(r.output.includes('x="1.23"'));
  assert.ok(r.output.includes('y="2.35"'));
  assert.ok(r.output.includes('width="3.46"'));
});

test("minifies colors in fill and stroke", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#ffffff" stroke="rgb(255, 0, 0)" width="1" height="1"/></svg>';
  const r = svg.optimize(input);
  assert.ok(r.output.includes('fill="#fff"'));
  assert.ok(r.output.includes('stroke="#f00"'));
  assert.strictEqual(r.stats.minifiedColors, 2);
});

test("sorts attributes deterministically", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><rect height="1" width="2" fill="#000"/></svg>';
  const r = svg.optimize(input);
  const rect = r.output.slice(r.output.indexOf("<rect"));
  assert.match(rect, /^<rect fill="#000" height="1" width="2"\/>/);
});

test("removes width/height only when a viewBox is present", () => {
  const withBox = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="1" height="1"/></svg>', { removeDimensions: true });
  assert.ok(!/ width="24"/.test(withBox.output));
  assert.strictEqual(withBox.stats.removedDimensions, 2);

  const noBox = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="1" height="1"/></svg>', { removeDimensions: true });
  assert.ok(/ width="24"/.test(noBox.output));
  assert.strictEqual(noBox.stats.removedDimensions, 0);
});

// ---------------------------------------------------------------------------
// Optimize: id shortening
// ---------------------------------------------------------------------------

test("shortens ids and rewrites url(#id) references", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="aVeryLongGradientName"><stop stop-color="#000"/></linearGradient></defs><rect fill="url(#aVeryLongGradientName)" width="1" height="1"/></svg>';
  const r = svg.optimize(input, { shortenIds: true });
  assert.ok(!r.output.includes("aVeryLongGradientName"));
  assert.ok(/id="a"/.test(r.output));
  assert.ok(r.output.includes("url(#a)"));
  assert.strictEqual(r.stats.shortenedIds, 1);
});

test("rewrites href and xlink:href id references", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="longPathId" d="M0 0"/></defs><use xlink:href="#longPathId"/></svg>';
  const r = svg.optimize(input, { shortenIds: true });
  assert.ok(r.output.includes('xlink:href="#a"'));
  assert.ok(r.output.includes('id="a"'));
});

test("rewrites url(#id) inside a <style> block", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gradientLongName"><stop stop-color="#000"/></linearGradient></defs><style>.a{fill:url(#gradientLongName)}</style><rect class="a" width="1" height="1"/></svg>';
  const r = svg.optimize(input, { shortenIds: true });
  assert.ok(r.output.includes("url(#a)"));
  assert.ok(!r.output.includes("gradientLongName"));
});

test("never shortens an id to one that is still in the document", () => {
  // "b" already exists, so the first free name must not be "b".
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><defs><rect id="b"/><rect id="firstLongId"/></defs><rect width="1" height="1"/></svg>';
  const r = svg.optimize(input, { shortenIds: true });
  const ids = r.output.match(/id="[^"]+"/g).map(function (m) { return m.slice(4, -1); });
  assert.strictEqual(new Set(ids).size, ids.length, "ids must stay unique: " + ids.join(", "));
  assert.ok(ids.includes("b"));
});

test("leaves ids alone when shortenIds is off", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><defs><rect id="keepMe"/></defs><rect width="1" height="1"/></svg>';
  const r = svg.optimize(input);
  assert.ok(r.output.includes('id="keepMe"'));
  assert.strictEqual(r.stats.shortenedIds, 0);
});

// ---------------------------------------------------------------------------
// Optimize: output shape and reporting
// ---------------------------------------------------------------------------

test("optimize returns byte and element counts", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg">\n  <!-- c -->\n  <rect width="1.2345" height="1"/>\n</svg>';
  const r = svg.optimize(input);
  assert.strictEqual(r.before.elements, 2);
  assert.strictEqual(r.after.elements, 2);
  assert.ok(r.savedBytes > 0);
  assert.ok(r.savedPercent > 0 && r.savedPercent < 1);
  assert.strictEqual(r.after.bytes, svg.byteLength(r.output));
});

test("pretty output is multi-line and reparses to the same bytes", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="1" height="1"/></g></svg>';
  const r = svg.optimize(input);
  assert.ok(r.prettyOutput.includes("\n"));
  const reparsed = svg.optimize(r.prettyOutput);
  assert.strictEqual(reparsed.ok, true);
  assert.strictEqual(reparsed.after.bytes, r.after.bytes);
});

test("minify is stable and idempotent", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
  const once = svg.optimize(input).output;
  const twice = svg.optimize(once).output;
  assert.strictEqual(once, twice);
});

test("escaping is applied to text and attribute values on output", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="2">a &amp; b &lt; c</text><rect fill="x" data-x="&quot;q&quot;"/></svg>';
  const r = svg.optimize(input);
  assert.ok(r.output.includes("a &amp; b &lt; c"));
  assert.ok(r.output.includes("&quot;q&quot;"));
});

test("rejects a document whose root is not <svg>", () => {
  const r = svg.optimize('<html><body>hi</body></html>');
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /not <svg>/);
});

test("returns a parse error object for malformed input", () => {
  const r = svg.optimize('<svg><g></svg>');
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.error.line === "number");
  assert.ok(typeof r.error.column === "number");
});

test("toReport renders a parse failure instead of throwing", () => {
  const report = svg.toReport(svg.optimize("<svg><g></svg>"));
  assert.match(report, /Could not parse/);
});

test("toReport lists changes and review findings", () => {
  const r = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg"><!-- c --><rect width="1" height="1"/></svg>');
  const report = svg.toReport(r);
  assert.match(report, /## Size/);
  assert.match(report, /Comments removed/);
  assert.match(report, /## Review/);
  assert.match(report, /No viewBox/);
});

test("byteLength matches Buffer.byteLength for non-ASCII input", () => {
  const text = "<text>café — ☕</text>";
  assert.strictEqual(svg.byteLength(text), Buffer.byteLength(text, "utf8"));
});

// ---------------------------------------------------------------------------
// Audit: accessibility and security
// ---------------------------------------------------------------------------

test("flags a script element as an error", () => {
  const r = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>');
  assert.ok(r.audit.hasScript);
  assert.ok(r.audit.issues.some(function (i) { return i.code === "script-tag" && i.level === "error"; }));
});

test("flags event handler attributes as an error", () => {
  const r = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>');
  assert.ok(r.audit.issues.some(function (i) { return i.code === "event-handler" && i.level === "error"; }));
});

test("flags javascript: links but accepts ordinary ones", () => {
  const bad = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>');
  assert.ok(bad.audit.issues.some(function (i) { return i.code === "dangerous-uri" && i.level === "error"; }));

  const good = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><rect width="1" height="1"/></a></svg>');
  assert.ok(!good.audit.issues.some(function (i) { return i.code === "dangerous-uri"; }));
});

test("warns about an SVG data: URI without treating it as a plain error", () => {
  const r = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml,%3Csvg/%3E" width="1" height="1"/></svg>');
  const issue = r.audit.issues.find(function (i) { return i.code === "data-uri"; });
  assert.ok(issue);
  assert.strictEqual(issue.level, "warn");
});

test("warns about a missing viewBox and a missing title", () => {
  const r = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
  assert.ok(r.audit.issues.some(function (i) { return i.code === "no-viewbox" && i.level === "warn"; }));
  assert.ok(r.audit.issues.some(function (i) { return i.code === "no-title" && i.level === "warn"; }));
});

test("reports low-contrast color pairs", () => {
  const r = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="#ffffff" width="10" height="10"/><rect fill="#f2f2f2" width="5" height="5"/></svg>');
  assert.ok(r.audit.contrasts.length >= 1);
  assert.ok(r.audit.contrasts[0].ratio < 3);
});

test("a clean, accessible SVG has no errors", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" width="24" height="24"><title>Circle</title><desc>A red circle</desc><circle cx="12" cy="12" r="10" fill="#b3402a"/></svg>';
  const r = svg.optimize(input);
  assert.strictEqual(r.audit.issues.filter(function (i) { return i.level === "error"; }).length, 0);
  assert.ok(r.audit.hasTitle && r.audit.hasDesc);
});

test("role on the root is detected, so no-role is not reported", () => {
  const withRole = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img"><title>t</title><rect width="1" height="1"/></svg>');
  assert.strictEqual(withRole.audit.hasRole, true);
  assert.ok(!withRole.audit.issues.some(function (i) { return i.code === "no-role"; }));

  const withoutRole = svg.optimize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>t</title><rect width="1" height="1"/></svg>');
  assert.strictEqual(withoutRole.audit.hasRole, false);
  assert.ok(withoutRole.audit.issues.some(function (i) { return i.code === "no-role"; }));
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test("every optimization can be turned off", () => {
  const input = '<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><metadata>m</metadata><g><rect fill="#ffffff" x="0" y="0" width="1.2345" height="1"/></g></svg>';
  const r = svg.optimize(input, {
    removeComments: false, removeMetadata: false, removeEditorData: false,
    removeEmptyContainers: false, collapseGroups: false, removeDefaults: false,
    trimWhitespace: false, roundNumbers: false, optimizePaths: false,
    minifyColors: false, sortAttributes: false, shortenIds: false, removeDimensions: false
  });
  assert.ok(r.output.includes("<!-- c -->"));
  assert.ok(r.output.includes("<metadata>"));
  assert.ok(r.output.includes("<g>"));
  assert.ok(r.output.includes('fill="#ffffff"'));
  assert.ok(r.output.includes('width="1.2345"'));
});

test("defaultOptions clamps precision and ignores unknown keys", () => {
  const o = svg.defaultOptions({ numberPrecision: 99, nonsense: true });
  assert.strictEqual(o.numberPrecision, 6);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(o, "nonsense"), false);
  assert.strictEqual(svg.defaultOptions({ numberPrecision: -5 }).numberPrecision, 0);
});

// ---------------------------------------------------------------------------
// Robustness and security-oriented input
// ---------------------------------------------------------------------------

test("does not throw on adversarial input", () => {
  const nasty = [
    '<svg xmlns="http://www.w3.org/2000/svg">' + "<g>".repeat(2000) + "</g>".repeat(2000) + "</svg>",
    "<svg>" + "<".repeat(5000) + "</svg>",
    "<svg>" + "&".repeat(5000) + "</svg>",
    "<svg><![CDATA[" + "]".repeat(2000) + "]]></svg>",
    "<svg " + 'a="1" '.repeat(3000) + "></svg>"
  ];
  for (const input of nasty) {
    assert.doesNotThrow(function () { svg.optimize(input); });
  }
});

test("never executes embedded expressions or scripts", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><title>${process.exit(1)}</title><script>require("fs")</script></svg>';
  const r = svg.optimize(input);
  assert.ok(r.output.includes("${process.exit(1)}"));
  // The script element is preserved (it is reported, not silently executed).
  assert.ok(r.output.includes("<script>"));
  assert.ok(r.audit.hasScript);
});

test("escapes injected markup in text so it cannot become a new element", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title></svg>';
  const r = svg.optimize(input);
  assert.ok(!r.output.includes("<script"));
  assert.ok(r.output.includes("&lt;script>"));
});

test("handles an SVG with a large but realistic number of elements", () => {
  const parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">'];
  for (let i = 0; i < 3000; i++) {
    parts.push('<rect x="' + (i % 100) + '.123" y="' + (i % 77) + '.456" width="3.5" height="3.5" fill="#ff0000"/>');
  }
  parts.push("</svg>");
  const r = svg.optimize(parts.join(""));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.after.elements, 3001); // <svg> plus 3000 rects
  assert.ok(r.savedBytes > 0);
});

test("deterministic output for the same input", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" width="10.5" height="10.5"><g><rect fill="rgb(1,2,3)" width="1"/></g></svg>';
  assert.strictEqual(svg.optimize(input).output, svg.optimize(input).output);
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
