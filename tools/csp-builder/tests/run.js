"use strict";

const assert = require("node:assert");
const csp = require("../tool.js");

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

console.log("csp-builder tests");

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parses a bare policy into directives", () => {
  const p = csp.parseCSP("default-src 'self'; script-src 'self' https://cdn.example.com");
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.directives["default-src"], ["'self'"]);
  assert.deepStrictEqual(p.directives["script-src"], ["'self'", "https://cdn.example.com"]);
  assert.deepStrictEqual(p.order, ["default-src", "script-src"]);
});

test("parses a full header line", () => {
  const p = csp.parseCSP("Content-Security-Policy: default-src 'none'; img-src *");
  assert.deepStrictEqual(p.directives["default-src"], ["'none'"]);
  assert.deepStrictEqual(p.directives["img-src"], ["*"]);
  assert.strictEqual(p.reportOnly, false);
});

test("detects report-only headers", () => {
  const p = csp.parseCSP("Content-Security-Policy-Report-Only: default-src 'self'");
  assert.strictEqual(p.reportOnly, true);
  assert.deepStrictEqual(p.directives["default-src"], ["'self'"]);
});

test("parses a meta tag", () => {
  const p = csp.parseCSP('<meta http-equiv="Content-Security-Policy" content="default-src &apos;self&apos;; img-src https:">');
  assert.deepStrictEqual(p.directives["default-src"], ["'self'"]);
  assert.deepStrictEqual(p.directives["img-src"], ["https:"]);
});

test("handles multiple policies separated by newlines", () => {
  const p = csp.parseCSP("default-src 'self'\nscript-src 'self'");
  assert.deepStrictEqual(p.directives["default-src"], ["'self'"]);
  assert.deepStrictEqual(p.directives["script-src"], ["'self'"]);
});

test("does not split on commas inside a source", () => {
  const p = csp.parseCSP("img-src data: 'self'");
  assert.deepStrictEqual(p.directives["img-src"], ["data:", "'self'"]);
});

test("handles a comma-separated policy", () => {
  const p = csp.parseCSP("default-src 'self', script-src 'self'");
  assert.deepStrictEqual(p.directives["default-src"], ["'self'"]);
  assert.deepStrictEqual(p.directives["script-src"], ["'self'"]);
});

test("keeps a valueless directive", () => {
  const p = csp.parseCSP("default-src 'self'; upgrade-insecure-requests");
  assert.deepStrictEqual(p.directives["upgrade-insecure-requests"], []);
});

test("flags a duplicated directive", () => {
  const p = csp.parseCSP("default-src 'self'; default-src 'none'");
  assert.ok(p.warnings.some(w => /more than once/.test(w)));
});

test("empty input reports an error", () => {
  const p = csp.parseCSP("");
  assert.strictEqual(p.ok, false);
  assert.ok(p.errors.length > 0);
});

test("directive names are case-insensitive", () => {
  const p = csp.parseCSP("DEFAULT-SRC 'self'");
  assert.deepStrictEqual(p.directives["default-src"], ["'self'"]);
});

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

test("builds a sorted policy", () => {
  const out = csp.buildPolicy({ "script-src": ["'self'"], "default-src": ["'none'"] });
  assert.strictEqual(out, "default-src 'none'; script-src 'self'");
});

test("builds a valueless directive", () => {
  const out = csp.buildPolicy({ "upgrade-insecure-requests": [] });
  assert.strictEqual(out, "upgrade-insecure-requests");
});

test("accepts string values in the map", () => {
  const out = csp.buildPolicy({ "img-src": "'self' data:" });
  assert.strictEqual(out, "img-src 'self' data:");
});

test("round-trips a parsed policy", () => {
  const original = "connect-src 'self'; default-src 'none'; script-src 'self'";
  const parsed = csp.parseCSP(original);
  assert.strictEqual(csp.buildPolicy(parsed.directives), original);
});

// ---------------------------------------------------------------------------
// Fallback resolution
// ---------------------------------------------------------------------------

