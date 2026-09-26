/* Toolshed Image Lab  tests. Run with: node tests/run.js
 * Uses Node built-in assert and requires ../tool.js via UMD. */
"use strict";
const assert = require("node:assert");
const lib = require("../tool.js");
let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++ ;
    console.log("  ok  " + name);
  } catch (err) {
    failed++ ;
    console.error("  FAIL  " + name);
    console.error("         " + (err && err.message));
  }
}
function testImage() {
  const w = 4;
  const h = 3;
  const px = new Uint8ClampedArray(w * h * 4);
  const vals = [
    255,0,0,255, 0,255, 0,255, 0,0,255,255, 255,255,255,255,
    0,0,0,255, 128,64,32,255, 10,20,30,255, 200,150,100,255,
    250,250,0,255,  250,0,250,255,  50,100,150,255, 128,128,128,255
  ];
  px.set(vals);
  return { w, h, px };
}
function pixel(px,x,y,w) {
  const o =(y*w +x)*4;
  return Array.from(new Uint8ClampedArray(px.buffer,o,4));
}
function full(px) {
  return Array.from(px);
}
console.log("image-lab tests");
test("copyPixels returns a copy and never aliases", function () {
  const img = testImage ();
  const out = lib.copyPixels(img.px);
  assert.notStrictEqual(out,img.px);
  assert.deepStrictEqual(full(out),full(img.px));
  out[0] = 0;
  assert.strictEqual(img.px[0],255);
  const into = new Uint8ClampedArray(img.px.length);
  const same = lib.copyPixels(img.px,into);
  assert.strictEqual(same,into);
  assert.deepStrictEqual(full(into),full(img.px));
});
test("normalizeAdjustments clamps and fills defaults", function () {
  const a = lib.normalizeAdjustments(null);
  assert.strictEqual(a.brightness,0);
  assert.strictEqual(a.contrast,0);
  assert.strictEqual(a.saturation,1);
  assert.strictEqual(a.blur,0);
  assert.strictEqual(a.sharpen,0);
  const b = lib.normalizeAdjustments({ brightness: 999,contrast: -999,saturation: 5,blur: 99,sharpen: 99 });
  assert.strictEqual(b.brightness,100);
  assert.strictEqual(b.contrast,-100);
  assert.strictEqual(b.saturation,2);
  assert.strictEqual(b.blur,50);
  assert.strictEqual(b.sharpen,2);
  const n = lib.normalizeAdjustments({ brightness:"5",contrast:"x" });
  assert.strictEqual(n.brightness,0);
  assert.strictEqual(n.contrast,0);
});
test("normalizeAdjustments rounds the blur radius", function () {
  const a = lib.normalizeAdjustments({ blur: 2.6 });
  assert.strictEqual(a.blur,3);
});
test("grayscale preserves alpha and makes RGB neutral", function () {
  const img = testImage();
  const out = lib.grayscale(img.px,img.w,img.h);
  const p = pixel(out,1,1,img.w);
  assert.strictEqual(p[0],p[1]);
  assert.strictEqual(p[1],p[2]);
  assert.strictEqual(p[3],255);
});
test("sepia applies the classic matrix", function () {
  const img = testImage();
  const out = lib.sepia(img.px,img.w,img.h);
  const p = pixel(out,0,0,img.w);
  assert.ok(p[0] > p[1] && p[1] > p[2]);
  assert.strictEqual(p[3],255);
});
function approx(actual,expected,tol,msg) {
  assert.ok(Math.abs(actual-expected)<=tol, (msg||"approx")+" got "+actual+" want "+expected+" +/-"+tol);
}
test("blur with radius 0 copies the source unchanged", function () {
  const img = testImage();
  const out = lib.blur(img.px,img.w,img.h,0);
  assert.deepStrictEqual(full(out),full(img.px));
});
test("blur radius 1 smooths a vertical spike", function () {
  const w=1,h=3;
  const px = new Uint8ClampedArray([0,0,0,255,255,0,0,255,0,0,0,255]);
  const out = lib.blur(px,w,h,1);
  // vertical box blur with edge clamp: rows [0,255,0]
  assert.strictEqual(out[0],128);   // (0+255)/2 boundary
  assert.strictEqual(out[4],85);    // (0+255+0)/3 interior
  assert.strictEqual(out[8],128);   // (255+0)/2 boundary
  assert.strictEqual(out[7],255);   // alpha preserved
});
test("blur clamps huge radius and never mutates source", function () {
  const img = testImage();
  const before = full(img.px);
  const out = lib.blur(img.px,img.w,img.h,99);
  assert.strictEqual(out.length,img.px.length);
  assert.deepStrictEqual(full(img.px),before);
});
test("sharpen leaves a flat image unchanged", function () {
  const w=4,h=4;
  const px = new Uint8ClampedArray(w*h*4);
  for (let i=0;i<px.length;i+=4){px[i]=100;px[i+1]=150;px[i+2]=200;px[i+3]=255;}
  const out = lib.sharpen(px,w,h,1);
  assert.deepStrictEqual(full(out),full(px));
});
test("sharpen amount 0 copies and increases edge contrast", function () {
  const w=3,h=1;
  const px = new Uint8ClampedArray([0,0,0,255,255,255,255,255,0,0,0,255]);
  const out0 = lib.sharpen(px,w,h,0);
  assert.deepStrictEqual(full(out0),full(px));
  const out = lib.sharpen(px,w,h,1);
  assert.ok(out[0] < 0.5);
  assert.strictEqual(out[3],255);
  assert.strictEqual(out.length,px.length);
});
test("sharpen applies fractional amounts instead of ignoring them", function () {
  const w=3,h=1;
  // Mid-grey shoulders around a bright centre, so the edge pixels have room to
  // move in both directions and clamping cannot mask the effect.
  const px = new Uint8ClampedArray([100,100,100,255,200,200,200,255,100,100,100,255]);
  // Anything between 0 and 1 is a real amount: the UI maps its 0-100 slider
  // to 0-1, so a threshold of 1 would make every slider value below max a no-op.
  for (const amount of [0.1,0.25,0.5,0.6,0.9]) {
    const out = lib.sharpen(px,w,h,amount);
    assert.notDeepStrictEqual(full(out),full(px),"sharpen "+amount+" should change pixels");
    assert.ok(out[0] < 100,"sharpen "+amount+" should darken the edge shoulder");
    assert.strictEqual(out[3],255,"alpha preserved at "+amount);
  }
  // Stronger amounts must bite harder than weaker ones.
  const weak = lib.sharpen(px,w,h,0.25);
  const strong = lib.sharpen(px,w,h,0.75);
  assert.ok(strong[0] < weak[0],"a larger amount must sharpen harder");
  assert.strictEqual(lib.sharpen(px,w,h,0)[0],100,"amount 0 is a no-op");
});
test("saturate 0 greys out, 2 doubles, alpha kept", function () {
  const w=1,h=1;
  const px = new Uint8ClampedArray([128,64,32,255]);
  const grey = lib.saturate(px,w,h,0);
  approx(grey[0],79.5,1,"saturate0 r");
  approx(grey[1],79.5,1,"saturate0 g");
  approx(grey[2],79.5,1,"saturate0 b");
  assert.strictEqual(grey[3],255);
  const vivid = lib.saturate(px,w,h,2);
  approx(vivid[0],176.5,1.5,"saturate2 r");
  approx(vivid[1],48.5,1.5,"saturate2 g");
  approx(vivid[2],0,0.01,"saturate2 b clamps to 0");
  assert.strictEqual(px[0],128);
});
test("saturate clamps out-of-range amounts", function () {
  const px = new Uint8ClampedArray([128,64,32,255]);
  const hi = lib.saturate(px,1,1,99);
  const lo = lib.saturate(px,1,1,-99);
  assert.deepStrictEqual(full(hi),full(lib.saturate(px,1,1,2)));
  assert.deepStrictEqual(full(lo),full(lib.saturate(px,1,1,0)));
  assert.notDeepStrictEqual(full(hi),full(lo));
});
test("applyAdjustments rejects missing source or dimensions", function () {
  assert.strictEqual(lib.applyAdjustments(null,4,4,{}),null);
  assert.strictEqual(lib.applyAdjustments(new Uint8ClampedArray(16),0,4,{}),null);
  assert.strictEqual(lib.applyAdjustments(new Uint8ClampedArray(16),4,0,{}),null);
});
test("applyAdjustments with defaults is an exact copy", function () {
  const img = testImage();
  const before = full(img.px);
  const out = lib.applyAdjustments(img.px,img.w,img.h,{});
  assert.deepStrictEqual(full(out),before);
  assert.notStrictEqual(out,img.px);
  assert.deepStrictEqual(full(img.px),before);
});
test("applyAdjustments brightness +100 lifts black to grey", function () {
  const px = new Uint8ClampedArray([0,0,0,255]);
  const out = lib.applyAdjustments(px,1,1,{ brightness: 100 });
  approx(out[0],100,1,"bright r");
  approx(out[1],100,1,"bright g");
  approx(out[2],100,1,"bright b");
  assert.strictEqual(out[3],255);
});
test("applyAdjustments contrast -100 flattens to mid grey", function () {
  const px = new Uint8ClampedArray([200,10,90,255]);
  const out = lib.applyAdjustments(px,1,1,{ contrast: -100 });
  approx(out[0],128,1,"contrast r");
  approx(out[1],128,1,"contrast g");
  approx(out[2],128,1,"contrast b");
});
test("applyAdjustments runs blur+saturation+sharpen together", function () {
  const img = testImage();
  const before = full(img.px);
  const out = lib.applyAdjustments(img.px,img.w,img.h,{ blur: 1,saturation: 0.5,sharpen: 1 });
  assert.strictEqual(out.length,img.px.length);
  for (let i=3;i<out.length;i+=4) assert.strictEqual(out[i],255);
  assert.deepStrictEqual(full(img.px),before);
});
test("applyAdjustments is deterministic across runs", function () {
  const img = testImage();
  const adj = { brightness: 12,contrast: -8,saturation: 1.4,blur: 2,sharpen: 0.7 };
  const a = lib.applyAdjustments(img.px,img.w,img.h,adj);
  const b = lib.applyAdjustments(img.px,img.w,img.h,adj);
  assert.deepStrictEqual(full(a),full(b));
});
console.log("");
console.log(passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
