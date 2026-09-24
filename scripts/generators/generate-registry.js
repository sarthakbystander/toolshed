#!/usr/bin/env node
"use strict";

/**
 * Toolshed registry generator.
 *
 * Discovers tools/ directories, reads each tool's tool.json, validates the
 * metadata, and writes the deterministic registry to registry/tools.json.
 *
 * The tool directories under tools/ are the source of truth. The output file
 * is generated — never edit registry/tools.json by hand.
 *
 * Invalid metadata fails the run with a useful error.
 */

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TOOLS_DIR = path.join(REPO_ROOT, "tools");
const REGISTRY_DIR = path.join(REPO_ROOT, "registry");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "tools.json");
const TOOL_MANIFEST = "tool.json";

// ---------------------------------------------------------------------------
// Metadata validation
// ---------------------------------------------------------------------------
//
// The full JSON schema lives in scripts/generators/tool-schema.json (used by
// editors and CI tooling). This bundled validator enforces the same contract
// with zero dependencies so the generator always works from a plain checkout.

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const STORAGE_VALUES = new Set(["none", "localStorage", "sessionStorage", "indexedDB"]);

function validateTool(tool, dirName) {
  const errors = [];

  const required = [
    "id", "name", "description", "category", "tags", "version", "runtime", "privacy",
  ];
  for (const field of required) {
    if (!(field in tool) || tool[field] === undefined) {
      errors.push(`missing required field: "${field}"`);
    }
  }

  if (typeof tool.id !== "string") {
    errors.push('"id" must be a string');
  } else if (!ID_PATTERN.test(tool.id)) {
    errors.push(`"id" must be lowercase-kebab-case (e.g. json-formatter), got ${JSON.stringify(tool.id)}`);
  } else if (tool.id !== dirName) {
    errors.push(`"id" (${JSON.stringify(tool.id)}) must match the directory name (${JSON.stringify(dirName)})`);
  }

  if (typeof tool.name !== "string" || tool.name.trim() === "") {
    errors.push('"name" must be a non-empty string');
  }
  if (typeof tool.description !== "string" || tool.description.trim() === "") {
    errors.push('"description" must be a non-empty string');
  }
  if (typeof tool.category !== "string" || tool.category.trim() === "") {
    errors.push('"category" must be a non-empty string');
  }

  if (!Array.isArray(tool.tags) || tool.tags.length === 0) {
    errors.push('"tags" must be a non-empty array');
  } else {
    tool.tags.forEach((tag, i) => {
      if (typeof tag !== "string" || tag.trim() === "") {
        errors.push(`"tags[${i}]" must be a non-empty string`);
      }
    });
    if (new Set(tool.tags).size !== tool.tags.length) {
      errors.push('"tags" must not contain duplicates');
    }
  }

  if (typeof tool.version !== "string" || !VERSION_PATTERN.test(tool.version)) {
    errors.push('"version" must be a semantic version like "1.0.0"');
  }

  if (tool.runtime !== "browser") {
    errors.push('"runtime" must be "browser"');
  }

  const privacy = tool.privacy;
  if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) {
    errors.push('"privacy" must be an object with "execution", "dataUploaded" and "storage"');
  } else {
    if (privacy.execution !== "local") errors.push('"privacy.execution" must be "local"');
    if (typeof privacy.dataUploaded !== "boolean") errors.push('"privacy.dataUploaded" must be a boolean');
    if (typeof privacy.storage !== "string" || !STORAGE_VALUES.has(privacy.storage)) {
      errors.push('"privacy.storage" must be one of: none, localStorage, sessionStorage, indexedDB');
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function listToolDirectories() {
  let entries;
  try {
    entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true });
  } catch (err) {
    fail(`cannot read tools directory ${TOOLS_DIR}: ${err.message}`);
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readToolManifest(dirName) {
  const manifestPath = path.join(TOOLS_DIR, dirName, TOOL_MANIFEST);
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    fail(
      `${manifestPath}: missing ${TOOL_MANIFEST} in tool directory "${dirName}" — ` +
      `every tool directory must contain its ${TOOL_MANIFEST} metadata file`
    );
  }
  try {
    return { dirName, manifestPath, metadata: JSON.parse(raw) };
  } catch (err) {
    fail(`${manifestPath}: invalid JSON — ${err.message}`);
  }
}

function validateManifest(tool) {
  const errors = validateTool(tool.metadata, tool.dirName);
  if (errors.length > 0) {
    fail(
      `${tool.manifestPath}: invalid tool metadata:\n` +
      errors.map((e) => `  - ${e}`).join("\n")
    );
  }
}

// ---------------------------------------------------------------------------
// Deterministic output
// ---------------------------------------------------------------------------

function projectMetadata(tool) {
  return {
    id: tool.metadata.id,
    name: tool.metadata.name,
    description: tool.metadata.description,
    category: tool.metadata.category,
    tags: [...tool.metadata.tags].sort(),
    version: tool.metadata.version,
    runtime: tool.metadata.runtime,
    privacy: {
      execution: tool.metadata.privacy.execution,
      dataUploaded: tool.metadata.privacy.dataUploaded,
      storage: tool.metadata.privacy.storage,
    },
  };
}

function main() {
  const dirNames = listToolDirectories();
  const tools = dirNames.map(readToolManifest);
  for (const tool of tools) {
    validateManifest(tool);
  }

  const registry = tools.map(projectMetadata).sort((a, b) => a.id.localeCompare(b.id));

  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const output = JSON.stringify(registry, null, 2) + "\n";
  const previous = readFileIfExists(REGISTRY_FILE);

  fs.writeFileSync(REGISTRY_FILE, output, "utf8");

  const count = registry.length;
  if (previous !== null && previous === output) {
    console.log(`Registry unchanged (${count} tool${count === 1 ? "" : "s"}).`);
  } else {
    console.log(`Wrote ${path.relative(REPO_ROOT, REGISTRY_FILE)} (${count} tool${count === 1 ? "" : "s"}).`);
  }
}

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  validateTool,
  listToolDirectories,
  readToolManifest,
  projectMetadata,
};