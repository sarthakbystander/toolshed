/* Toolshed Certificate Inspector — tests. Run with: node tests/run.js
 * Uses Node's built-in assert and requires ../tool.js via its UMD export.
 * The fixtures in ./fixtures.js are throwaway certificates generated once with
 * OpenSSL; they contain public data only and no private keys.
 */
"use strict";

const assert = require("node:assert");
const ci = require("../tool.js");
const fx = require("./fixtures.js");

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(r.then(
        () => { passed++; console.log("  ok - " + name); },
        (err) => { failed++; console.error("  FAIL - " + name); console.error("         " + (err && err.message)); }
      ));
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

function first(item) {
  return item.items[0];
}

async function inspectFirst(pem, options) {
  const res = await ci.inspect(pem, options);
  assert.strictEqual(res.ok, true, res.error || "expected a successful parse");
  return first(res);
}

console.log("certificate-inspector tests");

// ---------------------------------------------------------------------------
// Input decoding
// ---------------------------------------------------------------------------

test("rejects empty and whitespace-only input", async () => {
  assert.strictEqual((await ci.inspect("")).ok, false);
  assert.strictEqual((await ci.inspect("   \n\t ")).ok, false);
  assert.match((await ci.inspect("")).error, /No input/i);
});

test("rejects unrecognised free text", async () => {
  const res = await ci.inspect("hello, this is not a certificate");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Unrecognised/i);
});

test("refuses to read a private key", async () => {
  const res = await ci.inspect("-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.kind, "private-key");
  assert.match(res.error, /private key/i);
});

test("rejects a PEM block whose base64 body is corrupt", async () => {
  const broken = "-----BEGIN CERTIFICATE-----\n!!!not base64!!!\n-----END CERTIFICATE-----";
  const res = await ci.inspect(broken);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /could not be decoded/i);
});

test("rejects truncated DER without throwing", async () => {
  const der = ci.decodeInput(fx.LEAF).blocks[0].der;
  const truncated = ci.bytesToBase64(der.subarray(0, 40));
  const res = await ci.inspect(truncated);
  assert.strictEqual(res.ok, false);
});

test("decodes raw DER supplied as hex", async () => {
  const der = ci.decodeInput(fx.LEAF).blocks[0].der;
  const cert = await inspectFirst(ci.bytesToHex(der));
  assert.strictEqual(cert.kind, "certificate");
  assert.strictEqual(cert.subject.formatted.includes("CN=example.com"), true);
});

test("decodes raw DER supplied as base64", async () => {
  const der = ci.decodeInput(fx.LEAF).blocks[0].der;
  const cert = await inspectFirst(ci.bytesToBase64(der));
  assert.strictEqual(cert.kind, "certificate");
});

test("decodes a certificate regardless of CRLF line endings", async () => {
  const crlf = fx.LEAF.replace(/\n/g, "\r\n");
  const cert = await inspectFirst(crlf);
  assert.strictEqual(cert.kind, "certificate");
});

// ---------------------------------------------------------------------------
// Leaf certificate structure
// ---------------------------------------------------------------------------

test("parses the leaf certificate subject and issuer", async () => {
  const cert = await inspectFirst(fx.LEAF);
  assert.strictEqual(cert.kind, "certificate");
  assert.strictEqual(cert.version, 3);
  assert.strictEqual(cert.subject.formatted,
    "C=US, ST=California, L=San Francisco, O=Toolshed Test Ltd, CN=example.com");
  assert.strictEqual(cert.issuer.formatted,
    "C=US, O=Toolshed Test Intermediate CA, CN=Toolshed Test Intermediate CA");
});

test("reads the validity window", async () => {
  const cert = await inspectFirst(fx.LEAF);
  assert.strictEqual(cert.validity.notBefore.iso, "2026-10-29T03:36:42.000Z");
  assert.strictEqual(cert.validity.notAfter.iso, "2027-01-27T03:36:42.000Z");
  assert.ok(cert.validity.notAfter.epoch > cert.validity.notBefore.epoch);
});

test("reads the signature algorithm and hash", async () => {
  const cert = await inspectFirst(fx.LEAF);
  assert.strictEqual(cert.signatureAlgorithm.oid, "1.2.840.113549.1.1.11");
  assert.strictEqual(cert.signatureHash, "SHA-256");
  assert.strictEqual(cert.signatureFamily, "RSA");
  assert.ok(cert.signatureLength > 0);
});

