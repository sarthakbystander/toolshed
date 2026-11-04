"use strict";

/*
 * Archive Inspector — test suite.
 *
 * Fixtures are built in-process so the suite has no binary assets and no
 * dependencies beyond the Node standard library. ZIP archives are assembled
 * byte by byte; GZIP uses node:zlib (which the tool then decodes with its own
 * inflate); TAR is written in 512-byte blocks.
 */

const assert = require("node:assert");
const zlib = require("node:zlib");
const lib = require("../tool.js");

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

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function u32(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function u16(n) {
  return [n & 0xff, (n >>> 8) & 0xff];
}
// Normalise any fixture payload (string, Buffer, Uint8Array or number array)
// to a plain byte array, so callers never have to think about encoding.
function dataBytes(d) {
  if (d === undefined || d === null) return [];
  if (typeof d === "string") return Array.from(Buffer.from(d, "utf8"));
  return Array.from(Buffer.isBuffer(d) ? d : Buffer.from(d));
}
function bytes(...parts) {
  const out = [];
  for (const p of parts) {
    if (typeof p === "string") for (const ch of Buffer.from(p, "utf8")) out.push(ch);
    else if (Array.isArray(p)) out.push(...p);
  }
  return out;
}

// Build a ZIP with stored (method 0) or deflated (method 8) entries.
function buildZip(entries, options) {
  options = options || {};
  const out = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = Array.from(Buffer.from(e.name, "utf8"));
    const data = dataBytes(e.data);
    const method = e.method === undefined ? 0 : e.method;
    const comp = method === 8 ? Array.from(zlib.deflateRawSync(Buffer.from(data))) : data;
    const crc = lib.crc32(Uint8Array.from(dataBytes(data)));
    const local = bytes(
      u32(0x04034b50), u16(20), u16(e.flags || 0), u16(method),
      u16(0), u16(0), u32(crc), u32(comp.length), u32(data.length),
      u16(nameBytes.length), u16(0), nameBytes, comp
    );
    central.push(
      bytes(
        u32(0x02014b50), u16(20), u16(20), u16(e.flags || 0), u16(method),
        u16(0), u16(0), u32(crc), u32(comp.length), u32(data.length),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
        u32(e.externalAttrs || 0), u32(offset), nameBytes
      )
    );
    out.push(...local);
    offset += local.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    out.push(...c);
    cdSize += c.length;
  }
  out.push(
    ...bytes(
      u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(cdSize), u32(cdStart), u16(0)
    )
  );
  return Uint8Array.from(out);
}

function buildGzip(name, data) {
  const header = bytes(
    [0x1f, 0x8b, 0x08, 0x08],
    u32(0), // mtime
    [0x00, 0x03],
    name ? bytes(name, [0x00]) : []
  );
  const body = Array.from(zlib.deflateRawSync(Buffer.from(dataBytes(data))));
  const crc = lib.crc32(Uint8Array.from(dataBytes(data)));
  return Uint8Array.from([...header, ...body, ...u32(crc), ...u32(data.length)]);
}

function tarHeader(name, size, typeflag, linkname, mode) {
  const b = new Array(512).fill(0);
  const put = (str, off) => {
    const bs = Array.from(Buffer.from(str, "utf8"));
    for (let i = 0; i < bs.length && off + i < 512; i++) b[off + i] = bs[i];
  };
  const octal = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0);
  put(octal(mode === undefined ? 0o644 : mode, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(size, 12), 124);
  put(octal(1700000000, 12), 136);
  b[156] = (typeflag || "0").charCodeAt(0);
  if (linkname) put(linkname, 157);
  put("ustar\0", 257);
  put("00", 263);
  // checksum
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[i];
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return b;
}

