"use strict";

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
    console.error("         " + (err && err.stack ? err.stack.split("\n").slice(0, 3).join("\n         ") : err));
  }
}

console.log("openapi-request-builder tests");

// ---------------------------------------------------------------------------
// parseSpec
// ---------------------------------------------------------------------------

test("parseSpec accepts OpenAPI 3 documents", () => {
  const r = lib.parseSpec(lib.SAMPLE_SPEC_TEXT);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.flavor, "openapi");
  assert.strictEqual(r.version, "3.0.3");
  assert.ok(r.doc && r.doc.paths);
});

test("parseSpec accepts an already-parsed object", () => {
  const r = lib.parseSpec(lib.SAMPLE_SPEC);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.flavor, "openapi");
});

test("parseSpec accepts Swagger 2.0", () => {
  const r = lib.parseSpec({ swagger: "2.0", info: {}, paths: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.flavor, "swagger");
});

test("parseSpec rejects empty input", () => {
  assert.strictEqual(lib.parseSpec("   ").ok, false);
  assert.match(lib.parseSpec("").error, /empty/i);
});

test("parseSpec rejects malformed JSON with a readable message", () => {
  const r = lib.parseSpec("{ not json ]");
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not valid JSON/i);
});

test("parseSpec rejects non-OpenAPI objects", () => {
  const r = lib.parseSpec({ hello: "world" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /openapi|swagger/i);
});

test("parseSpec rejects arrays and primitives", () => {
  assert.strictEqual(lib.parseSpec("[1,2,3]").ok, false);
  assert.strictEqual(lib.parseSpec("42").ok, false);
  assert.strictEqual(lib.parseSpec("null").ok, false);
});

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

test("listServers reads OpenAPI 3 servers and trims trailing slashes", () => {
  const doc = { openapi: "3.0.0", servers: [{ url: "https://a.example.com/v1/" }, { url: "https://b.example.com" }], paths: {} };
  assert.deepStrictEqual(lib.listServers(doc), ["https://a.example.com/v1", "https://b.example.com"]);
});

test("listServers deduplicates and ignores blanks", () => {
  const doc = { openapi: "3.0.0", servers: [{ url: "https://a.example.com" }, { url: "https://a.example.com/" }, { url: "" }], paths: {} };
  assert.deepStrictEqual(lib.listServers(doc), ["https://a.example.com"]);
});

test("listServers derives a Swagger 2 base URL from host, schemes and basePath", () => {
  const doc = { swagger: "2.0", host: "api.example.com", basePath: "/v2", schemes: ["https"], paths: {} };
  assert.deepStrictEqual(lib.listServers(doc), ["https://api.example.com/v2"]);
});

test("listServers returns an empty array when nothing is declared", () => {
  assert.deepStrictEqual(lib.listServers({ openapi: "3.0.0", paths: {} }), []);
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

test("listOperations enumerates every path and method", () => {
  const ops = lib.listOperations(lib.parseSpec(lib.SAMPLE_SPEC_TEXT).doc);
  const keys = ops.map((o) => o.key);
  assert.deepStrictEqual(keys, [
    "GET /pets",
    "POST /pets",
    "GET /pets/{petId}",
    "DELETE /pets/{petId}",
    "POST /store/search",
  ]);
});

test("listOperations ignores path-item keys that are not methods", () => {
  const doc = { openapi: "3.0.0", paths: { "/x": { parameters: [], get: { responses: {} }, summary: "nope" } } };
  const ops = lib.listOperations(doc);
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(ops[0].operationId, "");
});

test("findOperation locates an operation by method and path", () => {
  const doc = lib.parseSpec(lib.SAMPLE_SPEC_TEXT).doc;
  const op = lib.findOperation(doc, "post", "/pets");
  assert.ok(op);
  assert.strictEqual(op.operationId, "createPet");
  assert.strictEqual(lib.findOperation(doc, "PATCH", "/pets"), null);
  assert.strictEqual(lib.findOperation(doc, "GET", "/nope"), null);
});

test("searchOperations filters by free text across fields", () => {
  const doc = lib.parseSpec(lib.SAMPLE_SPEC_TEXT).doc;
  assert.strictEqual(lib.searchOperations(doc, "createPet").length, 1);
  assert.strictEqual(lib.searchOperations(doc, "petId").length, 2);
  assert.strictEqual(lib.searchOperations(doc, "xyzzy").length, 0);
  assert.strictEqual(lib.searchOperations(doc, "").length, 5);
});

test("searchOperations filters by tag", () => {
  const doc = lib.parseSpec(lib.SAMPLE_SPEC_TEXT).doc;
  assert.strictEqual(lib.searchOperations(doc, "", "pets").length, 4);
  assert.strictEqual(lib.searchOperations(doc, "", "store").length, 1);
  assert.strictEqual(lib.searchOperations(doc, "", "All").length, 5);
});

test("listTags returns sorted distinct tags", () => {
  const doc = lib.parseSpec(lib.SAMPLE_SPEC_TEXT).doc;
  assert.deepStrictEqual(lib.listTags(doc), ["pets", "store"]);
});

test("search with empty query and missing paths is safe", () => {
  assert.deepStrictEqual(lib.listOperations({ openapi: "3.0.0" }), []);
  assert.deepStrictEqual(lib.listTags({ openapi: "3.0.0" }), []);
});

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

test("resolveRef follows JSON pointers", () => {
  const doc = { components: { schemas: { Pet: { type: "object" }, "weird/name": { type: "string" } } } };
  assert.deepStrictEqual(lib.resolveRef(doc, "#/components/schemas/Pet"), { type: "object" });
  assert.deepStrictEqual(lib.resolveRef(doc, "#/components/schemas/weird~1name"), { type: "string" });
});

test("resolveRef returns undefined for missing or external refs", () => {
  const doc = { a: {} };
  assert.strictEqual(lib.resolveRef(doc, "#/a/b"), undefined);
  assert.strictEqual(lib.resolveRef(doc, "https://example.com/schema.json"), undefined);
  assert.strictEqual(lib.resolveRef(doc, "#/nope"), undefined);
  assert.strictEqual(lib.resolveRef(doc, ""), undefined);
});

test("refName extracts the terminal name", () => {
  assert.strictEqual(lib.refName("#/components/schemas/Pet"), "Pet");
  assert.strictEqual(lib.refName(""), "");
});

test("derefSchema follows chains and stops cycles", () => {
  const doc = { components: { schemas: { A: { $ref: "#/components/schemas/B" }, B: { type: "number" }, Loop: { $ref: "#/components/schemas/Loop" } } } };
  const b = lib.derefSchema(doc, { $ref: "#/components/schemas/A" }, []);
  assert.strictEqual(b.type, "number");
  assert.strictEqual(lib.derefSchema(doc, { $ref: "#/components/schemas/Loop" }, []), null);
});

test("derefSchema returns null for unresolvable refs", () => {
  const doc = { components: { schemas: {} } };
  assert.strictEqual(lib.derefSchema(doc, { $ref: "#/components/schemas/Missing" }, []), null);
});

test("mergeAllOf combines properties and required across branches", () => {
  const doc = {
    components: {
      schemas: {
        Base: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        Extended: { allOf: [{ $ref: "#/components/schemas/Base" }, { type: "object", properties: { name: { type: "string" } }, required: ["name"] }] },
      },
    },
  };
  const merged = lib.mergeAllOf(doc, { $ref: "#/components/schemas/Extended" }, []);
  assert.deepStrictEqual(Object.keys(merged.properties).sort(), ["id", "name"]);
  assert.deepStrictEqual(merged.required.sort(), ["id", "name"]);
});

test("exampleFromSchema merges allOf and resolves refs", () => {
  const doc = {
    components: {
      schemas: {
        Base: { type: "object", properties: { id: { type: "integer" } } },
        Extended: { allOf: [{ $ref: "#/components/schemas/Base" }, { type: "object", properties: { name: { type: "string", example: "Rex" } } }] },
      },
    },
  };
  assert.deepStrictEqual(lib.exampleFromSchema(doc, { $ref: "#/components/schemas/Extended" }, {}), { id: 0, name: "Rex" });
});

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

test("exampleFromSchema generates type-appropriate placeholders", () => {
  const doc = { openapi: "3.0.0", components: {}, paths: {} };
  assert.strictEqual(lib.exampleFromSchema(doc, { type: "integer" }, {}), 0);
  assert.strictEqual(lib.exampleFromSchema(doc, { type: "number", minimum: 5 }, {}), 5);
  assert.strictEqual(lib.exampleFromSchema(doc, { type: "boolean" }, {}), false);
  assert.strictEqual(lib.exampleFromSchema(doc, { type: "string", format: "uuid" }, {}), "00000000-0000-4000-8000-000000000000");
  assert.strictEqual(lib.exampleFromSchema(doc, { type: "string", format: "date" }, {}), "2024-01-01");
  assert.strictEqual(lib.exampleFromSchema(doc, { type: "string", format: "email" }, {}), "user@example.com");
});

test("exampleFromSchema prefers example, then default, then enum", () => {
  const doc = {};
  assert.strictEqual(lib.exampleFromSchema(doc, { type: "string", example: "hi", default: "z" }, {}), "hi");
  assert.strictEqual(lib.exampleFromSchema(doc, { type: "string", default: "z" }, {}), "z");
  assert.strictEqual(lib.exampleFromSchema(doc, { type: "string", enum: ["a", "b"] }, {}), "a");
});

test("exampleFromSchema honors useExamples:false", () => {
  const doc = {};
  assert.strictEqual(lib.exampleFromSchema(doc, { type: "string", example: "hi" }, { useExamples: false }), "");
});

test("exampleFromSchema builds nested objects and arrays", () => {
  const doc = {};
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      nested: { type: "object", properties: { ok: { type: "boolean" } } },
    },
  };
  assert.deepStrictEqual(lib.exampleFromSchema(doc, schema, {}), {
    name: "",
    tags: [""],
    nested: { ok: false },
  });
});

test("exampleFromSchema selects the first oneOf/anyOf branch", () => {
  assert.strictEqual(lib.exampleFromSchema({}, { oneOf: [{ type: "integer" }, { type: "string" }] }, {}), 0);
  assert.strictEqual(lib.exampleFromSchema({}, { anyOf: [{ type: "boolean" }] }, {}), false);
});

test("exampleFromSchema handles null and unknown types safely", () => {
  assert.strictEqual(lib.exampleFromSchema({}, { type: "null" }, {}), null);
  assert.strictEqual(lib.exampleFromSchema({}, { type: "wat" }, {}), null);
  assert.strictEqual(lib.exampleFromSchema({}, null, {}), null);
});

test("exampleFromSchema bounds recursion and cyclic refs", () => {
  const doc = { components: { schemas: { Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } } } } };
  const value = lib.exampleFromSchema(doc, { $ref: "#/components/schemas/Node" }, {});
  assert.ok(value && typeof value === "object");
});

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