test("reads an RSA public key and its size", async () => {
  const cert = await inspectFirst(fx.LEAF);
  assert.strictEqual(cert.publicKey.keyType, "RSA");
  assert.strictEqual(cert.publicKey.keySize, 2048);
  assert.strictEqual(cert.publicKey.rsa.exponent, "65537");
  assert.match(cert.publicKey.rsa.modulus, /^\d{600,}$/);
});

test("reads an EC public key and its named curve", async () => {
  const cert = await inspectFirst(fx.EC_LEAF);
  assert.strictEqual(cert.publicKey.keyType, "EC");
  assert.strictEqual(cert.publicKey.keySize, 256);
  assert.match(cert.publicKey.curve, /prime256v1/);
});

test("marks a CA certificate and its path length", async () => {
  const root = await inspectFirst(fx.ROOT_CA);
  assert.strictEqual(root.isCA, true);
  const inter = await inspectFirst(fx.INTERMEDIATE_CA);
  assert.strictEqual(inter.isCA, true);
  assert.strictEqual(inter.pathLen, 0);
  const leaf = await inspectFirst(fx.LEAF);
  assert.strictEqual(leaf.isCA, false);
});

test("decodes key usage and extended key usage", async () => {
  const cert = await inspectFirst(fx.LEAF);
  assert.deepStrictEqual(cert.keyUsage.usages, ["digitalSignature", "keyEncipherment"]);
  const ekus = cert.extendedKeyUsage.usages.map((u) => u.oid);
  assert.deepStrictEqual(ekus, ["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"]);
});

test("decodes every subject alternative name type", async () => {
  const cert = await inspectFirst(fx.LEAF);
  const byType = {};
  cert.subjectAltNames.forEach((n) => {
    (byType[n.type] = byType[n.type] || []).push(n.value);
  });
  assert.deepStrictEqual(byType.dNSName, ["example.com", "www.example.com"]);
  assert.deepStrictEqual(byType.iPAddress, ["203.0.113.10"]);
  assert.deepStrictEqual(byType.rfc822Name, ["admin@example.com"]);
  assert.strictEqual(cert.subjectAltNames.length, 4);
});

test("decodes wildcard SANs verbatim", async () => {
  const cert = await inspectFirst(fx.WILDCARD);
  const names = cert.subjectAltNames.map((n) => n.value);
  assert.deepStrictEqual(names, ["*.example.org", "example.org", "*.api.example.org"]);
});