function buildTar(entries) {
  const out = [];
  for (const e of entries) {
    const data = dataBytes(e.data);
    out.push(...tarHeader(e.name, data.length, e.typeflag || "0", e.linkname, e.mode));
    out.push(...data);
    while (out.length % 512 !== 0) out.push(0);
  }
  out.push(...new Array(1024).fill(0)); // two zero blocks terminate
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

console.log("archive-inspector tests");

test("detectFormat identifies a ZIP by signature", () => {
  assert.strictEqual(lib.detectFormat(buildZip([{ name: "a.txt", data: "hi" }])), "zip");
});

test("detectFormat identifies GZIP", () => {
  assert.strictEqual(lib.detectFormat(buildGzip("a", "hello")), "gzip");
});

test("detectFormat identifies TAR by ustar magic", () => {
  assert.strictEqual(lib.detectFormat(buildTar([{ name: "a.txt", data: "hi" }])), "tar");
});

test("detectFormat reports unsupported formats distinctly", () => {
  assert.strictEqual(lib.detectFormat(Uint8Array.from([0x42, 0x5a, 0x68, 0x39, 1, 2])), "bzip2");
  assert.strictEqual(lib.detectFormat(Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])), "7z");
});

test("detectFormat returns null for plain text", () => {
  assert.strictEqual(lib.detectFormat(Uint8Array.from(Buffer.from("just some text"))), null);
});

// ---------------------------------------------------------------------------
// CRC-32 and inflate
// ---------------------------------------------------------------------------

test("crc32 matches known vectors", () => {
  assert.strictEqual(lib.crc32(Uint8Array.from(Buffer.from(""))), 0);
  assert.strictEqual(lib.crc32(Uint8Array.from(Buffer.from("123456789"))), 0xcbf43926);
});

test("inflateRaw decodes a deflated stream", () => {
  const text = "The quick brown fox jumps over the lazy dog. ".repeat(50);
  const comp = zlib.deflateRawSync(Buffer.from(text));
  const out = Buffer.from(lib.inflateRaw(Uint8Array.from(comp))).toString("utf8");
  assert.strictEqual(out, text);
});

test("inflateRaw handles stored blocks", () => {
  const text = "stored block payload";
  const comp = zlib.deflateRawSync(Buffer.from(text), { level: 0 });
  const out = Buffer.from(lib.inflateRaw(Uint8Array.from(comp))).toString("utf8");
  assert.strictEqual(out, text);
});

test("inflateRaw handles a large highly-compressible stream", () => {
  const text = "A".repeat(200000);
  const comp = zlib.deflateRawSync(Buffer.from(text));
  const out = Buffer.from(lib.inflateRaw(Uint8Array.from(comp))).toString("utf8");
  assert.strictEqual(out.length, 200000);
  assert.strictEqual(out, text);
});

test("inflateRaw rejects a corrupt stream", () => {
  assert.throws(() => lib.inflateRaw(Uint8Array.from([0xff, 0xff, 0xff, 0xff])), /DEFLATE/);
});

// ---------------------------------------------------------------------------
// ZIP analysis
// ---------------------------------------------------------------------------

test("analyse reads a stored ZIP with correct stats", () => {
  const zip = buildZip([
    { name: "hello.txt", data: "hello world" },
    { name: "folder/", data: "" },
    { name: "folder/nested.txt", data: "nested content" },
  ]);
  const r = lib.analyse(zip, { filename: "test.zip" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.format, "zip");
  assert.strictEqual(r.stats.fileCount, 2);
  assert.strictEqual(r.stats.folderCount, 1);
  assert.strictEqual(r.stats.totalUncompressed, "hello world".length + "nested content".length);
  assert.strictEqual(r.entries[0].path, "hello.txt");
  assert.strictEqual(r.entries[0].ext, "txt");
  assert.strictEqual(r.entries[2].depth, 2);
});

test("analyse decompresses deflated ZIP entries", () => {
  const zip = buildZip([{ name: "big.txt", data: "x".repeat(5000), method: 8 }]);
  const r = lib.analyse(zip);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entries[0].size, 5000);
  assert.ok(r.entries[0].compressedSize < 5000);
  assert.ok(r.stats.savingPercent > 80);
});

