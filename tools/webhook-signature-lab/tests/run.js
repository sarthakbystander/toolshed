"use strict";

/**
 * Webhook Signature Lab — test suite.
 *
 * Run directly (node tools/webhook-signature-lab/tests/run.js) or through the
 * repository runner (npm run test:tools). The library is required exactly as
 * the browser loads it, so these tests exercise the same code path the page
 * uses. Web Crypto is async, so assertions live in async functions driven by
 * an explicit queue.
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
// Encoding helpers
// ---------------------------------------------------------------------------

test("bytesToHex / hexToBytes round-trip", () => {
  const bytes = Uint8Array.from([0, 1, 15, 16, 127, 128, 255]);
  const hex = lib.bytesToHex(bytes);
  assert.strictEqual(hex, "00010f107f80ff");
  assert.deepStrictEqual(Array.from(lib.hexToBytes(hex)), Array.from(bytes));
});

test("hexToBytes tolerates whitespace and rejects bad input", () => {
  assert.deepStrictEqual(Array.from(lib.hexToBytes("de ad be ef")), [222, 173, 190, 239]);
  assert.strictEqual(lib.hexToBytes("abc"), null); // odd length
  assert.strictEqual(lib.hexToBytes("zz"), null); // non-hex
  assert.strictEqual(lib.hexToBytes(""), null);
  assert.strictEqual(lib.hexToBytes(null), null);
});

test("base64 round-trip, including URL-safe input", () => {
  const bytes = Uint8Array.from([251, 255, 190, 0, 10]);
  const b64 = lib.bytesToBase64(bytes);
  assert.deepStrictEqual(Array.from(lib.base64ToBytes(b64)), Array.from(bytes));
  // URL-safe alphabet decodes to the same bytes.
  assert.deepStrictEqual(Array.from(lib.base64ToBytes(b64.replace(/\+/g, "-").replace(/\//g, "_"))), Array.from(bytes));
});

test("base64ToBytes rejects impossible input", () => {
  assert.strictEqual(lib.base64ToBytes("A"), null); // length % 4 === 1
  assert.strictEqual(lib.base64ToBytes(""), null);
  assert.strictEqual(lib.base64ToBytes("!!!!"), null);
});

test("encodeBytes selects hex or base64", () => {
  const bytes = Uint8Array.from([1, 2, 3]);
  assert.strictEqual(lib.encodeBytes(bytes, "hex"), "010203");
  assert.strictEqual(lib.encodeBytes(bytes, "base64"), "AQID");
});

test("isAlgorithm / isEncoding guard the allowed values", () => {
  assert.strictEqual(lib.isAlgorithm("sha256"), true);
  assert.strictEqual(lib.isAlgorithm("md5"), false);
  assert.strictEqual(lib.isEncoding("base64"), true);
  assert.strictEqual(lib.isEncoding("base32"), false);
});

// ---------------------------------------------------------------------------
// HMAC correctness — RFC 4231 vectors
// ---------------------------------------------------------------------------

test("HMAC-SHA1 matches RFC 4231 test case 2", async () => {
  const sig = await lib.computeHmac("what do ya want for nothing?", "Jefe", "sha1");
  assert.strictEqual(lib.bytesToHex(sig), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
});

test("HMAC-SHA256 matches RFC 4231 test case 2", async () => {
  const sig = await lib.computeHmac("what do ya want for nothing?", "Jefe", "sha256");
  assert.strictEqual(lib.bytesToHex(sig), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
});

test("HMAC-SHA384 matches RFC 4231 test case 2", async () => {
  const sig = await lib.computeHmac("what do ya want for nothing?", "Jefe", "sha384");
  assert.strictEqual(
    lib.bytesToHex(sig),
    "af45d2e376484031617f78d2b58a6b1b9c7ef464f5a01b47e42ec3736322445e8e2240ca5e69e2c78b3239ecfab21649"
  );
});

test("HMAC-SHA512 matches RFC 4231 test case 2", async () => {
  const sig = await lib.computeHmac("what do ya want for nothing?", "Jefe", "sha512");
  assert.strictEqual(
    lib.bytesToHex(sig),
    "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737"
  );
});

test("HMAC matches RFC 4231 test case 1 across algorithms", async () => {
  const key = new Uint8Array(20).fill(0x0b);
  assert.strictEqual(
    lib.bytesToHex(await lib.computeHmac("Hi There", key, "sha1")),
    "b617318655057264e28bc0b6fb378c8ef146be00"
  );
  assert.strictEqual(
    lib.bytesToHex(await lib.computeHmac("Hi There", key, "sha256")),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
  );
  assert.strictEqual(
    lib.bytesToHex(await lib.computeHmac("Hi There", key, "sha512")),
    "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854"
  );
});

test("computeHmac rejects unsupported algorithms", async () => {
  await assert.rejects(() => lib.computeHmac("x", "k", "md5"), /Unsupported algorithm/);
});

test("computeHmac signs an empty payload with a non-empty secret", async () => {
  const sig = await lib.computeHmac("", "key", "sha256");
  assert.strictEqual(sig.length, 32);
});

test("computeHmac rejects an empty secret with a clear message", async () => {
  await assert.rejects(() => lib.computeHmac("x", "", "sha256"), /Secret must not be empty/);
  await assert.rejects(() => lib.computeHmac("x", new Uint8Array(0), "sha256"), /Secret must not be empty/);
});

test("computeHmac handles multi-byte UTF-8 bodies", async () => {
  // The same bytes must be signed regardless of representation.
  const sig = await lib.computeHmac("café ☕ — 日本語", "clé", "sha256");
  assert.strictEqual(sig.length, 32);
});

// ---------------------------------------------------------------------------
// Provider catalogue
// ---------------------------------------------------------------------------

test("lists every supported provider", () => {
  const ids = lib.listProviders().map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ["custom", "github", "shopify", "slack", "standard-webhooks", "stripe"]);
});

test("getProvider returns null for an unknown id", () => {
  assert.strictEqual(lib.getProvider("nope"), null);
  assert.strictEqual(lib.getProvider("github").signatureHeader, "X-Hub-Signature-256");
});

test("listProviders returns copies that cannot mutate the catalogue", () => {
  const first = lib.listProviders();
  first[0].notes.push("injected");
  first[0].parts.push({ source: "body" });
  const second = lib.listProviders();
  assert.ok(second[0].notes.indexOf("injected") === -1);
  assert.notStrictEqual(second[0].notes.length, first[0].notes.length);
});

// Regression: the copies returned by listProviders() must carry every field the
// verify path reads (scheme, prefixes, header fields). Dropping them silently
// broke verification in the UI while getProvider()-based tests still passed.
test("providers from listProviders() round-trip generate then verify", async () => {
  for (const provider of lib.listProviders()) {
    if (provider.id === "custom") continue;
    const values = {
      body: "{\"event\":\"ping\"}",
      timestamp: "1712345678",
      headers: { "webhook-id": "msg_123" },
      secret: "s3cret"
    };
    const generated = await lib.generateSignature(provider, values);
    assert.strictEqual(generated.ok, true, provider.id + " should generate");
    const verified = await lib.verifySignature(provider, values, { headerValue: generated.headerValue });
    assert.strictEqual(verified.ok, true, provider.id + " should verify");
    assert.strictEqual(verified.valid, true, provider.id + " header should round-trip");
  }
});

test("listProviders() exposes the prefix-stripping fields", () => {
  const github = lib.listProviders().find((p) => p.id === "github");
  assert.strictEqual(github.scheme, "prefix");
  assert.deepStrictEqual(github.signaturePrefixes, ["sha256="]);
  const stripe = lib.listProviders().find((p) => p.id === "stripe");
  assert.deepStrictEqual(stripe.headerFields, ["v1", "v0"]);
});

// ---------------------------------------------------------------------------
// Signed payload construction
// ---------------------------------------------------------------------------

test("GitHub signs the raw body", () => {
  const out = lib.buildSignedPayload(lib.getProvider("github"), { body: "{\"a\":1}" });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.payload, "{\"a\":1}");
});

test("Stripe signs \"timestamp.body\"", () => {
  const out = lib.buildSignedPayload(lib.getProvider("stripe"), { body: "hello", timestamp: "1712345678" });
  assert.strictEqual(out.payload, "1712345678.hello");
});

test("Slack signs \"v0:timestamp:body\"", () => {
  const out = lib.buildSignedPayload(lib.getProvider("slack"), { body: "hello", timestamp: "1712345678" });
  assert.strictEqual(out.payload, "v0:1712345678:hello");
});

test("Standard Webhooks signs \"id.timestamp.body\"", () => {
  const out = lib.buildSignedPayload(lib.getProvider("standard-webhooks"), {
    body: "hello",
    timestamp: "1712345678",
    headers: { "webhook-id": "msg_1" }
  });
  assert.strictEqual(out.payload, "msg_1.1712345678.hello");
});

test("Standard Webhooks reports a missing webhook-id", () => {
  const out = lib.buildSignedPayload(lib.getProvider("standard-webhooks"), { body: "x", timestamp: "1" });
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.missing, ["webhook-id"]);
});

test("a missing timestamp fails the build with a useful error", () => {
  const out = lib.buildSignedPayload(lib.getProvider("slack"), { body: "x" });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /timestamp/i);
});

test("body content is preserved byte-for-byte, including newlines", () => {
  const body = "line1\nline2\r\n\tindented";
  const out = lib.buildSignedPayload(lib.getProvider("github"), { body });
  assert.strictEqual(out.payload, body);
});

// ---------------------------------------------------------------------------
// Header extraction
// ---------------------------------------------------------------------------

test("strips the sha256= prefix for GitHub", () => {
  assert.deepStrictEqual(lib.extractCandidates(lib.getProvider("github"), "sha256=abc123"), ["abc123"]);
});

test("strips the v0= prefix for Slack", () => {
  assert.deepStrictEqual(lib.extractCandidates(lib.getProvider("slack"), "v0=deadbeef"), ["deadbeef"]);
});

test("reads Stripe v1 candidates and ignores other fields", () => {
  const candidates = lib.extractCandidates(lib.getProvider("stripe"), "t=1712345678,v1=aaa,v0=bbb,v1=ccc");
  assert.deepStrictEqual(candidates, ["aaa", "bbb", "ccc"]);
});

test("reads space-separated Standard Webhooks candidates", () => {
  const candidates = lib.extractCandidates(lib.getProvider("standard-webhooks"), "v1,aaa v1,bbb v2,ccc");
  assert.deepStrictEqual(candidates, ["aaa", "bbb"]);
});

test("returns no candidates for an unrelated header", () => {
  assert.deepStrictEqual(lib.extractCandidates(lib.getProvider("stripe"), "t=1712345678"), []);
  assert.deepStrictEqual(lib.extractCandidates(lib.getProvider("github"), ""), []);
});

// ---------------------------------------------------------------------------
// Signature comparison
// ---------------------------------------------------------------------------

test("hex comparison is case-insensitive", () => {
  assert.strictEqual(lib.signaturesMatch("ABCDEF", "abcdef", "hex"), true);
});

test("base64 comparison is case-sensitive", () => {
  assert.strictEqual(lib.signaturesMatch("AbC=", "abc=", "base64"), false);
});

test("different-length signatures never match", () => {
  assert.strictEqual(lib.signaturesMatch("abc", "abcd", "hex"), false);
  assert.strictEqual(lib.signaturesMatch("", "", "hex"), false);
});

// ---------------------------------------------------------------------------
// End-to-end generation and verification
// ---------------------------------------------------------------------------

test("GitHub header value and verification round-trip", async () => {
  const provider = lib.getProvider("github");
  const out = await lib.generateSignature(provider, { body: "hello", secret: "secret" });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.headerName, "X-Hub-Signature-256");
  assert.strictEqual(out.headerValue, "sha256=" + out.signature);

  const check = await lib.verifySignature(provider, { body: "hello", secret: "secret" }, { headerValue: out.headerValue });
  assert.strictEqual(check.valid, true);
});

test("verification fails for a tampered body", async () => {
  const provider = lib.getProvider("github");
  const out = await lib.generateSignature(provider, { body: "hello", secret: "secret" });
  const check = await lib.verifySignature(provider, { body: "hello!", secret: "secret" }, { headerValue: out.headerValue });
  assert.strictEqual(check.ok, true);
  assert.strictEqual(check.valid, false);
});

test("verification fails for the wrong secret", async () => {
  const provider = lib.getProvider("github");
  const out = await lib.generateSignature(provider, { body: "hello", secret: "secret" });
  const check = await lib.verifySignature(provider, { body: "hello", secret: "other" }, { headerValue: out.headerValue });
  assert.strictEqual(check.valid, false);
});

test("Stripe round-trip and rotation tolerance", async () => {
  const provider = lib.getProvider("stripe");
  const out = await lib.generateSignature(provider, { body: "hello", secret: "whsec_x", timestamp: "1712345678" });
  assert.strictEqual(out.headerValue, "t=1712345678,v1=" + out.signature);

  // A header with an extra stale v1 value must still verify.
  const rotated = "t=1712345678,v1=deadbeef," + "v1=" + out.signature;
  const check = await lib.verifySignature(provider, { body: "hello", secret: "whsec_x", timestamp: "1712345678" }, { headerValue: rotated });
  assert.strictEqual(check.valid, true);
});

test("Stripe verification is bound to the timestamp in the signed payload", async () => {
  const provider = lib.getProvider("stripe");
  // Signature produced over timestamp 1712345678.
  const out = await lib.generateSignature(provider, { body: "hello", secret: "whsec_x", timestamp: "1712345678" });
  // Reusing the digest with a different timestamp in the header must not verify,
  // because the rebuilt signed payload now uses 9999999999.
  const check = await lib.verifySignature(
    provider,
    { body: "hello", secret: "whsec_x", timestamp: "1712345678" },
    { headerValue: "t=9999999999,v1=" + out.signature }
  );
  assert.strictEqual(check.valid, false);
  // The t= value in the received header is authoritative, matching how a real
  // handler verifies: the same header verifies even if a stale timestamp is
  // still sitting in the form.
  const authoritative = await lib.verifySignature(
    provider,
    { body: "hello", secret: "whsec_x", timestamp: "9999999999" },
    { headerValue: out.headerValue }
  );
  assert.strictEqual(authoritative.valid, true);
});

test("Slack round-trip", async () => {
  const provider = lib.getProvider("slack");
  const out = await lib.generateSignature(provider, { body: "hello", secret: "s", timestamp: "1712345678" });
  assert.strictEqual(out.headerValue, "v0=" + out.signature);
  const check = await lib.verifySignature(provider, { body: "hello", secret: "s", timestamp: "1712345678" }, { headerValue: out.headerValue });
  assert.strictEqual(check.valid, true);
});

test("Shopify produces base64 and verifies", async () => {
  const provider = lib.getProvider("shopify");
  const out = await lib.generateSignature(provider, { body: "hello", secret: "s" });
  assert.strictEqual(out.encoding, "base64");
  assert.match(out.signature, /^[A-Za-z0-9+/]+={0,2}$/);
  const check = await lib.verifySignature(provider, { body: "hello", secret: "s" }, { headerValue: out.headerValue });
  assert.strictEqual(check.valid, true);
});

test("Standard Webhooks decodes a whsec_ secret and verifies", async () => {
  const provider = lib.getProvider("standard-webhooks");
  const values = { body: "hello", secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", timestamp: "1712345678", headers: { "webhook-id": "msg_1" } };
  const out = await lib.generateSignature(provider, values);
  assert.strictEqual(out.headerValue, "v1," + out.signature);
  const check = await lib.verifySignature(provider, values, { headerValue: out.headerValue });
  assert.strictEqual(check.valid, true);
});

test("a whsec_ secret and its decoded form are interchangeable", async () => {
  const provider = lib.getProvider("standard-webhooks");
  const full = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const decoded = lib.decodeSecret(full);
  assert.ok(decoded instanceof Uint8Array);
  const a = await lib.generateSignature(provider, { body: "b", secret: full, timestamp: "1", headers: { "webhook-id": "m" } });
  const b = await lib.generateSignature(provider, { body: "b", secret: decoded, timestamp: "1", headers: { "webhook-id": "m" } });
  assert.strictEqual(a.signature, b.signature);
});

test("custom provider honours the chosen algorithm and encoding", async () => {
  const provider = lib.getProvider("custom");
  const out = await lib.generateSignature(provider, { body: "hello", secret: "s" }, { algorithm: "sha512", encoding: "base64" });
  assert.strictEqual(out.algorithm, "sha512");
  assert.strictEqual(out.encoding, "base64");
  const check = await lib.verifySignature(provider, { body: "hello", secret: "s" }, { headerValue: out.headerValue, algorithm: "sha512", encoding: "base64" });
  assert.strictEqual(check.valid, true);
});

test("a locked provider ignores an override attempt", async () => {
  const provider = lib.getProvider("github");
  const out = await lib.generateSignature(provider, { body: "x", secret: "s" }, { algorithm: "sha1", encoding: "base64" });
  assert.strictEqual(out.algorithm, "sha256");
  assert.strictEqual(out.encoding, "hex");
});

test("empty header value is reported, not thrown", async () => {
  const provider = lib.getProvider("github");
  const check = await lib.verifySignature(provider, { body: "x", secret: "s" }, { headerValue: "  " });
  assert.strictEqual(check.ok, false);
  assert.match(check.error, /Paste the received signature header/);
});

test("a header without the expected field is reported", async () => {
  const provider = lib.getProvider("stripe");
  const check = await lib.verifySignature(provider, { body: "x", secret: "s", timestamp: "1" }, { headerValue: "t=1" });
  assert.strictEqual(check.ok, false);
  assert.match(check.error, /v1\/v0/);
});

test("verification still computes a signature when input is incomplete", async () => {
  // Missing timestamp means we cannot build the payload; verify returns the
  // generation error rather than a misleading "invalid".
  const provider = lib.getProvider("slack");
  const check = await lib.verifySignature(provider, { body: "x", secret: "s" }, { headerValue: "v0=abc" });
  assert.strictEqual(check.ok, false);
  assert.match(check.error, /timestamp/i);
});

test("formatHeaderValue covers every provider shape", () => {
  assert.strictEqual(lib.formatHeaderValue(lib.getProvider("github"), "SIG", {}), "sha256=SIG");
  assert.strictEqual(lib.formatHeaderValue(lib.getProvider("slack"), "SIG", {}), "v0=SIG");
  assert.strictEqual(lib.formatHeaderValue(lib.getProvider("stripe"), "SIG", { timestamp: "123" }), "t=123,v1=SIG");
  assert.strictEqual(lib.formatHeaderValue(lib.getProvider("standard-webhooks"), "SIG", {}), "v1,SIG");
  assert.strictEqual(lib.formatHeaderValue(lib.getProvider("shopify"), "SIG", {}), "SIG");
});

// ---------------------------------------------------------------------------
// Recipes and samples
// ---------------------------------------------------------------------------

test("every provider ships curl, node and python recipes", () => {
  lib.listProviders().forEach((provider) => {
    lib.listRecipeLanguages().forEach((language) => {
      const recipe = lib.verificationRecipe(provider.id, language);
      assert.strictEqual(typeof recipe, "string", provider.id + "/" + language);
      assert.ok(recipe.length > 20, provider.id + "/" + language + " should be substantive");
    });
  });
});

test("recipes never contain a hardcoded real secret", () => {
  lib.listProviders().forEach((provider) => {
    lib.listRecipeLanguages().forEach((language) => {
      const recipe = lib.verificationRecipe(provider.id, language);
      // Secrets are read from the environment, never embedded.
      assert.ok(!/["'](sk|whsec|ghp)_[A-Za-z0-9]{12,}/.test(recipe), provider.id + "/" + language);
    });
  });
});

test("verificationRecipe returns empty for unknown input", () => {
  assert.strictEqual(lib.verificationRecipe("nope", "node"), "");
  assert.strictEqual(lib.verificationRecipe("github", "rust"), "");
});

test("every provider ships a sample with a body and secret", () => {
  lib.listProviders().forEach((provider) => {
    const sample = lib.getSample(provider.id);
    assert.ok(sample, provider.id);
    assert.strictEqual(typeof sample.body, "string");
    assert.ok(sample.body.length > 0, provider.id + " body");
    assert.strictEqual(typeof sample.secret, "string");
    assert.ok(sample.secret.length > 0, provider.id + " secret");
  });
});

test("getSample returns a fresh object each call", () => {
  const a = lib.getSample("standard-webhooks");
  a.headers["webhook-id"] = "mutated";
  const b = lib.getSample("standard-webhooks");
  assert.strictEqual(b.headers["webhook-id"], "msg_2abc123");
});

// ---------------------------------------------------------------------------
// Larger / realistic inputs
// ---------------------------------------------------------------------------

test("signs a large realistic payload without error", async () => {
  const body = JSON.stringify({
    id: "evt_" + "x".repeat(200),
    type: "payment_intent.succeeded",
    data: { object: { items: Array.from({ length: 500 }, (_, i) => ({ sku: "sku-" + i, qty: i % 5 })) } }
  });
  const provider = lib.getProvider("stripe");
  const out = await lib.generateSignature(provider, { body, secret: "whsec_large", timestamp: "1712345678" });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.signature.length, 64);
  const check = await lib.verifySignature(provider, { body, secret: "whsec_large", timestamp: "1712345678" }, { headerValue: out.headerValue });
  assert.strictEqual(check.valid, true);
});

test("generation is deterministic for identical input", async () => {
  const provider = lib.getProvider("github");
  const a = await lib.generateSignature(provider, { body: "repeatable", secret: "k" });
  const b = await lib.generateSignature(provider, { body: "repeatable", secret: "k" });
  assert.strictEqual(a.signature, b.signature);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  console.log("webhook-signature-lab tests");
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
