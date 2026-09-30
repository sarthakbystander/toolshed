"use strict";

const assert = require("node:assert");
const fia = require("../tool.js");

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      pending.push(out.then(
        () => { passed++; console.log("  ok - " + name); },
        (err) => {
          failed++;
          console.error("  FAIL - " + name);
          console.error("         " + (err && err.message));
        }
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

function hexOf(algorithm, text) {
  return fia.bytesToHex(fia.shaFallback(algorithm, new TextEncoder().encode(text)));
}

console.log("file-integrity-auditor tests");

// ---------------------------------------------------------------------------
// MD5
// ---------------------------------------------------------------------------

test("md5 matches RFC 1321 vectors", () => {
  assert.strictEqual(fia.bytesToHex(fia.md5(new TextEncoder().encode(""))), "d41d8cd98f00b204e9800998ecf8427e");
  assert.strictEqual(fia.bytesToHex(fia.md5(new TextEncoder().encode("abc"))), "900150983cd24fb0d6963f7d28e17f72");
  assert.strictEqual(
    fia.bytesToHex(fia.md5(new TextEncoder().encode("The quick brown fox jumps over the lazy dog"))),
    "9e107d9d372bb6826bd81d3542a419d6"
  );
});

test("md5 handles the 1,000,000 'a' vector (multi-block)", () => {
  const input = new TextEncoder().encode("a".repeat(1000000));
  assert.strictEqual(fia.bytesToHex(fia.md5(input)), "7707d6ae4e027c70eea2a935c2296f21");
});

test("incremental md5 matches one-shot across awkward chunk sizes", () => {
  const data = new TextEncoder().encode(
    "The quick brown fox jumps over the lazy dog and then some more bytes to cross block boundaries repeatedly"
  );
  const expected = fia.bytesToHex(fia.md5(data));
  for (const size of [1, 7, 55, 56, 57, 63, 64, 65, 1000]) {
    const h = fia.md5Create();
    for (let i = 0; i < data.length; i += size) h.update(data.subarray(i, i + size));
    assert.strictEqual(fia.bytesToHex(h.digest()), expected, "chunk size " + size);
  }
});

test("incremental md5 with empty updates matches empty digest", () => {
  const h = fia.md5Create();
  h.update(new Uint8Array(0));
  h.update(new Uint8Array(0));
  assert.strictEqual(fia.bytesToHex(h.digest()), "d41d8cd98f00b204e9800998ecf8427e");
});

// ---------------------------------------------------------------------------
// SHA family (pure fallback path, exercised on every platform)
// ---------------------------------------------------------------------------

test("sha-1 matches NIST vectors", () => {
  assert.strictEqual(hexOf("sha-1", "abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.strictEqual(hexOf("sha-1", ""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
});

test("sha-256 matches NIST vectors", () => {
  assert.strictEqual(hexOf("sha-256", "abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.strictEqual(hexOf("sha-256", ""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("sha-384 matches NIST vectors", () => {
  assert.strictEqual(
    hexOf("sha-384", "abc"),
    "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7"
  );
});

test("sha-512 matches NIST vectors", () => {
  assert.strictEqual(
    hexOf("sha-512", "abc"),
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
  );
});

test("sha fallback handles the 1,000,000 'a' vectors", () => {
  const input = new TextEncoder().encode("a".repeat(1000000));
  assert.strictEqual(fia.bytesToHex(fia.shaFallback("sha-256", input)),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  assert.strictEqual(fia.bytesToHex(fia.shaFallback("sha-512", input)),
    "e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973ebde0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b");
});

test("digest() and hashBytes() agree with the pure fallback", async () => {
  const data = new TextEncoder().encode("integrity");
  const expected = hexOf("sha-256", "integrity");
  const viaDigest = await fia.digest("sha-256", data);
  assert.strictEqual(viaDigest.hex, expected);
  const viaHash = await fia.hashBytes(data, ["md5", "sha-256"]);
  assert.strictEqual(viaHash["sha-256"].hex, expected);
  assert.strictEqual(viaHash.md5.hex, fia.bytesToHex(fia.md5(data)));
});

test("base64 encoding matches Buffer", () => {
  const data = new Uint8Array([0, 1, 2, 250, 255, 128, 64, 63]);
  assert.strictEqual(fia.bytesToBase64(data), Buffer.from(data).toString("base64"));
});

// ---------------------------------------------------------------------------
// Algorithm resolution
// ---------------------------------------------------------------------------

test("canonicalAlgorithm normalizes common spellings", () => {
  assert.strictEqual(fia.canonicalAlgorithm("SHA256"), "sha-256");
  assert.strictEqual(fia.canonicalAlgorithm("sha256"), "sha-256");
  assert.strictEqual(fia.canonicalAlgorithm("SHA-256"), "sha-256");
  assert.strictEqual(fia.canonicalAlgorithm("sha_256"), "sha-256");
  assert.strictEqual(fia.canonicalAlgorithm("MD5"), "md5");
  assert.strictEqual(fia.canonicalAlgorithm("SHA1"), "sha-1");
  assert.strictEqual(fia.canonicalAlgorithm("sha-384"), "sha-384");
  assert.strictEqual(fia.canonicalAlgorithm("sha512"), "sha-512");
  assert.strictEqual(fia.canonicalAlgorithm("crc32"), null);
  assert.strictEqual(fia.canonicalAlgorithm(null), null);
});

test("algorithmFromLength maps hex lengths to algorithms", () => {
  assert.strictEqual(fia.algorithmFromLength("a".repeat(32)), "md5");
  assert.strictEqual(fia.algorithmFromLength("a".repeat(40)), "sha-1");
  assert.strictEqual(fia.algorithmFromLength("a".repeat(64)), "sha-256");
  assert.strictEqual(fia.algorithmFromLength("a".repeat(96)), "sha-384");
  assert.strictEqual(fia.algorithmFromLength("a".repeat(128)), "sha-512");
  assert.strictEqual(fia.algorithmFromLength("a".repeat(10)), null);
});

test("normalizeDigest strips prefixes and rejects non-hex", () => {
  assert.strictEqual(fia.normalizeDigest("sha256:ABCDEF"), "abcdef");
  assert.strictEqual(fia.normalizeDigest("  ABCDEF  "), "abcdef");
  assert.strictEqual(fia.normalizeDigest("not a digest"), "");
  assert.strictEqual(fia.normalizeDigest(""), "");
  assert.strictEqual(fia.normalizeDigest(null), "");
});

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

test("parses GNU coreutils output", () => {
  const out = fia.parseManifest("d41d8cd98f00b204e9800998ecf8427e  empty.txt\n");
  assert.strictEqual(out.entries.length, 1);
  assert.strictEqual(out.entries[0].filename, "empty.txt");
  assert.strictEqual(out.entries[0].algorithm, "md5");
  assert.strictEqual(out.entries[0].escaped, false);
});

test("parses GNU coreutils binary-mode marker", () => {
  const out = fia.parseManifest("900150983cd24fb0d6963f7d28e17f72 *archive.bin");
  assert.strictEqual(out.entries[0].filename, "archive.bin");
  assert.strictEqual(out.entries[0].escaped, true);
});

test("parses BSD / --tag style", () => {
  const out = fia.parseManifest([
    "MD5 (legacy.txt) = 9e107d9d372bb6826bd81d3542a419d6",
    "SHA256 (tagged.txt) = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  ].join("\n"));
  assert.strictEqual(out.entries.length, 2);
  assert.strictEqual(out.entries[0].algorithm, "md5");
  assert.strictEqual(out.entries[0].filename, "legacy.txt");
  assert.strictEqual(out.entries[1].algorithm, "sha-256");
  assert.strictEqual(out.entries[1].filename, "tagged.txt");
});

test("infers algorithm from digest length when unlabelled", () => {
  const out = fia.parseManifest("a".repeat(40) + "  file.bin");
  assert.strictEqual(out.entries[0].algorithm, "sha-1");
});

test("parses CSV manifests in either column order", () => {
  const out = fia.parseManifest([
    "app.js,2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad,server.py",
  ].join("\n"));
  assert.strictEqual(out.entries.length, 2);
  assert.strictEqual(out.entries[0].filename, "app.js");
  assert.strictEqual(out.entries[1].filename, "server.py");
});

test("parses RFC 9530 structured digest as a digest-only record", () => {
  const out = fia.parseManifest("sha-256=:YOnHp7dT6j8SLJPAdM8J3pAxFmuV/THhYAVGqoOkm9E=:");
  assert.strictEqual(out.entries.length, 1);
  assert.strictEqual(out.entries[0].algorithm, "sha-256");
  assert.strictEqual(out.entries[0].filename, "");
});

test("ignores blank lines and comments", () => {
  const out = fia.parseManifest("\n# comment\n\nd41d8cd98f00b204e9800998ecf8427e  a.txt\n");
  assert.strictEqual(out.entries.length, 1);
  assert.strictEqual(out.skipped.length, 0);
});

test("reports unparseable lines without throwing", () => {
  const out = fia.parseManifest("this is not a manifest line\n");
  assert.strictEqual(out.entries.length, 0);
  assert.strictEqual(out.skipped.length, 1);
  assert.strictEqual(out.skipped[0].line, 1);
});

test("empty manifest yields no entries and no errors", () => {
  const out = fia.parseManifest("");
  assert.strictEqual(out.entries.length, 0);
  assert.strictEqual(out.skipped.length, 0);
});

test("handles CRLF manifests", () => {
  const out = fia.parseManifest("d41d8cd98f00b204e9800998ecf8427e  a.txt\r\n900150983cd24fb0d6963f7d28e17f72  b.txt\r\n");
  assert.strictEqual(out.entries.length, 2);
  assert.strictEqual(out.entries[1].filename, "b.txt");
});

test("normalizes nested paths to a basename for matching", () => {
  const out = fia.parseManifest("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  path/to/nested.txt");
  assert.strictEqual(out.entries[0].filename, "path/to/nested.txt");
  assert.strictEqual(out.entries[0].path, "nested.txt");
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const D = {
  good: "900150983cd24fb0d6963f7d28e17f72",
  bad: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  absent: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  other: "11111111111111111111111111111111"
};

test("audit classifies match, mismatch, missing and extra", () => {
  const entries = fia.parseManifest([
    D.good + "  good.txt",
    D.bad + "  bad.txt",
    D.absent + "  absent.txt",
  ].join("\n")).entries;
  const files = [
    { name: "good.txt", digests: { md5: D.good } },
    { name: "bad.txt", digests: { md5: "00000000000000000000000000000000" } },
    { name: "other.txt", digests: { md5: D.other } },
  ];
  const res = fia.audit(files, entries, { checkExtras: true });
  assert.deepStrictEqual(res.summary, { total: 4, match: 1, mismatch: 1, missing: 1, extra: 1, unknown: 0 });
  const byName = {};
  res.rows.forEach((r) => { byName[r.filename] = r; });
  assert.strictEqual(byName["good.txt"].status, "match");
  assert.strictEqual(byName["bad.txt"].status, "mismatch");
  assert.strictEqual(byName["absent.txt"].status, "missing");
  assert.strictEqual(byName["other.txt"].status, "extra");
});

test("audit matches nested manifest paths by basename", () => {
  const entries = fia.parseManifest(D.good + "  dist/app.js").entries;
  const files = [{ name: "app.js", digests: { md5: D.good } }];
  const res = fia.audit(files, entries);
  assert.strictEqual(res.summary.match, 1);
});

test("audit supports one file verified against two algorithms", () => {
  const sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const entries = fia.parseManifest([
    D.good + "  good.bin",
    sha + "  good.bin",
  ].join("\n")).entries;
  const files = [{ name: "good.bin", digests: { md5: D.good, "sha-256": sha } }];
  const res = fia.audit(files, entries, { checkExtras: true });
  assert.strictEqual(res.summary.match, 2);
  assert.strictEqual(res.summary.extra, 0);
});

test("audit flags a duplicate file+algorithm entry", () => {
  const entries = fia.parseManifest([
    D.good + "  dup.txt",
    D.good + "  dup.txt",
  ].join("\n")).entries;
  const files = [{ name: "dup.txt", digests: { md5: D.good } }];
  const res = fia.audit(files, entries);
  assert.strictEqual(res.summary.match, 1);
  assert.strictEqual(res.summary.mismatch, 1);
  assert.match(res.rows[1].note, /more than once/);
});

test("audit marks digest-only entries as unknown", () => {
  const entries = fia.parseManifest("sha-256=:YOnHp7dT6j8SLJPAdM8J3pAxFmuV/THhYAVGqoOkm9E=:").entries;
  const res = fia.audit([{ name: "x", digests: { md5: D.good } }], entries);
  assert.strictEqual(res.summary.unknown, 1);
});

test("audit does not mark a file as extra when only one of its algorithms matched", () => {
  const entries = fia.parseManifest(D.good + "  good.bin").entries;
  const files = [{ name: "good.bin", digests: { md5: D.good, "sha-256": "f".repeat(64) } }];
  const res = fia.audit(files, entries, { checkExtras: true });
  assert.strictEqual(res.summary.extra, 0);
});

test("audit of an empty manifest reports everything as extra when enabled", () => {
  const res = fia.audit([{ name: "a.txt", digests: { md5: D.good } }], [], { checkExtras: true });
  assert.strictEqual(res.summary.total, 1);
  assert.strictEqual(res.summary.extra, 1);
});

test("audit of an empty manifest and no files is empty", () => {
  const res = fia.audit([], []);
  assert.strictEqual(res.summary.total, 0);
  assert.strictEqual(res.rows.length, 0);
});

// ---------------------------------------------------------------------------
// Export

test("toCsv emits a header, escapes commas and can omit extras", () => {
  const entries = fia.parseManifest(D.good + '  "a,b".txt').entries;
  const files = [{ name: 'a,b.txt', digests: { md5: D.good } }, { name: "z.txt", digests: { md5: D.other } }];
  const res = fia.audit(files, entries, { checkExtras: true });
  const csv = fia.toCsv(res.rows, true);
  assert.match(csv.split("\n")[0], /^status,filename,expected,actual,algorithm,note$/);
  assert.match(csv, /"a,b\.txt"/);
  const csvNoExtras = fia.toCsv(res.rows, false);
  assert.ok(!/z\.txt/.test(csvNoExtras));
});

test("toReport summarizes every status", () => {
  const entries = fia.parseManifest(D.good + "  good.txt").entries;
  const report = fia.toReport(fia.audit([{ name: "good.txt", digests: { md5: D.good } }], entries).rows,
    { total: 1, match: 1, mismatch: 0, missing: 0, extra: 0, unknown: 0 });
  assert.match(report, /OK:\s+1/);
  assert.match(report, /\[OK\] good\.txt/);
});

test("normalizeFileName unifies separators and prefixes", () => {
  assert.strictEqual(fia.normalizeFileName("./a/b.txt"), "a/b.txt");
  assert.strictEqual(fia.normalizeFileName("a\\b.txt"), "a/b.txt");
});

test("sha-384 and sha-512 match the empty-string vectors", () => {
  assert.strictEqual(
    hexOf("sha-384", ""),
    "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b"
  );
  assert.strictEqual(
    hexOf("sha-512", ""),
    "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
  );
});

test("digest() accepts an ArrayBuffer and a Buffer", async () => {
  const bytes = new TextEncoder().encode("abc");
  const expected = hexOf("sha-256", "abc");
  assert.strictEqual((await fia.digest("sha-256", bytes.buffer)).hex, expected);
  assert.strictEqual((await fia.digest("sha-256", Buffer.from(bytes))).hex, expected);
});

test("digest() rejects an unsupported algorithm", async () => {
  await assert.rejects(() => fia.digest("crc32", new Uint8Array(0)), /unsupported algorithm/);
});

test("hashBytes reports progress and returns hex plus base64", async () => {
  const data = new Uint8Array(3 * fia.CHUNK_SIZE + 17).fill(65);
  const fractions = [];
  const out = await fia.hashBytes(data, ["md5", "sha-256"], {
    onProgress: (f) => fractions.push(f)
  });
  assert.strictEqual(out.md5.hex, fia.bytesToHex(fia.md5(data)));
  assert.strictEqual(out["sha-256"].hex, hexOf("sha-256", "A".repeat(data.length)));
  assert.strictEqual(out.md5.base64, Buffer.from(fia.md5(data)).toString("base64"));
  assert.ok(fractions.length >= 3, "progress fired for each chunk");
  assert.ok(fractions[fractions.length - 1] <= 1);
});

test("audit leaves extra files out unless checkExtras is set", () => {
  const entries = fia.parseManifest(D.good + "  good.txt").entries;
  const files = [
    { name: "good.txt", digests: { md5: D.good } },
    { name: "unlisted.txt", digests: { md5: D.other } }
  ];
  assert.strictEqual(fia.audit(files, entries).summary.extra, 0);
  assert.strictEqual(fia.audit(files, entries, { checkExtras: true }).summary.extra, 1);
});

test("audit rows carry expected, actual and the source line", () => {
  const entries = fia.parseManifest([
    "# heading",
    D.good + "  good.txt",
    D.bad + "  absent.txt"
  ].join("\n")).entries;
  const res = fia.audit([{ name: "good.txt", digests: { md5: D.good } }], entries);
  assert.strictEqual(res.rows[0].expected, D.good);
  assert.strictEqual(res.rows[0].actual, D.good);
  assert.strictEqual(res.rows[0].line, 2);
  assert.strictEqual(res.rows[1].status, "missing");
  assert.strictEqual(res.rows[1].actual, "");
  assert.strictEqual(res.rows[1].expected, D.bad);
});

test("audit reports unknown when the manifest digest is not valid hex", () => {
  const entries = fia.parseManifest("sha-256 (odd.txt) = not-a-digest").entries;
  // The tagged line does not parse, so it is skipped rather than audited.
  assert.strictEqual(entries.length, 0);
  const forced = [{ filename: "odd.txt", path: "odd.txt", digest: "zz", algorithm: "md5" }];
  const res = fia.audit([{ name: "odd.txt", digests: { md5: D.good } }], forced);
  assert.strictEqual(res.summary.unknown, 1);
  assert.match(res.rows[0].note, /not a valid hex digest/);
});

test("audit reports unknown for an entry with no algorithm", () => {
  const forced = [{ filename: "x.txt", path: "x.txt", digest: D.good, algorithm: null }];
  const res = fia.audit([{ name: "x.txt", digests: { md5: D.good } }], forced);
  assert.strictEqual(res.summary.unknown, 1);
  assert.match(res.rows[0].note, /no recognisable algorithm/);
});

test("unrecognised algorithm tags are skipped with a line number", () => {
  const out = fia.parseManifest("CRC32 (file.bin) = abcd1234\n");
  assert.strictEqual(out.entries.length, 0);
  assert.strictEqual(out.skipped.length, 1);
  assert.strictEqual(out.skipped[0].line, 1);
});

test("csv escaping handles quotes and newlines", () => {
  const rows = [{
    status: "mismatch",
    filename: 'we"ird,name.txt',
    expected: "a",
    actual: "b",
    algorithm: "md5",
    note: "line\nbreak"
  }];
  const csv = fia.toCsv(rows, true);
  assert.ok(csv.indexOf('"we""ird,name.txt"') !== -1);
  assert.ok(csv.indexOf('"line\nbreak"') !== -1);
});

test("toReport handles a zero-entry audit", () => {
  const report = fia.toReport([], { total: 0, match: 0, mismatch: 0, missing: 0, extra: 0, unknown: 0 });
  assert.match(report, /Total entries: 0/);
  assert.match(report, /OK:\s+0/);
});

test("end-to-end: hash real bytes and verify a mixed-algorithm manifest", async () => {
  const enc = new TextEncoder();
  const payload = enc.encode("The quick brown fox jumps over the lazy dog");
  const digests = await fia.hashBytes(payload, ["md5", "sha-256"]);
  const manifest = [
    digests.md5.hex + "  fox.txt",
    digests["sha-256"].hex + " *fox.bin",
    "0".repeat(64) + "  tampered.bin"
  ].join("\n");
  const entries = fia.parseManifest(manifest).entries;
  const files = [
    { name: "fox.txt", digests: { md5: digests.md5.hex } },
    { name: "fox.bin", digests: { "sha-256": digests["sha-256"].hex } },
    { name: "tampered.bin", digests: { "sha-256": "f".repeat(64) } }
  ];
  const res = fia.audit(files, entries, { checkExtras: true });
  assert.deepStrictEqual(res.summary, { total: 3, match: 2, mismatch: 1, missing: 0, extra: 0, unknown: 0 });
});

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

// Await every async test before reporting, so the exit code is reliable.
Promise.all(pending).then(() => {
  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
});
