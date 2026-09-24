"use strict";

const assert = require("node:assert");
const uuid = require("../tool.js");

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

console.log("uuid-generator tests");

// --- format ---

test("generated UUID matches the v4 format", () => {
  for (let i = 0; i < 50; i++) {
    const v = uuid.uuidv4();
    assert.ok(uuid.isValid(v), "valid format for " + v);
  }
});

test("version and variant bits are correct", () => {
  for (let i = 0; i < 50; i++) {
    const v = uuid.uuidv4();
    assert.strictEqual(v[14], "4", "version 4 for " + v);
    assert.ok("89ab".includes(v[19]), "variant in 89ab for " + v);
  }
});

test("isValid rejects malformed strings", () => {
  assert.strictEqual(uuid.isValid("not-a-uuid"), false);
  assert.strictEqual(uuid.isValid(""), false);
  assert.strictEqual(uuid.isValid("12345678-1234-1234-1234-123456789012"), false);
  assert.strictEqual(uuid.isValid("12345678-1234-5234-1234-123456789012"), false);
});

// --- quantity ---

test("generate honors requested quantity", () => {
  assert.strictEqual(uuid.generate(1).length, 1);
  assert.strictEqual(uuid.generate(5).length, 5);
  assert.strictEqual(uuid.generate(100).length, 100);
});

test("generate clamps invalid quantities", () => {
  assert.strictEqual(uuid.generate(0).length, 1);
  assert.strictEqual(uuid.generate(-3).length, 1);
  assert.strictEqual(uuid.generate(5000).length, 1000);
  assert.strictEqual(uuid.generate("5").length, 5);
});

test("generate default is one", () => {
  assert.strictEqual(uuid.generate().length, 1);
});

// --- uniqueness ---

test("batch contains only unique values", () => {
  const batch = uuid.generate(200);
  const set = new Set(batch);
  assert.strictEqual(set.size, batch.length);
});

test("all values in batch are valid", () => {
  const batch = uuid.generate(50);
  batch.forEach((v) => assert.ok(uuid.isValid(v), "valid: " + v));
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
