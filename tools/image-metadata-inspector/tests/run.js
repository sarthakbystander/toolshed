"use strict";

/*
 * Image Metadata Inspector — test suite.
 * Run with `node tools/image-metadata-inspector/tests/run.js` (or `npm run test:tools`).
 * Exercises the real parsing and stripping code paths against synthetic files
 * built by the module itself, plus hand-crafted and malformed inputs.
 */

const assert = require("node:assert");
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

console.log("image-metadata-inspector tests");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const samples = {
  jpeg: lib.sampleBytes("jpeg"),
  png: lib.sampleBytes("png"),
  webp: lib.sampleBytes("webp"),
  gif: lib.sampleBytes("gif")
};

function exifNames(report) {
  const names = [];
  ["ifd0", "exif", "gps", "interop", "ifd1"].forEach((g) => {
    (report.exif[g] || []).forEach((e) => names.push(e.name));
  });
  return names;
}

function finding(report, id) {
  return report.findings.find((f) => f.id === id);
}

// ---------------------------------------------------------------------------
// detectFormat
// ---------------------------------------------------------------------------

test("detectFormat recognises JPEG, PNG, WebP and GIF", () => {
  assert.strictEqual(lib.detectFormat(samples.jpeg), "jpeg");
  assert.strictEqual(lib.detectFormat(samples.png), "png");
  assert.strictEqual(lib.detectFormat(samples.webp), "webp");
  assert.strictEqual(lib.detectFormat(samples.gif), "gif");
});

test("detectFormat returns unknown for other and short input", () => {
  assert.strictEqual(lib.detectFormat(new Uint8Array([1, 2, 3])), "unknown");
  assert.strictEqual(lib.detectFormat(new Uint8Array(0)), "unknown");
  assert.strictEqual(lib.detectFormat(new Uint8Array([0x42, 0x4d, 0x00, 0x00])), "unknown"); // BMP
  assert.strictEqual(lib.detectFormat(null), "unknown");
});

// ---------------------------------------------------------------------------
// inspect — happy paths per format
// ---------------------------------------------------------------------------

test("inspect JPEG reads dimensions, EXIF, XMP, IPTC, ICC and comment", () => {
  const r = lib.inspect(samples.jpeg);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.format, "jpeg");
  assert.strictEqual(r.mime, "image/jpeg");
  assert.deepStrictEqual(r.dimensions.width, 8);
  assert.deepStrictEqual(r.dimensions.height, 8);
  assert.strictEqual(r.exif.present, true);
  assert.strictEqual(r.exif.byteOrder, "little-endian (Intel)");
  assert.ok(exifNames(r).includes("Make"));
  assert.ok(exifNames(r).includes("DateTimeOriginal"));
  assert.deepStrictEqual(r.xmp.properties["creator"], ["Ada Lovelace"]);
  assert.strictEqual(r.xmp.properties["CreatorTool"], "Toolshed");
  assert.strictEqual(r.iptc.present, true);
  assert.strictEqual(r.icc.present, true);
  assert.strictEqual(r.icc.size, 132);
  assert.ok(/Toolshed sample builder/.test(r.comment));
});

test("inspect JPEG resolves GPS to signed decimal coordinates", () => {
  const r = lib.inspect(samples.jpeg);
  assert.ok(r.gps);
  // 51°30'0" N, 0°7'30" W → +51.5, -0.125
  assert.ok(Math.abs(r.gps.latitude - 51.5) < 1e-6, "lat " + r.gps.latitude);
  assert.ok(Math.abs(r.gps.longitude - (-0.125)) < 1e-6, "lon " + r.gps.longitude);
});

test("inspect JPEG decodes exposure, aperture and orientation", () => {
  const r = lib.inspect(samples.jpeg);
  assert.strictEqual(r.summary.aperture, "f/4");
  assert.ok(/normal/.test(r.summary.orientation));
  const fnumber = r.exif.exif.find((e) => e.name === "FNumber");
  assert.strictEqual(fnumber.display, "f/4");
});