test("analyse reports the compression ratio for deflated entries", () => {
  const zip = buildZip([{ name: "big.txt", data: "y".repeat(10000), method: 8 }]);
  const r = lib.analyse(zip);
  assert.ok(r.entries[0].ratio > 10);
  assert.strictEqual(lib.formatRatio(r.entries[0].ratio).endsWith("×"), true);
});

test("analyse flags path traversal as high severity", () => {
  const zip = buildZip([{ name: "../../etc/passwd", data: "nope" }]);
  const r = lib.analyse(zip);
  assert.strictEqual(r.ok, true);
  const f = r.findings.find((x) => x.code === "traversal");
  assert.ok(f, "expected a traversal finding");
  assert.strictEqual(f.severity, "high");
});

test("analyse flags an absolute path", () => {
  const zip = buildZip([{ name: "/etc/shadow", data: "nope" }]);
  const r = lib.analyse(zip);
  assert.ok(r.findings.some((x) => x.code === "absolute-path"));
});

test("analyse flags duplicate entries", () => {
  const zip = buildZip([
    { name: "dup.txt", data: "one" },
    { name: "dup.txt", data: "two" },
  ]);
  const r = lib.analyse(zip);
  assert.strictEqual(r.stats.duplicateCount, 1);
  assert.ok(r.findings.some((x) => x.code === "duplicate"));
});

test("analyse flags executable extensions", () => {
  const zip = buildZip([{ name: "payload.exe", data: "MZ" }]);
  const r = lib.analyse(zip);
  assert.ok(r.findings.some((x) => x.code === "executable" && x.path === "payload.exe"));
});

test("analyse flags nested archives", () => {
  const zip = buildZip([{ name: "inner.zip", data: "PK" }]);
  const r = lib.analyse(zip);
  assert.ok(r.findings.some((x) => x.code === "nested-archive"));
});

test("analyse flags macOS junk entries", () => {
  const zip = buildZip([
    { name: "__MACOSX/._file", data: "junk" },
    { name: ".DS_Store", data: "junk" },
    { name: "real.txt", data: "keep" },
  ]);
  const r = lib.analyse(zip);
  assert.ok(r.findings.some((x) => x.code === "mac-junk"));
});

test("analyse flags an encrypted entry", () => {
  const zip = buildZip([{ name: "secret.txt", data: "x", flags: 0x1 }]);
  const r = lib.analyse(zip);
  assert.strictEqual(r.entries[0].encrypted, true);
  assert.ok(r.findings.some((x) => x.code === "encrypted"));
});

test("analyse flags a decompression bomb ratio", () => {
  const zip = buildZip([{ name: "bomb.bin", data: Buffer.alloc(3 * 1024 * 1024, 0), method: 8 }]);
  const r = lib.analyse(zip);
  assert.ok(r.findings.some((x) => x.code === "zip-bomb"));
});

test("analyse sorts findings by severity", () => {
  const zip = buildZip([
    { name: "bad.exe", data: "MZ" },
    { name: "../escape", data: "x" },
    { name: ".DS_Store", data: "x" },
  ]);
  const r = lib.analyse(zip);
  const ranks = { high: 0, warning: 1, info: 2 };
  for (let i = 1; i < r.findings.length; i++) {
    assert.ok(ranks[r.findings[i - 1].severity] <= ranks[r.findings[i].severity]);
  }
  assert.strictEqual(r.findings[0].severity, "high");
});