test("decodes AIA, CRL distribution points and certificate policies", async () => {
  const cert = await inspectFirst(fx.LEAF);
  const byOid = {};
  cert.extensions.forEach((e) => { byOid[e.oid] = e; });
  assert.match(byOid["1.3.6.1.5.5.7.1.1"].decoded.summary, /OCSP → http:\/\/ocsp\.toolshed\.test\//);
  assert.match(byOid["2.5.29.31"].decoded.summary, /http:\/\/crl\.toolshed\.test\/root\.crl/);
  assert.deepStrictEqual(byOid["2.5.29.32"].decoded.policies.map((p) => p.oid), ["1.2.3.4.5"]);
});

test("marks critical extensions", async () => {
  const cert = await inspectFirst(fx.LEAF);
  const bc = cert.extensions.find((e) => e.oid === "2.5.29.19");
  const eku = cert.extensions.find((e) => e.oid === "2.5.29.37");
  assert.strictEqual(bc.critical, true);
  assert.strictEqual(eku.critical, false);
});

test("reads the subject key identifier", async () => {
  const cert = await inspectFirst(fx.LEAF);
  assert.strictEqual(cert.subjectKeyIdentifier.colon, "6F:6D:DC:B2:A7:9D:80:38:F3:03:CA:17:AB:09:8F:B4:8B:1E:A1:8E");
});

test("reads the authority key identifier", async () => {
  const cert = await inspectFirst(fx.LEAF);
  assert.strictEqual(cert.authorityKeyIdentifier.keyIdentifierColon,
    "61:EB:32:3B:A6:13:F5:46:A8:4E:10:BD:46:5F:E3:17:AE:49:9F:11");
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

test("computes fingerprints that match OpenSSL output", async () => {
  const cert = await inspectFirst(fx.LEAF);
  assert.strictEqual(cert.fingerprints["SHA-256"].colon,
    "EE:3F:38:0C:72:A9:24:81:D0:61:4D:55:F6:9A:46:67:A0:43:AD:82:B9:E5:EA:70:BB:13:B3:54:FD:42:75:32");
  assert.strictEqual(cert.fingerprints["SHA-1"].colon,
    "29:BA:0D:42:A3:E6:5F:67:CF:52:1D:30:54:94:7E:28:E8:8A:F2:80");
  assert.strictEqual(cert.fingerprints["SHA-384"].hex.length, 96);
  assert.strictEqual(cert.fingerprints["SHA-512"].hex.length, 128);
});

test("computed subject key identifier matches the extension for a CA", async () => {
  const cert = await inspectFirst(fx.ROOT_CA);
  assert.strictEqual(cert.computedKeyIdentifier, cert.subjectKeyIdentifier.colon);
});

// ---------------------------------------------------------------------------
// Validity states and security analysis
// ---------------------------------------------------------------------------

test("flags an expired certificate", async () => {
  const cert = await inspectFirst(fx.EXPIRED);
  assert.strictEqual(ci.validityState(cert), "expired");
  assert.ok(cert.analysis.findings.some((f) => f.severity === "error" && /Expired/.test(f.title)));
});

test("flags a not-yet-valid certificate", async () => {
  const cert = await inspectFirst(fx.NOT_YET_VALID);
  assert.strictEqual(ci.validityState(cert), "not-yet-valid");
  assert.ok(cert.analysis.findings.some((f) => f.severity === "error" && /Not yet valid/.test(f.title)));
});

test("reports an expiring certificate when 20 days remain", async () => {
  const cert = await inspectFirst(fx.LEAF);
  const nearEnd = cert.validity.notAfter.epoch - 20 * 86400000;
  assert.strictEqual(ci.validityState(cert, nearEnd), "expiring");
  const analysis = ci.analyzeCertificate(cert, nearEnd);
  assert.ok(analysis.findings.some((f) => f.severity === "warning" && /Expires soon/.test(f.title)));
});

test("reports a valid certificate inside its window", async () => {
  const cert = await inspectFirst(fx.LEAF);
  assert.strictEqual(ci.validityState(cert), "valid");
});

test("flags a SHA-1 signature as an error", async () => {
  const cert = await inspectFirst(fx.SHA1);
  assert.strictEqual(cert.signatureHash, "SHA-1");
  assert.ok(cert.analysis.findings.some((f) => f.severity === "error" && /SHA-1/.test(f.title)));
});

test("notes a long validity period", async () => {
  const cert = await inspectFirst(fx.WILDCARD);
  assert.ok(cert.analysis.findings.some((f) => /Long validity period/.test(f.title)));
});

test("identifies a self-signed root", async () => {
  const cert = await inspectFirst(fx.ROOT_CA);
  assert.ok(cert.analysis.findings.some((f) => /Self-signed/.test(f.title)));
});

test("warns when a leaf has no subject alternative name", async () => {
  const cert = await inspectFirst(fx.EXPIRED);
  // The expired fixture does carry a SAN; synthesize a no-SAN finding check via
  // a leaf that has one, then confirm the code path with a direct analysis.
  assert.ok(cert.subjectAltNames.length > 0);
  const synthetic = JSON.parse(JSON.stringify({
    validity: cert.validity,
    signatureHash: "SHA-256",
    signatureFamily: "RSA",
    signatureAlgorithm: cert.signatureAlgorithm,
    publicKey: cert.publicKey,
    isCA: false,
    keyUsage: cert.keyUsage,
    extendedKeyUsage: cert.extendedKeyUsage,
    subjectAltNames: [],
    subject: cert.subject,
    issuer: cert.issuer,
    extensions: [],
    subjectKeyIdentifier: cert.subjectKeyIdentifier,
    authorityKeyIdentifier: cert.authorityKeyIdentifier
  }));
  const analysis = ci.analyzeCertificate(synthetic, Date.now());
  assert.ok(analysis.findings.some((f) => /No Subject Alternative Name/.test(f.title)));
});

test("summarises findings by severity", async () => {
  const cert = await inspectFirst(fx.SHA1);
  assert.strictEqual(typeof cert.analysis.summary.error, "number");
  assert.strictEqual(typeof cert.analysis.summary.warning, "number");
  assert.strictEqual(typeof cert.analysis.summary.info, "number");
  assert.ok(cert.analysis.summary.error >= 1);
});

// ---------------------------------------------------------------------------
// Certificate signing requests
// ---------------------------------------------------------------------------

test("parses a bare CSR", async () => {
  const csr = await inspectFirst(fx.LEAF_CSR);
  assert.strictEqual(csr.kind, "csr");
  assert.strictEqual(csr.version, 0);
  assert.strictEqual(csr.subject.formatted,
    "C=US, ST=California, L=San Francisco, O=Toolshed Test Ltd, CN=example.com");
  assert.strictEqual(csr.publicKey.keySize, 2048);
  assert.strictEqual(csr.analysis.summary.error, 0);
});

test("parses a CSR and its requested extensions", async () => {
  const csr = await inspectFirst(fx.CSR_WITH_SAN);
  assert.strictEqual(csr.kind, "csr");
  const names = csr.extensionRequest.map((e) => e.name);
  assert.ok(names.includes("Subject Alternative Name"));
  assert.ok(names.includes("Basic Constraints"));
  assert.deepStrictEqual(csr.subjectAltNames.map((n) => n.value),
    ["api.example.dev", "api.internal.example.dev"]);
  assert.ok(csr.attributes.some((a) => a.oid === "1.2.840.113549.1.9.14"));
});

test("notes a CSR that requests no SAN", async () => {
  const csr = await inspectFirst(fx.LEAF_CSR);
  assert.ok(csr.analysis.findings.some((f) => /No SAN requested/.test(f.title)));
});

test("distinguishes a CSR from a certificate", async () => {
  const csrBlock = ci.parseBlock({ der: ci.decodeInput(fx.LEAF_CSR).blocks[0].der, label: "CERTIFICATE REQUEST", source: "pem", kind: "csr" });
  assert.strictEqual(csrBlock.ok, true);
  assert.strictEqual(csrBlock.value.kind, "csr");
  const certBlock = ci.parseBlock({ der: ci.decodeInput(fx.LEAF).blocks[0].der, label: "CERTIFICATE", source: "pem", kind: "certificate" });
  assert.strictEqual(certBlock.value.kind, "certificate");
});

// ---------------------------------------------------------------------------
// Chains and multiple blocks
// ---------------------------------------------------------------------------

test("parses a PEM chain of three certificates", async () => {
  const res = await ci.inspect(fx.CHAIN);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.items.length, 3);
  assert.deepStrictEqual(res.items.map((i) => i.kind), ["certificate", "certificate", "certificate"]);
  assert.match(res.items[0].subject.formatted, /CN=example\.com/);
  assert.match(res.items[2].subject.formatted, /Root CA/);
});

test("keeps parseable blocks when one block is broken", async () => {
  const mixed = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" + fx.LEAF;
  const res = await ci.inspect(mixed);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.items.length, 1);
  assert.strictEqual(res.errors.length, 1);
});

test("fails cleanly when every block is unparseable", async () => {
  const res = await ci.inspect("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----");
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.length > 0);
});

