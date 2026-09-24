#!/usr/bin/env node
"use strict";

/**
 * Run every tool's test suite (tools/<tool>/tests/run.js).
 * A tool may omit tests; then nothing runs for it.
 * Exits 0 only if every present suite passes.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TOOLS_DIR = path.join(REPO_ROOT, "tools");

const failures = [];

function report(ok, message) {
  if (ok) {
    console.log(`  ok — ${message}`);
  } else {
    failures.push(message);
    console.error(`FAIL — ${message}`);
  }
}

function main() {
  console.log("Running tool test suites...");

  let entries;
  try {
    entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    report(false, `cannot read tools directory: ${err.message}`);
    return;
  }

  const dirs = entries.filter((e) => e.isDirectory());
  for (const dir of dirs) {
    const testFile = path.join(TOOLS_DIR, dir.name, "tests", "run.js");
    if (!fs.existsSync(testFile)) continue;

    const result = spawnSync(process.execPath, [testFile], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60000,
    });

    if (result.error) {
      report(false, `tools/${dir.name}/tests/run.js could not be executed — ${result.error.message}`);
    } else if (result.status === 0) {
      const lastLines = result.stdout.trim().split("\\n").pop() || "";
      report(true, `tools/${dir.name}/ tests: ${lastLines}`);
    } else {
      report(false, `tools/${dir.name}/ tests failed (exit ${result.status}): ${(result.stderr || result.stdout).trim().split("\n").pop()}`);
    }
  }

  console.log(failures.length === 0 ? "\nAll tool test suites passed." : `\n${failures.length} test suite(s) failed.`);
  process.exit(failures.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { main };