test("pathTemplateNames extracts unique placeholder names", () => {
  assert.deepStrictEqual(lib.pathTemplateNames("/a/{b}/c/{d}"), ["b", "d"]);
  assert.deepStrictEqual(lib.pathTemplateNames("/a/{b}/{b}"), ["b"]);
  assert.deepStrictEqual(lib.pathTemplateNames("/plain"), []);
  assert.deepStrictEqual(lib.pathTemplateNames(""), []);
});

test("collectParameters merges path-item and operation params, operation wins", () => {
  const doc = {
    openapi: "3.0.0",
    paths: {},
    components: { parameters: { Limit: { name: "limit", in: "query", schema: { type: "integer", example: 1 } } } },
  };
  const pathItem = { parameters: [{ name: "limit", in: "query", schema: { type: "integer", example: 10 } }, { $ref: "#/components/parameters/Limit" }] };
  const operation = { parameters: [{ name: "limit", in: "query", schema: { type: "integer", example: 99 } }] };
  const params = lib.collectParameters(doc, pathItem, operation);
  assert.strictEqual(params.length, 1);
  assert.strictEqual(params[0].schema.example, 99);
});

test("parametersByLocation groups parameters correctly", () => {
  const doc = lib.parseSpec(lib.SAMPLE_SPEC_TEXT).doc;
  const op = lib.findOperation(doc, "GET", "/pets");
  const grouped = lib.parametersByLocation(doc, op.pathItem, op.operation);
  assert.deepStrictEqual(grouped.query.map((p) => p.name), ["limit", "status"]);
  assert.deepStrictEqual(grouped.header.map((p) => p.name), ["X-Request-Id"]);
  assert.deepStrictEqual(grouped.path, []);
});