test("inspect PNG reads IHDR, text chunks and XMP", () => {
  const r = lib.inspect(samples.png);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.format, "png");
  assert.deepStrictEqual(r.dimensions, { width: 16, height: 16, bitDepth: 8, colorType: 6 });
  assert.strictEqual(r.comment, "Hello from Toolshed");
  assert.deepStrictEqual(r.xmp.properties["creator"], ["Grace Hopper"]);
  assert.ok(r.textChunks.some((c) => c.keyword === "Software" && c.text === "Toolshed Sample"));
  assert.ok(r.chunks.some((c) => c.type === "IHDR"));
});

test("inspect WebP reads VP8X canvas, features, ICC, EXIF and XMP", () => {
  const r = lib.inspect(samples.webp);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.format, "webp");
  assert.deepStrictEqual(r.dimensions, { width: 16, height: 16 });
  assert.strictEqual(r.features.icc, true);
  assert.strictEqual(r.features.exif, true);
  assert.strictEqual(r.features.xmp, true);
  assert.strictEqual(r.icc.present, true);
  assert.strictEqual(r.icc.size, 132);
  assert.ok(exifNames(r).includes("Make"));
  assert.deepStrictEqual(r.xmp.properties["creator"], ["Alan Turing"]);
});

test("inspect GIF reads version, dimensions, comment and XMP application block", () => {
  const r = lib.inspect(samples.gif);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.format, "gif");
  assert.strictEqual(r.version, "GIF89a");
  assert.deepStrictEqual(r.dimensions, { width: 16, height: 16 });
  assert.strictEqual(r.comment, "Toolshed GIF sample");
  assert.deepStrictEqual(r.xmp.properties["creator"], ["Katherine Johnson"]);
});

// ---------------------------------------------------------------------------
// inspect — privacy scoring
// ---------------------------------------------------------------------------

test("JPEG with GPS scores high privacy exposure and lists GPS", () => {
  const r = lib.inspect(samples.jpeg);
  assert.strictEqual(r.privacy.level, "high");
  assert.ok(r.privacy.score >= 40);
  assert.ok(r.privacy.items.some((i) => i.id === "gps"));
  assert.strictEqual(finding(r, "gps").present, true);
});

test("metadata-light image scores lower than the GPS JPEG", () => {
  const r = lib.inspect(samples.png);
  assert.ok(r.privacy.score < lib.inspect(samples.jpeg).privacy.score);
  assert.strictEqual(finding(r, "exif").present, false);
});

// ---------------------------------------------------------------------------
// inspect — malformed and edge input
// ---------------------------------------------------------------------------

test("inspect reports a friendly error for empty input", () => {
  const r = lib.inspect(new Uint8Array(0));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /empty/i);
});

test("inspect reports a friendly error for unknown formats", () => {
  const r = lib.inspect(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.format, "unknown");
  assert.match(r.error, /JPEG, PNG, WebP and GIF/);
});

test("inspect accepts ArrayBuffer and plain arrays", () => {
  const ab = samples.jpeg.buffer.slice(samples.jpeg.byteOffset, samples.jpeg.byteOffset + samples.jpeg.byteLength);
  assert.strictEqual(lib.inspect(ab).format, "jpeg");
  assert.strictEqual(lib.inspect(Array.from(samples.jpeg)).format, "jpeg");
});

test("truncated JPEG yields warnings instead of throwing", () => {
  const truncated = samples.jpeg.subarray(0, 40);
  const r = lib.inspect(truncated);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.format, "jpeg");
  assert.ok(r.warnings.length > 0);
});

test("a JPEG whose APP1 length overruns the file does not throw", () => {
  // SOI + APP1 marker claiming a huge length, then nothing.
  const bad = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x01, 0x02, 0x03]);
  const r = lib.inspect(bad);
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.length > 0);
});

test("truncated PNG chunk is reported as a warning", () => {
  const truncated = samples.png.subarray(0, 20);
  const r = lib.inspect(truncated);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.format, "png");
  assert.ok(r.warnings.some((w) => /truncated/i.test(w)));
});