test("analyse reports an empty ZIP without failing", () => {
  const r = lib.analyse(buildZip([]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stats.entryCount, 0);
  assert.ok(r.findings.some((x) => x.code === "empty"));
});

test("analyse breaks down file types by extension", () => {
  const zip = buildZip([
    { name: "a.txt", data: "1" },
    { name: "b.txt", data: "22" },
    { name: "c.png", data: "333" },
  ]);
  const r = lib.analyse(zip);
  const txt = r.typeBreakdown.find((t) => t.ext === "txt");
  assert.strictEqual(txt.count, 2);
  assert.strictEqual(txt.bytes, 3);
});

// ---------------------------------------------------------------------------
// ZIP extraction / preview
// ---------------------------------------------------------------------------

test("extract returns stored entry bytes", () => {
  const zip = buildZip([{ name: "a.txt", data: "hello" }]);
  const r = lib.analyse(zip);
  const ex = lib.extract(zip, r, 0);
  assert.strictEqual(Buffer.from(ex.bytes).toString("utf8"), "hello");
  assert.strictEqual(ex.crcOk, true);
});

test("extract returns deflated entry bytes and verifies the CRC", () => {
  const zip = buildZip([{ name: "a.txt", data: "compress me ".repeat(200), method: 8 }]);
  const r = lib.analyse(zip);
  const ex = lib.extract(zip, r, 0);
  assert.strictEqual(Buffer.from(ex.bytes).toString("utf8"), "compress me ".repeat(200));
  assert.strictEqual(ex.crcOk, true);
});

test("extract refuses an encrypted entry", () => {
  const zip = buildZip([{ name: "secret.txt", data: "x", flags: 0x1 }]);
  const r = lib.analyse(zip);
  assert.throws(() => lib.extract(zip, r, 0), /encrypted/);
});

test("preview returns text for a text entry", () => {
  const zip = buildZip([{ name: "notes.md", data: "# Title\nbody" }]);
  const r = lib.analyse(zip);
  const p = lib.preview(zip, r, 0);
  assert.strictEqual(p.kind, "text");
  assert.strictEqual(p.text, "# Title\nbody");
});

test("preview detects binary content", () => {
  const bin = [0, 1, 2, 3, 0, 5, 6, 0, 8, 9, 0, 11];
  const zip = buildZip([{ name: "blob.bin", data: bin }]);
  const r = lib.analyse(zip);
  const p = lib.preview(zip, r, 0);
  assert.strictEqual(p.kind, "binary");
});

test("preview identifies an image entry", () => {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
  const zip = buildZip([{ name: "pic.png", data: png }]);
  const r = lib.analyse(zip);
  const p = lib.preview(zip, r, 0);
  assert.strictEqual(p.kind, "image");
  assert.strictEqual(p.mime, "image/png");
});

test("preview truncates text past the limit", () => {
  const zip = buildZip([{ name: "big.txt", data: "z".repeat(1000) }]);
  const r = lib.analyse(zip);
  const p = lib.preview(zip, r, 0, 100);
  assert.strictEqual(p.truncated, true);
  assert.strictEqual(p.text.length, 100);
  assert.strictEqual(p.totalSize, 1000);
});

test("preview reports a directory entry", () => {
  const zip = buildZip([{ name: "folder/", data: "" }]);
  const r = lib.analyse(zip);
  const p = lib.preview(zip, r, 0);
  assert.strictEqual(p.kind, "dir");
});

// ---------------------------------------------------------------------------
// GZIP
// ---------------------------------------------------------------------------

test("analyse reads a GZIP stream and recovers the name and content", () => {
  const gz = buildGzip("report.txt", "gzip payload body");
  const r = lib.analyse(gz, { filename: "report.txt.gz" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.format, "gzip");
  assert.strictEqual(r.entries[0].name, "report.txt");
  assert.strictEqual(r.entries[0].size, "gzip payload body".length);
  assert.strictEqual(r.entries[0].crcOk, true);
  assert.strictEqual(r.stats.fileCount, 1);
});

test("preview reads the decompressed GZIP payload", () => {
  const gz = buildGzip("a.txt", "hello from gzip");
  const r = lib.analyse(gz);
  const p = lib.preview(gz, r, 0);
  assert.strictEqual(p.kind, "text");
  assert.strictEqual(p.text, "hello from gzip");
});

test("analyse reports a corrupted GZIP body as an error", () => {
  const gz = buildGzip("a.txt", "hello");
  gz[20] = 0xff;
  gz[21] = 0xff;
  const r = lib.analyse(gz);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /decompress|DEFLATE/i);
});

// ---------------------------------------------------------------------------
// TAR
// ---------------------------------------------------------------------------

test("analyse reads a TAR archive", () => {
  const tar = buildTar([
    { name: "readme.txt", data: "hello tar" },
    { name: "bin/", typeflag: "5", data: "" },
    { name: "bin/run.sh", data: "#!/bin/sh", mode: 0o755 },
  ]);
  const r = lib.analyse(tar, { filename: "bundle.tar" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.format, "tar");
  assert.strictEqual(r.stats.fileCount, 2);
  assert.strictEqual(r.stats.folderCount, 1);
  assert.strictEqual(r.entries[0].size, "hello tar".length);
});

test("analyse extracts a TAR file's bytes", () => {
  const tar = buildTar([{ name: "a.txt", data: "tar bytes here" }]);
  const r = lib.analyse(tar);
  const ex = lib.extract(tar, r, 0);
  assert.strictEqual(Buffer.from(ex.bytes).toString("utf8"), "tar bytes here");
});

test("analyse flags an executable in a TAR", () => {
  const tar = buildTar([{ name: "install.sh", data: "echo hi", mode: 0o755 }]);
  const r = lib.analyse(tar);
  assert.ok(r.findings.some((x) => x.code === "executable"));
});

test("analyse handles a TAR symlink entry without reading data", () => {
  const tar = buildTar([{ name: "link", typeflag: "2", linkname: "target.txt", data: "" }]);
  const r = lib.analyse(tar);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entries[0].typeflag, "2");
  assert.strictEqual(r.entries[0].linkname, "target.txt");
});

test("analyse rejects a TAR with no entries", () => {
  const empty = new Uint8Array(2048);
  // 2048 zero bytes is a valid empty TAR but detectFormat cannot see a magic.
  const r = lib.analyse(empty);
  assert.strictEqual(r.ok, false);
});

// ---------------------------------------------------------------------------
// Invalid input
// ---------------------------------------------------------------------------

test("analyse rejects empty input", () => {
  const r = lib.analyse(new Uint8Array(0));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /empty/i);
});