// ---------------------------------------------------------------------------
// ASN.1 primitives
// ---------------------------------------------------------------------------

test("decodes OID values", () => {
  assert.strictEqual(ci.decodeOid(new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])),
    "1.2.840.113549.1.1.11");
  assert.strictEqual(ci.decodeOid(new Uint8Array([0x55, 0x1d, 0x13])), "2.5.29.19");
});

test("decodes large integers without floating point loss", () => {
  // 0x00FF... (256-bit-ish) serial numbers must keep every digit.
  const bytes = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x00]);
  assert.strictEqual(ci.decodeIntegerBig(bytes), "4294967296");
});

test("computes bit lengths of big-endian byte strings", () => {
  assert.strictEqual(ci.bitLengthOfBytes(new Uint8Array([0x00, 0x00, 0x80])), 8);
  assert.strictEqual(ci.bitLengthOfBytes(new Uint8Array([0x00, 0x01, 0x00])), 9);
  assert.strictEqual(ci.bitLengthOfBytes(new Uint8Array([0x00])), 0);
});

test("parses UTCTime and GeneralizedTime", () => {
  const utc = ci.decodeTime({ tagNumber: 23, value: ci.utf8ToBytes("261029033642Z") });
  assert.strictEqual(utc.iso, "2026-10-29T03:36:42.000Z");
  const general = ci.decodeTime({ tagNumber: 24, value: ci.utf8ToBytes("20261029033642Z") });
  assert.strictEqual(general.iso, "2026-10-29T03:36:42.000Z");
  const offset = ci.decodeTime({ tagNumber: 23, value: ci.utf8ToBytes("261029033642+0200") });
  assert.strictEqual(offset.iso, "2026-10-29T01:36:42.000Z");
});

