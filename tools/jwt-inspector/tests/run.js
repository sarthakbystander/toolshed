"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const jwt = require("../tool.js");

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      // Async test: recorded and awaited before the summary is printed.
      pending.push(r.then(() => { passed++; console.log("  ok - " + name); },
        (err) => { failed++; console.error("  FAIL - " + name); console.error("         " + (err && err.message)); }));
      return;
    }
    passed++;
    console.log("  ok - " + name);
  } catch (err) {
    failed++;
    console.error("  FAIL - " + name);
    console.error("         " + (err && err.message));
  }
}

// The canonical jwt.io example, signed with the shared secret below.
const SAMPLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const SAMPLE_SECRET = "your-256-bit-secret";

function b64url(str) { return jwt.bytesToBase64Url(jwt.utf8ToBytes(str)); }
function tokenOf(header, payload, signature) {
  return b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload)) + "." + (signature || "");
}

async function main() {
  console.log("jwt-inspector tests");

  // -------------------------------------------------------------------------
  // Base64url and UTF-8
  // -------------------------------------------------------------------------

  test("base64url round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 128, 64]);
    const encoded = jwt.bytesToBase64Url(bytes);
    assert.ok(!/[+/=]/.test(encoded), "encoded output must be URL-safe and unpadded");
    const back = jwt.base64UrlToBytes(encoded);
    assert.deepStrictEqual(Array.from(back), Array.from(bytes));
  });

  test("base64url handles UTF-8 text", () => {
    const text = "héllo — wörld ✓ 日本語";
    const encoded = jwt.bytesToBase64Url(jwt.utf8ToBytes(text));
    assert.strictEqual(jwt.bytesToUtf8(jwt.base64UrlToBytes(encoded)), text);
  });

  test("base64UrlToBytes rejects invalid characters", () => {
    assert.strictEqual(jwt.base64UrlToBytes("abc$def"), null);
    assert.strictEqual(jwt.base64UrlToBytes("ab c"), null);
    // "=" padding and the standard-base64 "+" / "/" are not valid Base64url in a JWS.
    assert.strictEqual(jwt.base64UrlToBytes("YWJj="), null);
    assert.strictEqual(jwt.base64UrlToBytes("ab+d"), null);
    assert.strictEqual(jwt.base64UrlToBytes("ab/d"), null);
  });

  test("base64UrlToBytes rejects impossible lengths", () => {
    // length % 4 === 1 can never be a valid Base64 encoding.
    assert.strictEqual(jwt.base64UrlToBytes("a"), null);
    assert.strictEqual(jwt.base64UrlToBytes("abcde"), null);
  });

  test("base64UrlToBytes accepts the empty string as empty bytes", () => {
    assert.strictEqual(jwt.base64UrlToBytes("").length, 0);
  });

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  test("parses the canonical sample token", () => {
    const parsed = jwt.parseJwt(SAMPLE);
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.header, { alg: "HS256", typ: "JWT" });
    assert.strictEqual(parsed.payload.sub, "1234567890");
    assert.strictEqual(parsed.payload.name, "John Doe");
    assert.strictEqual(parsed.signature.length > 0, true);
    assert.strictEqual(parsed.signingInput, SAMPLE.split(".").slice(0, 2).join("."));
  });

  test("strips a Bearer prefix and surrounding quotes", () => {
    assert.strictEqual(jwt.parseJwt("Bearer " + SAMPLE).ok, true);
    assert.strictEqual(jwt.parseJwt('"' + SAMPLE + '"').ok, true);
    assert.strictEqual(jwt.parseJwt("  bearer   " + SAMPLE + "  ").ok, true);
  });

  test("rejects an empty or non-string token", () => {
    assert.strictEqual(jwt.parseJwt("").ok, false);
    assert.strictEqual(jwt.parseJwt("   ").ok, false);
    assert.strictEqual(jwt.parseJwt(null).ok, false);
    assert.strictEqual(jwt.parseJwt(undefined).ok, false);
    assert.strictEqual(jwt.parseJwt(42).ok, false);
  });

  test("rejects the wrong number of segments", () => {
    const two = jwt.parseJwt("aaa.bbb");
    assert.strictEqual(two.ok, false);
    assert.match(two.error, /three dot-separated parts/);
    assert.strictEqual(jwt.parseJwt("a.b.c.d").ok, false);
  });

  test("explains a JWE (five segments) instead of failing obscurely", () => {
    const jwe = jwt.parseJwt("a.b.c.d.e");
    assert.strictEqual(jwe.ok, false);
    assert.match(jwe.error, /JWE/);
  });

  test("reports a header that is not JSON", () => {
    const bad = jwt.parseJwt(b64url("not json") + "." + b64url("{}") + ".sig");
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /header/i);
  });

  test("reports a payload that is not a JSON object", () => {
    const arr = jwt.parseJwt(b64url('{"alg":"HS256"}') + "." + b64url("[1,2,3]") + ".sig");
    assert.strictEqual(arr.ok, false);
    assert.match(arr.error, /object/);
    const scalar = jwt.parseJwt(b64url('{"alg":"HS256"}') + "." + b64url('"a string"') + ".sig");
    assert.strictEqual(scalar.ok, false);
  });

  test("rejects a header segment that is not Base64url", () => {
    const bad = jwt.parseJwt("!!!!." + b64url("{}") + ".sig");
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /Base64url/);
  });

  test("parses a token with an empty signature (unsecured)", () => {
    const unsecured = tokenOf({ alg: "none" }, { sub: "x" }, "");
    const parsed = jwt.parseJwt(unsecured);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.signature, "");
  });

  // -------------------------------------------------------------------------
  // Claim analysis
  // -------------------------------------------------------------------------

  test("orders registered claims before custom ones", () => {
    const claims = jwt.analyzeClaims({ custom: 1, sub: "s", iss: "i", exp: 2 }, { now: 0 });
    assert.deepStrictEqual(claims.map((c) => c.key), ["iss", "sub", "exp", "custom"]);
  });

  test("labels known claims and leaves custom ones unlabelled", () => {
    const claims = jwt.analyzeClaims({ iss: "x", role: "admin" }, { now: 0 });
    const iss = claims.find((c) => c.key === "iss");
    const role = claims.find((c) => c.key === "role");
    assert.strictEqual(iss.label, "Issuer");
    assert.strictEqual(role.label, "");
  });

  test("marks an expired exp claim as danger", () => {
    const status = jwt.timeClaimStatus("exp", 1000, 2000);
    assert.strictEqual(status.status, "danger");
    assert.match(status.note, /Expired/);
  });

  test("marks an exp claim inside the warning window", () => {
    assert.strictEqual(jwt.timeClaimStatus("exp", 1200, 1000).status, "warn");
    assert.strictEqual(jwt.timeClaimStatus("exp", 9000, 1000).status, "ok");
  });

  test("marks a future nbf as a warning", () => {
    const status = jwt.timeClaimStatus("nbf", 5000, 1000);
    assert.strictEqual(status.status, "warn");
    assert.match(status.note, /Not valid/);
    assert.strictEqual(jwt.timeClaimStatus("nbf", 500, 1000).status, "ok");
  });

  test("flags an iat in the future", () => {
    assert.strictEqual(jwt.timeClaimStatus("iat", 5000, 1000).status, "warn");
    assert.strictEqual(jwt.timeClaimStatus("iat", 500, 1000).status, "ok");
  });

  test("flags a non-numeric exp as danger", () => {
    const claims = jwt.analyzeClaims({ exp: "tomorrow" }, { now: 0 });
    assert.strictEqual(claims[0].status, "danger");
  });

  test("accepts a string or an array audience", () => {
    assert.strictEqual(jwt.analyzeClaims({ aud: "a" }, { now: 0 })[0].status, "");
    assert.strictEqual(jwt.analyzeClaims({ aud: ["a", "b"] }, { now: 0 })[0].status, "");
    assert.strictEqual(jwt.analyzeClaims({ aud: 5 }, { now: 0 })[0].status, "warn");
    assert.strictEqual(jwt.analyzeClaims({ aud: ["a", 5] }, { now: 0 })[0].status, "warn");
  });

  test("renders object and array claim values without throwing", () => {
    const claims = jwt.analyzeClaims({ aud: ["a", "b"], nested: { x: 1 } }, { now: 0 });
    assert.strictEqual(claims.find((c) => c.key === "aud").display, '["a","b"]');
    assert.strictEqual(claims.find((c) => c.key === "nested").display, '{"x":1}');
  });

  // -------------------------------------------------------------------------
  // Security review
  // -------------------------------------------------------------------------

  function levels(issues) { return issues.map((i) => i.level); }
  function texts(issues) { return issues.map((i) => i.text).join(" | "); }

  test("flags alg none as critical", () => {
    const issues = jwt.analyzeSecurity({ alg: "none" }, { exp: 9e9 }, { now: 0 });
    assert.strictEqual(issues[0].level, "danger");
    assert.match(texts(issues), /unsecured/);
  });

  test("flags a missing alg", () => {
    const issues = jwt.analyzeSecurity({}, { exp: 9e9 }, { now: 0 });
    assert.match(texts(issues), /no "alg" field/);
  });

  test("flags a missing exp claim", () => {
    const issues = jwt.analyzeSecurity({ alg: "HS256" }, {}, { now: 0 });
    assert.match(texts(issues), /never expires/);
  });

  test("flags an expired token", () => {
    const issues = jwt.analyzeSecurity({ alg: "HS256" }, { exp: 100, iat: 50 }, { now: 1000 * 1000 });
    assert.match(texts(issues), /expired/);
  });

  test("flags missing iss and aud", () => {
    const issues = jwt.analyzeSecurity({ alg: "HS256" }, { exp: 9e9 }, { now: 0 });
    assert.match(texts(issues), /No "iss"/);
    assert.match(texts(issues), /No "aud"/);
  });

  test("flags an excessively long lifetime", () => {
    const issues = jwt.analyzeSecurity({ alg: "HS256" }, { iat: 0, exp: 86400 * 30, iss: "i", aud: "a" }, { now: 0 });
    assert.match(texts(issues), /lifetime/);
  });

  test("flags nbf after exp as critical", () => {
    const issues = jwt.analyzeSecurity({ alg: "HS256" }, { nbf: 500, exp: 100, iss: "i", aud: "a" }, { now: 0 });
    assert.match(texts(issues), /nbf is after exp/);
  });

  test("flags sensitive-looking claim names", () => {
    const issues = jwt.analyzeSecurity({ alg: "HS256" }, { password: "hunter2", iss: "i", aud: "a", exp: 9e9 }, { now: 0 });
    assert.match(texts(issues), /sensitive data/);
  });

  test("adds an informational note for HMAC algorithms", () => {
    const issues = jwt.analyzeSecurity({ alg: "HS256" }, { iss: "i", aud: "a", exp: 9e9 }, { now: 0 });
    assert.ok(issues.some((i) => i.level === "info" && /HMAC/.test(i.text)));
  });

  test("sorts critical issues first", () => {
    const issues = jwt.analyzeSecurity({ alg: "none" }, {}, { now: 0 });
    assert.strictEqual(issues[0].level, "danger");
    // Every danger must precede every warn, and every warn every info.
    const order = { danger: 0, warn: 1, info: 2 };
    for (let i = 1; i < issues.length; i++) {
      assert.ok(order[issues[i].level] >= order[issues[i - 1].level], "levels must be non-decreasing");
    }
  });

  test("returns no issues for a well-formed token", () => {
    const header = { alg: "RS256" };
    const payload = { iss: "https://issuer", aud: "api", sub: "s", iat: 0, exp: 3600, jti: "x" };
    assert.deepStrictEqual(jwt.analyzeSecurity(header, payload, { now: 100 }), []);
  });

  // -------------------------------------------------------------------------
  // Verification — HMAC
  // -------------------------------------------------------------------------

  test("verifies the canonical HS256 sample", () => {
    return jwt.verifyJwt(SAMPLE, SAMPLE_SECRET).then((r) => {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.valid, true);
      assert.strictEqual(r.algorithm, "HS256");
    });
  });

  test("rejects the sample with the wrong secret", () => {
    return jwt.verifyJwt(SAMPLE, "wrong-secret").then((r) => {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.valid, false);
    });
  });

  test("rejects a tampered payload", () => {
    const parts = SAMPLE.split(".");
    const forged = parts[0] + "." + b64url(JSON.stringify({ sub: "attacker" })) + "." + parts[2];
    return jwt.verifyJwt(forged, SAMPLE_SECRET).then((r) => {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.valid, false);
    });
  });

  test("refuses to verify an alg none token", () => {
    const unsecured = tokenOf({ alg: "none" }, { sub: "x" }, "");
    return jwt.verifyJwt(unsecured, "anything").then((r) => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.stage, "algorithm");
    });
  });

  test("reports an unsupported algorithm", () => {
    const tok = tokenOf({ alg: "XX999" }, { sub: "x" }, "c2ln");
    return jwt.verifyJwt(tok, "secret").then((r) => {
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /not supported/);
    });
  });

  test("reports a missing key", () => {
    return jwt.verifyJwt(SAMPLE, "").then((r) => {
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /No key material/);
    });
  });

  test("reports a malformed token before touching the key", () => {
    return jwt.verifyJwt("not-a-token", "secret").then((r) => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.stage, "parse");
    });
  });

  test("rejects a token with no signature segment", () => {
    const tok = tokenOf({ alg: "HS256" }, { sub: "x" }, "");
    return jwt.verifyJwt(tok, "secret").then((r) => {
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /no signature/);
    });
  });

  test("verifies an HS384 token", () => {
    return jwt.signJwt({ alg: "HS384" }, { sub: "x" }, "s3cret").then((signed) => {
      assert.strictEqual(signed.ok, true);
      return jwt.verifyJwt(signed.token, "s3cret").then((r) => {
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.algorithm, "HS384");
      });
    });
  });

  // -------------------------------------------------------------------------
  // Verification — asymmetric
  // -------------------------------------------------------------------------

  test("round-trips an RS256 token through PEM keys", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const priv = privateKey.export({ type: "pkcs8", format: "pem" });
    const pub = publicKey.export({ type: "spki", format: "pem" });
    return jwt.signJwt({ alg: "RS256" }, { sub: "rsa" }, priv).then((signed) => {
      assert.strictEqual(signed.ok, true);
      return jwt.verifyJwt(signed.token, pub).then((r) => assert.strictEqual(r.valid, true));
    });
  });

  test("round-trips a PS256 token", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const priv = privateKey.export({ type: "pkcs8", format: "pem" });
    const pub = publicKey.export({ type: "spki", format: "pem" });
    return jwt.signJwt({ alg: "PS256" }, { sub: "pss" }, priv).then((signed) => {
      assert.strictEqual(signed.ok, true);
      return jwt.verifyJwt(signed.token, pub).then((r) => assert.strictEqual(r.valid, true));
    });
  });

  test("round-trips an ES256 token", () => {
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const priv = ec.privateKey.export({ type: "pkcs8", format: "pem" });
    const pub = ec.publicKey.export({ type: "spki", format: "pem" });
    return jwt.signJwt({ alg: "ES256" }, { sub: "ec" }, priv).then((signed) => {
      assert.strictEqual(signed.ok, true);
      return jwt.verifyJwt(signed.token, pub).then((r) => assert.strictEqual(r.valid, true));
    });
  });

  test("round-trips an EdDSA token", () => {
    const ed = crypto.generateKeyPairSync("ed25519");
    const priv = ed.privateKey.export({ type: "pkcs8", format: "pem" });
    const pub = ed.publicKey.export({ type: "spki", format: "pem" });
    return jwt.signJwt({ alg: "EdDSA" }, { sub: "ed" }, priv).then((signed) => {
      assert.strictEqual(signed.ok, true);
      return jwt.verifyJwt(signed.token, pub).then((r) => assert.strictEqual(r.valid, true));
    });
  });

  test("rejects a PEM key of the wrong type for the algorithm", () => {
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const ecPub = ec.publicKey.export({ type: "spki", format: "pem" });
    return jwt.signJwt({ alg: "RS256" }, { sub: "x" }, crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }))
      .then((signed) => jwt.verifyJwt(signed.token, ecPub))
      .then((r) => {
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.stage, "key");
      });
  });

  test("gives a helpful error when a PEM key is used with an HMAC algorithm", () => {
    const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pub = publicKey.export({ type: "spki", format: "pem" });
    return jwt.verifyJwt(SAMPLE, pub).then((r) => {
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /shared secret/);
    });
  });

  test("explains that an EC signature in DER form cannot verify", () => {
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const priv = ec.privateKey.export({ type: "pkcs8", format: "pem" });
    const pub = ec.publicKey.export({ type: "spki", format: "pem" });
    return jwt.signJwt({ alg: "ES256" }, { sub: "x" }, priv).then((signed) => {
      const parts = signed.token.split(".");
      // Replace the raw r‖s signature with a longer, DER-like one.
      const fakeSig = jwt.bytesToBase64Url(new Uint8Array(72));
      return jwt.verifyJwt(parts[0] + "." + parts[1] + "." + fakeSig, pub).then((r) => {
        assert.strictEqual(r.valid, false);
        assert.match(r.hint, /r‖s/);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  test("signing adds a default typ header", () => {
    return jwt.signJwt({ alg: "HS256" }, { sub: "x" }, "secret").then((r) => {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.header.typ, "JWT");
      const parsed = jwt.parseJwt(r.token);
      assert.strictEqual(parsed.header.typ, "JWT");
    });
  });

  test("signing refuses alg none", () => {
    return jwt.signJwt({ alg: "none" }, { sub: "x" }, "secret").then((r) => {
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /unsecured/);
    });
  });

  test("signing rejects a non-object payload", () => {
    return jwt.signJwt({ alg: "HS256" }, [1, 2], "secret").then((r) => {
      assert.strictEqual(r.ok, false);
    });
  });

  test("signing rejects a missing algorithm", () => {
    return jwt.signJwt({}, { sub: "x" }, "secret").then((r) => {
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /algorithm/);
    });
  });

  test("preserves unicode in signed payloads", () => {
    return jwt.signJwt({ alg: "HS256" }, { name: "日本語 — ✓" }, "secret").then((r) => {
      const parsed = jwt.parseJwt(r.token);
      assert.strictEqual(parsed.payload.name, "日本語 — ✓");
    });
  });

  // -------------------------------------------------------------------------
  // JWKS
  // -------------------------------------------------------------------------

  test("verifies against a JWKS by kid", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const priv = privateKey.export({ type: "pkcs8", format: "pem" });
    const jwk = publicKey.export({ format: "jwk" });
    jwk.kid = "k1"; jwk.alg = "RS256"; jwk.use = "sig";
    const jwks = { keys: [{ kty: "oct", k: "aaa" }, jwk] };
    return jwt.signJwt({ alg: "RS256", kid: "k1" }, { sub: "x" }, priv).then((signed) => {
      return jwt.verifyJwtWithJwks(signed.token, jwks).then((r) => {
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.key.kid, "k1");
      });
    });
  });

  test("JWKS skips a key that cannot verify and still succeeds", () => {
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const ecJwk = ec.publicKey.export({ format: "jwk" });
    ecJwk.kid = "k1"; ecJwk.alg = "RS256"; // wrong key type, matching metadata
    const rsaJwk = rsa.publicKey.export({ format: "jwk" });
    rsaJwk.kid = "k1"; rsaJwk.alg = "RS256";
    const priv = rsa.privateKey.export({ type: "pkcs8", format: "pem" });
    return jwt.signJwt({ alg: "RS256", kid: "k1" }, { sub: "x" }, priv).then((signed) => {
      return jwt.verifyJwtWithJwks(signed.token, { keys: [ecJwk, rsaJwk] }).then((r) => {
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.tried, 2);
      });
    });
  });

  test("JWKS with a non-matching kid fails cleanly", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const priv = privateKey.export({ type: "pkcs8", format: "pem" });
    const jwk = publicKey.export({ format: "jwk" });
    jwk.kid = "other"; jwk.alg = "RS256";
    return jwt.signJwt({ alg: "RS256", kid: "k1" }, { sub: "x" }, priv).then((signed) => {
      return jwt.verifyJwtWithJwks(signed.token, { keys: [jwk] }).then((r) => {
        assert.strictEqual(r.ok, false);
        assert.match(r.error, /No key in the JWKS/);
      });
    });
  });

  test("parses a JWKS with keys, a bare JWK, and rejects junk", () => {
    assert.strictEqual(jwt.parseJwks('{"keys":[{"kty":"RSA"}]}').ok, true);
    assert.strictEqual(jwt.parseJwks('{"kty":"RSA","n":"x","e":"AQAB"}').ok, true);
    assert.strictEqual(jwt.parseJwks("not json").ok, false);
    assert.strictEqual(jwt.parseJwks('{"keys":[]}').ok, false);
    assert.strictEqual(jwt.parseJwks('{"keys":[{"nope":1}]}').ok, false);
    assert.strictEqual(jwt.parseJwks("[]").ok, false);
  });

  test("jwksCandidates filters on kid and alg", () => {
    const header = { kid: "a", alg: "RS256" };
    const keys = [
      { kid: "a", alg: "RS256" },
      { kid: "b", alg: "RS256" },
      { kid: "a", alg: "ES256" },
      { kid: "a" },
      { kty: "RSA" }
    ];
    const out = jwt.jwksCandidates({ keys }, header);
    // Keys with a conflicting kid or alg are dropped; keys that omit either
    // field are still tried (some providers publish a single key without a kid).
    assert.deepStrictEqual(out, [keys[0], keys[3], keys[4]]);
  });

  // -------------------------------------------------------------------------
  // analyzeToken and formatting
  // -------------------------------------------------------------------------

  test("analyzeToken bundles parse, claims, security and size", () => {
    const res = jwt.analyzeToken(SAMPLE, { now: 1516239022000 });
    assert.strictEqual(res.ok, true);
    assert.ok(res.claims.length >= 3);
    assert.ok(Array.isArray(res.security));
    assert.strictEqual(res.size, SAMPLE.length);
    assert.strictEqual(res.expired, false);
  });

  test("analyzeToken marks an expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    return jwt.signJwt({ alg: "HS256" }, { exp: now - 10 }, "s").then((signed) => {
      const res = jwt.analyzeToken(signed.token);
      assert.strictEqual(res.expired, true);
    });
  });

  test("analyzeToken propagates parse errors", () => {
    assert.strictEqual(jwt.analyzeToken("nope").ok, false);
  });

  test("formatDuration scales units", () => {
    assert.strictEqual(jwt.formatDuration(1), "1 second");
    assert.strictEqual(jwt.formatDuration(90), "2 minutes");
    assert.strictEqual(jwt.formatDuration(7200), "2 hours");
    assert.strictEqual(jwt.formatDuration(172800), "2 days");
  });

  test("formatDate produces an ISO timestamp", () => {
    assert.strictEqual(jwt.formatDate(0), "1970-01-01T00:00:00Z");
    assert.strictEqual(jwt.formatDate(NaN), "invalid date");
    assert.strictEqual(jwt.formatDate("x"), "invalid date");
  });

  test("formatBytes scales units", () => {
    assert.strictEqual(jwt.formatBytes(512), "512 B");
    assert.strictEqual(jwt.formatBytes(2048), "2.0 KB");
  });

  test("displayValue renders primitives and structures", () => {
    assert.strictEqual(jwt.displayValue(null), "null");
    assert.strictEqual(jwt.displayValue(true), "true");
    assert.strictEqual(jwt.displayValue("x"), "x");
    assert.strictEqual(jwt.displayValue([1, 2]), "[1,2]");
    assert.strictEqual(jwt.displayValue({ a: 1 }), '{"a":1}');
  });

  test("exposes a crypto availability check", () => {
    assert.strictEqual(typeof jwt.hasCrypto(), "boolean");
  });

  await Promise.all(pending);

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner crashed: " + (err && err.stack || err));
  process.exit(1);
});