test("analyse rejects non-archive input", () => {
  const r = lib.analyse(Uint8Array.from(Buffer.from("this is definitely not an archive")));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /does not look like/i);
});

test("analyse reports unsupported formats with a clear message", () => {
  const r = lib.analyse(Uint8Array.from([0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59]));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /bzip2/);
});

test("analyse reports a truncated ZIP instead of throwing", () => {
  const zip = buildZip([{ name: "a.txt", data: "hello" }]);
  const truncated = zip.subarray(0, zip.length - 30);
  const r = lib.analyse(truncated);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /end-of-directory|central directory/i);
});

test("analyse never throws on random bytes", () => {
  for (let seed = 0; seed < 40; seed++) {
    const buf = Buffer.alloc(256);
    for (let i = 0; i < buf.length; i++) buf[i] = (seed * 131 + i * 17) & 0xff;
    const r = lib.analyse(Uint8Array.from(buf));
    assert.strictEqual(typeof r.ok, "boolean");
  }
});

// ---------------------------------------------------------------------------
// Untrusted names and content
// ---------------------------------------------------------------------------

test("analyse preserves hostile entry names verbatim and flags them", () => {
  const name = "<img src=x onerror=alert(1)>/../../etc/passwd";
  const zip = buildZip([{ name: name, data: "x" }]);
  const r = lib.analyse(zip);
  assert.strictEqual(r.ok, true);
  const entry = r.entries[0];
  // The name is data: it is kept exactly as stored, never interpreted.
  assert.strictEqual(entry.rawPath, name);
  assert.strictEqual(entry.path, name);
  const codes = r.findings.map((f) => f.code);
  assert.ok(codes.includes("traversal"), "traversal flagged");
  assert.ok(
    r.findings.some((f) => f.code === "traversal" && f.severity === "high"),
    "traversal is high severity"
  );
});