test("path parameters are always required", () => {
  const descriptor = lib.describeParameter({ name: "id", in: "path", schema: { type: "string" } });
  assert.strictEqual(descriptor.required, true);
});

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

test("requestBodySchema reads OpenAPI 3 JSON bodies and prefers application/json", () => {
  const doc = lib.parseSpec(lib.SAMPLE_SPEC_TEXT).doc;
  const op = lib.findOperation(doc, "POST", "/pets");
  const body = lib.requestBodySchema(doc, op.operation);
  assert.strictEqual(body.mediaType, "application/json");
  assert.strictEqual(body.required, true);
  assert.ok(body.schema);
});

test("requestBodySchema picks the first JSON-ish media type among alternatives", () => {
  const doc = { openapi: "3.0.0", paths: {} };
  const operation = {
    requestBody: {
      content: {
        "text/plain": { schema: { type: "string" } },
        "application/vnd.api+json": { schema: { type: "object" } },
      },
    },
  };
  assert.strictEqual(lib.pickMediaType(Object.keys(operation.requestBody.content)), "application/vnd.api+json");
  assert.strictEqual(lib.requestBodySchema(doc, operation).mediaType, "application/vnd.api+json");
});

test("requestBodySchema builds a form body from Swagger 2 formData params", () => {
  const doc = { swagger: "2.0", paths: {} };
  const operation = { parameters: [{ name: "file", in: "formData", type: "string" }, { name: "note", in: "formData", type: "string" }] };
  const body = lib.requestBodySchema(doc, operation);
  assert.strictEqual(body.mediaType, "application/x-www-form-urlencoded");
  assert.deepStrictEqual(Object.keys(body.schema.properties).sort(), ["file", "note"]);
});