test("a PNG with a corrupt IHDR still parses other chunks", () => {
  // Signature + IHDR length claiming 13 but only 2 bytes of data present.
  const bad = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00
  ]);
  const r = lib.inspect(bad);
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.length > 0);
});

test("inspect never throws on random bytes", () => {
  const rnd = new Uint8Array(512);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 37 + 11) & 0xff;
  const r = lib.inspect(rnd);
  assert.strictEqual(r.ok, false);
});

test("a GIF that is too short is reported, not thrown", () => {
  const r = lib.inspect(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => /too short/i.test(w)));
});

test("large PNG (1 MB IDAT) inspects and strips without issue", () => {
  // Build a PNG with a big IDAT payload to exercise realistic sizes.
  const big = new Uint8Array(1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 131) & 0xff;
  function chunk(type, data) {
    const len = data.length;
    const out = new Uint8Array(12 + len);
    out[0] = (len >>> 24) & 0xff; out[1] = (len >>> 16) & 0xff;
    out[2] = (len >>> 8) & 0xff; out[3] = len & 0xff;
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    return out;
  }
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array([0, 0, 0, 64, 0, 0, 0, 64, 8, 6, 0, 0, 0]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", big), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const file = new Uint8Array(total);
  let off = 0;
  parts.forEach((p) => { file.set(p, off); off += p.length; });

  const r = lib.inspect(file);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dimensions.width, 64);
  const stripped = lib.stripMetadata(file);
  assert.strictEqual(stripped.ok, true);
  assert.ok(stripped.bytes.length >= 1024 * 1024);
});

// ---------------------------------------------------------------------------
// parseExif
// ---------------------------------------------------------------------------

test("parseExif handles a big-endian (Motorola) TIFF block", () => {
  // Minimal MM TIFF: IFD0 with one ASCII tag (Make = "Nikon").
  const bytes = [];
  const push = (...v) => v.forEach((x) => bytes.push(x));
  push(0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08); // MM + magic + IFD0 @ 8
  push(0x00, 0x01);                                     // 1 entry
  push(0x01, 0x0f, 0x00, 0x02, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x1a); // Make, ASCII, 6, offset 26
  push(0x00, 0x00, 0x00, 0x00);                         // next IFD = 0
  push(0x4e, 0x69, 0x6b, 0x6f, 0x6e, 0x00);             // "Nikon\0"
  const tiff = new Uint8Array(bytes);
  const r = lib.parseExif(tiff);
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.byteOrder, "big-endian (Motorola)");
  const make = r.ifd0.find((e) => e.name === "Make");
  assert.ok(make);
  assert.strictEqual(make.value, "Nikon");
});

test("parseExif rejects a block with no byte-order marker", () => {
  const r = lib.parseExif(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]));
  assert.ok(r.warnings.some((w) => /byte-order/i.test(w)));
});

test("parseExif rejects a block that is too short", () => {
  const r = lib.parseExif(new Uint8Array([0x49, 0x49]));
  assert.ok(r.warnings.length > 0);
});

test("parseExif tolerates an invalid IFD entry count", () => {
  // Little-endian header pointing IFD0 at an offset with a huge count.
  const bytes = new Uint8Array(16);
  bytes[0] = 0x49; bytes[1] = 0x49; bytes[2] = 0x2a; bytes[3] = 0x00;
  bytes[4] = 0x08; bytes[5] = 0x00; bytes[6] = 0x00; bytes[7] = 0x00;
  bytes[8] = 0xff; bytes[9] = 0xff; // count = 65535
  const r = lib.parseExif(bytes);
  assert.ok(r.warnings.some((w) => /entry count/i.test(w)));
});

// ---------------------------------------------------------------------------
// parseXmp / parseXmlTree
// ---------------------------------------------------------------------------

