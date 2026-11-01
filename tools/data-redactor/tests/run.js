/* Toolshed Data Redactor — tests. Run with: node tests/run.js
 * Uses Node's built-in assert and requires ../tool.js via its UMD export.
 */
"use strict";

const assert = require("node:assert");
const redactor = require("../tool.js");

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

console.log("data-redactor tests");

// ---------------------------------------------------------------------------
// SHA-256 primitives (verified against published test vectors)
// ---------------------------------------------------------------------------

test("sha256 matches the published vectors", () => {
  assert.strictEqual(
    redactor.sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
  assert.strictEqual(
    redactor.sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.strictEqual(
    redactor.sha256Hex("The quick brown fox jumps over the lazy dog"),
    "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
  );
});

test("sha256 handles multi-block and multi-byte input", () => {
  // Longer than one 64-byte block, exercising the length padding path.
  const long = "a".repeat(200);
  assert.strictEqual(redactor.sha256Hex(long).length, 64);
  // Non-ASCII must be hashed as UTF-8, not UTF-16.
  assert.notStrictEqual(redactor.sha256Hex("caf\u00e9"), redactor.sha256Hex("cafe"));
  assert.strictEqual(redactor.sha256Hex("\u00e9").length, 64);
});

// ---------------------------------------------------------------------------
// Detection — credentials
// ---------------------------------------------------------------------------

test("detects an AWS access key", () => {
  const found = redactor.detect("key=AKIAIOSFODNN7EXAMPLE");
  const aws = found.filter((f) => f.type === "aws-key");
  assert.strictEqual(aws.length, 1);
  assert.strictEqual(aws[0].value, "AKIAIOSFODNN7EXAMPLE");
});

test("detects a GitHub token", () => {
  const found = redactor.detect("token: ghp_" + "a".repeat(36));
  assert.ok(found.some((f) => f.type === "github-token"));
});

test("detects a private key block spanning lines", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nline3\n-----END RSA PRIVATE KEY-----";
  const found = redactor.detect(pem);
  const keys = found.filter((f) => f.type === "private-key");
  assert.strictEqual(keys.length, 1);
  assert.strictEqual(keys[0].value, pem);
});

test("detects a bearer token but not the word Bearer alone", () => {
  const found = redactor.detect("Authorization: Bearer abcdefghijklmnop1234");
  const bearer = found.filter((f) => f.type === "bearer-token");
  assert.strictEqual(bearer.length, 1);
  assert.strictEqual(bearer[0].value, "abcdefghijklmnop1234");
  assert.strictEqual(redactor.detect("Bearer").length, 0);
});

test("detects a connection-string password only, not the whole URI", () => {
  const found = redactor.detect("postgres://admin:s3cr3tP4ss@db.internal:5432/app");
  const cs = found.filter((f) => f.type === "connection-string");
  assert.strictEqual(cs.length, 1);
  assert.strictEqual(cs[0].value, "s3cr3tP4ss");
});

test("detects an assigned secret", () => {
  const found = redactor.detect("password=hunter2supersecret");
  assert.ok(found.some((f) => f.type === "assigned-secret"));
  assert.strictEqual(found.find((f) => f.type === "assigned-secret").value, "hunter2supersecret");
});

test("does not treat a bare key name as an assigned secret", () => {
  const found = redactor.detect("the password field is required");
  assert.strictEqual(found.filter((f) => f.type === "assigned-secret").length, 0);
});

// ---------------------------------------------------------------------------
// Detection — personal data
// ---------------------------------------------------------------------------

test("detects an email address", () => {
  const found = redactor.detect("contact alice.smith+tag@sub.example.co.uk today");
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].type, "email");
  assert.strictEqual(found[0].value, "alice.smith+tag@sub.example.co.uk");
});

test("accepts a card number that passes Luhn and rejects one that fails", () => {
  assert.ok(redactor.detect("4111 1111 1111 1111").some((f) => f.type === "credit-card"));
  assert.strictEqual(redactor.detect("4111 1111 1111 1112").filter((f) => f.type === "credit-card").length, 0);
  // Valid Luhn, hyphenated form.
  assert.ok(redactor.detect("4111-1111-1111-1111").some((f) => f.type === "credit-card"));
});

test("detects a valid IBAN and rejects an invalid check digit", () => {
  assert.ok(redactor.detect("GB82 WEST 1234 5698 7654 32").some((f) => f.type === "iban"));
  assert.strictEqual(redactor.detect("GB83 WEST 1234 5698 7654 32").filter((f) => f.type === "iban").length, 0);
});