test("requestBodySchema reads a Swagger 2 body parameter", () => {
  const doc = { swagger: "2.0", paths: {} };
  const operation = { parameters: [{ name: "payload", in: "body", required: true, schema: { type: "object", properties: { a: { type: "string" } } } }] };
  const body = lib.requestBodySchema(doc, operation);
  assert.strictEqual(body.required, true);
  assert.strictEqual(body.mediaType, "application/json");
});

test("requestBodySchema returns null when there is no body", () => {
  assert.strictEqual(lib.requestBodySchema({}, { parameters: [] }), null);
  assert.strictEqual(lib.requestBodySchema({}, null), null);
});

// ---------------------------------------------------------------------------
// deriveInputs
// ---------------------------------------------------------------------------

test("deriveInputs seeds path params from the template and example values", () => {
  const doc = lib.parseSpec(lib.SAMPLE_SPEC_TEXT).doc;
  const op = lib.findOperation(doc, "GET", "/pets/{petId}");
  const inputs = lib.deriveInputs(doc, op.path, op.pathItem, op.operation);
  assert.deepStrictEqual(inputs.pathParams.map((p) => p.name), ["petId"]);
  assert.strictEqual(inputs.pathParams[0].required, true);
});

test("deriveInputs enables required params and disables optional ones", () => {
  const doc = lib.parseSpec(lib.SAMPLE_SPEC_TEXT).doc;
  const op = lib.findOperation(doc, "GET", "/pets");
  const inputs = lib.deriveInputs(doc, op.path, op.pathItem, op.operation);
  const byName = Object.fromEntries(inputs.query.map((q) => [q.name, q]));
  assert.strictEqual(byName.limit.enabled, false);
  assert.strictEqual(byName.limit.required, false);
});