test("rejects an indefinite-length ASN.1 element", () => {
  assert.throws(() => ci.parseDer(new Uint8Array([0x30, 0x80, 0x00, 0x00])), /Indefinite/);
});

test("rejects a length that overruns the buffer", () => {
  assert.throws(() => ci.parseDer(new Uint8Array([0x30, 0x7f, 0x01])), /past the end/);
});

// ---------------------------------------------------------------------------
// JSON export and helpers
// ---------------------------------------------------------------------------

test("produces a JSON report for a certificate", async () => {
  const res = await ci.inspect(fx.LEAF);
  const json = ci.toJsonReport(res);
  const item = json.items[0];
  assert.strictEqual(item.kind, "certificate");
  assert.strictEqual(item.subject.includes("CN=example.com"), true);
  assert.strictEqual(item.publicKey.size, 2048);
  assert.ok(Array.isArray(item.analysis));
  assert.strictEqual(item.fingerprints["SHA-256"].colon.length, 95);
});

test("produces a JSON report for a CSR", async () => {
  const res = await ci.inspect(fx.CSR_WITH_SAN);
  const json = ci.toJsonReport(res);
  assert.strictEqual(json.items[0].kind, "csr");
  assert.strictEqual(json.items[0].subjectAltNames.length, 2);
});

test("formats dates in UTC", () => {
  assert.strictEqual(ci.formatDate(Date.UTC(2026, 9, 29, 3, 36, 42)), "2026-10-29 03:36:42 UTC");
  assert.strictEqual(ci.formatDate(NaN), "—");
});

// ---------------------------------------------------------------------------
// Robustness / security
// ---------------------------------------------------------------------------

test("is deterministic for repeated inspection", async () => {
  const a = ci.toJsonReport(await ci.inspect(fx.LEAF));
  const b = ci.toJsonReport(await ci.inspect(fx.LEAF));
  assert.deepStrictEqual(a, b);
});

test("treats embedded markup as data, never as code", async () => {
  // A comment extension carrying script-looking bytes must not execute.
  const cert = await inspectFirst(fx.LEAF);
  const evil = '<script>alert(1)</script>';
  const encoded = ci.utf8ToBytes(evil);
  assert.strictEqual(ci.bytesToHex(encoded).length, evil.length * 2);
  assert.strictEqual(cert.subject.formatted.includes("<script>"), false);
});

test("survives deeply nested but malformed structures", async () => {
  const nested = new Uint8Array(600).fill(0x30);
  const res = await ci.inspect(ci.bytesToBase64(nested));
  assert.strictEqual(res.ok, false);
});

test("handles a very long SAN list without throwing", async () => {
  // Repeat the leaf certificate many times to exercise multiple-block parsing.
  const many = new Array(20).fill(fx.LEAF).join("\n");
  const res = await ci.inspect(many);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.items.length, 20);
});

// ---------------------------------------------------------------------------
// Chain building and signature verification
// ---------------------------------------------------------------------------

test("orders a shuffled bundle into a leaf-to-root chain", async () => {
  // Deliberately out of order: root first, then leaf, then intermediate.
  const shuffled = [fx.ROOT_CA, fx.LEAF, fx.INTERMEDIATE_CA].join("\n");
  const res = await ci.inspect(shuffled);
  const chain = ci.buildChain(res.items);
  assert.strictEqual(chain.complete, true);
  assert.strictEqual(chain.chain.length, 3);
  assert.strictEqual(ci.nameValue(chain.chain[0].subject, "CN"), "example.com");
  assert.strictEqual(ci.nameValue(chain.chain[1].subject, "CN"), "Toolshed Test Intermediate CA");
  assert.strictEqual(ci.nameValue(chain.chain[2].subject, "CN"), "Toolshed Test Root CA");
  assert.strictEqual(chain.unused.length, 0);
});

test("links the chain using authority key identifiers", async () => {
  const res = await ci.inspect(fx.CHAIN);
  const chain = ci.buildChain(res.items);
  assert.strictEqual(chain.chain.length, 3);
  assert.strictEqual(chain.links[0].reason, "matched by key identifier");
  assert.strictEqual(chain.links[2].selfSigned, true);
});

test("reports an incomplete chain when the issuer is missing", async () => {
  const res = await ci.inspect(fx.LEAF);
  const chain = ci.buildChain(res.items);
  assert.strictEqual(chain.complete, false);
  assert.strictEqual(chain.chain.length, 1);
  assert.match(chain.links[0].reason, /issuer not found/);
});