test("detects a plausible SSN and rejects impossible prefixes", () => {
  assert.ok(redactor.detect("ssn 123-45-6789").some((f) => f.type === "ssn"));
  assert.strictEqual(redactor.detect("id 000-12-3456").filter((f) => f.type === "ssn").length, 0);
  assert.strictEqual(redactor.detect("id 666-12-3456").filter((f) => f.type === "ssn").length, 0);
});

test("detects an IPv4 address and rejects an out-of-range one", () => {
  assert.ok(redactor.detect("host 192.168.1.10 up").some((f) => f.type === "ipv4"));
  assert.strictEqual(redactor.detect("version 1.2.3.999").filter((f) => f.type === "ipv4").length, 0);
});

test("detects a MAC address", () => {
  assert.ok(redactor.detect("nic 00:1A:2B:3C:4D:5E").some((f) => f.type === "mac"));
});

test("heuristic detectors are off by default and on when enabled", () => {
  const text = "name: Ada Lovelace";
  assert.strictEqual(redactor.detect(text).filter((f) => f.type === "person-name").length, 0);
  const on = redactor.detect(text, { categories: { "person-name": true } });
  assert.ok(on.some((f) => f.type === "person-name" && f.value === "Ada Lovelace"));
});

// ---------------------------------------------------------------------------
// Overlap resolution
// ---------------------------------------------------------------------------

test("a private key block wins over the identifiers inside it", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\ncontact me at a@b.com\n-----END PRIVATE KEY-----";
  const found = redactor.detect(pem);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].type, "private-key");
});

test("a credential beats a lower-severity match at the same offset", () => {
  const found = redactor.detect("postgres://user:p4ssw0rd@example.com:5432/db");
  assert.ok(found.some((f) => f.type === "connection-string"));
  // The password span must be reported, not the broader URL.
  assert.ok(!found.some((f) => f.type === "url"));
});

test("findings are returned in ascending start order and never overlap", () => {
  const text = "a@b.com then 10.0.0.1 then c@d.org";
  const found = redactor.detect(text);
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i].start >= found[i - 1].end, "findings must not overlap");
  }
});

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

const SAMPLE = "mail bob@example.com key password=hunter2supersecret host 10.0.0.7";

test("redact strategy replaces values with typed placeholders", () => {
  const out = redactor.redact(SAMPLE, { strategy: "redact" });
  assert.ok(out.text.includes("[EMAIL_ADDRESS]"));
  assert.ok(out.text.includes("[ASSIGNED_SECRET]"));
  assert.ok(out.text.includes("[IPV4_ADDRESS]"));
  assert.ok(!out.text.includes("bob@example.com"));
  assert.ok(!out.text.includes("hunter2supersecret"));
});

test("mask strategy keeps a short prefix and suffix", () => {
  const out = redactor.redact("card 4111111111111111", { strategy: "mask", maskKeep: 2 });
  assert.ok(/^card 41\*+11$/.test(out.text), "got: " + out.text);
  const email = redactor.redact("mail bob@example.com", { strategy: "mask" });
  assert.ok(email.text.includes("@example.com"), "domain is preserved for readability");
  assert.ok(!email.text.includes("bob@"));
});