test("deriveInputs includes a JSON body example from the schema", () => {
  const doc = lib.parseSpec(lib.SAMPLE_SPEC_TEXT).doc;
  const op = lib.findOperation(doc, "POST", "/pets");
  const inputs = lib.deriveInputs(doc, op.path, op.pathItem, op.operation);
  assert.strictEqual(inputs.body.hasSchema, true);
  const parsed = JSON.parse(inputs.body.text);
  assert.strictEqual(parsed.name, "Rex");
  assert.deepStrictEqual(parsed.photoUrls, ["https://example.com"]);
});

// ---------------------------------------------------------------------------
// buildRequest
// ---------------------------------------------------------------------------

const BASE = "https://api.example.com/v1";

test("buildRequest substitutes and encodes path parameters", () => {
  const req = lib.buildRequest(null, "GET", "/pets/{petId}", { baseUrl: BASE, pathParams: { petId: "a b/c" } });
  assert.strictEqual(req.url, BASE + "/pets/a%20b%2Fc");
  assert.deepStrictEqual(req.errors, []);
});

test("buildRequest flags missing path parameters", () => {
  const req = lib.buildRequest(null, "GET", "/pets/{petId}", { baseUrl: BASE, pathParams: {} });
  assert.strictEqual(req.errors.length, 1);
  assert.match(req.errors[0], /petId/);
  assert.strictEqual(req.url, BASE + "/pets/%7BpetId%7D");
});

test("buildRequest appends enabled query parameters and skips disabled ones", () => {
  const req = lib.buildRequest(null, "GET", "/pets", {
    baseUrl: BASE,
    query: [
      { name: "limit", value: "10", enabled: true },
      { name: "secret", value: "x", enabled: false },
    ],
  });
  assert.strictEqual(req.queryString, "limit=10");
  assert.strictEqual(req.url, BASE + "/pets?limit=10");
});

test("buildRequest encodes query values and warns on empties", () => {
  const req = lib.buildRequest(null, "GET", "/pets", {
    baseUrl: BASE,
    query: [{ name: "q", value: "a&b=c", enabled: true }, { name: "empty", value: "", enabled: true }],
  });
  assert.strictEqual(req.queryString, "q=a%26b%3Dc&empty=");
  assert.strictEqual(req.warnings.length, 1);
});

test("buildRequest applies headers and adds Content-Type for bodies", () => {
  const req = lib.buildRequest(null, "POST", "/pets", {
    baseUrl: BASE,
    headers: [{ name: "Authorization", value: "Bearer token", enabled: true }],
    body: '{"name":"Rex"}',
    contentType: "application/json",
  });
  assert.strictEqual(req.headers.Authorization, "Bearer token");
  assert.strictEqual(req.headers["Content-Type"], "application/json");
  assert.strictEqual(req.body, '{"name":"Rex"}');
});

test("buildRequest does not duplicate an explicit Content-Type header", () => {
  const req = lib.buildRequest(null, "POST", "/pets", {
    baseUrl: BASE,
    headers: [{ name: "content-type", value: "application/json; charset=utf-8", enabled: true }],
    body: "{}",
    contentType: "application/json",
  });
  assert.strictEqual(req.headers["content-type"], "application/json; charset=utf-8");
  assert.strictEqual(Object.keys(req.headers).filter((k) => /content-type/i.test(k)).length, 1);
});