test("parseXmp reads scalar, Bag, Seq and Alt properties", () => {
  const xml =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">' +
    "<dc:creator><rdf:Seq><rdf:li>A</rdf:li><rdf:li>B</rdf:li></rdf:Seq></dc:creator>" +
    "<dc:subject><rdf:Bag><rdf:li>one</rdf:li><rdf:li>two</rdf:li></rdf:Bag></dc:subject>" +
    "<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">T</rdf:li></rdf:Alt></dc:title>" +
    "<xmp:Rating>5</xmp:Rating>" +
    "</rdf:Description></rdf:RDF></x:xmpmeta>";
  const r = lib.parseXmp(xml);
  // Property keys are local names (namespace prefix dropped).
  assert.deepStrictEqual(r.properties["creator"], ["A", "B"]);
  assert.deepStrictEqual(r.properties["subject"], ["one", "two"]);
  assert.deepStrictEqual(r.properties["title"], ["T"]);
  assert.strictEqual(r.properties["Rating"], "5");
});

test("parseXmp reads CDATA and self-closing attribute properties", () => {
  const xml =
    "<rdf:RDF xmlns:rdf=\"r\"><rdf:Description xmlns:dc=\"d\" dc:format=\"image/jpeg\">" +
    "<dc:description><rdf:Alt><rdf:li><![CDATA[raw <text>]]></rdf:li></rdf:Alt></dc:description>" +
    "</rdf:Description></rdf:RDF>";
  const r = lib.parseXmp(xml);
  assert.strictEqual(r.properties["format"], "image/jpeg");
  assert.deepStrictEqual(r.properties["description"], ["raw <text>"]);
});

test("parseXmp returns null for non-XML input", () => {
  assert.strictEqual(lib.parseXmp("not xml at all"), null);
  assert.strictEqual(lib.parseXmp(42), null);
});

test("parseXmlTree handles mismatched closing tags without throwing", () => {
  const root = lib.parseXmlTree("<a><b></c></a>");
  assert.strictEqual(root.name, "a");
  assert.strictEqual(root.children[0].name, "b");
});

// ---------------------------------------------------------------------------
// parseIptc
// ---------------------------------------------------------------------------

test("parseIptc decodes datasets into named records", () => {
  const stream = new Uint8Array([
    0x1c, 0x02, 0x69, 0x00, 0x08, 0x54, 0x6f, 0x6f, 0x6c, 0x73, 0x68, 0x65, 0x64, // 2:105 Headline = Toolshed
    0x1c, 0x02, 0x50, 0x00, 0x03, 0x41, 0x64, 0x61 // 2:80 By-line = Ada
  ]);
  const r = lib.parseIptc(stream);
  assert.strictEqual(r.present, true);
  const app = r.records.find((rec) => rec.record === 2);
  assert.strictEqual(app.name, "Application");
  assert.strictEqual(app.datasets.find((d) => d.dataset === 105).name, "Headline");
  assert.strictEqual(app.datasets.find((d) => d.dataset === 105).value, "Toolshed");
  assert.strictEqual(app.datasets.find((d) => d.dataset === 80).value, "Ada");
});

test("parseIptc returns null when the stream does not start with 0x1C", () => {
  assert.strictEqual(lib.parseIptc(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])), null);
});

test("parseIptc stops cleanly on a truncated dataset", () => {
  const r = lib.parseIptc(new Uint8Array([0x1c, 0x02, 0x69, 0x00, 0xff, 0x41]));
  assert.strictEqual(r, null);
});

// ---------------------------------------------------------------------------
// parseIcc
// ---------------------------------------------------------------------------

test("parseIcc accepts a minimal profile and rejects bad signatures", () => {
  const good = new Uint8Array(132);
  good[3] = 132; good[36] = 0x61; good[37] = 0x63; good[38] = 0x73; good[39] = 0x70;
  const r = lib.parseIcc(good);
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.size, 132);

  const badSig = Uint8Array.from(good);
  badSig[36] = 0x00;
  assert.strictEqual(lib.parseIcc(badSig), null);
  assert.strictEqual(lib.parseIcc(new Uint8Array(10)), null);
});

// ---------------------------------------------------------------------------
// stripMetadata
// ---------------------------------------------------------------------------