test("hash strategy is deterministic, salted and type-scoped", () => {
  const a = redactor.redact("bob@example.com", { strategy: "hash" });
  const b = redactor.redact("bob@example.com", { strategy: "hash" });
  assert.strictEqual(a.text, b.text);
  const salted = redactor.redact("bob@example.com", { strategy: "hash", salt: "pepper" });
  assert.notStrictEqual(a.text, salted.text);
  assert.ok(/^\[?EMAIL_ADDRESS:[0-9a-f]{10}/.test(a.text.replace("[", "")), "got: " + a.text);
});

test("tokenize strategy is stable and per-value", () => {
  const out = redactor.redact("a@b.com a@b.com c@d.com", { strategy: "tokenize" });
  assert.ok(out.text.includes("EMAIL_ADDRESS_1"));
  assert.ok(out.text.includes("EMAIL_ADDRESS_2"));
  assert.ok(!out.text.includes("EMAIL_ADDRESS_3"));
  // Same value always maps to the same token.
  const again = redactor.redact("c@d.com a@b.com a@b.com", { strategy: "tokenize" });
  assert.ok(again.text.includes("EMAIL_ADDRESS_1"));
});

test("remove strategy deletes the value", () => {
  const out = redactor.redact("ip=10.0.0.7.", { strategy: "remove" });
  assert.strictEqual(out.text, "ip=.");
});

test("per-detector strategy overrides the global strategy", () => {
  const out = redactor.redact(SAMPLE, {
    strategy: "redact",
    strategyOverrides: { email: "mask" },
  });
  assert.ok(out.text.includes("@example.com"), "email is masked, not redacted");
  assert.ok(out.text.includes("[ASSIGNED_SECRET]"), "other types keep the global strategy");
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

test("restore reverses a redaction using the returned mapping", () => {
  const original = "reach bob@example.com or 10.0.0.7";
  const out = redactor.redact(original, { strategy: "redact" });
  assert.notStrictEqual(out.text, original);
  assert.strictEqual(redactor.restore(out.text, out.mapping), original);
});

test("restore is longest-token-first so shared prefixes survive", () => {
  const mapping = [
    { replacement: "[EMAIL_ADDRESS]", original: "x@y.com", type: "email" },
    { replacement: "[EMAIL_ADDRESS_1]", original: "p@q.com", type: "email" },
  ];
  assert.strictEqual(
    redactor.restore("a [EMAIL_ADDRESS_1] b [EMAIL_ADDRESS] c", mapping),
    "a p@q.com b x@y.com c"
  );
});

test("restore returns the input unchanged for an empty mapping", () => {
  assert.strictEqual(redactor.restore("nothing here", []), "nothing here");
  assert.strictEqual(redactor.restore("nothing here", null), "nothing here");
});

// ---------------------------------------------------------------------------
// Options and disabling
// ---------------------------------------------------------------------------

test("disabling a detector removes its findings", () => {
  const out = redactor.redact("a@b.com 10.0.0.1", { categories: { email: false } });
  assert.ok(out.text.includes("a@b.com"), "email is left intact");
  assert.ok(out.text.includes("[IPV4_ADDRESS]"), "ipv4 still redacted");
});

test("all detectors can be disabled", () => {
  const off = {};
  redactor.listDetectors().forEach((d) => { off[d.id] = false; });
  const text = "bob@example.com 10.0.0.7";
  assert.strictEqual(redactor.redact(text, { categories: off }).text, text);
});

test("unknown strategy falls back to redact", () => {
  const out = redactor.redact("a@b.com", { strategy: "nonsense" });
  assert.ok(out.text.includes("[EMAIL_ADDRESS]"));
});

test("default options enable every non-heuristic detector", () => {
  const enabled = redactor.defaultOptions();
  redactor.listDetectors().forEach((d) => {
    assert.strictEqual(enabled[d.id], !d.heuristic, d.id);
  });
});

// ---------------------------------------------------------------------------
// Custom terms
// ---------------------------------------------------------------------------

test("custom terms are redacted literally, including regex metacharacters", () => {
  const out = redactor.redact("Project Nightingale is run by Acme (Internal).", {
    customTerms: ["Project Nightingale", "Acme (Internal)"],
  });
  assert.ok(!out.text.includes("Project Nightingale"));
  assert.ok(!out.text.includes("Acme (Internal)"));
  assert.ok(out.text.includes("[CUSTOM_TERM]"));
  assert.strictEqual(out.stats.byType.find((t) => t.id === "custom").count, 2);
});

test("custom terms dedupe, trim and ignore empty entries", () => {
  const out = redactor.redact("zzz zzz", { customTerms: [" zzz ", "zzz", "", "   ", 42] });
  assert.strictEqual(out.stats.total, 2);
});

test("custom terms do not override a higher-severity detector on the same span", () => {
  const out = redactor.redact("admin@example.com", { customTerms: ["admin@example.com"] });
  assert.ok(out.text.includes("[EMAIL_ADDRESS]"));
  assert.ok(!out.text.includes("[CUSTOM_TERM]"));
});

test("no custom terms means no custom findings", () => {
  const out = redactor.redact("nothing custom here", {});
  assert.strictEqual(out.stats.total, 0);
});

// ---------------------------------------------------------------------------
// Empty, malformed and adversarial input
// ---------------------------------------------------------------------------

test("empty input returns no findings and unchanged text", () => {
  assert.deepStrictEqual(redactor.detect(""), []);
  const out = redactor.redact("", {});
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.text, "");
  assert.strictEqual(out.stats.total, 0);
});

test("non-string input is rejected with an error, not a throw", () => {
  const out = redactor.redact(null, {});
  assert.strictEqual(out.ok, false);
  assert.ok(typeof out.error === "string" && out.error.length > 0);
  assert.deepStrictEqual(redactor.detect(undefined), []);
});

test("text with no sensitive values is returned byte-identical", () => {
  const text = "The quick brown fox jumps over the lazy dog.\nNothing to see here.";
  const out = redactor.redact(text, {});
  assert.strictEqual(out.text, text);
  assert.strictEqual(out.stats.total, 0);
});

test("does not hang on adversarial repeated input", () => {
  // A long run of characters that could trigger catastrophic backtracking in a
  // naive email or URL pattern.
  const nasty = "a".repeat(20000) + "@" + "b".repeat(20000) + " http://" + "x".repeat(20000);
  const started = Date.now();
  redactor.detect(nasty);
  assert.ok(Date.now() - started < 4000, "detection should stay fast");
});

test("handles a realistic multi-format log with mixed findings", () => {
  const log = [
    "2024-05-01T10:00:00Z INFO  login user=ada@example.com from 203.0.113.7",
    '2024-05-01T10:00:01Z ERROR {"email":"grace@example.org","card":"4111-1111-1111-1111"}',
    "2024-05-01T10:00:02Z DEBUG token=ghp_" + "z".repeat(36),
    "2024-05-01T10:00:03Z INFO  db postgres://svc:pgP4ssw0rd@db:5432/app",
  ].join("\n");
  const out = redactor.redact(log, { strategy: "redact" });
  assert.ok(out.stats.total >= 5);
  assert.ok(!out.text.includes("ada@example.com"));
  assert.ok(!out.text.includes("grace@example.org"));
  assert.ok(!out.text.includes("4111-1111-1111-1111"));
  assert.ok(!out.text.includes("pgP4ssw0rd"));
  assert.ok(out.text.includes("2024-05-01T10:00:00Z"), "timestamps are untouched");
  assert.ok(out.text.includes("INFO"), "log structure is preserved");
});

test("statistics count unique values separately from occurrences", () => {
  const out = redactor.redact("a@b.com a@b.com c@d.com", {});
  const email = out.stats.byType.find((t) => t.id === "email");
  assert.strictEqual(email.count, 3);
  assert.strictEqual(email.unique, 2);
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test("JSON report is valid JSON and includes findings", () => {
  const out = redactor.redact("bob@example.com", {});
  const parsed = JSON.parse(redactor.toJSONReport(out));
  assert.strictEqual(parsed.findings.length, 1);
  assert.strictEqual(parsed.findings[0].original, "bob@example.com");
  assert.ok(parsed.stats.total === 1);
});

test("CSV report escapes values containing commas and quotes", () => {
  const csv = redactor.toCSVReport([
    { type: "x", label: "X", severity: "low", start: 0, end: 3, value: 'a,"b"', replacement: "[X]" },
  ]);
  const lines = csv.split("\r\n");
  assert.strictEqual(lines[0], "type,label,severity,start,end,original,replacement");
  assert.ok(lines[1].includes('"a,""b"""'));
});

test("Markdown report summarises counts and handles the empty case", () => {
  const out = redactor.redact("bob@example.com 10.0.0.1", {});
  const md = redactor.toMarkdownReport(out);
  assert.ok(md.includes("# Redaction report"));
  assert.ok(md.includes("Email address"));
  const empty = redactor.redact("clean text", {});
  assert.ok(redactor.toMarkdownReport(empty).includes("No sensitive values"));
});

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

test("listDetectors exposes stable ids and no duplicates", () => {
  const list = redactor.listDetectors();
  assert.ok(list.length >= 15);
  const ids = list.map((d) => d.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  list.forEach((d) => {
    assert.ok(d.id && d.label && d.group && d.severity && d.description);
  });
});

// ---------------------------------------------------------------------------
// End-to-end
// ---------------------------------------------------------------------------

test("end-to-end: scan, redact, restore round-trips a document", () => {
  const original = [
    "Customer: Ada Lovelace",
    "Email: ada@example.com",
    "Phone: +1 (555) 123-4567",
    "Card: 4111 1111 1111 1111",
    "Server: 192.168.0.42",
  ].join("\n");
  const opts = { strategy: "redact", categories: { "person-name": true } };
  const scan = redactor.scan(original, opts);
  assert.ok(scan.stats.total >= 4);

  const out = redactor.redact(original, opts);
  assert.ok(!out.text.includes("ada@example.com"));
  assert.ok(!out.text.includes("4111 1111 1111 1111"));
  assert.ok(out.text.includes("Customer:"), "labels survive");
  assert.strictEqual(redactor.restore(out.text, out.mapping), original);
});

test("end-to-end: hash strategy produces no recoverable originals", () => {
  const out = redactor.redact("bob@example.com", { strategy: "hash", salt: "team-a" });
  assert.ok(!out.text.includes("bob@example.com"));
  // A mapping is still recorded so the UI can offer a same-session undo, but
  // the visible text never contains the original value.
  assert.ok(!out.text.includes("bob"));
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