test("buildRequest normalizes base URLs and leading slashes", () => {
  const req = lib.buildRequest(null, "GET", "pets", { baseUrl: "https://api.example.com/v1/" });
  assert.strictEqual(req.url, "https://api.example.com/v1/pets");
});

test("buildRequest tolerates empty input", () => {
  const req = lib.buildRequest(null, "GET", "/pets", {});
  assert.strictEqual(req.url, "/pets");
  assert.strictEqual(req.body, null);
});

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

function sampleRequest() {
  return lib.buildRequest(null, "POST", "/pets/{petId}", {
    baseUrl: BASE,
    pathParams: { petId: "7" },
    query: [{ name: "verbose", value: "true", enabled: true }],
    headers: [{ name: "Authorization", value: "Bearer abc", enabled: true }],
    body: '{"name":"Rex","n":1,"flag":true,"nothing":null}',
    contentType: "application/json",
  });
}

test("toCurl produces a runnable multi-line curl command", () => {
  const curl = lib.toCurl(sampleRequest());
  assert.ok(curl.startsWith("curl -X POST 'https://api.example.com/v1/pets/7?verbose=true'"));
  assert.ok(curl.includes("-H 'Authorization: Bearer abc'"));
  assert.ok(curl.includes("-H 'Content-Type: application/json'"));
  assert.ok(curl.includes("-d '{"));
  assert.ok(curl.includes(" \\\n"));
});

test("toCurl escapes single quotes safely", () => {
  const req = lib.buildRequest(null, "POST", "/x", { baseUrl: BASE, body: "it's fine", contentType: "text/plain" });
  const curl = lib.toCurl(req);
  assert.ok(curl.includes("'it'\\''s fine'"));
});

test("toFetch renders JSON.stringify for the body and omits body for GET", () => {
  const fetch = lib.toFetch(sampleRequest());
  assert.ok(fetch.includes('method: "POST"'));
  assert.ok(fetch.includes("body: JSON.stringify({"));
  assert.ok(fetch.includes("Content-Type"));
  const get = lib.buildRequest(null, "GET", "/pets", { baseUrl: BASE, body: '{"x":1}' });
  assert.ok(!lib.toFetch(get).includes("body:"));
});

test("toNode prepends run instructions", () => {
  const node = lib.toNode(sampleRequest());
  assert.ok(node.startsWith("// Node.js 18+"));
  assert.ok(node.includes("fetch("));
});

test("toPython emits Python literals, not JSON booleans", () => {
  const py = lib.toPython(sampleRequest());
  assert.ok(py.includes("import requests"));
  assert.ok(py.includes("True"));
  assert.ok(py.includes("None"));
  assert.ok(!py.includes("true,"));
  assert.ok(py.includes("requests.post("));
});

test("toPython falls back to data= for non-JSON bodies", () => {
  const req = lib.buildRequest(null, "POST", "/x", { baseUrl: BASE, body: "a=1&b=2", contentType: "application/x-www-form-urlencoded" });
  const py = lib.toPython(req);
  assert.ok(py.includes("data=payload"));
  assert.ok(!py.includes("json=payload"));
});

test("toPython handles invalid JSON bodies without throwing", () => {
  const req = lib.buildRequest(null, "POST", "/x", { baseUrl: BASE, body: "{broken", contentType: "application/json" });
  const py = lib.toPython(req);
  assert.ok(py.includes("data=payload"));
});

test("toHttp renders a raw HTTP/1.1 request with Host and body", () => {
  const http = lib.toHttp(sampleRequest());
  assert.ok(http.startsWith("POST /pets/7?verbose=true HTTP/1.1"));
  assert.ok(http.includes("Host: api.example.com"));
  assert.ok(http.includes("Content-Type: application/json"));
  assert.ok(http.includes("\n\n{"));
});

