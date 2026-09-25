"use strict";

const assert = require("assert");
const crypto = require("node:crypto");
const checksum = require("../tool.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok - " + name);
  } catch (err) {
    failed += 1;
    console.log("  FAIL - " + name);
    console.log("         " + String(err.message || err).split("\n").join("\n         "));
  }
}

const enc = new TextEncoder();

// --- MD5 RFC 1321 vectors ----------------------------------------------------------
test("MD5 matches all RFC 1321 test vectors", async function () {
  const vectors = [
    [enc.encode(""), "d41d8cd98f00b204e9800998ecf8427e"],
    [enc.encode("a"), "0cc175b9c0f1b6a831c399e269772661"],
    [enc.encode("abc"), "900150983cd24fb0d6963f7d28e17f72"],
    [enc.encode("message digest"), "f96b697d7cb7938d525a2f31aaf161d0"],
    [enc.encode("abcdefghijklmnopqrstuvwxyz"), "c3fcd3d76192e4007dfb496cca67e13b"],
    [enc.encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"), "d174ab98d277d9f5a5611c2c9f419d9f"],
    [enc.encode("12345678901234567890123456789012345678901234567890123456789012345678901234567890"), "57edf4a22be3c955ac49da2e2107b67a"]
  ];
  for (const [input, want] of vectors) {
    const got = checksum.md5(input);
    assert.strictEqual(Buffer.from(got).toString("hex"), want);
  }
});

// --- MD5 cross-check against node:crypto --------------------------------------------
test("MD5 matches node:crypto on multi-block random input", function () {
  const data = crypto.randomBytes(1048576);
  const got = Buffer.from(checksum.md5(data)).toString("hex");
  const want = crypto.createHash("md5").update(data).digest("hex");
  assert.strictEqual(got, want);
});

// --- compute() ------------------------------------------------------------------------
test("compute hashes a Uint8Array with every algorithm", async function () {
  const data = enc.encode("The quick brown fox jumps over the lazy dog");
  const res = await checksum.compute(data, { algorithms: ["SHA-1", "SHA-256", "SHA-384", "MD5"] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.bytes, data.length);
  assert.strictEqual(res.digests["SHA-1"], "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12");
  assert.strictEqual(res.digests["SHA-256"], "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
  assert.strictEqual(res.digests["SHA-384"], "ca737f1014a48f4c0b6dd43cb177b0afd9e5169367544c494011e3317dbf9a509cb1e5dc1e85a941bbee3d7f2afbc9b1");
  assert.strictEqual(res.digests.MD5, "9e107d9d372bb6826bd81d3542a419d6");
});

test("compute hashes an ArrayBuffer and a string", async function () {
  const ab = enc.encode("abc").buffer;
  const viaBuffer = await checksum.compute(ab, { algorithms: ["MD5"] });
  assert.strictEqual(viaBuffer.digests.MD5, "900150983cd24fb0d6963f7d28e17f72");

  const viaString = await checksum.compute("abc", { algorithms: ["MD5"] });
  assert.strictEqual(viaString.digests.MD5, "900150983cd24fb0d6963f7d28e17f72");
});

test("compute hashes a File-like object via arrayBuffer", async function () {
  const fileLike = {
    name: "sample.txt",
    size: 3,
    arrayBuffer: async function () { return enc.encode("abc").buffer; }
  };
  const res = await checksum.compute(fileLike, { algorithms: ["SHA-256", "MD5"] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.digests.MD5, "900150983cd24fb0d6963f7d28e17f72");
  assert.strictEqual(res.digests["SHA-256"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("compute handles an empty file", async function () {
  const res = await checksum.compute(enc.encode(""), { algorithms: ["MD5", "SHA-256"] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.bytes, 0);
  assert.strictEqual(res.digests.MD5, "d41d8cd98f00b204e9800998ecf8427e");
  assert.strictEqual(res.digests["SHA-256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

// --- errors and validation ------------------------------------------------------------
test("compute rejects no input", async function () {
  const res = await checksum.compute(null, { algorithms: ["MD5"] });
  assert.strictEqual(res.ok, false);
  assert.ok(res.message.length > 0);
});

test("compute rejects empty algorithm list", async function () {
  const res = await checksum.compute("abc", { algorithms: [] });
  assert.strictEqual(res.ok, false);
  assert.ok(res.message.length > 0);
});

test("compute rejects unknown algorithms", async function () {
  const res = await checksum.compute("abc", { algorithms: ["Skein"] });
  assert.strictEqual(res.ok, false);
  assert.ok(res.message.length > 0);
});

test("compute deduplicates algorithm names case-insensitively", async function () {
  const res = await checksum.compute("abc", { algorithms: ["MD5", "md5", "SHA-256", "sha-256"] });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(Object.keys(res.digests).sort(), ["MD5", "SHA-256"]);
  assert.strictEqual(res.digests.MD5, "900150983cd24fb0d6963f7d28e17f72");
});

// --- helpers ------------------------------------------------------------------------------
test("formatBytes renders human sizes", function () {
  assert.strictEqual(checksum.formatBytes(0), "0 B");
  assert.strictEqual(checksum.formatBytes(523), "523 B");
  assert.strictEqual(checksum.formatBytes(1024), "1.0 KiB");
  assert.strictEqual(checksum.formatBytes(1536), "1.5 KiB");
  assert.strictEqual(checksum.formatBytes(1048576), "1.0 MiB");
  assert.strictEqual(checksum.formatBytes(1073741824), "1.0 GiB");
});

test("SUPPORTED exposes the four algorithm names", function () {
  assert.deepStrictEqual(checksum.SUPPORTED.map(function (t) { return t.id; }), ["SHA-1", "SHA-256", "SHA-384", "MD5"]);
});

if (failed > 0) {
  console.log(failed + " failed," + passed + " passed");
  process.exit(1);
} else {
  console.log(passed + " passed");
}