test("script-src-elem falls back to script-src then default-src", () => {
  const p = csp.parseCSP("default-src 'none'; script-src 'self'");
  assert.strictEqual(csp.effectiveSources(p, "script-src-elem").from, "script-src");
});

test("worker-src falls back through child-src and script-src", () => {
  const p = csp.parseCSP("default-src 'none'; script-src 'self'");
  assert.strictEqual(csp.effectiveSources(p, "worker-src").from, "script-src");
});

test("frame-src falls back to child-src then default-src", () => {
  const p = csp.parseCSP("default-src 'self'");
  assert.strictEqual(csp.effectiveSources(p, "frame-src").from, "default-src");
});

test("an unset directive with no default-src resolves to nothing", () => {
  const p = csp.parseCSP("script-src 'self'");
  assert.strictEqual(csp.effectiveSources(p, "img-src").sources, null);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("strict preset produces no errors", () => {
  const parsed = csp.parseCSP(csp.buildPolicy(csp.applyPreset("strict")));
  const v = csp.validatePolicy(parsed);
  assert.deepStrictEqual(v.errors, []);
});

test("warns about unsafe-inline in script-src", () => {
  const parsed = csp.parseCSP("default-src 'self'; script-src 'unsafe-inline'");
  const v = csp.validatePolicy(parsed);
  assert.ok(v.warnings.some(w => /unsafe-inline/.test(w)));
});

test("warns about a wildcard source", () => {
  const parsed = csp.parseCSP("default-src *");
  const v = csp.validatePolicy(parsed);
  assert.ok(v.warnings.some(w => /wildcard/.test(w)));
});

test("warns about plaintext http sources", () => {
  const parsed = csp.parseCSP("default-src 'self'; connect-src http://api.example.com");
  const v = csp.validatePolicy(parsed);
  assert.ok(v.warnings.some(w => /insecure/.test(w)));
});

test("warns when default-src is missing", () => {
  const parsed = csp.parseCSP("script-src 'self'");
  const v = csp.validatePolicy(parsed);
  assert.ok(v.warnings.some(w => /no default-src/.test(w)));
});

test("warns when object-src is not 'none'", () => {
  const parsed = csp.parseCSP("default-src 'self'");
  const v = csp.validatePolicy(parsed);
  assert.ok(v.warnings.some(w => /object-src should be 'none'/.test(w)));
});

test("accepts a nonce source", () => {
  const parsed = csp.parseCSP("default-src 'none'; script-src 'nonce-abcdefghijklmnop'");
  const v = csp.validatePolicy(parsed);
  assert.deepStrictEqual(v.errors, []);
  assert.ok(!v.warnings.some(w => /nonce/.test(w)));
});

test("flags a very short nonce", () => {
  const parsed = csp.parseCSP("default-src 'none'; script-src 'nonce-abc'");
  const v = csp.validatePolicy(parsed);
  assert.ok(v.warnings.some(w => /nonce is very short/.test(w)));
});

test("flags an unknown keyword source", () => {
  const parsed = csp.parseCSP("default-src 'unsafe-whatever'");
  const v = csp.validatePolicy(parsed);
  assert.ok(v.warnings.some(w => /unknown keyword/.test(w)));
});

test("errors on a source given to sandbox", () => {
  const parsed = csp.parseCSP("sandbox https://example.com");
  const v = csp.validatePolicy(parsed);
  assert.ok(v.errors.some(e => /sandbox takes tokens/.test(e)));
});

test("accepts sandbox tokens", () => {
  const parsed = csp.parseCSP("sandbox allow-scripts allow-forms");
  const v = csp.validatePolicy(parsed);
  assert.deepStrictEqual(v.errors, []);
});

test("warns when report-uri is not an absolute URL", () => {
  const parsed = csp.parseCSP("default-src 'self'; report-uri /csp-report");
  const v = csp.validatePolicy(parsed);
  assert.ok(v.warnings.some(w => /absolute URL/.test(w)));
});

test("warns when a valueless directive is given values", () => {
  const parsed = csp.parseCSP("upgrade-insecure-requests 'self'");
  const v = csp.validatePolicy(parsed);
  assert.ok(v.warnings.some(w => /does not take any values/.test(w)));
});

test("notes that 'unsafe-inline' is ignored when a nonce is present", () => {
  const parsed = csp.parseCSP("default-src 'none'; script-src 'unsafe-inline' 'nonce-abcdefghijklmnop'");
  const v = csp.validatePolicy(parsed);
  assert.ok(v.info.some(i => /ignored by modern browsers/.test(i)));
});

// ---------------------------------------------------------------------------
// Merge / intersect
// ---------------------------------------------------------------------------

test("intersect keeps shared sources", () => {
  const a = csp.parseCSP("script-src 'self' https://a.example.com");
  const b = csp.parseCSP("script-src 'self' https://b.example.com");
  const out = csp.intersectPolicies(a, b);
  assert.deepStrictEqual(out.directives["script-src"], ["'self'"]);
});

test("intersect yields 'none' when nothing is shared", () => {
  const a = csp.parseCSP("script-src 'self'");
  const b = csp.parseCSP("script-src https://b.example.com");
  const out = csp.intersectPolicies(a, b);
  assert.deepStrictEqual(out.directives["script-src"], ["'none'"]);
  assert.strictEqual(out.notes.length, 1);
});

test("intersect inherits a directive only one policy sets", () => {
  const a = csp.parseCSP("default-src 'self'; img-src 'self'");
  const b = csp.parseCSP("default-src 'self'");
  const out = csp.intersectPolicies(a, b);
  assert.deepStrictEqual(out.directives["img-src"], ["'self'"]);
});

test("merge lets later policies win", () => {
  const a = csp.parseCSP("default-src 'none'; script-src 'self'");
  const b = csp.parseCSP("script-src 'self' https://cdn.example.com");
  const out = csp.mergePolicies([a, b]);
  assert.deepStrictEqual(out.directives["script-src"], ["'self'", "https://cdn.example.com"]);
  assert.deepStrictEqual(out.directives["default-src"], ["'none'"]);
});

// ---------------------------------------------------------------------------
// Explanations
// ---------------------------------------------------------------------------

test("explainPolicy marks inherited directives", () => {
  const p = csp.parseCSP("default-src 'self'");
  const rows = csp.explainPolicy(p);
  const script = rows.find(r => r.name === "script-src");
  assert.strictEqual(script.set, false);
  assert.strictEqual(script.inheritedFrom, "default-src");
  assert.ok(script.description.length > 0);
});

test("explainPolicy marks set directives", () => {
  const p = csp.parseCSP("default-src 'self'; script-src 'self'");
  const rows = csp.explainPolicy(p);
  const script = rows.find(r => r.name === "script-src");
  assert.strictEqual(script.set, true);
  assert.strictEqual(script.inheritedFrom, null);
});

test("every catalogued directive has a description", () => {
  csp.catalog().forEach(d => {
    assert.ok(typeof d.desc === "string" && d.desc.length > 0, d.name);
    assert.ok(csp.explainDirective(d.name).length > 0);
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test("strict preset scores grade A", () => {
  const p = csp.parseCSP(csp.buildPolicy(csp.applyPreset("strict")));
  const a = csp.auditPolicy(p);
  assert.strictEqual(a.grade, "A");
  assert.ok(a.score >= 90);
});

test("baseline preset scores at least A or B", () => {
  const p = csp.parseCSP(csp.buildPolicy(csp.applyPreset("baseline")));
  const a = csp.auditPolicy(p);
  assert.ok(["A", "B"].includes(a.grade));
});

test("a permissive policy scores badly", () => {
  const p = csp.parseCSP("default-src *; script-src 'unsafe-inline' 'unsafe-eval' http:");
  const a = csp.auditPolicy(p);
  assert.ok(["D", "F"].includes(a.grade));
  assert.ok(a.findings.some(f => f.level === "bad"));
});

test("audit findings carry levels", () => {
  const p = csp.parseCSP("default-src 'self'; object-src 'none'");
  const a = csp.auditPolicy(p);
  a.findings.forEach(f => assert.ok(["good", "warn", "info", "bad"].includes(f.level)));
});

// ---------------------------------------------------------------------------
// Export formats
// ---------------------------------------------------------------------------

const POLICY = "default-src 'self'; script-src 'self'";

test("exports a header", () => {
  assert.strictEqual(csp.exportPolicy("header", POLICY), "Content-Security-Policy: " + POLICY);
});

test("exports a meta tag with escaped content", () => {
  const out = csp.exportPolicy("meta", POLICY);
  assert.ok(out.startsWith("<meta http-equiv=\"Content-Security-Policy\" content=\""));
  assert.ok(out.endsWith("\">"));
  assert.ok(out.includes("default-src 'self'"));
});

test("escapes quotes in a meta tag", () => {
  const out = csp.exportPolicy("meta", 'img-src "weird"');
  assert.ok(out.includes("&quot;weird&quot;"));
});

test("exports Apache config", () => {
  const out = csp.exportPolicy("apache", POLICY);
  assert.ok(out.startsWith("Header always set Content-Security-Policy \""));
});

test("exports Nginx config", () => {
  const out = csp.exportPolicy("nginx", POLICY);
  assert.strictEqual(out, "add_header Content-Security-Policy \"" + POLICY + "\" always;");
});

test("exports a Netlify _headers block", () => {
  const out = csp.exportPolicy("netlify", POLICY);
  assert.ok(out.startsWith("/*\n  Content-Security-Policy: "));
});

test("exports Cloudflare instructions", () => {
  const out = csp.exportPolicy("cloudflare", POLICY);
  assert.ok(out.includes("Content-Security-Policy"));
  assert.ok(out.includes(POLICY));
});

test("report-only export uses the report-only header name", () => {
  const out = csp.exportPolicy("report-only", POLICY);
  assert.ok(out.startsWith("Content-Security-Policy-Report-Only: "));
});

test("exporting a parsed report-only object keeps the report-only header", () => {
  const parsed = csp.parseCSP("Content-Security-Policy-Report-Only: default-src 'self'");
  const out = csp.exportPolicy("header", parsed);
  assert.ok(out.startsWith("Content-Security-Policy-Report-Only: "));
});

test("exports JSON with the header and value", () => {
  const parsed = csp.parseCSP(POLICY);
  const out = JSON.parse(csp.exportPolicy("json", parsed));
  assert.strictEqual(out.header, "Content-Security-Policy");
  assert.strictEqual(out.value, POLICY);
  assert.deepStrictEqual(out.directives["default-src"], ["'self'"]);
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

test("preset names are exposed", () => {
  const names = csp.presetNames();
  assert.ok(names.includes("strict"));
  assert.ok(names.includes("baseline"));
});

test("applyPreset returns a copy, not the shared object", () => {
  const a = csp.applyPreset("strict");
  a["default-src"] = "'unsafe-inline'";
  const b = csp.applyPreset("strict");
  assert.deepStrictEqual(b["default-src"], ["'none'"]);
});

test("unknown preset returns an empty map", () => {
  assert.deepStrictEqual(csp.applyPreset("nope"), {});
});

// ---------------------------------------------------------------------------
// End-to-end
// ---------------------------------------------------------------------------

test("end-to-end: build strict, validate, audit and export", () => {
  const built = csp.buildPolicy(csp.applyPreset("strict"));
  const parsed = csp.parseCSP(built);
  assert.strictEqual(parsed.ok, true);
  assert.deepStrictEqual(csp.validatePolicy(parsed).errors, []);
  assert.strictEqual(csp.auditPolicy(parsed).grade, "A");
  const header = csp.exportPolicy("header", parsed);
  assert.ok(header.includes("object-src 'none'"));
  assert.ok(header.includes("frame-ancestors 'none'"));
});

test("end-to-end: a nonce policy with reporting validates cleanly", () => {
  const policy = "default-src 'none'; script-src 'nonce-0123456789abcdef' 'strict-dynamic'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; report-to csp-endpoint";
  const parsed = csp.parseCSP(policy);
  const v = csp.validatePolicy(parsed);
  assert.deepStrictEqual(v.errors, []);
  assert.ok(!v.warnings.some(w => /nonce is very short/.test(w)));
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
