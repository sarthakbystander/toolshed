/* Toolshed Color Converter  tests. Run with: node tests/run.js
 * Uses Node's built-in assert and requires ../tool.js via its UMD export.
 */
"use strict";

const assert = require("node:assert");
const color = require("../tool.js");

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

console.log("color-converter tests");

// --- common HEX values -------------------------------------------------------
test("parses full HEX", () => {
  assert.deepStrictEqual(color.toRGB("#ff0000"), { r: 255, g: 0, b: 0 });
  assert.deepStrictEqual(color.toRGB("#00ff00"), { r: 0, g: 255, b: 0 });
  assert.deepStrictEqual(color.toRGB("#0000ff"), { r: 0, g: 0, b: 255 });
  assert.deepStrictEqual(color.toRGB("#ffffff"), { r: 255, g: 255, b: 255 });
  assert.deepStrictEqual(color.toRGB("#000000"), { r: 0, g: 0, b: 0 });
});

test("parses shorthand HEX", () => {
  assert.deepStrictEqual(color.toRGB("#f00"), { r: 255, g: 0, b: 0 });
  assert.deepStrictEqual(color.toRGB("abc"), { r: 170, g: 187, b: 204 });
});

test("parses HEX without hash", () => {
  assert.deepStrictEqual(color.toRGB("336699"), { r: 51, g: 102, b: 153 });
  assert.deepStrictEqual(color.toRGB("c0ffee"), { r: 192, g: 255, b: 238 });
});

test("HEX output is canonical lowercase #rrggbb", () => {
  assert.strictEqual(color.toHEX("#FF0000"), "#ff0000");
  assert.strictEqual(color.toHEX("#f00"), "#ff0000");
  assert.strictEqual(color.toHEX("rgb(255, 0, 0)"), "#ff0000");
});

// --- RGB conversion ----------------------------------------------------------
test("parses RGB", () => {
  assert.deepStrictEqual(color.toRGB("rgb(255, 0, 0)"), { r: 255, g: 0, b: 0 });
  assert.deepStrictEqual(color.toRGB("rgb(0, 128, 255)"), { r: 0, g: 128, b: 255 });
});

test("RGB output string", () => {
  assert.strictEqual(color.toRGBString("#336699"), "rgb(51, 102, 153)");
});

test("clamps out-of-range RGB", () => {
  assert.strictEqual(color.toRGBString("rgb(300, -20, 128)"), "rgb(255, 0, 128)");
});

test("RGB -> HEX -> RGB round trip", () => {
  ["rgb(255, 0, 0)", "rgb(10, 200, 30)", "rgb(0, 0, 0)", "rgb(255, 255, 255)"].forEach((input) => {
    const hex = color.toHEX(input);
    assert.deepStrictEqual(color.toRGB(hex), color.toRGB(input));
  });
});

// --- HSL conversion ----------------------------------------------------------
test("parses HSL", () => {
  // hsl(0,100%,50%) == pure red
  assert.deepStrictEqual(color.toRGB("hsl(0, 100%, 50%)"), { r: 255, g: 0, b: 0 });
  // hsl(120,100%,50%) == pure green
  assert.deepStrictEqual(color.toRGB("hsl(120, 100%, 50%)"), { r: 0, g: 255, b: 0 });
  // hsl(240,100%,50%) == pure blue
  assert.deepStrictEqual(color.toRGB("hsl(240, 100%, 50%)"), { r: 0, g: 0, b: 255 });
});

test("HSL output string", () => {
  assert.strictEqual(color.toHSL("#ff0000"), "hsl(0, 100%, 50%)");
});

test("HSL grayscale", () => {
  assert.strictEqual(color.toHSL("#ffffff"), "hsl(0, 0%, 100%)");
  assert.strictEqual(color.toHSL("#000000"), "hsl(0, 0%, 0%)");
  assert.strictEqual(color.toHSL("#808080"), "hsl(0, 0%, 50.196%)");
});

test("hslToRGB round trips through rgbToHSL", () => {
  for (let i = 0; i < 24; i++) {
    const h = (i * 37) % 360;
    const s = (i * 11) % 101;
    const l = (i * 7) % 101;
    const rgb = color.hslToRGB(h, s, l);
    const back = color.rgbToHSL(rgb.r, rgb.g, rgb.b);
    // Hue is unstable when saturation is tiny or lightness hugs the edges;
    // 8-bit RGB quantization makes exact recovery impossible there.

    const hueTol = s < 15 || l < 10 || l >  90 ? 30 :  3;
    const diff = Math.abs(back.h - h);
    assert.ok(diff < hueTol || Math.abs(diff - 360) < hueTol, "hue near " + h + " got " + back.h + " (s=" + s + ", l=" + l);
    const satTol = s < 15 || l < 10 || l > 90 ? 15 :  5;
    assert.ok(Math.abs(back.s - s) < satTol, "sat near: " + s + " got " + back.s);
    assert.ok(Math.abs(back.l - l) < 2, "light near: " + l + " got " + back.l);
  }
});

test("convert returns all three representations", () => {
  const out = color.convert("#ff0000");
  assert.strictEqual(out.hex, "#ff0000");
  assert.strictEqual(out.rgb, "rgb(255, 0, 0)");
  assert.strictEqual(out.hsl, "hsl(0, 100%, 50%)");
});

// --- invalid values ----------------------------------------------------------
test("rejects invalid HEX", () => {
  assert.throws(() => color.toRGB("#gg0000"));
  assert.throws(() => color.toRGB("#12345"));
  assert.throws(() => color.toRGB("#1234567"));
  assert.throws(() => color.toRGB("nope"));
});

test("rejects empty input", () => {
  assert.throws(() => color.toRGB(""));
  assert.throws(() => color.toRGB("   "));
});

test("rejects malformed functional notation", () => {
  assert.throws(() => color.toRGB("rgb(255)"));
  assert.throws(() => color.toRGB("rgb(a, b, c)"));
  assert.throws(() => color.toRGB("hsl(0, 0, 50)"), "missing percent should still parse? no");
});

// --- boundary values ---------------------------------------------------------
test("handles RGB boundaries", () => {
  assert.strictEqual(color.toRGBString("rgb(0,0,0)"), "rgb(0, 0, 0)");
  assert.strictEqual(color.toRGBString("rgb(255,255,255)"), "rgb(255, 255, 255)");
});

test("handles HSL boundaries", () => {
  // black/white regardless of hue/sat
  assert.deepStrictEqual(color.hslToRGB(120, 50, 0), { r: 0, g: 0, b: 0 });
  assert.deepStrictEqual(color.hslToRGB(120, 50, 100), { r: 255, g: 255, b: 255 });
});

test("clamps HSL saturation and lightness", () => {
  const rgb = color.hslToRGB(0, 200, 150);
  assert.ok(rgb.r <= 255 && rgb.g >= 0 && rgb.b >= 0);
});

test("normalizes negative / large hue", () => {
  const a = color.hslToRGB(-120, 100, 50);
  const b = color.hslToRGB(240, 100, 50);
  assert.deepStrictEqual(a, b);
  const c = color.hslToRGB(480, 100, 50);
  const d = color.hslToRGB(120, 100, 50);
  assert.deepStrictEqual(c, d);
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);