test("stripMetadata removes JPEG metadata but keeps the image", () => {
  const result = lib.stripMetadata(samples.jpeg);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.format, "jpeg");
  assert.ok(result.removedSegments.includes("APP1"));
  assert.ok(result.removedSegments.includes("COM"));
  assert.ok(result.removedSegments.includes("APP2"));
  assert.ok(result.removedSegments.includes("APP13"));
  assert.ok(result.keptSegments.includes("APP0"));
  assert.ok(result.bytes.length < samples.jpeg.length);

  const after = lib.inspect(result.bytes);
  assert.strictEqual(after.ok, true);
  assert.strictEqual(after.format, "jpeg");
  assert.strictEqual(after.exif, null);
  assert.strictEqual(after.xmp, null);
  assert.strictEqual(after.iptc, null);
  assert.strictEqual(after.icc, null);
  assert.strictEqual(after.comment, null);
  // Dimensions survive, so the image data is intact.
  assert.strictEqual(after.dimensions.width, 8);
});

test("stripMetadata does not mutate the caller's bytes", () => {
  const before = Uint8Array.from(samples.webp);
  lib.stripMetadata(samples.webp);
  assert.deepStrictEqual(Array.from(samples.webp), Array.from(before));
});

test("stripMetadata on JPEG is deterministic", () => {
  const a = lib.stripMetadata(samples.jpeg);
  const b = lib.stripMetadata(samples.jpeg);
  assert.deepStrictEqual(Array.from(a.bytes), Array.from(b.bytes));
});

test("stripMetadata removes PNG text, EXIF and ICC chunks", () => {
  const result = lib.stripMetadata(samples.png);
  assert.strictEqual(result.ok, true);
  assert.ok(result.removedSegments.includes("tEXt"));
  assert.ok(result.removedSegments.includes("iTXt"));
  assert.ok(result.keptSegments.includes("IHDR"));
  assert.ok(result.keptSegments.includes("IEND"));
  const after = lib.inspect(result.bytes);
  assert.strictEqual(after.comment, null);
  assert.strictEqual(after.xmp, null);
  assert.strictEqual(after.dimensions.width, 16);
});

test("stripMetadata removes WebP EXIF/XMP/ICC and clears VP8X flags", () => {
  const result = lib.stripMetadata(samples.webp);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.removedSegments.sort(), ["EXIF", "ICCP", "XMP"]);
  const after = lib.inspect(result.bytes);
  assert.strictEqual(after.exif, null);
  assert.strictEqual(after.xmp, null);
  assert.strictEqual(after.icc, null);
  assert.strictEqual(after.features.icc, false);
  assert.strictEqual(after.features.exif, false);
  assert.strictEqual(after.features.xmp, false);
  assert.strictEqual(after.dimensions.width, 16);
});

test("stripMetadata removes GIF comments and XMP but keeps the trailer", () => {
  const result = lib.stripMetadata(samples.gif);
  assert.strictEqual(result.ok, true);
  assert.ok(result.removedSegments.includes("Comment"));
  assert.ok(result.removedSegments.includes("XMP"));
  const after = lib.inspect(result.bytes);
  assert.strictEqual(after.comment, null);
  assert.strictEqual(after.xmp, null);
  assert.strictEqual(after.version, "GIF89a");
  assert.strictEqual(result.bytes[result.bytes.length - 1], 0x3b); // trailer intact
});

