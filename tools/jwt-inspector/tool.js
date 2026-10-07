/* Toolshed — JWT Inspector
 * Decode, analyse, verify and create JSON Web Tokens, entirely in the browser.
 *
 * Core logic is dependency-free. Loads as window.Toolshed.jwtInspector in the
 * browser and via require("../tool.js") in Node for the test suite.
 *
 * Cryptography uses the Web Crypto API (crypto.subtle), which is available in
 * secure browser contexts and in modern Node. Nothing here touches the
 * network, uses eval/dynamic code execution, or writes to storage.
 *
 * Design notes:
 *  - Decoding is deliberately forgiving (it only Base64url-decodes and parses
 *    JSON) so that malformed tokens can be inspected. Verification is strict.
 *  - Signature checks always hash the exact original segments; the token is
 *    never re-serialised before verification.
 *  - Algorithm handling is table-driven so the same code drives the UI and the
 *    tests, and unsupported algorithms fail with a useful message.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.jwtInspector = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // -----------------------------------------------------------------------
  // Algorithm registry
  // -----------------------------------------------------------------------

  var JWS_ALGORITHMS = {
    HS256: { family: "HMAC", hash: "SHA-256", secret: true },
    HS384: { family: "HMAC", hash: "SHA-384", secret: true },
    HS512: { family: "HMAC", hash: "SHA-512", secret: true },
    RS256: { family: "RSA", hash: "SHA-256", padding: "pkcs1" },
    RS384: { family: "RSA", hash: "SHA-384", padding: "pkcs1" },
    RS512: { family: "RSA", hash: "SHA-512", padding: "pkcs1" },
    PS256: { family: "RSA", hash: "SHA-256", padding: "pss" },
    PS384: { family: "RSA", hash: "SHA-384", padding: "pss" },
    PS512: { family: "RSA", hash: "SHA-512", padding: "pss" },
    ES256: { family: "EC", hash: "SHA-256", curve: "P-256" },
    ES384: { family: "EC", hash: "SHA-384", curve: "P-384" },
    ES512: { family: "EC", hash: "SHA-512", curve: "P-521" },
    EdDSA: { family: "OKP", hash: null, curve: "Ed25519" }
  };

  var REGISTERED_CLAIMS = {
    iss: "Issuer",
    sub: "Subject",
    aud: "Audience",
    exp: "Expiration Time",
    nbf: "Not Before",
    iat: "Issued At",
    jti: "JWT ID",
    auth_time: "Authentication Time",
    nonce: "Nonce",
    acr: "Authentication Context Class",
    amr: "Authentication Methods",
    azp: "Authorized Party",
    scope: "Scope",
    sid: "Session ID",
    typ: "Type",
    cnf: "Confirmation",
    act: "Actor"
  };

  var CLAIM_ORDER = [
    "iss", "sub", "aud", "exp", "nbf", "iat", "jti",
    "auth_time", "nonce", "acr", "amr", "azp", "scope", "sid", "typ", "cnf", "act"
  ];

  var SENSITIVE_KEY = /(pass(word|phrase)?|secret|private|ssn|social.?security|credit|card.?number|cvv|api.?key|access.?token|refresh.?token|client.?secret)/i;

  // -----------------------------------------------------------------------
  // Environment helpers
  // -----------------------------------------------------------------------

  function getSubtle() {
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto.subtle;
    }
    if (typeof crypto !== "undefined" && crypto.subtle) return crypto.subtle;
    if (typeof require === "function") {
      try {
        var nodeCrypto = require("crypto");
        if (nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle) return nodeCrypto.webcrypto.subtle;
      } catch (e) { /* not available */ }
    }
    return null;
  }

  function hasCrypto() {
    return getSubtle() !== null;
  }

  // -----------------------------------------------------------------------
  // Base64url and UTF-8
  // -----------------------------------------------------------------------

  function base64UrlToBytes(str) {
    if (typeof str !== "string") return null;
    var s = str.trim();
    if (s === "") return new Uint8Array(0);
    // Base64url in JWS is unpadded; "=" and standard-base64 characters are rejected.
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
    if (s.length % 4 === 1) return null;
    var b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    var pad = b64.length % 4;
    if (pad) b64 += "====".slice(pad);
    var bin;
    if (typeof atob === "function") {
      try { bin = atob(b64); } catch (e) { return null; }
    } else if (typeof Buffer !== "undefined") {
      try { bin = Buffer.from(b64, "base64").toString("binary"); } catch (e) { return null; }
    } else {
      return null;
    }
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64Url(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var b64;
    if (typeof btoa === "function") b64 = btoa(bin);
    else b64 = Buffer.from(bytes).toString("base64");
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64ToBytes(b64) {
    var clean = String(b64).replace(/[\s\r\n]+/g, "");
    var bin;
    if (typeof atob === "function") {
      try { bin = atob(clean); } catch (e) { return null; }
    } else if (typeof Buffer !== "undefined") {
      try { bin = Buffer.from(clean, "base64").toString("binary"); } catch (e) { return null; }
    } else {
      return null;
    }
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToUtf8(bytes) {
    if (typeof TextDecoder !== "undefined") {
      try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); }
      catch (e) { /* fall through */ }
    }
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(bin)); }
    catch (e2) { return bin; }
  }

  function utf8ToBytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var bin = unescape(encodeURIComponent(str));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // -----------------------------------------------------------------------
  // Token parsing
  // -----------------------------------------------------------------------

  function decodeJsonSegment(segment, label) {
    var bytes = base64UrlToBytes(segment);
    if (bytes === null) return { ok: false, error: label + " is not valid Base64url." };
    var text = bytesToUtf8(bytes);
    var value;
    try { value = JSON.parse(text); }
    catch (e) { return { ok: false, error: label + " is not valid JSON (" + e.message + ")." }; }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: label + " must be a JSON object." };
    }
    return { ok: true, value: value, text: text, bytes: bytes };
  }

  /**
   * Split and decode a JWT without verifying anything.
   * @param {string} token
   * @returns {{ok:true, header:object, payload:object, ...}|{ok:false, error:string}}
   */
  function parseJwt(token) {
    if (typeof token !== "string") return { ok: false, error: "No token provided." };
    var t = token.trim().replace(/^["']|["']$/g, "");
    if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, "").trim();
    if (t === "") return { ok: false, error: "No token provided." };

    var parts = t.split(".");
    if (parts.length === 5) {
      return {
        ok: false,
        error: "This looks like a JWE (encrypted token, five segments). This tool inspects signed JWTs (JWS); a JWE payload is encrypted and cannot be read without the key."
      };
    }
    if (parts.length !== 3) {
      return { ok: false, error: "A JWT has three dot-separated parts (header.payload.signature); this has " + parts.length + "." };
    }

    var header = decodeJsonSegment(parts[0], "The header");
    if (!header.ok) return header;
    var payload = decodeJsonSegment(parts[1], "The payload");
    if (!payload.ok) return payload;

    return {
      ok: true,
      token: t,
      header: header.value,
      payload: payload.value,
      headerText: header.text,
      payloadText: payload.text,
      signature: parts[2],
      signingInput: parts[0] + "." + parts[1],
      parts: parts
    };
  }

  // -----------------------------------------------------------------------
  // Formatting helpers
  // -----------------------------------------------------------------------

  function formatDuration(seconds) {
    var s = Math.abs(Math.round(seconds));
    if (s < 60) return s + (s === 1 ? " second" : " seconds");
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? " minute" : " minutes");
    var h = Math.round(m / 60);
    if (h < 48) return h + (h === 1 ? " hour" : " hours");
    var d = Math.round(h / 24);
    if (d < 60) return d + (d === 1 ? " day" : " days");
    var mo = Math.round(d / 30);
    if (mo < 24) return mo + (mo === 1 ? " month" : " months");
    var y = Math.round(d / 365);
    return y + (y === 1 ? " year" : " years");
  }

  function formatDate(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds)) return "invalid date";
    var d = new Date(seconds * 1000);
    if (isNaN(d.getTime())) return "invalid date";
    return d.toISOString().replace(/\.000Z$/, "Z");
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    return (n / 1024).toFixed(1) + " KB";
  }

  function displayValue(value) {
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }

  function hashLength(hash) {
    if (hash === "SHA-256") return 32;
    if (hash === "SHA-384") return 48;
    if (hash === "SHA-512") return 64;
    return 32;
  }

  // -----------------------------------------------------------------------
  // Claim analysis
  // -----------------------------------------------------------------------

  function timeClaimStatus(key, value, nowSec) {
    var diff = value - nowSec;
    if (key === "exp") {
      if (diff <= 0) return { status: "danger", note: "Expired " + formatDuration(-diff) + " ago" };
      if (diff < 300) return { status: "warn", note: "Expires in " + formatDuration(diff) };
      return { status: "ok", note: "Valid for " + formatDuration(diff) + " more" };
    }
    if (key === "nbf") {
      if (diff > 0) return { status: "warn", note: "Not valid for another " + formatDuration(diff) };
      return { status: "ok", note: "Active since " + formatDuration(-diff) + " ago" };
    }
    if (key === "iat") {
      if (diff > 0) return { status: "warn", note: "Issued in the future (" + formatDuration(diff) + " from now)" };
      return { status: "ok", note: "Issued " + formatDuration(-diff) + " ago" };
    }
    return { status: "", note: "" };
  }

  function audienceNote(aud) {
    if (typeof aud === "string") return "Single audience";
    if (Array.isArray(aud)) return aud.length + " audiences";
    return "Expected a string or array of strings";
  }

  function analyzeClaims(payload, options) {
    options = options || {};
    var nowMs = typeof options.now === "number" ? options.now : Date.now();
    var nowSec = Math.floor(nowMs / 1000);
    var claims = [];
    var seen = {};

    function add(key) {
      seen[key] = true;
      var value = payload[key];
      var label = REGISTERED_CLAIMS[key] || "";
      var status = "";
      var note = "";

      if (key === "exp" || key === "nbf" || key === "iat" || key === "auth_time") {
        if (typeof value === "number" && isFinite(value)) {
          var ts = key === "auth_time"
            ? { status: "", note: "" }
            : timeClaimStatus(key, value, nowSec);
          status = ts.status;
          note = formatDate(value) + (ts.note ? " · " + ts.note : "");
        } else {
          status = "danger";
          note = "Should be a NumericDate (seconds since the Unix epoch).";
        }
      } else if (key === "aud") {
        note = audienceNote(value);
        if (typeof value !== "string" && !(Array.isArray(value) && value.every(function (v) { return typeof v === "string"; }))) {
          status = "warn";
        }
      } else if (key === "amr") {
        if (!Array.isArray(value)) { status = "warn"; note = "Expected an array."; }
      } else if (key === "scope") {
        if (typeof value !== "string" && !Array.isArray(value)) { status = "warn"; note = "Expected a string or array."; }
      } else if (label && typeof value !== "string") {
        status = "warn";
        note = "Expected a string.";
      }

      claims.push({
        key: key,
        label: label,
        value: value,
        display: displayValue(value),
        note: note,
        status: status
      });
    }

    CLAIM_ORDER.forEach(function (key) { if (key in payload) add(key); });
    Object.keys(payload).forEach(function (key) { if (!seen[key]) add(key); });

    return claims;
  }

  function analyzeSecurity(header, payload, options) {
    options = options || {};
    var nowMs = typeof options.now === "number" ? options.now : Date.now();
    var nowSec = Math.floor(nowMs / 1000);
    var issues = [];
    var alg = header && header.alg;

    function issue(level, text) { issues.push({ level: level, text: text }); }

    if (typeof alg !== "string" || alg === "") {
      issue("danger", "The header has no \"alg\" field, so the signing algorithm is unspecified. Reject tokens without a known algorithm.");
    } else if (alg.toLowerCase() === "none") {
      issue("danger", "alg is \"none\": the token is unsecured and can be forged by anyone. Never accept it in production.");
    } else if (!JWS_ALGORITHMS[alg]) {
      issue("warn", "The algorithm \"" + alg + "\" is not one this tool recognises; it cannot be verified here.");
    }

    if (!("exp" in payload)) {
      issue("warn", "No \"exp\" claim: the token never expires.");
    } else if (typeof payload.exp !== "number") {
      issue("danger", "The \"exp\" claim is not a number and will be ignored by strict validators.");
    } else if (payload.exp <= nowSec) {
      issue("danger", "The token is expired (exp is in the past).");
    }

    if (!("iss" in payload)) issue("warn", "No \"iss\" claim: the issuer is not pinned, so the token is not tied to a known authority.");
    if (!("aud" in payload)) issue("warn", "No \"aud\" claim: the token is not restricted to a specific audience.");

    if (typeof payload.iat === "number" && typeof payload.exp === "number" && payload.exp > payload.iat) {
      var life = payload.exp - payload.iat;
      if (life > 86400) {
        issue("warn", "The token lifetime is " + formatDuration(life) + " (over 24 hours); long-lived bearer tokens are riskier if leaked.");
      }
    }

    if (typeof payload.exp === "number" && typeof payload.nbf === "number" && payload.nbf > payload.exp) {
      issue("danger", "nbf is after exp, so the token can never be valid.");
    }

    // Sensitive-looking claim names.
    Object.keys(payload).forEach(function (key) {
      if (SENSITIVE_KEY.test(key)) {
        issue("warn", "The payload contains a claim named \"" + key + "\", which may hold sensitive data. A JWT payload is only Base64url-encoded and is readable by anyone holding the token.");
      }
    });

    if (alg === "HS256" || alg === "HS384" || alg === "HS512") {
      issue("info", "HMAC (" + alg + "): one shared secret both signs and verifies. If a service accepts both HMAC and RSA tokens, an attacker who learns the public key may attempt an algorithm-confusion attack — pin the expected algorithm server-side.");
    }

    var rank = { danger: 0, warn: 1, info: 2 };
    return issues.slice().sort(function (a, b) {
      return (rank[a.level] === undefined ? 3 : rank[a.level]) - (rank[b.level] === undefined ? 3 : rank[b.level]);
    });
  }

  // -----------------------------------------------------------------------
  // Key material
  // -----------------------------------------------------------------------

  function pemToDer(pem) {
    var body = String(pem)
      .replace(/-----BEGIN [^-]+-----/g, "")
      .replace(/-----END [^-]+-----/g, "")
      .replace(/[\s\r\n]+/g, "");
    if (body === "") return null;
    return base64ToBytes(body);
  }

  function looksLikePem(text) {
    return /-----BEGIN [A-Z0-9 ]+-----/.test(String(text));
  }

  function looksLikeJwk(text) {
    var t = String(text).trim();
    if (t.charAt(0) !== "{") return false;
    try {
      var o = JSON.parse(t);
      return !!(o && typeof o === "object" && (o.kty || Array.isArray(o.keys)));
    } catch (e) { return false; }
  }

  function jwkAlgorithm(spec) {
    if (spec.family === "HMAC") return { name: "HMAC", hash: spec.hash };
    if (spec.family === "RSA") {
      return spec.padding === "pss"
        ? { name: "RSA-PSS", hash: spec.hash }
        : { name: "RSASSA-PKCS1-v1_5", hash: spec.hash };
    }
    if (spec.family === "EC") return { name: "ECDSA", namedCurve: spec.curve };
    return { name: "Ed25519" };
  }

  function signVerifyAlgorithm(spec) {
    if (spec.family === "HMAC") return { name: "HMAC" };
    if (spec.family === "RSA") {
      return spec.padding === "pss"
        ? { name: "RSA-PSS", saltLength: hashLength(spec.hash) }
        : { name: "RSASSA-PKCS1-v1_5" };
    }
    if (spec.family === "EC") return { name: "ECDSA", hash: spec.hash };
    return { name: "Ed25519" };
  }

  function importJwkObject(jwk, alg, usage) {
    var spec = JWS_ALGORITHMS[alg];
    if (!spec) return Promise.resolve({ ok: false, error: "Unsupported algorithm: " + alg });
    var subtle = getSubtle();
    if (!subtle) return Promise.resolve({ ok: false, error: "Web Crypto is not available in this environment." });
    return subtle.importKey("jwk", jwk, jwkAlgorithm(spec), false, [usage])
      .then(function (key) { return { ok: true, key: key }; })
      .catch(function (err) { return { ok: false, error: "Could not import the JWK: " + err.message }; });
  }

  /**
   * Import key material for signing or verification.
   * Accepts a raw secret (HMAC), a PEM block (asymmetric), or a JWK JSON.
   */
  function importKeyMaterial(material, alg, usage) {
    var spec = JWS_ALGORITHMS[alg];
    if (!spec) return Promise.resolve({ ok: false, error: "Unsupported algorithm: " + alg });
    var subtle = getSubtle();
    if (!subtle) return Promise.resolve({ ok: false, error: "Web Crypto is not available in this environment." });

    var text = String(material === null || material === undefined ? "" : material).trim();
    if (text === "") return Promise.resolve({ ok: false, error: "No key material provided." });

    if (spec.family === "HMAC") {
      if (looksLikePem(text)) {
        return Promise.resolve({
          ok: false,
          error: "HMAC (" + alg + ") verifies with a shared secret, not a PEM public key. " +
            "Paste the raw secret, or switch to an asymmetric algorithm that matches the key."
        });
      }
      if (looksLikeJwk(text)) {
        var oct;
        try { oct = JSON.parse(text); } catch (e) { return Promise.resolve({ ok: false, error: "Invalid JWK JSON." }); }
        if (oct.kty !== "oct" || typeof oct.k !== "string") {
          return Promise.resolve({ ok: false, error: "An HMAC key JWK must have kty \"oct\" and a \"k\" value." });
        }
        var secret = base64UrlToBytes(oct.k);
        if (!secret) return Promise.resolve({ ok: false, error: "The JWK \"k\" value is not valid Base64url." });
        return subtle.importKey("raw", secret, { name: "HMAC", hash: spec.hash }, false, [usage])
          .then(function (key) { return { ok: true, key: key }; })
          .catch(function (err) { return { ok: false, error: "Could not import the HMAC key: " + err.message }; });
      }
      return subtle.importKey("raw", utf8ToBytes(text), { name: "HMAC", hash: spec.hash }, false, [usage])
        .then(function (key) { return { ok: true, key: key }; })
        .catch(function (err) { return { ok: false, error: "Could not import the HMAC key: " + err.message }; });
    }

    if (looksLikeJwk(text)) {
      var jwk;
      try { jwk = JSON.parse(text); } catch (e) { return Promise.resolve({ ok: false, error: "Invalid JWK JSON." }); }
      if (jwk.kty === "oct") return Promise.resolve({ ok: false, error: "An \"oct\" JWK is an HMAC secret; it cannot be used with " + alg + "." });
      return importJwkObject(jwk, alg, usage);
    }

    if (!looksLikePem(text)) {
      return Promise.resolve({ ok: false, error: "For " + spec.family + " keys, paste a PEM block (-----BEGIN …-----) or a JWK JSON object." });
    }
    var der = pemToDer(text);
    if (!der) return Promise.resolve({ ok: false, error: "The PEM block could not be decoded." });
    var format = usage === "sign" ? "pkcs8" : "spki";
    return subtle.importKey(format, der, jwkAlgorithm(spec), false, [usage])
      .then(function (key) { return { ok: true, key: key }; })
      .catch(function (err) {
        return {
          ok: false,
          error: "Could not import the PEM key — check that it is the right type (" +
            (usage === "sign" ? "a private key in PKCS#8" : "a public key in SPKI") +
            ") for " + alg + ": " + err.message
        };
      });
  }

  // -----------------------------------------------------------------------
  // Verification and signing
  // -----------------------------------------------------------------------

  function signatureLengthHint(spec, sigBytes) {
    if (spec.family === "EC") {
      var coord = { "P-256": 32, "P-384": 48, "P-521": 66 }[spec.curve];
      var expected = coord * 2;
      if (sigBytes.length !== expected) {
        return "This " + spec.curve + " signature is " + sigBytes.length +
          " bytes; the raw JWS form should be " + expected +
          " bytes (r‖s). A DER/ASN.1-encoded signature will not verify.";
      }
    }
    return "";
  }

  /**
   * Verify a token's signature. Resolves with {ok, valid} or {ok:false, error}.
   */
  function verifyJwt(token, keyMaterial, options) {
    options = options || {};
    var parsed = parseJwt(token);
    if (!parsed.ok) return Promise.resolve({ ok: false, error: parsed.error, stage: "parse" });

    var alg = parsed.header.alg;
    if (typeof alg === "string" && alg.toLowerCase() === "none") {
      return Promise.resolve({ ok: false, error: "The token is unsecured (alg \"none\"); there is no signature to verify.", stage: "algorithm" });
    }
    var spec = JWS_ALGORITHMS[alg];
    if (!spec) {
      return Promise.resolve({ ok: false, error: "The token's algorithm \"" + alg + "\" is not supported for verification.", stage: "algorithm" });
    }
    if (parsed.signature === "") {
      return Promise.resolve({ ok: false, error: "The token has no signature segment.", stage: "parse" });
    }
    var sigBytes = base64UrlToBytes(parsed.signature);
    if (!sigBytes) return Promise.resolve({ ok: false, error: "The signature is not valid Base64url.", stage: "parse" });

    var data = utf8ToBytes(parsed.signingInput);
    return importKeyMaterial(keyMaterial, alg, "verify").then(function (imported) {
      if (!imported.ok) return { ok: false, error: imported.error, stage: "key" };
      return getSubtle().verify(signVerifyAlgorithm(spec), imported.key, sigBytes, data).then(function (valid) {
        if (valid) return { ok: true, valid: true, algorithm: alg, stage: "verify" };
        var out = { ok: true, valid: false, algorithm: alg, stage: "verify", error: "The signature does not match this key." };
        var hint = signatureLengthHint(spec, sigBytes);
        if (hint) out.hint = hint;
        return out;
      });
    }).catch(function (err) {
      return { ok: false, error: "Verification failed: " + (err && err.message ? err.message : String(err)), stage: "verify" };
    });
  }

  /**
   * Sign a header and payload, producing a compact JWS.
   */
  function signJwt(header, payload, keyMaterial, options) {
    options = options || {};
    if (!header || typeof header !== "object") return Promise.resolve({ ok: false, error: "A header object is required." });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return Promise.resolve({ ok: false, error: "A payload object is required." });

    var alg = header.alg;
    if (typeof alg === "string" && alg.toLowerCase() === "none") {
      return Promise.resolve({ ok: false, error: "Refusing to create an unsecured token (alg \"none\")." });
    }
    var spec = JWS_ALGORITHMS[alg];
    if (!spec) return Promise.resolve({ ok: false, error: "Unsupported or missing algorithm \"" + alg + "\"." });

    var headerObj = {};
    Object.keys(header).forEach(function (k) { headerObj[k] = header[k]; });
    if (!headerObj.typ) headerObj.typ = "JWT";

    var headerJson = JSON.stringify(headerObj);
    var payloadJson = JSON.stringify(payload);
    var h = bytesToBase64Url(utf8ToBytes(headerJson));
    var p = bytesToBase64Url(utf8ToBytes(payloadJson));
    var signingInput = h + "." + p;
    var data = utf8ToBytes(signingInput);

    return importKeyMaterial(keyMaterial, alg, "sign").then(function (imported) {
      if (!imported.ok) return { ok: false, error: imported.error, stage: "key" };
      return getSubtle().sign(signVerifyAlgorithm(spec), imported.key, data).then(function (sig) {
        var sigB64 = bytesToBase64Url(new Uint8Array(sig));
        return {
          ok: true,
          token: signingInput + "." + sigB64,
          header: headerObj,
          payload: payload,
          signingInput: signingInput,
          signature: sigB64
        };
      });
    }).catch(function (err) {
      return { ok: false, error: "Signing failed: " + (err && err.message ? err.message : String(err)), stage: "sign" };
    });
  }

  // -----------------------------------------------------------------------
  // JWKS
  // -----------------------------------------------------------------------

  function parseJwks(text) {
    var obj;
    try { obj = JSON.parse(text); }
    catch (e) { return { ok: false, error: "JWKS is not valid JSON: " + e.message }; }
    if (!obj || typeof obj !== "object") return { ok: false, error: "JWKS must be a JSON object." };
    if (Array.isArray(obj.keys)) {
      var keys = obj.keys.filter(function (k) { return k && typeof k === "object" && typeof k.kty === "string"; });
      if (keys.length === 0) return { ok: false, error: "The \"keys\" array contains no usable keys." };
      return { ok: true, keys: keys };
    }
    if (typeof obj.kty === "string") return { ok: true, keys: [obj] };
    return { ok: false, error: "Expected a JWKS with a \"keys\" array, or a single JWK object." };
  }

  function jwksCandidates(jwks, header) {
    var keys = (jwks && jwks.keys) || [];
    return keys.filter(function (k) {
      if (header.kid && k.kid && k.kid !== header.kid) return false;
      if (header.alg && k.alg && k.alg !== header.alg) return false;
      return true;
    });
  }

  /**
   * Verify a token against a JWKS by trying the keys whose kid/alg match.
   */
  function verifyJwtWithJwks(token, jwks, options) {
    options = options || {};
    var parsed = parseJwt(token);
    if (!parsed.ok) return Promise.resolve({ ok: false, error: parsed.error });
    var alg = parsed.header.alg;
    var spec = JWS_ALGORITHMS[alg];
    if (!spec) return Promise.resolve({ ok: false, error: "Unsupported or missing algorithm \"" + alg + "\"." });
    if (parsed.signature === "") return Promise.resolve({ ok: false, error: "The token has no signature segment." });

    var candidates = jwksCandidates(jwks, parsed.header);
    if (candidates.length === 0) {
      return Promise.resolve({ ok: false, error: "No key in the JWKS matches this token's kid/alg (kid " + JSON.stringify(parsed.header.kid || null) + ")." });
    }

    var sigBytes = base64UrlToBytes(parsed.signature);
    if (!sigBytes) return Promise.resolve({ ok: false, error: "The signature is not valid Base64url." });
    var data = utf8ToBytes(parsed.signingInput);
    var i = 0;

    function tryNext() {
      if (i >= candidates.length) {
        return Promise.resolve({ ok: true, valid: false, tried: candidates.length, error: "None of the " + candidates.length + " candidate key(s) matched the signature." });
      }
      var jwk = candidates[i++];
      return importJwkObject(jwk, alg, "verify").then(function (imported) {
        if (!imported.ok) return tryNext();
        return getSubtle().verify(signVerifyAlgorithm(spec), imported.key, sigBytes, data).then(function (valid) {
          if (valid) {
            return { ok: true, valid: true, tried: i, key: { kid: jwk.kid || null, alg: jwk.alg || null, kty: jwk.kty } };
          }
          return tryNext();
        }, function () {
          // A key that imports but cannot verify this algorithm is simply skipped.
          return tryNext();
        });
      });
    }
    return tryNext();
  }

  // -----------------------------------------------------------------------
  // One-shot analysis
  // -----------------------------------------------------------------------

  function analyzeToken(token, options) {
    options = options || {};
    var nowMs = typeof options.now === "number" ? options.now : Date.now();
    var parsed = parseJwt(token);
    if (!parsed.ok) return parsed;
    var claims = analyzeClaims(parsed.payload, { now: nowMs });
    var security = analyzeSecurity(parsed.header, parsed.payload, { now: nowMs });
    var expMs = typeof parsed.payload.exp === "number" ? parsed.payload.exp * 1000 : null;
    return {
      ok: true,
      parsed: parsed,
      claims: claims,
      security: security,
      size: parsed.token.length,
      sizeLabel: formatBytes(parsed.token.length),
      expired: expMs !== null && expMs <= nowMs
    };
  }

  return {
    // constants
    JWS_ALGORITHMS: JWS_ALGORITHMS,
    REGISTERED_CLAIMS: REGISTERED_CLAIMS,
    CLAIM_ORDER: CLAIM_ORDER,
    // base64 / bytes
    base64UrlToBytes: base64UrlToBytes,
    bytesToBase64Url: bytesToBase64Url,
    base64ToBytes: base64ToBytes,
    bytesToUtf8: bytesToUtf8,
    utf8ToBytes: utf8ToBytes,
    // parsing
    parseJwt: parseJwt,
    parseJwks: parseJwks,
    jwksCandidates: jwksCandidates,
    // analysis
    analyzeClaims: analyzeClaims,
    analyzeSecurity: analyzeSecurity,
    analyzeToken: analyzeToken,
    timeClaimStatus: timeClaimStatus,
    // crypto
    hasCrypto: hasCrypto,
    importKeyMaterial: importKeyMaterial,
    verifyJwt: verifyJwt,
    verifyJwtWithJwks: verifyJwtWithJwks,
    signJwt: signJwt,
    // formatting
    formatDuration: formatDuration,
    formatDate: formatDate,
    formatBytes: formatBytes,
    displayValue: displayValue
  };
});