test("toSnippets returns all five targets", () => {
  const snippets = lib.toSnippets(sampleRequest());
  assert.deepStrictEqual(Object.keys(snippets).sort(), ["curl", "fetch", "http", "node", "python"]);
  Object.values(snippets).forEach((s) => assert.strictEqual(typeof s, "string"));
});

test("toPythonLiteral converts nested JSON to Python source", () => {
  assert.strictEqual(lib.toPythonLiteral(true), "True");
  assert.strictEqual(lib.toPythonLiteral(null), "None");
  assert.strictEqual(lib.toPythonLiteral([1, 2]), "[\n    1,\n    2,\n]");
  assert.strictEqual(lib.toPythonLiteral({ a: 1 }), '{\n    "a": 1,\n}');
});

test("prettyJson reformats valid JSON and passes through invalid input", () => {
  assert.strictEqual(lib.prettyJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.strictEqual(lib.prettyJson("{broken"), "{broken");
  assert.strictEqual(lib.prettyJson(""), "");
});

// ---------------------------------------------------------------------------
// Sample document sanity
// ---------------------------------------------------------------------------

test("the bundled sample spec is valid and self-consistent", () => {
  const r = lib.parseSpec(lib.SAMPLE_SPEC_TEXT);
  assert.strictEqual(r.ok, true);
  const ops = lib.listOperations(r.doc);
  assert.strictEqual(ops.length, 5);
  assert.strictEqual(lib.listServers(r.doc)[0], "https://api.example.com/v1");
});

test("every sample operation builds a request without errors", () => {
  const doc = lib.parseSpec(lib.SAMPLE_SPEC_TEXT).doc;
  const base = lib.listServers(doc)[0];
  lib.listOperations(doc).forEach((op) => {
    const inputs = lib.deriveInputs(doc, op.path, op.pathItem, op.operation);
    const pathParams = {};
    inputs.pathParams.forEach((p) => { pathParams[p.name] = p.value || "1"; });
    const req = lib.buildRequest(doc, op.method, op.path, {
      baseUrl: base,
      pathParams: pathParams,
      query: inputs.query,
      headers: inputs.headers,
      body: inputs.body.text,
      contentType: inputs.body.contentType,
    });
    assert.deepStrictEqual(req.errors, [], op.key + " produced errors");
    assert.ok(req.url.startsWith(base), op.key + " URL should start with the base");
  });
});

// ---------------------------------------------------------------------------
// Security-oriented cases
// ---------------------------------------------------------------------------

test("path parameters cannot inject query separators", () => {
  const req = lib.buildRequest(null, "GET", "/pets/{id}", { baseUrl: BASE, pathParams: { id: "1?admin=1&x" } });
  assert.ok(!req.url.includes("?admin=1"));
  assert.ok(req.url.includes("%3Fadmin%3D1%26x"));
});

test("moving a header's value into the URL is impossible (no body/header leakage into path)", () => {
  const req = lib.buildRequest(null, "GET", "/pets", { baseUrl: BASE, headers: [{ name: "X", value: "y", enabled: true }] });
  assert.strictEqual(req.url, BASE + "/pets");
  assert.strictEqual(req.headers.X, "y");
});

test("resolveRef does not execute or evaluate anything", () => {
  const doc = { a: { b: "process.exit(1)" } };
  assert.strictEqual(lib.resolveRef(doc, "#/a/b"), "process.exit(1)");
});

test("buildRequest never throws on malformed rows", () => {
  const req = lib.buildRequest(null, "GET", "/x", {
    baseUrl: BASE,
    query: [null, undefined, {}, "nope", { name: "", value: "v", enabled: true }],
    headers: [null, {}, { name: "A", value: null, enabled: true }],
  });
  assert.ok(Array.isArray(req.errors));
  assert.strictEqual(req.headers.A, "");
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
