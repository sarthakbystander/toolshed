/* Toolshed — Webhook Signature Lab
 * Core logic, dependency-free (Web Crypto only). Loads in the browser as
 * window.Toolshed.webhookSignatureLab and in Node via require() for tests.
 *
 * The module builds the exact base string a provider signs, computes the
 * HMAC, formats the signature header, and verifies a received header value.
 * Everything happens in memory: no network, no eval, no storage.
 *
 * Cryptography uses the standard Web Crypto API (crypto.subtle), available in
 * every modern browser and in Node 18+. Secrets are never transmitted or
 * persisted by this module.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.webhookSignatureLab = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // -------------------------------------------------------------------
  // Algorithms
  // -------------------------------------------------------------------

  var ALGORITHMS = {
    "sha1": { label: "SHA-1", hash: "SHA-1", bytes: 20 },
    "sha256": { label: "SHA-256", hash: "SHA-256", bytes: 32 },
    "sha384": { label: "SHA-384", hash: "SHA-384", bytes: 48 },
    "sha512": { label: "SHA-512", hash: "SHA-512", bytes: 64 }
  };

  function isAlgorithm(id) {
    return Object.prototype.hasOwnProperty.call(ALGORITHMS, id);
  }

  function listAlgorithms() {
    return Object.keys(ALGORITHMS).map(function (id) {
      return { id: id, label: ALGORITHMS[id].label };
    });
  }

  // -------------------------------------------------------------------
  // Byte / text encoding helpers
  // -------------------------------------------------------------------

  function textToBytes(str) {
    return new TextEncoder().encode(String(str == null ? "" : str));
  }

  function bytesToText(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function bytesToHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      out += (bytes[i] >>> 4).toString(16) + (bytes[i] & 15).toString(16);
    }
    return out;
  }

  /**
   * Parse a hex string into bytes. Whitespace is ignored; an odd length or a
   * non-hex character returns null.
   * @param {string} hex
   * @returns {Uint8Array|null}
   */
  function hexToBytes(hex) {
    var s = String(hex == null ? "" : hex).replace(/\s+/g, "");
    if (s.length === 0 || s.length % 2 !== 0) return null;
    if (!/^[0-9a-fA-F]+$/.test(s)) return null;
    var out = new Uint8Array(s.length / 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = parseInt(s.substr(i * 2, 2), 16);
    }
    return out;
  }

  function bytesToBase64(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    if (typeof btoa === "function") return btoa(binary);
    return Buffer.from(bytes).toString("base64");
  }

  /**
   * Decode standard or URL-safe base64 into bytes. Returns null when invalid.
   * @param {string} str
   * @returns {Uint8Array|null}
   */
  function base64ToBytes(str) {
    var s = String(str == null ? "" : str).trim().replace(/\s+/g, "");
    if (!s) return null;
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    var pad = s.length % 4;
    if (pad === 1) return null;
    if (pad) s += "====".slice(0, 4 - pad);
    try {
      if (typeof atob === "function") {
        var binary = atob(s);
        var out = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
      }
      return new Uint8Array(Buffer.from(s, "base64"));
    } catch (err) {
      return null;
    }
  }

  function encodeBytes(bytes, encoding) {
    return encoding === "base64" ? bytesToBase64(bytes) : bytesToHex(bytes);
  }

  function isEncoding(id) {
    return id === "hex" || id === "base64";
  }

  // -------------------------------------------------------------------
  // Providers
  // -------------------------------------------------------------------
  //
  // Each provider describes:
  //   signatureHeader      the HTTP header carrying the signature
  //   scheme               how to read candidate signatures out of that header
  //   signaturePrefixes    prefixes stripped before comparison (github, slack)
  //   headerFields         key names kept when the header is a key=value list
  //   algorithm/encoding   defaults, and whether the user may override them
  //   timestampHeader      where the signed timestamp comes from, if any
  //   parts                the ordered recipe for the signed base string
  //   notes / docs         human guidance shown in the UI

  var PROVIDERS = [
    {
      id: "github",
      name: "GitHub",
      tagline: "Webhook deliveries from GitHub and GitHub Enterprise.",
      signatureHeader: "X-Hub-Signature-256",
      scheme: "prefix",
      signaturePrefixes: ["sha256="],
      algorithm: "sha256",
      algorithmLocked: true,
      encoding: "hex",
      encodingLocked: true,
      timestampHeader: "",
      timestampRequired: false,
      parts: [{ source: "body" }],
      headerFormat: "sha256=<hex digest>",
      notes: [
        "GitHub signs the raw request body only — no timestamp is part of the signature.",
        "The legacy X-Hub-Signature header uses sha1=<hex>; modern deliveries use X-Hub-Signature-256."
      ],
      docs: "https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries"
    },
    {
      id: "stripe",
      name: "Stripe",
      tagline: "Stripe webhook endpoints (v1 scheme).",
      signatureHeader: "Stripe-Signature",
      scheme: "keyvalue",
      headerFields: ["v1", "v0"],
      signaturePrefixes: [],
      algorithm: "sha256",
      algorithmLocked: true,
      encoding: "hex",
      encodingLocked: true,
      timestampHeader: "t (inside Stripe-Signature)",
      timestampRequired: true,
      parts: [
        { source: "timestamp" },
        { literal: "." },
        { source: "body" }
      ],
      headerFormat: "t=<unix seconds>,v1=<hex digest>",
      notes: [
        "The signed payload is \"<timestamp>.<raw body>\"; the timestamp lives in the same header as t=.",
        "Stripe may send several v1= values during secret rotation — any match is valid.",
        "Reject events whose timestamp is too far from now to defend against replay."
      ],
      docs: "https://docs.stripe.com/webhooks#verify-manually"
    },
    {
      id: "slack",
      name: "Slack",
      tagline: "Slack Events API and interactive component requests.",
      signatureHeader: "X-Slack-Signature",
      scheme: "prefix",
      signaturePrefixes: ["v0="],
      algorithm: "sha256",
      algorithmLocked: true,
      encoding: "hex",
      encodingLocked: true,
      timestampHeader: "X-Slack-Request-Timestamp",
      timestampRequired: true,
      parts: [
        { literal: "v0" },
        { literal: ":" },
        { source: "timestamp" },
        { literal: ":" },
        { source: "body" }
      ],
      headerFormat: "v0=<hex digest>",
      notes: [
        "The base string is \"v0:<request timestamp>:<raw body>\".",
        "Slack recommends rejecting requests whose timestamp is more than five minutes old."
      ],
      docs: "https://api.slack.com/authentication/verifying-requests-from-slack"
    },
    {
      id: "shopify",
      name: "Shopify",
      tagline: "Shopify webhook deliveries (HMAC-SHA256, base64).",
      signatureHeader: "X-Shopify-Hmac-Sha256",
      scheme: "plain",
      signaturePrefixes: [],
      algorithm: "sha256",
      algorithmLocked: true,
      encoding: "base64",
      encodingLocked: true,
      timestampHeader: "",
      timestampRequired: false,
      parts: [{ source: "body" }],
      headerFormat: "<base64 digest>",
      notes: [
        "Shopify signs the raw request body and sends the digest base64-encoded.",
        "Compare the digest with a constant-time comparison in your handler."
      ],
      docs: "https://shopify.dev/docs/apps/build/webhooks/subscribe/https#step-5-verify-the-webhook"
    },
    {
      id: "standard-webhooks",
      name: "Standard Webhooks",
      tagline: "The Standard Webhooks spec (Svix, Resend, and others).",
      signatureHeader: "webhook-signature",
      scheme: "spacekeyvalue",
      headerFields: ["v1"],
      signaturePrefixes: [],
      algorithm: "sha256",
      algorithmLocked: true,
      encoding: "base64",
      encodingLocked: true,
      timestampHeader: "webhook-timestamp",
      timestampRequired: true,
      extraHeaders: ["webhook-id"],
      parts: [
        { source: "header", name: "webhook-id" },
        { literal: "." },
        { source: "timestamp" },
        { literal: "." },
        { source: "body" }
      ],
      headerFormat: "v1,<base64 digest> (space-separated list)",
      notes: [
        "The base string is \"<webhook-id>.<webhook-timestamp>.<raw body>\".",
        "Secrets are prefixed whsec_ and the raw secret is base64-decoded before use; paste either the decoded key or the full whsec_ value and the tool decodes it.",
        "The header may carry several space-separated v1,<signature> values — any match is valid."
      ],
      docs: "https://www.standardwebhooks.com/"
    },
    {
      id: "custom",
      name: "Custom HMAC",
      tagline: "Any service that HMACs the raw body with a header you choose.",
      signatureHeader: "X-Signature",
      scheme: "plain",
      signaturePrefixes: [],
      algorithm: "sha256",
      algorithmLocked: false,
      encoding: "hex",
      encodingLocked: false,
      timestampHeader: "",
      timestampRequired: false,
      parts: [{ source: "body" }],
      headerFormat: "<digest>",
      notes: [
        "Use this for services with a plain HMAC-over-body scheme: pick the hash, the encoding and the header name.",
        "If the service prepends a scheme prefix (like sha256=), include it in the header value when verifying."
      ],
      docs: ""
    }
  ];

  function getProvider(id) {
    for (var i = 0; i < PROVIDERS.length; i++) {
      if (PROVIDERS[i].id === id) return PROVIDERS[i];
    }
    return null;
  }

  function listProviders() {
    return PROVIDERS.map(function (p) {
      return {
        id: p.id,
        name: p.name,
        tagline: p.tagline,
        signatureHeader: p.signatureHeader,
        scheme: p.scheme,
        signaturePrefixes: (p.signaturePrefixes || []).slice(),
        headerFields: p.headerFields ? p.headerFields.slice() : undefined,
        algorithm: p.algorithm,
        algorithmLocked: !!p.algorithmLocked,
        encoding: p.encoding,
        encodingLocked: !!p.encodingLocked,
        timestampHeader: p.timestampHeader,
        timestampRequired: !!p.timestampRequired,
        extraHeaders: (p.extraHeaders || []).slice(),
        headerFormat: p.headerFormat,
        notes: p.notes.slice(),
        docs: p.docs,
        parts: p.parts.map(function (part) { return Object.assign({}, part); })
      };
    });
  }

  // -------------------------------------------------------------------
  // Building the signed payload
  // -------------------------------------------------------------------

  /**
   * Assemble the exact base string a provider signs.
   * @param {object} provider
   * @param {{body?:string,timestamp?:string,headers?:object}} values
   * @returns {{ok:boolean, payload?:string, error?:string, missing?:string[]}}
   */
  function buildSignedPayload(provider, values) {
    if (!provider) return { ok: false, error: "Unknown provider." };
    var v = values || {};
    var body = v.body == null ? "" : String(v.body);
    var timestamp = v.timestamp == null ? "" : String(v.timestamp);
    var headers = v.headers || {};
    var missing = [];
    var payload = "";

    for (var i = 0; i < provider.parts.length; i++) {
      var part = provider.parts[i];
      if (typeof part.literal === "string") {
        payload += part.literal;
      } else if (part.source === "body") {
        payload += body;
      } else if (part.source === "timestamp") {
        if (!timestamp) missing.push(provider.timestampHeader || "timestamp");
        payload += timestamp;
      } else if (part.source === "header") {
        var value = headers[part.name];
        if (value == null || String(value).trim() === "") missing.push(part.name);
        payload += value == null ? "" : String(value);
      }
    }

    if (missing.length) {
      return { ok: false, error: "Missing required value: " + missing.join(", ") + ".", missing: missing };
    }
    return { ok: true, payload: payload };
  }

  // -------------------------------------------------------------------
  // HMAC (async — Web Crypto)
  // -------------------------------------------------------------------

  function subtleCrypto() {
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto.subtle;
    }
    return null;
  }

  /**
   * Compute an HMAC over a payload.
   * @param {string} payload
   * @param {string|Uint8Array} secret
   * @param {string} algorithm  sha1 | sha256 | sha384 | sha512
   * @returns {Promise<Uint8Array>}
   */
  async function computeHmac(payload, secret, algorithm) {
    var subtle = subtleCrypto();
    if (!subtle) throw new Error("Web Crypto is unavailable in this environment.");
    if (!isAlgorithm(algorithm)) throw new Error("Unsupported algorithm: " + algorithm);
    var keyBytes = secret instanceof Uint8Array ? secret : textToBytes(secret);
    // Web Crypto refuses a zero-length HMAC key. Webhook secrets are never
    // empty, so surface a clear message instead of a raw importKey failure.
    if (keyBytes.length === 0) throw new Error("Secret must not be empty.");
    var key = await subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: ALGORITHMS[algorithm].hash },
      false,
      ["sign"]
    );
    var signature = await subtle.sign("HMAC", key, textToBytes(payload));
    return new Uint8Array(signature);
  }

  /**
   * Decode a Standard Webhooks style secret: strip the whsec_ prefix and
   * base64-decode when possible; otherwise return the string unchanged.
   * @param {string} secret
   * @returns {Uint8Array|string}
   */
  function decodeSecret(secret) {
    if (secret instanceof Uint8Array) return secret;
    var s = String(secret == null ? "" : secret);
    if (s.indexOf("whsec_") === 0) {
      var decoded = base64ToBytes(s.slice(6));
      if (decoded) return decoded;
    }
    return s;
  }

  /**
   * Build the value that belongs in the provider's signature header.
   * @param {object} provider
   * @param {string} signature
   * @param {{timestamp?:string}} values
   * @returns {string}
   */
  function formatHeaderValue(provider, signature, values) {
    var v = values || {};
    switch (provider.id) {
      case "github":
        return "sha256=" + signature;
      case "slack":
        return "v0=" + signature;
      case "stripe":
        return "t=" + (v.timestamp || "") + ",v1=" + signature;
      case "standard-webhooks":
        return "v1," + signature;
      default:
        return signature;
    }
  }

  /**
   * Generate the signature for a provider and its input values.
   * @param {object} provider
   * @param {{body?:string,timestamp?:string,headers?:object,secret?:string,headerName?:string}} values
   * @param {{algorithm?:string,encoding?:string}} [options]
   * @returns {Promise<object>}
   */
  async function generateSignature(provider, values, options) {
    if (!provider) return { ok: false, error: "Unknown provider." };
    var opts = options || {};
    var v = values || {};
    var algorithm = provider.algorithmLocked ? provider.algorithm : (opts.algorithm || provider.algorithm);
    var encoding = provider.encodingLocked ? provider.encoding : (opts.encoding || provider.encoding);

    if (!isAlgorithm(algorithm)) return { ok: false, error: "Unsupported algorithm: " + algorithm };
    if (!isEncoding(encoding)) return { ok: false, error: "Unsupported encoding: " + encoding };

    var built = buildSignedPayload(provider, v);
    if (!built.ok) return built;

    // decodeSecret always returns a string or Uint8Array, so an undefined
    // secret becomes an empty string and computeHmac reports it clearly.
    var secret = provider.id === "standard-webhooks" ? decodeSecret(v.secret) : v.secret;

    var bytes;
    try {
      bytes = await computeHmac(built.payload, secret, algorithm);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : "Could not compute the signature." };
    }

    var signature = encodeBytes(bytes, encoding);
    var headerName = v.headerName || provider.signatureHeader;
    return {
      ok: true,
      payload: built.payload,
      signature: signature,
      algorithm: algorithm,
      encoding: encoding,
      headerName: headerName,
      headerValue: formatHeaderValue(provider, signature, v)
    };
  }

  // -------------------------------------------------------------------
  // Reading a received signature header
  // -------------------------------------------------------------------

  /**
   * Pull the candidate signature value(s) out of a received header.
   * @param {object} provider
   * @param {string} headerValue
   * @returns {string[]}
   */
  function extractCandidates(provider, headerValue) {
    var raw = String(headerValue == null ? "" : headerValue).trim();
    if (!raw || !provider) return [];

    if (provider.scheme === "keyvalue") {
      return raw.split(/[,\s]+/).map(function (pair) {
        var eq = pair.indexOf("=");
        if (eq < 0) return null;
        var key = pair.slice(0, eq).trim();
        if ((provider.headerFields || []).indexOf(key) < 0) return null;
        return pair.slice(eq + 1).trim();
      }).filter(function (val) { return val; });
    }

    if (provider.scheme === "spacekeyvalue") {
      return raw.split(/\s+/).map(function (token) {
        var comma = token.indexOf(",");
        if (comma < 0) return null;
        var key = token.slice(0, comma).trim();
        if ((provider.headerFields || []).indexOf(key) < 0) return null;
        return token.slice(comma + 1).trim();
      }).filter(function (val) { return val; });
    }

    var value = raw;
    (provider.signaturePrefixes || []).forEach(function (prefix) {
      if (value.indexOf(prefix) === 0) value = value.slice(prefix.length);
    });
    return [value];
  }

  /**
   * Compare two signature strings. Hex is compared case-insensitively. The
   * loop runs over the full length without an early exit, mirroring the
   * constant-time comparison a handler should use.
   */
  function signaturesMatch(a, b, encoding) {
    var x = String(a == null ? "" : a);
    var y = String(b == null ? "" : b);
    if (encoding === "hex") {
      x = x.toLowerCase();
      y = y.toLowerCase();
    }
    if (x.length !== y.length || x.length === 0) return false;
    var diff = 0;
    for (var i = 0; i < x.length; i++) {
      diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Timestamp carried inside the signature header itself. Stripe embeds it as
   * t=; other providers put it in a separate header the caller supplies.
   * @returns {string|null}
   */
  function extractTimestamp(provider, headerValue) {
    if (!provider || provider.id !== "stripe") return null;
    var parts = String(headerValue == null ? "" : headerValue).split(/[,\s]+/);
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf("=");
      if (eq > 0 && parts[i].slice(0, eq).trim() === "t") {
        return parts[i].slice(eq + 1).trim();
      }
    }
    return null;
  }

  /**
   * Verify a received header value against a freshly computed signature.
   * For providers that embed the timestamp in the signature header (Stripe),
   * the header's own timestamp is what gets signed — matching how a real
   * handler verifies.
   * @returns {Promise<object>}
   */
  async function verifySignature(provider, values, options) {
    var opts = options || {};
    var headerValue = opts.headerValue;
    if (headerValue == null || String(headerValue).trim() === "") {
      return { ok: false, error: "Paste the received signature header value to verify." };
    }

    var verifyValues = Object.assign({}, values);
    var headerTimestamp = extractTimestamp(provider, headerValue);
    if (headerTimestamp != null) verifyValues.timestamp = headerTimestamp;

    var generated = await generateSignature(provider, verifyValues, opts);
    if (!generated.ok) return generated;

    var candidates = extractCandidates(provider, headerValue);
    if (!candidates.length) {
      return {
        ok: false,
        error: "No " + (provider.headerFields || ["signature"]).join("/") + " value found in that header.",
        generated: generated
      };
    }

    var matched = null;
    for (var i = 0; i < candidates.length; i++) {
      if (signaturesMatch(generated.signature, candidates[i], generated.encoding)) {
        matched = candidates[i];
        break;
      }
    }

    return {
      ok: true,
      valid: matched !== null,
      generated: generated,
      candidates: candidates,
      matched: matched
    };
  }

  // -------------------------------------------------------------------
  // Static verification recipes (shown in the UI, not executed)
  // -------------------------------------------------------------------

  var RECIPES = {
    github: {
      curl: [
        "# GitHub — verify the X-Hub-Signature-256 header",
        "# $BODY must be the exact raw request body bytes.",
        "SECRET=\"your_webhook_secret\"",
        "BODY='{\"action\":\"opened\",\"number\":42}'",
        "",
        "EXPECTED=\"sha256=$(printf '%s' \"$BODY\" | openssl dgst -sha256 -hmac \"$SECRET\" | awk '{print $2}')\"",
        "echo \"$EXPECTED\""
      ].join("\n"),
      node: [
        "const crypto = require(\"node:crypto\");",
        "",
        "const secret = process.env.GITHUB_WEBHOOK_SECRET;",
        "const rawBody = req.rawBody;            // Buffer — the raw body, not a re-serialized object",
        "const received = req.headers[\"x-hub-signature-256\"] || \"\";",
        "const expected = \"sha256=\" + crypto.createHmac(\"sha256\", secret).update(rawBody).digest(\"hex\");",
        "",
        "const a = Buffer.from(received);",
        "const b = Buffer.from(expected);",
        "const valid = a.length === b.length && crypto.timingSafeEqual(a, b);"
      ].join("\n"),
      python: [
        "import hashlib, hmac, os",
        "",
        "secret = os.environ[\"GITHUB_WEBHOOK_SECRET\"].encode()",
        "raw_body = request.get_data()            # raw bytes, not a re-serialized dict",
        "received = request.headers.get(\"X-Hub-Signature-256\", \"\")",
        "expected = \"sha256=\" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()",
        "valid = hmac.compare_digest(expected, received)"
      ].join("\n")
    },
    stripe: {
      curl: [
        "# Stripe — verify a Stripe-Signature header",
        "SECRET=\"whsec_your_secret\"",
        "HEADER=\"t=1712345678,v1=...\"",
        "BODY='{\"type\":\"payment_intent.succeeded\"}'",
        "",
        "# Pull t= and v1= out of the header, rebuild \"<t>.<body>\" and HMAC it.",
        "T=$(printf '%s' \"$HEADER\" | tr ',' '\\n' | sed -n 's/^t=//p')",
        "SIG=$(printf '%s' \"$HEADER\" | tr ',' '\\n' | sed -n 's/^v1=//p')",
        "EXPECTED=$(printf '%s.%s' \"$T\" \"$BODY\" | openssl dgst -sha256 -hmac \"$SECRET\" | awk '{print $2}')",
        "[ \"$EXPECTED\" = \"$SIG\" ] && echo valid || echo invalid"
      ].join("\n"),
      node: [
        "const crypto = require(\"node:crypto\");",
        "",
        "const secret = process.env.STRIPE_WEBHOOK_SECRET;",
        "const rawBody = req.rawBody;             // Buffer",
        "const header = req.headers[\"stripe-signature\"] || \"\";",
        "",
        "const parts = Object.fromEntries(header.split(\",\").map((p) => p.split(\"=\")));",
        "const expected = crypto",
        "  .createHmac(\"sha256\", secret)",
        "  .update(`${parts.t}.${rawBody}`)",
        "  .digest(\"hex\");",
        "",
        "// Stripe may send several v1= values during rotation — any match is valid.",
        "const candidates = header.split(\",\").filter((p) => p.startsWith(\"v1=\")).map((p) => p.slice(3));",
        "const valid = candidates.some((c) => c.length === expected.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(expected)));"
      ].join("\n"),
      python: [
        "import hashlib, hmac, os",
        "",
        "secret = os.environ[\"STRIPE_WEBHOOK_SECRET\"].encode()",
        "raw_body = request.get_data()",
        "header = request.headers.get(\"Stripe-Signature\", \"\")",
        "",
        "parts = dict(p.split(\"=\", 1) for p in header.split(\",\") if \"=\" in p)",
        "expected = hmac.new(secret, f\"{parts['t']}.\".encode() + raw_body, hashlib.sha256).hexdigest()",
        "candidates = [p.split(\"=\", 1)[1] for p in header.split(\",\") if p.startswith(\"v1=\")]",
        "valid = any(hmac.compare_digest(expected, c) for c in candidates)"
      ].join("\n")
    },
    slack: {
      curl: [
        "# Slack — verify an X-Slack-Signature header",
        "SECRET=\"your_signing_secret\"",
        "TS=\"1712345678\"",
        "BODY='{\"type\":\"event_callback\"}'",
        "",
        "EXPECTED=\"v0=$(printf 'v0:%s:%s' \"$TS\" \"$BODY\" | openssl dgst -sha256 -hmac \"$SECRET\" | awk '{print $2}')\"",
        "echo \"$EXPECTED\""
      ].join("\n"),
      node: [
        "const crypto = require(\"node:crypto\");",
        "",
        "const secret = process.env.SLACK_SIGNING_SECRET;",
        "const rawBody = req.rawBody;             // Buffer",
        "const ts = req.headers[\"x-slack-request-timestamp\"] || \"\";",
        "const received = req.headers[\"x-slack-signature\"] || \"\";",
        "",
        "const expected = \"v0=\" + crypto",
        "  .createHmac(\"sha256\", secret)",
        "  .update(`v0:${ts}:${rawBody}`)",
        "  .digest(\"hex\");",
        "",
        "const a = Buffer.from(received);",
        "const b = Buffer.from(expected);",
        "const valid = a.length === b.length && crypto.timingSafeEqual(a, b);"
      ].join("\n"),
      python: [
        "import hashlib, hmac, os, time",
        "",
        "secret = os.environ[\"SLACK_SIGNING_SECRET\"].encode()",
        "raw_body = request.get_data()",
        "ts = request.headers.get(\"X-Slack-Request-Timestamp\", \"\")",
        "",
        "# Reject stale requests first (replay protection).",
        "if abs(time.time() - int(ts)) > 60 * 5:",
        "    raise ValueError(\"stale request\")",
        "",
        "base = b\"v0:\" + ts.encode() + b\":\" + raw_body",
        "expected = \"v0=\" + hmac.new(secret, base, hashlib.sha256).hexdigest()",
        "valid = hmac.compare_digest(expected, request.headers.get(\"X-Slack-Signature\", \"\"))"
      ].join("\n")
    },
    shopify: {
      curl: [
        "# Shopify — verify an X-Shopify-Hmac-Sha256 header",
        "SECRET=\"your_app_secret\"",
        "BODY='{\"id\":1234567890}'",
        "",
        "EXPECTED=$(printf '%s' \"$BODY\" | openssl dgst -sha256 -hmac \"$SECRET\" -binary | openssl base64)",
        "echo \"$EXPECTED\""
      ].join("\n"),
      node: [
        "const crypto = require(\"node:crypto\");",
        "",
        "const secret = process.env.SHOPIFY_WEBHOOK_SECRET;",
        "const rawBody = req.rawBody;             // Buffer",
        "const received = req.headers[\"x-shopify-hmac-sha256\"] || \"\";",
        "const expected = crypto.createHmac(\"sha256\", secret).update(rawBody).digest(\"base64\");",
        "",
        "const a = Buffer.from(received);",
        "const b = Buffer.from(expected);",
        "const valid = a.length === b.length && crypto.timingSafeEqual(a, b);"
      ].join("\n"),
      python: [
        "import base64, hashlib, hmac, os",
        "",
        "secret = os.environ[\"SHOPIFY_WEBHOOK_SECRET\"].encode()",
        "raw_body = request.get_data()",
        "digest = hmac.new(secret, raw_body, hashlib.sha256).digest()",
        "expected = base64.b64encode(digest).decode()",
        "valid = hmac.compare_digest(expected, request.headers.get(\"X-Shopify-Hmac-Sha256\", \"\"))"
      ].join("\n")
    },
    "standard-webhooks": {
      curl: [
        "# Standard Webhooks — verify a webhook-signature header",
        "# Secret is base64-decoded after the whsec_ prefix.",
        "SECRET=\"whsec_your_secret\"",
        "ID=\"msg_2abc\"",
        "TS=\"1712345678\"",
        "BODY='{\"type\":\"email.sent\"}'",
        "",
        "KEY=$(printf '%s' \"${SECRET#whsec_}\" | openssl base64 -d -A | xxd -p -c 256)",
        "EXPECTED=$(printf '%s.%s.%s' \"$ID\" \"$TS\" \"$BODY\" | openssl dgst -sha256 -mac HMAC -macopt hexkey:\"$KEY\" -binary | openssl base64)",
        "echo \"v1,$EXPECTED\""
      ].join("\n"),
      node: [
        "const crypto = require(\"node:crypto\");",
        "",
        "const rawSecret = process.env.STANDARD_WEBHOOKS_SECRET; // e.g. whsec_...",
        "const key = Buffer.from(rawSecret.replace(/^whsec_/, \"\"), \"base64\");",
        "const rawBody = req.rawBody;             // Buffer",
        "const id = req.headers[\"webhook-id\"] || \"\";",
        "const ts = req.headers[\"webhook-timestamp\"] || \"\";",
        "",
        "const expected = crypto",
        "  .createHmac(\"sha256\", key)",
        "  .update(`${id}.${ts}.${rawBody}`)",
        "  .digest(\"base64\");",
        "",
        "const candidates = (req.headers[\"webhook-signature\"] || \"\")",
        "  .split(\" \")",
        "  .filter((token) => token.startsWith(\"v1,\"))",
        "  .map((token) => token.slice(3));",
        "const valid = candidates.some((c) => c.length === expected.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(expected)));"
      ].join("\n"),
      python: [
        "import base64, hashlib, hmac, os",
        "",
        "raw_secret = os.environ[\"STANDARD_WEBHOOKS_SECRET\"]",
        "key = base64.b64decode(raw_secret.replace(\"whsec_\", \"\"))",
        "raw_body = request.get_data()",
        "msg_id = request.headers.get(\"webhook-id\", \"\")",
        "ts = request.headers.get(\"webhook-timestamp\", \"\")",
        "",
        "signed = f\"{msg_id}.{ts}.\".encode() + raw_body",
        "expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()",
        "candidates = [t[3:] for t in request.headers.get(\"webhook-signature\", \"\").split(\" \") if t.startswith(\"v1,\")]",
        "valid = any(hmac.compare_digest(expected, c) for c in candidates)"
      ].join("\n")
    },
    custom: {
      curl: [
        "# Custom HMAC — verify a plain HMAC over the raw body",
        "SECRET=\"your_secret\"",
        "BODY='{\"hello\":\"world\"}'",
        "",
        "# Swap sha256 for sha1 / sha384 / sha512, and -binary | openssl base64 for base64 output.",
        "EXPECTED=$(printf '%s' \"$BODY\" | openssl dgst -sha256 -hmac \"$SECRET\" | awk '{print $2}')",
        "echo \"$EXPECTED\""
      ].join("\n"),
      node: [
        "const crypto = require(\"node:crypto\");",
        "",
        "const secret = process.env.WEBHOOK_SECRET;",
        "const rawBody = req.rawBody;             // Buffer",
        "const received = req.headers[\"x-signature\"] || \"\";",
        "const expected = crypto.createHmac(\"sha256\", secret).update(rawBody).digest(\"hex\");",
        "",
        "const a = Buffer.from(received);",
        "const b = Buffer.from(expected);",
        "const valid = a.length === b.length && crypto.timingSafeEqual(a, b);"
      ].join("\n"),
      python: [
        "import hashlib, hmac, os",
        "",
        "secret = os.environ[\"WEBHOOK_SECRET\"].encode()",
        "raw_body = request.get_data()",
        "expected = hmac.new(secret, raw_body, hashlib.sha256).hexdigest()",
        "valid = hmac.compare_digest(expected, request.headers.get(\"X-Signature\", \"\"))"
      ].join("\n")
    }
  };

  function verificationRecipe(providerId, language) {
    var recipe = RECIPES[providerId];
    if (!recipe) return "";
    return recipe[language] || "";
  }

  function listRecipeLanguages() {
    return ["curl", "node", "python"];
  }

  // -------------------------------------------------------------------
  // Samples
  // -------------------------------------------------------------------

  var SAMPLES = {
    github: {
      body: '{\n  "action": "opened",\n  "number": 42,\n  "repository": { "full_name": "acme/widgets" }\n}',
      secret: "whsec_github_example_secret",
      timestamp: ""
    },
    stripe: {
      body: '{\n  "id": "evt_1Pexample",\n  "type": "payment_intent.succeeded",\n  "data": { "object": { "amount": 2000, "currency": "usd" } }\n}',
      secret: "whsec_stripe_example_secret",
      timestamp: "1712345678"
    },
    slack: {
      body: '{\n  "type": "event_callback",\n  "event": { "type": "app_mention", "text": "hello" }\n}',
      secret: "slack_signing_example_secret",
      timestamp: "1712345678"
    },
    shopify: {
      body: '{\n  "id": 1234567890,\n  "topic": "orders/create",\n  "shop_domain": "acme.myshopify.com"\n}',
      secret: "shopify_example_secret",
      timestamp: ""
    },
    "standard-webhooks": {
      body: '{\n  "type": "email.sent",\n  "data": { "to": "user@example.com" }\n}',
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      timestamp: "1712345678",
      headers: { "webhook-id": "msg_2abc123" }
    },
    custom: {
      body: '{\n  "hello": "world"\n}',
      secret: "your_secret",
      timestamp: ""
    }
  };

  function getSample(providerId) {
    var sample = SAMPLES[providerId];
    if (!sample) return null;
    return {
      body: sample.body,
      secret: sample.secret,
      timestamp: sample.timestamp || "",
      headers: Object.assign({}, sample.headers || {})
    };
  }

  return {
    ALGORITHMS: ALGORITHMS,
    isAlgorithm: isAlgorithm,
    listAlgorithms: listAlgorithms,
    isEncoding: isEncoding,
    textToBytes: textToBytes,
    bytesToText: bytesToText,
    bytesToHex: bytesToHex,
    hexToBytes: hexToBytes,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    encodeBytes: encodeBytes,
    listProviders: listProviders,
    getProvider: getProvider,
    buildSignedPayload: buildSignedPayload,
    computeHmac: computeHmac,
    decodeSecret: decodeSecret,
    formatHeaderValue: formatHeaderValue,
    generateSignature: generateSignature,
    extractCandidates: extractCandidates,
    signaturesMatch: signaturesMatch,
    verifySignature: verifySignature,
    verificationRecipe: verificationRecipe,
    listRecipeLanguages: listRecipeLanguages,
    getSample: getSample
  };
});
