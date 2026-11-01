/* Toolshed — Data Redactor & Anonymizer
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.dataRedactor and in Node via require() for tests.
 *
 * The module scans arbitrary text (logs, CSV, JSON, notes, chat exports) for
 * sensitive values — personal data, credentials and secrets — and replaces
 * them according to a chosen strategy. It never touches the network, never
 * uses eval/dynamic code execution, and never writes to storage. Every value
 * it produces is derived from the user's own input.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.dataRedactor = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // =====================================================================
  // SHA-256 (pure JS)
  // =====================================================================
  //
  // A small, self-contained SHA-256 so the module behaves identically in the
  // browser and in Node without depending on Web Crypto (async) or node:crypto
  // (unavailable in a plain browser). Used only for the deterministic "hash"
  // strategy.

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function utf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return bytes;
  }

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  function sha256Hex(input) {
    var bytes = typeof input === "string" ? utf8Bytes(input) : input.slice();
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(bitLen / 0x100000000);
    var lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
    bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

    var h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    var w = new Array(64);

    for (var off = 0; off < bytes.length; off += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] =
          (bytes[off + i * 4] << 24) |
          (bytes[off + i * 4 + 1] << 16) |
          (bytes[off + i * 4 + 2] << 8) |
          bytes[off + i * 4 + 3];
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }

      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0;
      h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }

    var out = "";
    for (i = 0; i < 8; i++) out += ("00000000" + (h[i] >>> 0).toString(16)).slice(-8);
    return out;
  }

  // =====================================================================
  // Detectors
  // =====================================================================
  //
  // Each detector declares: a stable `id`, a human `label`, a `group`
  // (personal / credential / network), a `severity`, whether it is
  // `heuristic` (off by default and prone to false positives), a global
  // `pattern`, an optional `validate(value)` gate, and an optional `capture`
  // index (default 0) for patterns that wrap the sensitive value in a label.
  //
  // Patterns avoid nested unbounded quantifiers so they cannot exhibit
  // catastrophic backtracking on adversarial input.

  var DETECTORS = [
    {
      id: "private-key", label: "Private key", group: "credential", severity: "critical",
      pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
      description: "PEM-encoded private key block.",
    },
    {
      id: "aws-key", label: "AWS access key", group: "credential", severity: "critical",
      pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b/g,
      description: "AWS access key ID.",
    },
    {
      id: "github-token", label: "GitHub token", group: "credential", severity: "critical",
      pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
      description: "GitHub personal access, OAuth, app or refresh token.",
    },
    {
      id: "slack-token", label: "Slack token", group: "credential", severity: "critical",
      pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,80}\b/g,
      description: "Slack bot, user or app token.",
    },
    {
      id: "stripe-key", label: "Stripe key", group: "credential", severity: "critical",
      pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,99}\b/g,
      description: "Stripe secret, publishable or restricted key.",
    },
    {
      id: "google-api-key", label: "Google API key", group: "credential", severity: "critical",
      pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
      description: "Google API key.",
    },
    {
      id: "jwt", label: "JSON Web Token", group: "credential", severity: "high",
      pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}/g,
      description: "A signed or encrypted JWT.",
    },
    {
      id: "bearer-token", label: "Bearer token", group: "credential", severity: "high",
      pattern: /\bBearer[ \t]+([A-Za-z0-9._~+/=-]{16,4096})/g, capture: 1,
      description: "Authorization header bearer credential.",
    },
    {
      id: "basic-auth", label: "Basic auth", group: "credential", severity: "high",
      pattern: /\bBasic[ \t]+([A-Za-z0-9+/]{8,}={0,2})/g, capture: 1,
      description: "Authorization header basic credential.",
    },
    {
      id: "connection-string", label: "Connection string", group: "credential", severity: "critical",
      pattern: /\b[a-z][a-z0-9+.\-]{1,20}:\/\/[^\s:/@]{1,64}:([^\s:/@]{1,128})@[^\s/]{1,255}/g, capture: 1,
      description: "Password embedded in a URL-style connection string.",
    },
    {
      id: "assigned-secret", label: "Assigned secret", group: "credential", severity: "high",
      pattern: /(?:^|[^A-Za-z0-9])(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|private[_-]?key|credential)["']?\s*[:=]\s*["']?([^\s"'`,;)}\]]{6,512})/gi,
      capture: 1,
      description: "A value assigned to a secret-looking key, e.g. password=...",
    },
    {
      id: "email", label: "Email address", group: "personal", severity: "medium",
      // Requires a dotted domain ending in an alphabetic TLD so version and
      // package specifiers like `pkg@1.2.3` are not mistaken for addresses.
      pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}\b/g,
      description: "An email address.",
    },
    {
      id: "credit-card", label: "Card number", group: "personal", severity: "critical",
      pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
      validate: function (v) {
        var digits = v.replace(/[^0-9]/g, "");
        return digits.length >= 13 && digits.length <= 19 && luhn(digits);
      },
      description: "A payment card number that passes the Luhn check.",
    },
    {
      id: "iban", label: "IBAN", group: "personal", severity: "high",
      pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30}\b/g,
      validate: function (v) { return validIban(v); },
      description: "An International Bank Account Number.",
    },
    {
      id: "ssn", label: "US SSN", group: "personal", severity: "critical",
      pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
      validate: function (v) {
        var p = v.split("-");
        return p[0] !== "000" && p[0] !== "666" && Number(p[0]) < 900 && p[1] !== "00" && p[2] !== "0000";
      },
      description: "A US Social Security number.",
    },
    {
      id: "uk-nino", label: "UK National Insurance", group: "personal", severity: "high",
      pattern: /\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g,
      description: "A UK National Insurance number.",
    },
    {
      id: "phone", label: "Phone number", group: "personal", severity: "medium",
      pattern: /(?:\+?\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]?\d{2,4}(?:[ .-]?\d{2,4})?/g,
      validate: function (v) {
        var digits = v.replace(/[^0-9]/g, "");
        if (digits.length < 7 || digits.length > 15) return false;
        if (v.indexOf(".") !== -1) return false;
        return true;
      },
      description: "A phone number in a common grouped format.",
    },
    {
      id: "ipv4", label: "IPv4 address", group: "network", severity: "low",
      pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
      validate: function (v) {
        var p = v.split(".");
        for (var i = 0; i < 4; i++) {
          if (p[i].length > 1 && p[i][0] === "0") return false;
          if (Number(p[i]) > 255) return false;
        }
        return true;
      },
      description: "An IPv4 address.",
    },
    {
      id: "ipv6", label: "IPv6 address", group: "network", severity: "low",
      pattern: /(?:\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b|\b(?:[0-9A-Fa-f]{1,4}:){1,7}:|\b(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}\b|\b::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}\b)/g,
      description: "An IPv6 address.",
    },
    {
      id: "mac", label: "MAC address", group: "network", severity: "low",
      pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g,
      description: "A hardware MAC address.",
    },
    {
      id: "url", label: "URL", group: "network", severity: "low",
      pattern: /\bhttps?:\/\/[^\s<>"'`]{4,2048}/g,
      description: "An http(s) URL (may itself contain identifiers).",
    },
    {
      id: "person-name", label: "Person name", group: "personal", severity: "medium",
      heuristic: true,
      pattern: /(?:^|[^A-Za-z])(?:name|full[_-]?name|customer|client|patient|employee|user|contact|author|owner)["']?\s*[:=]\s*["']?((?:[A-Z][a-z]{1,20})(?:[ \t]+(?:[A-Z][a-z]{1,20}|[A-Z]\.)){1,3})/g,
      capture: 1,
      description: "A name following a labelling field such as name: ... (heuristic).",
    },
    {
      id: "dob", label: "Date of birth", group: "personal", severity: "medium",
      heuristic: true,
      pattern: /(?:^|[^A-Za-z])(?:dob|date[_-]?of[_-]?birth|birth[_-]?date|born)["']?\s*[:=]\s*["']?(\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|\d{4}\/\d{1,2}\/\d{1,2})/gi,
      capture: 1,
      description: "A date following a birth-date label such as dob: ... (heuristic).",
    },
    {
      id: "address", label: "Postal address", group: "personal", severity: "medium",
      heuristic: true,
      pattern: /(?:^|[^A-Za-z])(?:address|addr|street|shipping[_-]?address|billing[_-]?address)["']?\s*[:=]\s*["']?(\d{1,6}[ \t]+[A-Za-z0-9][A-Za-z0-9 .'\-]{2,60}(?:[ \t]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl|Terrace|Highway|Hwy)\.?)?)/g,
      capture: 1,
      description: "A street address following an address label such as address: ... (heuristic).",
    },
  ];

  var DETECTOR_BY_ID = {};
  for (var di = 0; di < DETECTORS.length; di++) DETECTOR_BY_ID[DETECTORS[di].id] = DETECTORS[di];

  // =====================================================================
  // Validators / helpers
  // =====================================================================

  function luhn(digits) {
    var sum = 0;
    var alt = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var d = digits.charCodeAt(i) - 48;
      if (d < 0 || d > 9) return false;
      if (alt) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      alt = !alt;
    }
    return sum % 10 === 0 && sum > 0;
  }

  function validIban(raw) {
    var s = raw.replace(/[ \t]/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
    var rearranged = s.slice(4) + s.slice(0, 4);
    var remainder = 0;
    for (var i = 0; i < rearranged.length; i++) {
      var ch = rearranged[i];
      var val = (ch >= "0" && ch <= "9") ? ch : String(ch.charCodeAt(0) - 55);
      for (var j = 0; j < val.length; j++) {
        remainder = (remainder * 10 + (val.charCodeAt(j) - 48)) % 97;
      }
    }
    return remainder === 1;
  }

  function shannonEntropy(str) {
    if (!str.length) return 0;
    var counts = Object.create(null);
    for (var i = 0; i < str.length; i++) counts[str[i]] = (counts[str[i]] || 0) + 1;
    var entropy = 0;
    for (var key in counts) {
      var p = counts[key] / str.length;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  // =====================================================================
  // Options
  // =====================================================================

  var STRATEGIES = ["redact", "mask", "hash", "tokenize", "remove"];

  function defaultEnabled() {
    var enabled = {};
    for (var i = 0; i < DETECTORS.length; i++) {
      enabled[DETECTORS[i].id] = !DETECTORS[i].heuristic;
    }
    return enabled;
  }

  function normalizeOptions(options) {
    var o = options || {};
    var enabled = defaultEnabled();
    // Already-normalized options (they carry an `enabled` map) are reused as-is
    // so passing normalized options back into detect() does not reset them.
    if (o.enabled && typeof o.enabled === "object") {
      for (var eid in enabled) {
        if (Object.prototype.hasOwnProperty.call(o.enabled, eid)) {
          enabled[eid] = !!o.enabled[eid];
        }
      }
    }
    if (o.categories && typeof o.categories === "object") {
      for (var id in o.categories) {
        if (Object.prototype.hasOwnProperty.call(DETECTOR_BY_ID, id)) {
          enabled[id] = !!o.categories[id];
        }
      }
    }
    var customTerms = [];
    if (Array.isArray(o.customTerms)) {
      var seen = Object.create(null);
      for (var t = 0; t < o.customTerms.length; t++) {
        var term = o.customTerms[t];
        if (typeof term !== "string") continue;
        term = term.trim();
        if (!term || seen[term]) continue;
        seen[term] = true;
        customTerms.push(term);
        if (customTerms.length >= 200) break;
      }
    }
    var strategy = STRATEGIES.indexOf(o.strategy) !== -1 ? o.strategy : "redact";
    var overrides = {};
    if (o.strategyOverrides && typeof o.strategyOverrides === "object") {
      for (var key in o.strategyOverrides) {
        if (Object.prototype.hasOwnProperty.call(DETECTOR_BY_ID, key) &&
            STRATEGIES.indexOf(o.strategyOverrides[key]) !== -1) {
          overrides[key] = o.strategyOverrides[key];
        }
      }
    }
    var maskKeep = typeof o.maskKeep === "number" && o.maskKeep >= 0 ? Math.min(8, Math.floor(o.maskKeep)) : 2;
    return {
      enabled: enabled,
      customTerms: customTerms,
      strategy: strategy,
      strategyOverrides: overrides,
      maskKeep: maskKeep,
      salt: typeof o.salt === "string" ? o.salt : "",
      tokenPrefix: typeof o.tokenPrefix === "string" ? o.tokenPrefix : "",
      hashLength: typeof o.hashLength === "number" ? Math.max(6, Math.min(32, Math.floor(o.hashLength))) : 10,
    };
  }

  function strategyFor(id, opts) {
    return opts.strategyOverrides[id] || opts.strategy;
  }

  // =====================================================================
  // Detection
  // =====================================================================

  /**
   * Find every sensitive span in `text`.
   * Returns findings sorted by start offset with overlaps resolved by
   * severity, then match length, then detector order.
   */
  function detect(text, options) {
    var opts = normalizeOptions(options);
    if (typeof text !== "string" || text.length === 0) return [];

    var candidates = [];
    for (var d = 0; d < DETECTORS.length; d++) {
      var det = DETECTORS[d];
      if (!opts.enabled[det.id]) continue;
      var re = new RegExp(det.pattern.source, det.pattern.flags);
      var m;
      var guard = 0;
      while ((m = re.exec(text)) !== null) {
        if (guard++ > 100000) break;
        var capture = det.capture || 0;
        var value = m[capture];
        if (value === undefined || value === null || value.length === 0) {
          if (m[0].length === 0) re.lastIndex++;
          continue;
        }
        var start = m.index + (capture > 0 ? m[0].indexOf(value) : 0);
        var end = start + value.length;
        if (det.validate && !det.validate(value, text, start)) {
          if (m[0].length === 0) re.lastIndex++;
          continue;
        }
        candidates.push({
          type: det.id,
          label: det.label,
          group: det.group,
          severity: det.severity,
          heuristic: !!det.heuristic,
          value: value,
          start: start,
          end: end,
          order: d,
        });
        if (m[0].length === 0) re.lastIndex++;
      }
    }

    // Custom literal terms supplied by the user. Matched case-sensitively and
    // as whole occurrences; longest terms are matched first so overlapping
    // user terms resolve sensibly.
    if (opts.customTerms.length) {
      var sortedTerms = opts.customTerms.slice().sort(function (a, b) { return b.length - a.length; });
      for (var ti = 0; ti < sortedTerms.length; ti++) {
        var term = sortedTerms[ti];
        var from = 0;
        var idx;
        while ((idx = text.indexOf(term, from)) !== -1) {
          candidates.push({
            type: "custom",
            label: "Custom term",
            group: "custom",
            severity: "medium",
            heuristic: false,
            value: term,
            start: idx,
            end: idx + term.length,
            order: DETECTORS.length + ti,
          });
          from = idx + term.length;
        }
      }
    }

    return resolveOverlaps(candidates);
  }

  var SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

  function resolveOverlaps(candidates) {
    // Highest priority first: earlier start, then higher severity, then a
    // longer span (so a private-key block beats an email inside it), then
    // detector declaration order for stability.
    candidates.sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      var sa = SEVERITY_RANK[a.severity], sb = SEVERITY_RANK[b.severity];
      if (sa !== sb) return sa - sb;
      if (a.end !== b.end) return b.end - a.end;
      return a.order - b.order;
    });

    var accepted = [];
    var lastEnd = -1;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c.start >= lastEnd) {
        accepted.push(c);
        lastEnd = c.end;
      }
    }
    return accepted;
  }

  // =====================================================================
  // Replacement strategies
  // =====================================================================

  function labelFor(det, opts) {
    return (opts.tokenPrefix ? opts.tokenPrefix : "") + det.label.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  }

  function maskValue(value, det, opts) {
    var keep = opts.maskKeep;
    if (det.id === "email" && value.indexOf("@") > 0) {
      var at = value.indexOf("@");
      var local = value.slice(0, at);
      var domain = value.slice(at);
      var keepLocal = Math.min(keep, Math.max(0, local.length - 1));
      return local.slice(0, keepLocal) + "*".repeat(Math.max(1, local.length - keepLocal)) + domain;
    }
    if (value.length <= keep * 2 + 1) return "*".repeat(value.length);
    var middle = value.length - keep * 2;
    return value.slice(0, keep) + "*".repeat(Math.min(middle, 16)) + value.slice(value.length - keep);
  }

  function hashValue(value, det, opts) {
    var hex = sha256Hex(opts.salt + "\u0000" + det.id + "\u0000" + value);
    return labelFor(det, opts) + ":" + hex.slice(0, opts.hashLength);
  }

  function buildReplacement(det, value, strategy, opts, state) {
    switch (strategy) {
      case "remove":
        return "";
      case "mask":
        return maskValue(value, det, opts);
      case "hash":
        return hashValue(value, det, opts);
      case "tokenize": {
        var key = det.id + "\u0000" + value;
        if (!state.tokenMap[key]) {
          state.tokenCounters[det.id] = (state.tokenCounters[det.id] || 0) + 1;
          state.tokenMap[key] = labelFor(det, opts) + "_" + state.tokenCounters[det.id];
        }
        return state.tokenMap[key];
      }
      case "redact":
      default:
        return "[" + labelFor(det, opts) + "]";
    }
  }

  // =====================================================================
  // Public API
  // =====================================================================

  function summarize(findings, text, opts) {
    var byType = {};
    var bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    var redactedChars = 0;
    var uniqueValues = Object.create(null);
    for (var i = 0; i < findings.length; i++) {
      var f = findings[i];
      if (!byType[f.type]) {
        byType[f.type] = {
          id: f.type, label: f.label, group: f.group, severity: f.severity,
          heuristic: f.heuristic, count: 0, unique: 0,
        };
      }
      byType[f.type].count++;
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      redactedChars += f.value.length;
      uniqueValues[f.type + "\u0000" + f.value] = true;
    }
    for (var key in uniqueValues) {
      var type = key.slice(0, key.indexOf("\u0000"));
      if (byType[type]) byType[type].unique++;
    }
    var types = Object.keys(byType).map(function (k) { return byType[k]; })
      .sort(function (a, b) { return b.count - a.count || a.id.localeCompare(b.id); });
    return {
      total: findings.length,
      totalChars: text ? text.length : 0,
      redactedChars: redactedChars,
      bySeverity: bySeverity,
      byType: types,
    };
  }

  /**
   * Scan text and return findings plus aggregate statistics, without
   * producing redacted output.
   */
  function scan(text, options) {
    var opts = normalizeOptions(options);
    var findings = detect(text, opts);
    return { findings: findings, stats: summarize(findings, text, opts) };
  }

  /**
   * Redact `text` according to `options`.
   * Returns { ok, text, findings, stats, mapping } or { ok:false, error }.
   * `mapping` maps every replacement back to its original value and is kept
   * in memory only — it is what powers Restore.
   */
  function redact(text, options) {
    if (typeof text !== "string") {
      return { ok: false, error: "Input must be text." };
    }
    var opts = normalizeOptions(options);
    var findings = detect(text, opts);
    var state = { tokenMap: {}, tokenCounters: {} };
    var mapping = [];
    var out = [];
    var cursor = 0;

    for (var i = 0; i < findings.length; i++) {
      var f = findings[i];
      if (f.start < cursor) continue;
      out.push(text.slice(cursor, f.start));
      var det = DETECTOR_BY_ID[f.type] || {
        id: "custom", label: "Custom term", group: "custom", severity: "medium",
      };
      var strategy = strategyFor(f.type, opts);
      var replacement = buildReplacement(det, f.value, strategy, opts, state);
      out.push(replacement);
      f.strategy = strategy;
      f.replacement = replacement;
      if (strategy !== "remove") {
        mapping.push({ replacement: replacement, original: f.value, type: f.type });
      }
      cursor = f.end;
    }
    out.push(text.slice(cursor));

    return {
      ok: true,
      text: out.join(""),
      findings: findings,
      stats: summarize(findings, text, opts),
      mapping: mapping,
      strategy: opts.strategy,
    };
  }

  /**
   * Replace every replacement token in `text` with its original value.
   * Longest tokens first so token names that share a prefix restore cleanly.
   * Best-effort: values that appear in the text by coincidence are replaced
   * too, which is why the mapping is only meaningful for text this module
   * produced.
   */
  function restore(text, mapping) {
    if (typeof text !== "string" || !Array.isArray(mapping)) return text;
    var entries = mapping.slice().sort(function (a, b) {
      return b.replacement.length - a.replacement.length;
    });
    var out = text;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || !e.replacement) continue;
      out = out.split(e.replacement).join(e.original);
    }
    return out;
  }

  // =====================================================================
  // Reporting
  // =====================================================================

  function toJSONReport(result, reportOptions) {
    var includeOriginals = !reportOptions || reportOptions.includeOriginals !== false;
    var payload = {
      generatedBy: "Toolshed Data Redactor",
      strategy: result.strategy || null,
      stats: result.stats,
      findings: result.findings.map(function (f) {
        return {
          type: f.type,
          label: f.label,
          severity: f.severity,
          group: f.group,
          start: f.start,
          end: f.end,
          original: includeOriginals ? f.value : null,
          replacement: f.replacement === undefined ? null : f.replacement,
        };
      }),
    };
    return JSON.stringify(payload, null, 2);
  }

  function csvCell(value) {
    var s = String(value === undefined || value === null ? "" : value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSVReport(findings, reportOptions) {
    var includeOriginals = !reportOptions || reportOptions.includeOriginals !== false;
    var rows = [["type", "label", "severity", "start", "end", "original", "replacement"]];
    for (var i = 0; i < findings.length; i++) {
      var f = findings[i];
      rows.push([
        f.type, f.label, f.severity, f.start, f.end,
        includeOriginals ? f.value : "",
        f.replacement === undefined ? "" : f.replacement,
      ]);
    }
    return rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
  }

  function toMarkdownReport(result) {
    var stats = result.stats;
    var lines = [];
    lines.push("# Redaction report");
    lines.push("");
    lines.push("- Findings: **" + stats.total + "**");
    lines.push("- Characters replaced: **" + stats.redactedChars + "**");
    lines.push("- Critical: " + stats.bySeverity.critical +
      " | High: " + stats.bySeverity.high +
      " | Medium: " + stats.bySeverity.medium +
      " | Low: " + stats.bySeverity.low);
    lines.push("");
    if (!stats.byType.length) {
      lines.push("No sensitive values were detected.");
      return lines.join("\n");
    }
    lines.push("| Category | Severity | Findings | Unique values |");
    lines.push("| --- | --- | ---: | ---: |");
    for (var i = 0; i < stats.byType.length; i++) {
      var t = stats.byType[i];
      lines.push("| " + t.label + (t.heuristic ? " (heuristic)" : "") + " | " + t.severity +
        " | " + t.count + " | " + t.unique + " |");
    }
    return lines.join("\n");
  }

  // =====================================================================
  // Introspection for the UI
  // =====================================================================

  function listDetectors() {
    return DETECTORS.map(function (d) {
      return {
        id: d.id, label: d.label, group: d.group, severity: d.severity,
        heuristic: !!d.heuristic, description: d.description,
      };
    });
  }

  return {
    // detection
    detect: detect,
    scan: scan,
    // transformation
    redact: redact,
    restore: restore,
    // reporting
    toJSONReport: toJSONReport,
    toCSVReport: toCSVReport,
    toMarkdownReport: toMarkdownReport,
    // introspection
    listDetectors: listDetectors,
    defaultOptions: defaultEnabled,
    // primitives (exported for tests and reuse)
    sha256Hex: sha256Hex,
    luhn: luhn,
    validIban: validIban,
    shannonEntropy: shannonEntropy,
    maskValue: maskValue,
    STRATEGIES: STRATEGIES.slice(),
  };
});
