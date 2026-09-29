/* Toolshed — OpenAPI Request Builder
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.openapiRequestBuilder and in Node via require() for tests.
 *
 * The module parses an OpenAPI 3.x (or Swagger 2.0) document, lists its
 * operations, resolves JSON Schema $refs, derives example values, builds a
 * concrete HTTP request, and renders code snippets (curl, fetch, Node,
 * Python, raw HTTP). It never touches the network and never uses eval.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.openapiRequestBuilder = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MAX_DEPTH = 8;
  var HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return value;
    }
  }

  /** Decode a single JSON Pointer segment (~1 -> "/", ~0 -> "~"). */
  function decodePointerSegment(segment) {
    return String(segment).replace(/~1/g, "/").replace(/~0/g, "~");
  }

  /** Human-readable name for a $ref like #/components/schemas/Pet. */
  function refName(ref) {
    if (typeof ref !== "string") return "";
    var parts = ref.split("/");
    return decodePointerSegment(parts[parts.length - 1] || "");
  }

  /**
   * Resolve a local JSON Pointer $ref against a document.
   * Returns undefined when the target cannot be found. Never throws.
   */
  function resolveRef(doc, ref) {
    if (typeof ref !== "string" || ref.charAt(0) !== "#") return undefined;
    var pointer = ref.slice(1);
    if (pointer === "" || pointer === "/") return doc;
    if (pointer.charAt(0) !== "/") return undefined;
    var segments = pointer.slice(1).split("/").map(decodePointerSegment);
    var current = doc;
    for (var i = 0; i < segments.length; i++) {
      if (!isObject(current) && !Array.isArray(current)) return undefined;
      current = current[segments[i]];
      if (current === undefined) return undefined;
    }
    return current;
  }

  // ---------------------------------------------------------------------
  // Parsing and detection
  // ---------------------------------------------------------------------

  /**
   * Parse an OpenAPI/Swagger document.
   * @param {string|object} input JSON text or an already-parsed object.
   * @returns {{ok:boolean, doc?:object, version?:string, flavor?:string, error?:string}}
   */
  function parseSpec(input) {
    var doc = input;
    if (typeof input === "string") {
      var text = input.trim();
      if (text === "") return { ok: false, error: "The document is empty." };
      try {
        doc = JSON.parse(text);
      } catch (err) {
        return { ok: false, error: "That is not valid JSON: " + err.message };
      }
    }
    if (!isObject(doc)) {
      return { ok: false, error: "An OpenAPI document must be a JSON object." };
    }
    if (doc.swagger === "2.0") {
      return { ok: true, doc: doc, version: "2.0", flavor: "swagger" };
    }
    if (typeof doc.openapi === "string") {
      return { ok: true, doc: doc, version: doc.openapi, flavor: "openapi" };
    }
    return {
      ok: false,
      error: 'Missing "openapi" or "swagger" version field — is this an OpenAPI document?',
    };
  }

  // ---------------------------------------------------------------------
  // Servers / base URLs
  // ---------------------------------------------------------------------

  /** Collect the server base URLs declared by the document. */
  function listServers(doc) {
    var raw = [];
    if (Array.isArray(doc.servers) && doc.servers.length) {
      raw = doc.servers.map(function (s) { return isObject(s) ? s.url : s; });
    } else if (isObject(doc.servers)) {
      raw = [doc.servers.url];
    } else if (doc.swagger === "2.0") {
      if (doc.host) {
        var scheme = (doc.schemes && doc.schemes[0]) || "https";
        raw = [scheme + "://" + doc.host + (doc.basePath || "")];
      } else if (doc.basePath) {
        raw = [doc.basePath];
      }
    }
    var seen = {};
    var out = [];
    raw.forEach(function (url) {
      if (typeof url !== "string" || url.trim() === "") return;
      var trimmed = url.trim().replace(/\/+$/, "");
      if (seen[trimmed]) return;
      seen[trimmed] = true;
      out.push(trimmed);
    });
    return out;
  }

  // ---------------------------------------------------------------------
  // Operation inventory
  // ---------------------------------------------------------------------

  /** List every operation in the document, in document order. */
  function listOperations(doc) {
    var paths = isObject(doc && doc.paths) ? doc.paths : {};
    var out = [];
    Object.keys(paths).forEach(function (path) {
      var item = paths[path];
      if (!isObject(item)) return;
      HTTP_METHODS.forEach(function (method) {
        var op = item[method];
        if (!isObject(op)) return;
        var tags = Array.isArray(op.tags) ? op.tags.filter(function (t) { return typeof t === "string"; }) : [];
        out.push({
          key: method.toUpperCase() + " " + path,
          method: method.toUpperCase(),
          path: path,
          operationId: typeof op.operationId === "string" ? op.operationId : "",
          summary: typeof op.summary === "string" ? op.summary : "",
          description: typeof op.description === "string" ? op.description : "",
          tags: tags,
          deprecated: op.deprecated === true,
          operation: op,
          pathItem: item,
        });
      });
    });
    return out;
  }

  function findOperation(doc, method, path) {
    var ops = listOperations(doc);
    var wantedMethod = String(method || "").toUpperCase();
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].path === path && ops[i].method === wantedMethod) return ops[i];
    }
    return null;
  }

  function operationMatches(op, query) {
    if (!query) return true;
    var q = query.toLowerCase();
    return op.method.toLowerCase().indexOf(q) !== -1 ||
      op.path.toLowerCase().indexOf(q) !== -1 ||
      op.summary.toLowerCase().indexOf(q) !== -1 ||
      op.operationId.toLowerCase().indexOf(q) !== -1 ||
      op.tags.some(function (t) { return t.toLowerCase().indexOf(q) !== -1; });
  }

  /** Filter operations by a free-text query and/or an exact tag. */
  function searchOperations(doc, query, tag) {
    return listOperations(doc).filter(function (op) {
      if (tag && tag !== "All" && op.tags.indexOf(tag) === -1) return false;
      return operationMatches(op, query);
    });
  }

  /** Distinct tag names, sorted. Operations without tags are ignored. */
  function listTags(doc) {
    var seen = {};
    listOperations(doc).forEach(function (op) {
      op.tags.forEach(function (t) { seen[t] = true; });
    });
    return Object.keys(seen).sort();
  }

  // ---------------------------------------------------------------------
  // Schemas
  // ---------------------------------------------------------------------

  /**
   * Follow a $ref chain at the top level of a schema, guarding against
   * cycles. Returns the target schema, or null when it cannot be resolved.
   */
  function derefSchema(doc, schema, seenRefs) {
    var current = schema;
    var seen = seenRefs || [];
    var guard = 0;
    while (isObject(current) && typeof current.$ref === "string" && guard < 32) {
      if (seen.indexOf(current.$ref) !== -1) return null;
      var target = resolveRef(doc, current.$ref);
      if (!isObject(target)) return null;
      seen = seen.concat([current.$ref]);
      current = target;
      guard++;
    }
    return current || null;
  }

  /** Merge allOf branches (recursively, following refs) into one schema. */
  function mergeAllOf(doc, schema, seenRefs) {
    var merged = {};
    var props = {};
    var required = [];
    var seen = seenRefs || [];

    function absorb(branch, depth) {
      if (depth > 16 || !isObject(branch)) return;
      var resolved = derefSchema(doc, branch, seen);
      if (!isObject(resolved)) return;
      if (Array.isArray(resolved.allOf)) {
        resolved.allOf.forEach(function (b) { absorb(b, depth + 1); });
      }
      Object.keys(resolved).forEach(function (key) {
        if (key === "allOf") return;
        if (key === "properties") {
          Object.keys(resolved.properties).forEach(function (p) {
            props[p] = resolved.properties[p];
          });
        } else if (key === "required") {
          (Array.isArray(resolved.required) ? resolved.required : []).forEach(function (r) {
            if (typeof r === "string" && required.indexOf(r) === -1) required.push(r);
          });
        } else {
          merged[key] = resolved[key];
        }
      });
    }

    absorb(schema, 0);
    if (Object.keys(props).length) merged.properties = props;
    if (required.length) merged.required = required;
    return merged;
  }

  function schemaType(schema) {
    if (!isObject(schema)) return "";
    if (schema.type) return schema.type;
    if (schema.properties || schema.additionalProperties) return "object";
    if (schema.items) return "array";
    if (Array.isArray(schema.enum) && schema.enum.length) return typeof schema.enum[0];
    return "";
  }

  /**
   * Produce an example value for a schema.
   * @param {object} doc Parsed document, used to resolve $refs.
   * @param {object} schema JSON Schema.
   * @param {object} [options] { useExamples, depth, seenRefs }
   */
  function exampleFromSchema(doc, schema, options) {
    var opts = options || {};
    var useExamples = opts.useExamples !== false;
    var depth = opts.depth || 0;
    var seenRefs = opts.seenRefs || [];

    if (depth > MAX_DEPTH) return null;

    var resolved = derefSchema(doc, schema, seenRefs);
    if (!isObject(resolved)) return null;

    if (Array.isArray(resolved.allOf)) {
      resolved = mergeAllOf(doc, resolved, seenRefs);
    }
    if (Array.isArray(resolved.oneOf) && resolved.oneOf.length) {
      return exampleFromSchema(doc, resolved.oneOf[0], { useExamples: useExamples, depth: depth + 1, seenRefs: seenRefs });
    }
    if (Array.isArray(resolved.anyOf) && resolved.anyOf.length) {
      return exampleFromSchema(doc, resolved.anyOf[0], { useExamples: useExamples, depth: depth + 1, seenRefs: seenRefs });
    }

    if (useExamples && resolved.example !== undefined) return clone(resolved.example);
    if (resolved.default !== undefined) return clone(resolved.default);
    if (Array.isArray(resolved.enum) && resolved.enum.length) return clone(resolved.enum[0]);
    if (Array.isArray(resolved.examples) && resolved.examples.length) return clone(resolved.examples[0]);

    var type = schemaType(resolved);
    var childOptions = { useExamples: useExamples, depth: depth + 1, seenRefs: seenRefs };

    if (type === "object" || isObject(resolved.properties)) {
      var out = {};
      var props = isObject(resolved.properties) ? resolved.properties : {};
      Object.keys(props).forEach(function (name) {
        out[name] = exampleFromSchema(doc, props[name], childOptions);
      });
      if (!Object.keys(props).length && isObject(resolved.additionalProperties)) {
        out.key = exampleFromSchema(doc, resolved.additionalProperties, childOptions);
      }
      return out;
    }
    if (type === "array") {
      if (resolved.items) return [exampleFromSchema(doc, resolved.items, childOptions)];
      return [];
    }
    if (type === "string") {
      var format = resolved.format;
      if (format === "date-time") return "2024-01-01T00:00:00Z";
      if (format === "date") return "2024-01-01";
      if (format === "email") return "user@example.com";
      if (format === "uri" || format === "url") return "https://example.com";
      if (format === "uuid") return "00000000-0000-4000-8000-000000000000";
      if (format === "byte") return "c3RyaW5n";
      return "";
    }
    if (type === "integer" || type === "number") {
      return isFinite(resolved.minimum) ? resolved.minimum : 0;
    }
    if (type === "boolean") return false;
    if (type === "null") return null;
    return null;
  }

  /** String representation of a schema's example, for text inputs. */
  function exampleToString(doc, schema, useExamples) {
    var value = exampleFromSchema(doc, schema, { useExamples: useExamples !== false });
    if (value === null || value === undefined) return "";
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch (e) {
        return "";
      }
    }
    return String(value);
  }

  // ---------------------------------------------------------------------
  // Parameters
  // ---------------------------------------------------------------------

  /**
   * Collect a deduplicated parameter list from a path item and an operation.
   * Path-item parameters provide defaults; operation-level ones override.
   */
  function collectParameters(doc, pathItem, operation) {
    var out = [];
    var index = {};

    function push(list) {
      (Array.isArray(list) ? list : []).forEach(function (raw) {
        var param = derefSchema(doc, raw, []);
        if (!isObject(param) || typeof param.name !== "string" || typeof param.in !== "string") return;
        var key = param.in + ":" + param.name;
        if (index[key] !== undefined) out[index[key]] = param;
        else {
          index[key] = out.length;
          out.push(param);
        }
      });
    }

    push(pathItem && pathItem.parameters);
    push(operation && operation.parameters);
    return out;
  }

  /** Group collected parameters by their location. */
  function parametersByLocation(doc, pathItem, operation) {
    var grouped = { path: [], query: [], header: [], cookie: [] };
    collectParameters(doc, pathItem, operation).forEach(function (param) {
      if (grouped[param.in]) grouped[param.in].push(param);
    });
    return grouped;
  }

  /** Extract the {placeholder} names embedded in a path template. */
  function pathTemplateNames(path) {
    var names = [];
    var re = /\{([^}]+)\}/g;
    var match;
    while ((match = re.exec(String(path || ""))) !== null) {
      if (names.indexOf(match[1]) === -1) names.push(match[1]);
    }
    return names;
  }

  /** Build a parameter descriptor suitable for rendering an input row. */
  function describeParameter(param) {
    return {
      name: param.name,
      in: param.in,
      required: param.required === true || param.in === "path",
      description: typeof param.description === "string" ? param.description : "",
      deprecated: param.deprecated === true,
      schema: param.schema || (param.type ? param : null),
    };
  }

  // ---------------------------------------------------------------------
  // Request bodies
  // ---------------------------------------------------------------------

  function pickMediaType(mediaTypes) {
    var preferred = ["application/json", "application/*+json"];
    for (var i = 0; i < preferred.length; i++) {
      if (mediaTypes.indexOf(preferred[i]) !== -1) return preferred[i];
    }
    for (var j = 0; j < mediaTypes.length; j++) {
      if (/json/i.test(mediaTypes[j])) return mediaTypes[j];
    }
    return mediaTypes[0];
  }

  function omitKeys(obj, keys) {
    var out = {};
    Object.keys(obj).forEach(function (k) {
      if (keys.indexOf(k) === -1) out[k] = obj[k];
    });
    return out;
  }

  /**
   * Describe the request body shape for an operation.
   * Supports OpenAPI 3 `requestBody` and Swagger 2 `body`/`formData`.
   */
  function requestBodySchema(doc, operation) {
    if (!isObject(operation)) return null;

    if (isObject(operation.requestBody)) {
      var body = derefSchema(doc, operation.requestBody, []) || operation.requestBody;
      var content = isObject(body.content) ? body.content : {};
      var mediaTypes = Object.keys(content);
      if (!mediaTypes.length) return null;
      var preferred = pickMediaType(mediaTypes);
      var mediaObject = content[preferred];
      // OpenAPI 3 media type objects wrap the schema in a `schema` key.
      var mediaSchema = isObject(mediaObject) && mediaObject.schema !== undefined
        ? mediaObject.schema
        : mediaObject;
      return {
        required: body.required === true,
        mediaTypes: mediaTypes,
        mediaType: preferred,
        schema: mediaSchema,
      };
    }

    var params = Array.isArray(operation.parameters) ? operation.parameters : [];
    var formData = params.filter(function (p) {
      return isObject(p) && p.in === "formData";
    });
    if (formData.length) {
      var props = {};
      formData.forEach(function (p) {
        props[p.name] = p.schema || omitKeys(p, ["name", "in", "required", "description", "collectionFormat"]);
      });
      return {
        required: true,
        mediaTypes: ["application/x-www-form-urlencoded"],
        mediaType: "application/x-www-form-urlencoded",
        schema: { type: "object", properties: props },
      };
    }

    var bodyParam = params.filter(function (p) { return isObject(p) && p.in === "body"; })[0];
    if (bodyParam) {
      return {
        required: bodyParam.required === true,
        mediaTypes: ["application/json"],
        mediaType: "application/json",
        schema: bodyParam.schema,
      };
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Derived editable inputs (used by the UI and by tests)
  // ---------------------------------------------------------------------

  /**
   * Derive the initial editable request state for an operation.
   *
   * @param {object} doc
   * @param {string} path Path template (used to discover path parameters).
   * @param {object} pathItem
   * @param {object} operation
   * @param {object} [options] { useExamples }
   * @returns {{
   *   pathParams: Array, query: Array, headers: Array, cookies: Array,
   *   body: {contentType, text, mediaTypes, required, hasSchema}
   * }}
   */
  function deriveInputs(doc, path, pathItem, operation, options) {
    var opts = options || {};
    var useExamples = opts.useExamples !== false;
    var grouped = parametersByLocation(doc, pathItem, operation);

    var pathParams = pathTemplateNames(path).map(function (name) {
      return { name: name, value: "", required: true, description: "" };
    });

    grouped.path.forEach(function (param) {
      var existing = null;
      for (var i = 0; i < pathParams.length; i++) {
        if (pathParams[i].name === param.name) existing = pathParams[i];
      }
      var value = exampleToString(doc, param.schema, useExamples);
      if (existing) {
        existing.description = param.description || "";
        existing.value = value;
      } else {
        pathParams.push({ name: param.name, value: value, required: true, description: param.description || "" });
      }
    });

    function row(param) {
      return {
        name: param.name,
        value: exampleToString(doc, param.schema, useExamples),
        required: param.required === true,
        enabled: param.required === true,
        description: param.description || "",
      };
    }

    var bodyInfo = requestBodySchema(doc, operation);
    var body = { contentType: "", text: "", mediaTypes: [], required: false, hasSchema: false };
    if (bodyInfo) {
      body.mediaTypes = bodyInfo.mediaTypes.slice();
      body.contentType = bodyInfo.mediaType;
      body.required = bodyInfo.required;
      body.hasSchema = !!bodyInfo.schema;
      var example = exampleFromSchema(doc, bodyInfo.schema, { useExamples: useExamples });
      if (example !== null && example !== undefined) {
        if (typeof example === "object") {
          body.text = JSON.stringify(example, null, 2);
        } else {
          body.text = String(example);
        }
      }
    }

    return {
      pathParams: pathParams,
      query: grouped.query.map(row),
      headers: grouped.header.map(row),
      cookies: grouped.cookie.map(row),
      body: body,
    };
  }

  // ---------------------------------------------------------------------
  // Request building
  // ---------------------------------------------------------------------

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function trimSlashes(url) {
    return String(url || "").replace(/\/+$/, "");
  }

  /**
   * Build a concrete request from an operation and user-supplied values.
   *
   * @param {object} doc Parsed document (kept for signature symmetry).
   * @param {string} method HTTP method.
   * @param {string} path Path template.
   * @param {object} input
   *   baseUrl      — chosen server base URL
   *   pathParams   — { name: value }
   *   query        — [{ name, value, enabled }]
   *   headers      — [{ name, value, enabled }]
   *   body         — serialized body string or null
   *   contentType  — media type used when the body has no explicit header
   * @returns {{method,path,queryString,url,headers,body,contentType,errors,warnings}}
   */
  function buildRequest(doc, method, path, input) {
    var opts = input || {};
    var errors = [];
    var warnings = [];
    var requestPath = String(path || "");

    var pathParams = opts.pathParams || {};
    pathTemplateNames(requestPath).forEach(function (name) {
      var value = pathParams[name];
      if (value === undefined || value === null || String(value) === "") {
        errors.push('Path parameter "' + name + '" is required.');
        value = "{" + name + "}";
      }
      requestPath = requestPath.replace(
        new RegExp("\\{" + escapeRegExp(name) + "\\}", "g"),
        encodeURIComponent(String(value))
      );
    });

    var baseUrl = trimSlashes(opts.baseUrl || "");
    var fullPath = requestPath.charAt(0) === "/" ? requestPath : "/" + requestPath;
    var url = baseUrl + fullPath;

    var queryParts = [];
    (opts.query || []).forEach(function (row) {
      if (!row || row.enabled === false || !row.name) return;
      var value = row.value === undefined || row.value === null ? "" : String(row.value);
      if (value === "") warnings.push('Query parameter "' + row.name + '" has no value.');
      queryParts.push(encodeURIComponent(row.name) + "=" + encodeURIComponent(value));
    });
    var queryString = queryParts.join("&");
    if (queryString) url += (url.indexOf("?") === -1 ? "?" : "&") + queryString;

    var headers = {};
    var hasContentType = false;
    (opts.headers || []).forEach(function (row) {
      if (!row || row.enabled === false || !row.name) return;
      if (/^content-type$/i.test(row.name)) hasContentType = true;
      headers[row.name] = row.value === undefined || row.value === null ? "" : String(row.value);
    });

    var body = opts.body === undefined || opts.body === null ? null : String(opts.body);
    var contentType = opts.contentType || "";
    if (body !== null && body !== "" && !hasContentType && contentType) {
      headers["Content-Type"] = contentType;
    }

    return {
      method: String(method || "GET").toUpperCase(),
      path: fullPath,
      queryString: queryString,
      url: url,
      headers: headers,
      body: body,
      contentType: contentType,
      errors: errors,
      warnings: warnings,
    };
  }

  // ---------------------------------------------------------------------
  // Code snippets
  // ---------------------------------------------------------------------

  function headerPairs(request) {
    return Object.keys(request.headers).map(function (name) {
      return { name: name, value: request.headers[name] };
    });
  }

  function hasExplicitContentType(request) {
    return Object.keys(request.headers).some(function (n) { return /^content-type$/i.test(n); });
  }

  function hasBody(request) {
    return request.body !== null && request.body !== undefined && request.body !== "" &&
      request.method !== "GET" && request.method !== "HEAD";
  }

  function shouldSendContentType(request) {
    return hasBody(request) && !hasExplicitContentType(request) && !!request.contentType;
  }

  function looksJson(text) {
    if (typeof text !== "string") return false;
    var trimmed = text.trim();
    return (trimmed.charAt(0) === "{" && trimmed.charAt(trimmed.length - 1) === "}") ||
      (trimmed.charAt(0) === "[" && trimmed.charAt(trimmed.length - 1) === "]");
  }

  function isJsonish(request) {
    return /json/i.test(request.contentType || "") || looksJson(request.body);
  }

  function prettyJson(text) {
    if (typeof text !== "string" || text.trim() === "") return text;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
      return text;
    }
  }

  function shellQuote(text) {
    return "'" + String(text).replace(/'/g, "'\\''") + "'";
  }

  function toCurl(request) {
    var lines = ["curl -X " + request.method + " " + shellQuote(request.url)];
    headerPairs(request).forEach(function (h) {
      lines.push("  -H " + shellQuote(h.name + ": " + h.value));
    });
    if (hasBody(request)) lines.push("  -d " + shellQuote(request.body));
    return lines.join(" \\\n");
  }

  function hostOf(url) {
    var match = String(url).match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    return match ? match[1] : "";
  }

  function toHttp(request) {
    var target = request.path + (request.queryString ? "?" + request.queryString : "");
    var lines = [request.method + " " + target + " HTTP/1.1"];
    var host = hostOf(request.url);
    if (host) lines.push("Host: " + host);
    headerPairs(request).forEach(function (h) { lines.push(h.name + ": " + h.value); });
    if (shouldSendContentType(request)) lines.push("Content-Type: " + request.contentType);
    if (hasBody(request)) lines.push("", request.body);
    return lines.join("\n");
  }

  /** Shared body for the fetch and Node snippets. */
  function fetchSnippet(request, prefixLines) {
    var lines = (prefixLines || []).slice();
    lines.push("const res = await fetch(" + JSON.stringify(request.url) + ", {");
    lines.push("  method: " + JSON.stringify(request.method) + ",");
    var pairs = headerPairs(request);
    if (pairs.length || shouldSendContentType(request)) {
      lines.push("  headers: {");
      pairs.forEach(function (h) {
        lines.push("    " + JSON.stringify(h.name) + ": " + JSON.stringify(h.value) + ",");
      });
      if (shouldSendContentType(request)) {
        lines.push("    \"Content-Type\": " + JSON.stringify(request.contentType) + ",");
      }
      lines.push("  },");
    }
    if (hasBody(request)) {
      if (isJsonish(request)) {
        lines.push("  body: JSON.stringify(" + prettyJson(request.body) + "),");
      } else {
        lines.push("  body: " + JSON.stringify(request.body) + ",");
      }
    }
    lines.push("});");
    lines.push("");
    lines.push("const data = await res.json();");
    lines.push("console.log(data);");
    return lines.join("\n");
  }

  function toFetch(request) {
    return fetchSnippet(request, []);
  }

  function toNode(request) {
    return fetchSnippet(request, [
      "// Node.js 18+ exposes a global fetch.",
      "// Save as request.mjs and run: node request.mjs",
      "",
    ]);
  }

  /** Convert a JSON value into Python literal source. */
  function toPythonLiteral(value, indentLevel) {
    var level = indentLevel || 0;
    var pad = new Array(level + 1).join("    ");
    var childPad = new Array(level + 2).join("    ");
    if (value === null) return "None";
    if (value === true) return "True";
    if (value === false) return "False";
    if (typeof value === "number") return isFinite(value) ? String(value) : "None";
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) {
      if (!value.length) return "[]";
      return "[\n" + value.map(function (v) {
        return childPad + toPythonLiteral(v, level + 1) + ",";
      }).join("\n") + "\n" + pad + "]";
    }
    if (isObject(value)) {
      var keys = Object.keys(value);
      if (!keys.length) return "{}";
      return "{\n" + keys.map(function (k) {
        return childPad + JSON.stringify(k) + ": " + toPythonLiteral(value[k], level + 1) + ",";
      }).join("\n") + "\n" + pad + "}";
    }
    return "None";
  }

  function toPython(request) {
    var lines = ["import requests", ""];
    lines.push("url = " + JSON.stringify(request.url));
    var pairs = headerPairs(request);
    if (pairs.length || shouldSendContentType(request)) {
      lines.push("headers = {");
      pairs.forEach(function (h) {
        lines.push("    " + JSON.stringify(h.name) + ": " + JSON.stringify(h.value) + ",");
      });
      if (shouldSendContentType(request)) {
        lines.push("    \"Content-Type\": " + JSON.stringify(request.contentType) + ",");
      }
      lines.push("}");
    } else {
      lines.push("headers = {}");
    }
    var kwargs = ["headers=headers"];
    if (hasBody(request)) {
      if (isJsonish(request)) {
        var parsed = null;
        var valid = true;
        try {
          parsed = JSON.parse(request.body);
        } catch (e) {
          valid = false;
        }
        if (valid) {
          lines.push("payload = " + toPythonLiteral(parsed, 0));
          kwargs.push("json=payload");
        } else {
          lines.push("payload = " + JSON.stringify(request.body));
          kwargs.push("data=payload");
        }
      } else {
        lines.push("payload = " + JSON.stringify(request.body));
        kwargs.push("data=payload");
      }
    }
    lines.push("");
    lines.push("response = requests." + request.method.toLowerCase() + "(url, " + kwargs.join(", ") + ")");
    lines.push("print(response.status_code)");
    lines.push("print(response.json())");
    return lines.join("\n");
  }

  function toSnippets(request) {
    return {
      curl: toCurl(request),
      fetch: toFetch(request),
      node: toNode(request),
      python: toPython(request),
      http: toHttp(request),
    };
  }

  // ---------------------------------------------------------------------
  // Sample document
  // ---------------------------------------------------------------------

  var SAMPLE_SPEC = {
    openapi: "3.0.3",
    info: {
      title: "Toolshed Store API",
      version: "1.0.0",
      description: "A tiny sample API used to explore the request builder.",
    },
    servers: [{ url: "https://api.example.com/v1" }],
    tags: [{ name: "pets" }, { name: "store" }],
    paths: {
      "/pets": {
        get: {
          tags: ["pets"],
          operationId: "listPets",
          summary: "List pets",
          parameters: [
            { name: "limit", in: "query", description: "How many items to return.", schema: { type: "integer", format: "int32" } },
            { name: "status", in: "query", schema: { type: "string", enum: ["available", "pending", "sold"] } },
            { name: "X-Request-Id", in: "header", schema: { type: "string", format: "uuid" } },
          ],
          responses: { "200": { description: "A paged array of pets" } },
        },
        post: {
          tags: ["pets"],
          operationId: "createPet",
          summary: "Create a pet",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
          responses: { "201": { description: "Created" } },
        },
      },
      "/pets/{petId}": {
        get: {
          tags: ["pets"],
          operationId: "getPet",
          summary: "Get a pet by id",
          parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "A pet" } },
        },
        delete: {
          tags: ["pets"],
          operationId: "deletePet",
          summary: "Delete a pet",
          parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "Deleted" } },
        },
      },
      "/store/search": {
        post: {
          tags: ["store"],
          operationId: "searchStore",
          summary: "Search the store",
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/SearchQuery" } } },
          },
          responses: { "200": { description: "Results" } },
        },
      },
    },
    components: {
      schemas: {
        Pet: {
          type: "object",
          required: ["name"],
          properties: {
            id: { type: "integer", format: "int64" },
            name: { type: "string", example: "Rex" },
            tag: { type: "string" },
            status: { type: "string", enum: ["available", "pending", "sold"] },
            photoUrls: { type: "array", items: { type: "string", format: "uri" } },
          },
        },
        SearchQuery: {
          type: "object",
          properties: {
            text: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            page: { type: "integer", default: 1 },
            maxPrice: { type: "number" },
          },
        },
      },
    },
  };

  var SAMPLE_SPEC_TEXT = JSON.stringify(SAMPLE_SPEC, null, 2);

  return {
    parseSpec: parseSpec,
    listServers: listServers,
    listOperations: listOperations,
    findOperation: findOperation,
    searchOperations: searchOperations,
    listTags: listTags,
    resolveRef: resolveRef,
    refName: refName,
    derefSchema: derefSchema,
    mergeAllOf: mergeAllOf,
    schemaType: schemaType,
    exampleFromSchema: exampleFromSchema,
    exampleToString: exampleToString,
    collectParameters: collectParameters,
    parametersByLocation: parametersByLocation,
    pathTemplateNames: pathTemplateNames,
    describeParameter: describeParameter,
    requestBodySchema: requestBodySchema,
    pickMediaType: pickMediaType,
    deriveInputs: deriveInputs,
    buildRequest: buildRequest,
    toCurl: toCurl,
    toFetch: toFetch,
    toNode: toNode,
    toPython: toPython,
    toHttp: toHttp,
    toSnippets: toSnippets,
    toPythonLiteral: toPythonLiteral,
    prettyJson: prettyJson,
    SAMPLE_SPEC: SAMPLE_SPEC,
    SAMPLE_SPEC_TEXT: SAMPLE_SPEC_TEXT,
    HTTP_METHODS: HTTP_METHODS,
  };
});