test("analyse flags control characters hidden in a name", () => {
  const zip = buildZip([{ name: "safe.txt\u0000.exe", data: "payload" }]);
  const r = lib.analyse(zip);
  const f = r.findings.find((x) => x.code === "control-chars");
  assert.ok(f, "control-chars finding present");
  assert.strictEqual(f.severity, "high");
  // The reported message must not contain a raw NUL that could break output.
  assert.ok(!/\u0000/.test(f.message), "message escapes control characters");
});

test("preview returns text content as data, not markup", () => {
  const payload = "<script>alert('xss')</script>\nline two\n";
  const zip = buildZip([{ name: "note.html", data: payload, method: 8 }]);
  const r = lib.analyse(zip);
  const p = lib.preview(zip, r, 0);
  assert.strictEqual(p.kind, "text");
  assert.strictEqual(p.text, payload);
});

test("extract round-trips bytes that look like markup", () => {
  const payload = Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x3e, 0x00, 0xff, 0x10]);
  const zip = buildZip([{ name: "evil.svg", data: payload, method: 8 }]);
  const r = lib.analyse(zip);
  const ex = lib.extract(zip, r, 0);
  assert.deepStrictEqual(Array.from(ex.bytes), Array.from(payload));
});

// ---------------------------------------------------------------------------
// Large input / performance
// ---------------------------------------------------------------------------

test("analyse handles a ZIP with many entries quickly", () => {
  const entries = [];
  for (let i = 0; i < 1500; i++) entries.push({ name: "dir/file" + i + ".txt", data: "content " + i });
  const zip = buildZip(entries);
  const start = Date.now();
  const r = lib.analyse(zip, { filename: "many.zip" });
  assert.ok(Date.now() - start < 8000, "analysed quickly");
  assert.strictEqual(r.stats.fileCount, 1500);
});

test("analyse handles a large deflated entry", () => {
  const zip = buildZip([{ name: "big.log", data: "log line\n".repeat(60000), method: 8 }]);
  const r = lib.analyse(zip);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entries[0].size, "log line\n".length * 60000);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("extensionOf handles dotfiles, paths and no extension", () => {
  assert.strictEqual(lib.extensionOf("a/b/c.TXT"), "txt");
  assert.strictEqual(lib.extensionOf("Makefile"), "");
  assert.strictEqual(lib.extensionOf(".gitignore"), "");
  assert.strictEqual(lib.extensionOf("archive.tar.gz"), "gz");
});

test("baseName and dirName split paths", () => {
  assert.strictEqual(lib.baseName("a/b/c.txt"), "c.txt");
  assert.strictEqual(lib.dirName("a/b/c.txt"), "a/b");
  assert.strictEqual(lib.dirName("c.txt"), "");
});

test("formatBytes is readable across magnitudes", () => {
  assert.strictEqual(lib.formatBytes(0), "0 B");
  assert.strictEqual(lib.formatBytes(999), "999 B");
  assert.strictEqual(lib.formatBytes(1000), "1.0 KB");
  assert.strictEqual(lib.formatBytes(1500000), "1.5 MB");
  assert.strictEqual(lib.formatBytes(null), "—");
});

test("formatDate renders an ISO timestamp", () => {
  assert.strictEqual(lib.formatDate("2024-01-02T03:04:05.000Z"), "2024-01-02 03:04:05 UTC");
  assert.strictEqual(lib.formatDate(null), "—");
});

test("describeEntry summarises a file", () => {
  assert.strictEqual(lib.describeEntry({ isDir: true }), "folder");
  assert.match(lib.describeEntry({ isDir: false, ext: "png", size: 2048 }), /PNG file · 2\.0 KB/);
});

// ---------------------------------------------------------------------------

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
