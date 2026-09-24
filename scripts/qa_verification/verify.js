#!/usr/bin/env node
"use strict";

/**
 * Toolshed repository verification.
 *
 * Performs the checks that are practical today and will grow into the full
 * pipeline: schema validation, tool structure validation, metadata
 * validation, registry validation, and website presence checks.
 *
 * Exit code 0 means the repository is healthy. Any failure exits 1.
 *
 * Deliberately omitted for now (see AGENTS.md for the planned pipeline):
 * tests/linting, security scans, link/asset checks. Nothing here is a
 * placeholder — every check below verifies something real.
 */

const fs = require("node:fs");
const path = require("node:path");

const generator = require(path.join(__dirname, "..", "generators", "generate-registry.js"));

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TOOLS_DIR = path.join(REPO_ROOT, "tools");
const REGISTRY_FILE = path.join(REPO_ROOT, "registry", "tools.json");
const PACKAGE_FILE = path.join(REPO_ROOT, "package.json");
const HOMEPAGE_FILE = path.join(REPO_ROOT, "index.html");
const SCHEMA_FILE = path.join(REPO_ROOT, "scripts", "generators", "tool-schema.json");
const TOOL_MANIFEST = "tool.json";

const WORKFLOW_FILES = [
  path.join(REPO_ROOT, ".github", "workflows", "verify.yml"),
  path.join(REPO_ROOT, ".github", "workflows", "deploy.yml"),
];

const REQUIRED_DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "AGENTS.md",
  "LICENSE",
];

const failures = [];

function report(ok, message) {
  if (ok) {
    console.log(`  ok — ${message}`);
  } else {
    failures.push(message);
    console.error(`FAIL — ${message}`);
  }
}

function readJSON(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    report(false, `${label} (${relative(filePath)}) is not valid JSON — ${err.message}`);
    return null;
  }
}

function relative(filePath) {
  return path.relative(REPO_ROOT, filePath);
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

function checkPackage() {
  console.log("Checking package.json...");
  const pkg = readJSON(PACKAGE_FILE, "package.json");
  if (!pkg) return;

  report(typeof pkg.scripts?.generate === "string", `package.json defines a "generate" script`);
  report(typeof pkg.scripts?.verify === "string", `package.json defines a "verify" script`);

  const runtimeDeps = Object.keys(pkg.dependencies || {});
  report(
    runtimeDeps.length === 0,
    `package.json declares no runtime dependencies (found: ${runtimeDeps.length})`
  );
}

// ---------------------------------------------------------------------------
// JSON validity across the repository
// ---------------------------------------------------------------------------

function collectJSONFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJSONFiles(full, out);
    } else if (entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
}

function checkAllJSON() {
  console.log("Checking JSON validity...");
  const files = [];
  collectJSONFiles(REPO_ROOT, files);
  files.sort();
  for (const file of files) {
    readJSON(file, relative(file));
  }
  report(files.length > 0, `scanned ${files.length} JSON file(s)`);
}

// ---------------------------------------------------------------------------
// Tool directories
// ---------------------------------------------------------------------------

function safeReadManifest(dirName) {
  const manifestPath = path.join(TOOLS_DIR, dirName, TOOL_MANIFEST);
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return { error: `${relative(manifestPath)}: missing ${TOOL_MANIFEST} in tool directory "${dirName}"` };
  }
  try {
    return { metadata: JSON.parse(raw), dirName };
  } catch (err) {
    return { error: `${relative(manifestPath)}: invalid JSON — ${err.message}` };
  }
}

function checkToolStructure() {
  console.log("Checking tool structure...");

  let entries;
  try {
    entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    report(false, `cannot read tools directory: ${err.message}`);
    return;
  }

  const unexpected = entries.filter((e) => !e.isDirectory() && e.name !== ".gitkeep");
  report(
    unexpected.length === 0,
    unexpected.length === 0
      ? "no stray files directly under tools/"
      : `unexpected non-directory entries under tools/: ${unexpected.map((e) => e.name).join(", ")}`
  );

  const dirs = entries.filter((e) => e.isDirectory());
  for (const dir of dirs) {
    const manifest = safeReadManifest(dir.name);
    if (manifest.error) {
      report(false, manifest.error);
      continue;
    }
    const errors = generator.validateTool(manifest.metadata, dir.name);
    report(
      errors.length === 0,
      errors.length === 0
        ? `tools/${dir.name}/ validates against the tool.json contract`
        : `tools/${dir.name}/tool.json invalid: ${errors.join("; ")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Registry freshness
// ---------------------------------------------------------------------------

function computeExpectedRegistry() {
  const dirNames = generator.listToolDirectories();
  const tools = dirNames.map(safeReadManifest);

  for (const tool of tools) {
    if (tool.error) return { error: tool.error };
    const errors = generator.validateTool(tool.metadata, tool.dirName);
    if (errors.length > 0) {
      return { error: `invalid metadata: ${errors.join("; ")}` };
    }
  }

  const registry = tools
    .map((t) => generator.projectMetadata(t))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { registry };
}

function checkRegistry() {
  console.log("Checking registry...");
  const disk = readJSON(REGISTRY_FILE, "registry/tools.json");
  if (disk === null) return;

  report(Array.isArray(disk), "registry/tools.json is an array");

  const expected = computeExpectedRegistry();
  if (expected.error) {
    report(false, `cannot compute expected registry: ${expected.error}`);
    return;
  }
  const generated = JSON.stringify(expected.registry, null, 2) + "\n";
  const onDisk = fs.readFileSync(REGISTRY_FILE, "utf8");
  report(
    generated === onDisk,
    generated === onDisk
      ? "registry/tools.json is up to date with the generator"
      : "registry/tools.json is stale — run `npm run generate` and commit the result"
  );
}

// ---------------------------------------------------------------------------
// Homepage
// ---------------------------------------------------------------------------

function checkHomepage() {
  console.log("Checking homepage...");
  let html;
  try {
    html = fs.readFileSync(HOMEPAGE_FILE, "utf8");
  } catch {
    report(false, "index.html exists at the repository root");
    return;
  }
  report(html.includes("Toolshed"), "index.html is the Toolshed homepage");
  report(html.includes("<title"), "index.html declares a title");
}

// ---------------------------------------------------------------------------
// Infrastructure presence
// ---------------------------------------------------------------------------

function checkInfrastructure() {
  console.log("Checking infrastructure...");
  report(fs.existsSync(SCHEMA_FILE), "tool metadata JSON schema is present");

  for (const file of WORKFLOW_FILES) {
    report(fs.existsSync(file), `.github/workflows/ files are present (${path.basename(file)})`);
  }

  for (const doc of REQUIRED_DOCS) {
    report(fs.existsSync(path.join(REPO_ROOT, doc)), `${doc} is present`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("Toolshed verification\n");
  checkPackage();
  checkAllJSON();
  checkToolStructure();
  checkRegistry();
  checkHomepage();
  checkInfrastructure();

  console.log(failures.length === 0 ? "\nAll checks passed." : `\n${failures.length} check(s) failed.`);
  process.exit(failures.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  checkPackage,
  checkAllJSON,
  checkToolStructure,
  checkRegistry,
  checkHomepage,
  checkInfrastructure,
};