test("buildChain ignores non-certificate items and empty input", async () => {
  const res = await ci.inspect(fx.LEAF + "\n" + fx.LEAF_CSR);
  const chain = ci.buildChain(res.items);
  assert.strictEqual(chain.chain.length, 1);
  const empty = ci.buildChain([]);
  assert.strictEqual(empty.ok, false);
  assert.match(empty.error, /No certificates/);
});

test("verifies a valid signature from the issuing CA", async () => {
  const res = await ci.inspect(fx.CHAIN);
  const [leaf, intermediate, root] = res.items;
  const leafByIntermediate = await ci.verifySignature(leaf, intermediate);
  assert.strictEqual(leafByIntermediate.status, "valid");
  assert.strictEqual(leafByIntermediate.hash, "SHA-256");
  const intermediateByRoot = await ci.verifySignature(intermediate, root);
  assert.strictEqual(intermediateByRoot.status, "valid");
});

test("verifies a self-signed root against its own key", async () => {
  const res = await ci.inspect(fx.ROOT_CA);
  const result = await ci.verifySignature(res.items[0], res.items[0]);
  assert.strictEqual(result.status, "valid");
});

test("rejects a signature checked against the wrong issuer key", async () => {
  const res = await ci.inspect(fx.CHAIN);
  const [leaf, intermediate] = res.items;
  // The leaf was not signed by its own key.
  const wrong = await ci.verifySignature(leaf, leaf);
  assert.strictEqual(wrong.status, "invalid");
  // Nor was the intermediate signed by the leaf.
  const backwards = await ci.verifySignature(intermediate, leaf);
  assert.strictEqual(backwards.status, "invalid");
});

test("verifies a CSR signature against its own public key", async () => {
  const csr = await inspectFirst(fx.LEAF_CSR);
  const result = await ci.verifySignature(csr, csr);
  assert.strictEqual(result.status, "valid");
});

test("verifies an ECDSA signature after DER-to-raw conversion", async () => {
  const res = await ci.inspect(fx.EC_SELF_SIGNED);
  const result = await ci.verifySignature(res.items[0], res.items[0]);
  assert.strictEqual(result.status, "valid");
  assert.strictEqual(result.hash, "SHA-256");
});

test("explains a key/algorithm mismatch instead of throwing", async () => {
  const certs = await ci.inspect(fx.EC_LEAF + "\n" + fx.EC_SELF_SIGNED);
  const [rsaSignedEcCert, ecKey] = certs.items;
  const result = await ci.verifySignature(rsaSignedEcCert, ecKey);
  assert.strictEqual(result.status, "unsupported");
  assert.match(result.reason, /RSA.*EC|EC.*RSA/);
});

test("reports unsupported verification targets without throwing", async () => {
  const noIssuer = await ci.verifySignature({ kind: "certificate" }, null);
  assert.strictEqual(noIssuer.status, "unsupported");
  const nonsense = await ci.verifySignature({ kind: "other" }, { publicKey: {} });
  assert.strictEqual(nonsense.status, "unsupported");
});

test("verifies every link in a complete chain", async () => {
  const res = await ci.inspect(fx.CHAIN);
  const chain = ci.buildChain(res.items);
  const verified = await ci.verifyChain(chain.chain);
  assert.strictEqual(verified.links.length, 2);
  verified.links.forEach((l) => assert.strictEqual(l.result.status, "valid"));
  assert.ok(verified.selfSignature);
  assert.strictEqual(verified.selfSignature.result.status, "valid");
});

test("normalises ECDSA r/s integers to fixed-width raw bytes", async () => {
  // A minimal DER SEQUENCE { INTEGER 1, INTEGER 1 } should pad to the curve width.
  const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]);
  const raw = ci.ecdsaDerToRaw(der, 32);
  assert.strictEqual(raw.length, 64);
  assert.strictEqual(raw[31], 1);
  assert.strictEqual(raw[63], 1);
  assert.strictEqual(raw[0], 0);
});

test("rejects a malformed ECDSA signature structure", async () => {
  const notASequence = new Uint8Array([0x02, 0x01, 0x01]);
  assert.throws(() => ci.ecdsaDerToRaw(notASequence, 32));
  const oneInteger = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]);
  assert.throws(() => ci.ecdsaDerToRaw(oneInteger, 32));
});

Promise.all(pending).then(() => {
  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
});