test("stripMetadata refuses unknown formats and empty input", () => {
  const unknown = lib.stripMetadata(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.strictEqual(unknown.ok, false);
  assert.match(unknown.error, /Unrecognised/);
  const empty = lib.stripMetadata(new Uint8Array(0));
  assert.strictEqual(empty.ok, false);
});

test("stripMetadata refuses a truncated container rather than guessing", () => {
  const truncated = samples.png.subarray(0, 12);
  const result = lib.stripMetadata(truncated);
  assert.strictEqual(result.ok, false);
});

test("stripped output has no residual metadata on a second pass", () => {
  const once = lib.stripMetadata(samples.jpeg).bytes;
  const twice = lib.stripMetadata(once);
  assert.strictEqual(twice.ok, true);
  assert.strictEqual(twice.removedSegments.length, 0);
  assert.deepStrictEqual(Array.from(twice.bytes), Array.from(once));
});

// ---------------------------------------------------------------------------
// reportToText / privacyCardSvg / formatBytes
// ---------------------------------------------------------------------------

test("reportToText summarises the report and handles the empty case", () => {
  assert.strictEqual(lib.reportToText(null), "No image inspected.");
  const text = lib.reportToText(lib.inspect(samples.jpeg));
  assert.match(text, /Image Metadata Report/);
  assert.match(text, /Privacy exposure: HIGH/);
  assert.match(text, /GPS/);
  assert.match(text, /Ada Lovelace/);
});

test("privacyCardSvg produces a script-free SVG", () => {
  const svg = lib.privacyCardSvg(lib.inspect(samples.jpeg));
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.ok(!/<script/i.test(svg));
  assert.ok(!/onload=/i.test(svg));
  assert.strictEqual(lib.privacyCardSvg(null), "");
});

test("privacyCardSvg escapes XML metacharacters from metadata", () => {
  // A property value carrying a script tag must be escaped, never emitted raw.
  const report = lib.inspect(samples.jpeg);
  report.privacy = {
    level: "high",
    score: 100,
    items: [{
      key: "author",
      label: "Author / copyright",
      detail: '<script>alert(1)</script> "&" <img src=x onerror=alert(2)>',
      weight: 12
    }]
  };
  const svg = lib.privacyCardSvg(report);
  assert.ok(!/<script/i.test(svg));
  assert.ok(!/<img/i.test(svg));
  assert.ok(/&lt;script/.test(svg));
  assert.ok(/&amp;/.test(svg));
});

test("formatBytes renders bytes, KB and MB and guards bad input", () => {
  assert.strictEqual(lib.formatBytes(512), "512 B");
  assert.strictEqual(lib.formatBytes(2048), "2.0 KB");
  assert.strictEqual(lib.formatBytes(3 * 1024 * 1024), "3.00 MB");
  assert.strictEqual(lib.formatBytes(null), "\u2014");
  assert.strictEqual(lib.formatBytes(NaN), "\u2014");
});

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

test("decodeText decodes UTF-8 and trimNull strips terminators", () => {
  const bytes = Buffer.from("café", "utf8");
  assert.strictEqual(lib._internal.decodeText(new Uint8Array(bytes)), "café");
  assert.strictEqual(lib._internal.trimNull("café\u0000\u0000"), "café");
  assert.strictEqual(lib._internal.trimNull("trailing  "), "trailing");
});

test("rationalToNumber returns null for zero denominators", () => {
  assert.strictEqual(lib._internal.rationalToNumber({ num: 1, den: 0 }), null);
  assert.strictEqual(lib._internal.rationalToNumber({ num: 1, den: 2 }), 0.5);
});

test("formatExposure renders sub-second and whole-second values", () => {
  assert.strictEqual(lib._internal.formatExposure(0.008), "1/125 s");
  assert.strictEqual(lib._internal.formatExposure(2), "2 s");
  assert.strictEqual(lib._internal.formatExposure(0), "0 s");
});

test("describeOrientation maps the EXIF orientation values", () => {
  assert.match(lib._internal.describeOrientation(6), /90\u00B0 CW/);
  assert.strictEqual(lib._internal.describeOrientation(99), "99");
});

test("toBytes handles Uint8Array, ArrayBuffer and arrays, and rejects null", () => {
  assert.strictEqual(lib._internal.toBytes(null), null);
  assert.strictEqual(lib._internal.toBytes(new Uint8Array([1, 2])).length, 2);
  assert.strictEqual(lib._internal.toBytes(new ArrayBuffer(4)).length, 4);
  assert.strictEqual(lib._internal.toBytes([1, 2, 3]).length, 3);
});

// ---------------------------------------------------------------------------

console.log("\n" + passed + " passed, " + failed + " failed.");
process.exit(failed === 0 ? 0 : 1);
