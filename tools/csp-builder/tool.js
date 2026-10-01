/* Toolshed — Content Security Policy Builder
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.cspBuilder and in Node via require() for tests.
 *
 * The module parses a Content-Security-Policy header or <meta> tag into a
 * directive map, builds a policy from directive values, validates and merges
 * policies, explains each directive in plain language, flags security
 * weaknesses, and exports to header / meta / Apache / Nginx / Cloudflare /
 * Netlify / Report-Only formats.
 *
 * Everything is computed from the user's input in memory. The module never
 * touches the network, never uses eval/dynamic code execution, and never
 * writes to storage.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.cspBuilder = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------

  // Directive catalogue. `default` is the starting value; `known` marks
  // directives the UI offers by default (less common but valid directives are
  // still accepted by the parser).
  var CATALOG = [
    { name: "default-src", label: "Default", group: "Fetch", default: "'self'", desc: "Fallback for every fetch directive that is not set explicitly.", known: true },
    { name: "script-src", label: "Scripts", group: "Fetch", default: "'self'", desc: "Where JavaScript may be loaded and executed from.", known: true },
    { name: "script-src-elem", label: "Script elements", group: "Fetch", default: "", desc: "Sources for <script> elements specifically, overriding script-src.", known: true },
    { name: "script-src-attr", label: "Inline script attributes", group: "Fetch", default: "", desc: "Controls inline event handlers such as onclick, overriding script-src.", known: true },
    { name: "style-src", label: "Styles", group: "Fetch", default: "'self'", desc: "Where stylesheets may be loaded from.", known: true },
    { name: "style-src-elem", label: "Style elements", group: "Fetch", default: "", desc: "Sources for <style> and <link rel=stylesheet>, overriding style-src.", known: true },
    { name: "style-src-attr", label: "Inline style attributes", group: "Fetch", default: "", desc: "Controls inline style attributes, overriding style-src.", known: true },
    { name: "img-src", label: "Images", group: "Fetch", default: "'self' data:", desc: "Where images may be loaded from.", known: true },
    { name: "font-src", label: "Fonts", group: "Fetch", default: "'self'", desc: "Where web fonts may be loaded from.", known: true },
    { name: "connect-src", label: "Connections", group: "Fetch", default: "'self'", desc: "Targets for fetch, XHR, WebSocket and EventSource.", known: true },
    { name: "media-src", label: "Media", group: "Fetch", default: "'self'", desc: "Where audio and video may be loaded from.", known: true },
    { name: "object-src", label: "Plugins", group: "Fetch", default: "'none'", desc: "Sources for <object>, <embed> and <applet>. Should be 'none'.", known: true },
    { name: "frame-src", label: "Frames", group: "Fetch", default: "'self'", desc: "Sources for nested browsing contexts such as <iframe>.", known: true },
    { name: "child-src", label: "Workers & frames (legacy)", group: "Fetch", default: "", desc: "Legacy fallback for frame-src and worker-src.", known: true },
    { name: "worker-src", label: "Workers", group: "Fetch", default: "", desc: "Sources for Worker, SharedWorker and ServiceWorker scripts.", known: true },
    { name: "manifest-src", label: "Web app manifest", group: "Fetch", default: "", desc: "Sources for the web app manifest.", known: true },
    { name: "prefetch-src", label: "Prefetch", group: "Fetch", default: "", desc: "Sources that may be prefetched or preloaded (deprecated).", known: false },

    { name: "base-uri", label: "Base URI", group: "Document", default: "'self'", desc: "Restricts the URLs that <base> may use.", known: true },
    { name: "sandbox", label: "Sandbox", group: "Document", default: "", desc: "Applies a sandbox to the page, similar to the iframe sandbox attribute.", known: true },
    { name: "form-action", label: "Form actions", group: "Document", default: "'self'", desc: "Where forms on the page may submit to.", known: true },
    { name: "frame-ancestors", label: "Frame ancestors", group: "Document", default: "'none'", desc: "Which pages may embed this page. Replaces X-Frame-Options.", known: true },
    { name: "navigate-to", label: "Navigate to", group: "Document", default: "", desc: "Restricts the URLs the page may navigate to (removed from the spec).", known: false },

    { name: "upgrade-insecure-requests", label: "Upgrade insecure requests", group: "Navigation", default: "", desc: "Rewrites http:// subresource URLs to https://.", known: true },
    { name: "block-all-mixed-content", label: "Block all mixed content", group: "Navigation", default: "", desc: "Blocks any http:// subresource on an https page.", known: true },

    { name: "report-uri", label: "Report URI (legacy)", group: "Reporting", default: "", desc: "Deprecated endpoint that receives violation reports as JSON POSTs.", known: true },
    { name: "report-to", label: "Report To", group: "Reporting", default: "", desc: "Reporting API group that receives violation reports.", known: true }
  ];

  var CATALOG_BY_NAME = {};
  CATALOG.forEach(function (d) { CATALOG_BY_NAME[d.name] = d; });

  var DEPRECATED = { "report-uri": true, "prefetch-src": true, "navigate-to": true, "block-all-mixed-content": true };

  var KNOWN_SCHEMES = { "http:": 1, "https:": 1, "data:": 1, "mediastream:": 1, "blob:": 1, "filesystem:": 1, "ws:": 1, "wss:": 1 };

  var SANDBOX_TOKENS = {
    "allow-downloads": 1, "allow-forms": 1, "allow-modals": 1, "allow-orientation-lock": 1,
    "allow-pointer-lock": 1, "allow-popups": 1, "allow-popups-to-escape-sandbox": 1,
    "allow-presentation": 1, "allow-same-origin": 1, "allow-scripts": 1, "allow-top-navigation": 1,
    "allow-top-navigation-by-user-activation": 1, "allow-top-navigation-to-custom-protocols": 1,
    "allow-storage-access-by-user-activation": 1
  };

  var PRESETS = {
    "strict": {
      "default-src": "'none'",
      "script-src": "'self'",
      "style-src": "'self'",
      "img-src": "'self'",
      "font-src": "'self'",
      "connect-src": "'self'",
      "object-src": "'none'",
      "base-uri": "'self'",
      "frame-ancestors": "'none'",
      "form-action": "'self'"
    },
    "baseline": {
      "default-src": "'self'",
      "script-src": "'self'",
      "style-src": "'self'",
      "img-src": "'self' data:",
      "font-src": "'self'",
      "connect-src": "'self'",
      "object-src": "'none'",
      "base-uri": "'self'",
      "frame-ancestors": "'self'",
      "form-action": "'self'",
      "upgrade-insecure-requests": ""
    },
    "google-analytics": {
      "script-src": "'self' https://www.googletagmanager.com",
      "connect-src": "'self' https://www.google-analytics.com https://analytics.google.com https://www.googletagmanager.com",
      "img-src": "'self' data: https://www.google-analytics.com https://www.googletagmanager.com"
    }
  };

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function uniq(list) {
    var seen = {};
    var out = [];
    list.forEach(function (v) {
      if (!seen[v]) { seen[v] = 1; out.push(v); }
    });
    return out;
  }

  function normalizeSource(value) {
    return String(value).trim().toLowerCase();
  }

  function decodeEntities(value) {
    return String(value)
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
  }

  function tokenize(input) {
    var out = [];
    var i = 0;
    var s = String(input);
    while (i < s.length) {
      var c = s[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") { i++; continue; }
      if (c === ";") { out.push({ type: "semi" }); i++; continue; }
      var buf = "";
      var inQuote = false;
      while (i < s.length) {
        var ch = s[i];
        if (inQuote) {
          buf += ch;
          if (ch === "'") inQuote = false;
          i++;
        } else if (ch === "'") {
          inQuote = true;
          buf += ch;
          i++;
        } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === ";") {
          break;
        } else {
          buf += ch;
          i++;
        }
      }
      if (buf) out.push({ type: "token", value: buf });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------

  /**
   * Parse a CSP string into a directive map.
   * Accepts a bare policy, a full "Content-Security-Policy: ..." header,
   * multiple headers separated by newlines, or a <meta http-equiv> tag.
   * @param {string} input
   * @returns {{ok: boolean, directives: Object<string,string[]>, order: string[], errors: string[], warnings: string[], reportOnly: boolean}}
   */
  function parseCSP(input) {
    var text = String(input == null ? "" : input);
    var errors = [];
    var warnings = [];
    var reportOnly = false;
    var foundPolicy = false;

    var policies = [];
    text.split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var headerMatch = trimmed.match(/^content-security-policy(?:-report-only)?\s*:\s*(.+)$/i);
      if (headerMatch) {
        if (/-report-only\s*:/i.test(trimmed)) reportOnly = true;
        policies.push(headerMatch[1]);
        foundPolicy = true;
        return;
      }
      var metaMatch = trimmed.match(/content\s*=\s*(["'])([\s\S]*?)\1/i);
      if (/<meta\b/i.test(trimmed) && /http-equiv\s*=\s*(["'])?content-security-policy/i.test(trimmed) && metaMatch) {
        policies.push(decodeEntities(metaMatch[2]));
        foundPolicy = true;
        return;
      }
      policies.push(trimmed);
    });

    if (policies.length === 0) policies.push("");

    // Split policies on top-level commas/newlines; a comma can appear inside a
    // data: URI, so only split when not inside quotes.
    var combined = policies.join("\n");
    var chunks = [];
    var inQuote = false;
    var current = "";
    for (var i = 0; i < combined.length; i++) {
      var ch = combined[i];
      if (ch === "'") inQuote = !inQuote;
      if ((ch === "," || ch === "\n") && !inQuote) {
        chunks.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    chunks.push(current);

    var directives = {};
    var order = [];
    chunks.forEach(function (chunk) {
      var tokens = tokenize(chunk);
      var name = null;
      tokens.forEach(function (tok) {
        if (tok.type === "semi") { name = null; return; }
        if (name === null) {
          name = tok.value.toLowerCase();
          if (!directives[name]) {
            directives[name] = [];
            order.push(name);
          } else {
            warnings.push("directive " + name + " appears more than once");
          }
        } else {
          directives[name].push(tok.value);
        }
      });
    });

    if (order.length === 0 && !foundPolicy) {
      errors.push("no directives found");
    }
    if (directives["report-uri"] && directives["report-to"]) {
      warnings.push("both report-uri and report-to are set; modern browsers prefer report-to");
    }

    return {
      ok: errors.length === 0,
      directives: directives,
      order: order,
      errors: errors,
      warnings: warnings,
      reportOnly: reportOnly
    };
  }

  // ---------------------------------------------------------------------
  // Building
  // ---------------------------------------------------------------------

  function directiveToString(name, sources) {
    var list = (sources || []).map(function (s) { return String(s).trim(); }).filter(Boolean);
    if (list.length === 0) return name;
    return name + " " + list.join(" ");
  }

  /**
   * Build a CSP string from a directive map.
   * @param {Object<string, string[]|string>} directives
   * @param {{sort?: boolean}} [options]
   * @returns {string}
   */
  function buildPolicy(directives, options) {
    var opts = options || {};
    var map = directives || {};
    var names = Object.keys(map).filter(function (n) {
      var v = map[n];
      return v !== undefined && v !== null;
    });
    if (opts.sort !== false) names.sort();
    return names.map(function (name) {
      var value = map[name];
      var sources = Array.isArray(value) ? value : String(value).split(/\s+/);
      return directiveToString(name, sources);
    }).join("; ");
  }

  /**
   * Resolve a directive's effective sources, following the fallback chain.
   * @returns {{sources: string[]|null, from: string|null}}
   */
  function effectiveSources(parsed, directive) {
    var d = parsed.directives || parsed;
    if (d[directive]) return { sources: d[directive], from: directive };
    var chain;
    if (directive === "script-src-elem" || directive === "script-src-attr") chain = ["script-src", "default-src"];
    else if (directive === "style-src-elem" || directive === "style-src-attr") chain = ["style-src", "default-src"];
    else if (directive === "frame-src") chain = ["child-src", "default-src"];
    else if (directive === "worker-src") chain = ["child-src", "script-src", "default-src"];
    else chain = ["default-src"];
    for (var i = 0; i < chain.length; i++) {
      if (d[chain[i]]) return { sources: d[chain[i]], from: chain[i] };
    }
    return { sources: null, from: null };
  }

  // ---------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------

  function isKnownSchemeSource(source) {
    return KNOWN_SCHEMES[source] === 1;
  }

  function looksLikeHost(source) {
    if (source === "*" || source === "'self'" || source === "'none'" || source === "'unsafe-inline'" || source === "'unsafe-eval'" || source === "'strict-dynamic'" || source === "'unsafe-hashes'" || source === "'report-sample'") return false;
    if (isKnownSchemeSource(source)) return false;
    if (source.indexOf("'nonce-") === 0 || source.indexOf("'sha256-") === 0 || source.indexOf("'sha384-") === 0 || source.indexOf("'sha512-") === 0) return false;
    if (source.indexOf("'") === 0) return false;
    return true;
  }

  function validateSource(source) {
    if (source === "*") return "wildcard source allows any origin";
    if (source === "'none'" || source === "'self'" || source === "'strict-dynamic'" || source === "'report-sample'") return null;
    if (source === "'unsafe-inline'") return "allows inline scripts/styles — weakens XSS protection";
    if (source === "'unsafe-eval'") return "allows eval() and similar — weakens XSS protection";
    if (source === "'unsafe-hashes'") return "allows specific inline event handlers; use sparingly";
    if (source.indexOf("'nonce-") === 0) {
      var nonce = source.slice(7, -1);
      if (nonce.length < 8) return "nonce is very short and may be guessable";
      return null;
    }
    if (source.indexOf("'sha256-") === 0 || source.indexOf("'sha384-") === 0 || source.indexOf("'sha512-") === 0) return null;
    if (source.charAt(0) === "'") return "unknown keyword source " + source;
    if (isKnownSchemeSource(source)) {
      if (source === "http:") return "plaintext http: source is insecure";
      if (source === "data:") return "data: URIs can be abused for injection in some directives";
      return null;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(source)) {
      var scheme = source.split("://")[0];
      if (scheme === "http") return "plaintext http:// source is insecure";
      return null;
    }
    var hostPart = source.replace(/^[^/]*\/\//, "").split("/")[0];
    if (hostPart === "") return "empty host";
    if (/[\s"']/.test(hostPart)) return "host contains whitespace or quotes";
    return null;
  }

  /**
   * Validate a parsed policy and report problems.
   * @returns {{errors: string[], warnings: string[], info: string[]}}
   */
  function validatePolicy(parsed) {
    var errors = [];
    var warnings = [];
    var info = [];
    var directives = parsed.directives || {};

    Object.keys(directives).forEach(function (name) {
      var sources = directives[name];
      if (name === "sandbox") {
        sources.forEach(function (s) {
          if (!SANDBOX_TOKENS[s.toLowerCase()]) {
            errors.push("sandbox takes tokens like allow-scripts, not the source " + s);
          }
        });
        return;
      }
      if (name === "report-uri" || name === "report-to") {
        sources.forEach(function (s) {
          if (!/^https?:\/\//i.test(s)) warnings.push(name + " value should be an absolute URL: " + s);
        });
        return;
      }
      if (name === "upgrade-insecure-requests" || name === "block-all-mixed-content") {
        if (sources.length > 0) warnings.push(name + " does not take any values");
        return;
      }
      if (DEPRECATED[name]) warnings.push(name + " is deprecated");
      if (sources.length === 0) {
        warnings.push(name + " has no sources");
        return;
      }
      sources.forEach(function (s) {
        var issue = validateSource(s);
        if (issue) warnings.push(name + " " + s + ": " + issue);
      });
    });

    var hasDefault = !!directives["default-src"];

    if (directives["script-src"]) {
      var scriptSrc = directives["script-src"];
      var hasStrictDynamic = scriptSrc.indexOf("'strict-dynamic'") !== -1;
      if (scriptSrc.indexOf("'unsafe-inline'") !== -1 && !hasStrictDynamic) {
        warnings.push("script-src 'unsafe-inline' disables inline-script protection");
      }
      if (scriptSrc.indexOf("'unsafe-eval'") !== -1) {
        warnings.push("script-src 'unsafe-eval' permits eval() and Function()");
      }
      if (scriptSrc.indexOf("*") !== -1) {
        warnings.push("script-src * allows scripts from any origin");
      }
    }

    if (!hasDefault) {
      warnings.push("no default-src — fetch directives without an explicit value are unrestricted");
    }

    var objSrc = directives["object-src"] || (hasDefault ? directives["default-src"] : null);
    if (!objSrc || objSrc.indexOf("'none'") === -1) {
      warnings.push("object-src should be 'none' to block plugin-based XSS");
    }

    var baseUri = directives["base-uri"] || (hasDefault ? directives["default-src"] : null);
    if (!baseUri) {
      warnings.push("base-uri is not set; a <base> tag could redirect relative URLs");
    }

    if (!directives["frame-ancestors"]) {
      info.push("frame-ancestors is not set; clickjacking protection relies on X-Frame-Options");
    }
    if (!directives["form-action"]) {
      info.push("form-action is not set; forms can submit to any origin");
    }

    if (parsed.reportOnly) {
      info.push("this is a report-only policy — violations are reported but not blocked");
    }

    var hasNonceOrHash = false;
    Object.keys(directives).forEach(function (name) {
      if (name === "script-src" || name === "script-src-elem" || name === "style-src" || name === "style-src-elem") {
        directives[name].forEach(function (s) {
          if (s.indexOf("'nonce-") === 0 || /^'sha(256|384|512)-/.test(s)) hasNonceOrHash = true;
        });
      }
    });
    if (hasNonceOrHash && directives["script-src"] && directives["script-src"].indexOf("'unsafe-inline'") !== -1) {
      info.push("a nonce or hash is present, so 'unsafe-inline' is ignored by modern browsers");
    }

    return { errors: uniq(errors), warnings: uniq(warnings), info: uniq(info) };
  }

  // ---------------------------------------------------------------------
  // Merge / intersect
  // ---------------------------------------------------------------------

  function sourcesFor(parsed, directive) {
    return effectiveSources(parsed, directive).sources || [];
  }

  /**
   * Intersect two policies: the result allows a source only if both inputs do.
   * A directive absent from one policy means "unrestricted" there, so it
   * inherits the other policy's value.
   */
  function intersectPolicies(a, b) {
    var aDirectives = a.directives || a;
    var bDirectives = b.directives || b;
    var names = uniq(Object.keys(aDirectives).concat(Object.keys(bDirectives))).sort();
    var out = {};
    var notes = [];

    names.forEach(function (name) {
      var aHas = !!aDirectives[name];
      var bHas = !!bDirectives[name];
      if (aHas && !bHas) { out[name] = aDirectives[name].slice(); return; }
      if (!aHas && bHas) { out[name] = bDirectives[name].slice(); return; }
      var aSet = {};
      aDirectives[name].forEach(function (s) { aSet[normalizeSource(s)] = true; });
      var shared = bDirectives[name].filter(function (s) { return aSet[normalizeSource(s)]; });
      if (shared.length === 0) {
        out[name] = ["'none'"];
        notes.push(name + ": the two policies share no source, so the result is 'none'");
      } else {
        out[name] = uniq(shared);
      }
    });

    return { directives: out, notes: notes };
  }

  /**
   * Merge policies, with later policies overriding earlier ones per directive.
   */
  function mergePolicies(policies) {
    var out = {};
    var order = [];
    (policies || []).forEach(function (p) {
      var d = p.directives || p;
      Object.keys(d).forEach(function (name) {
        out[name] = d[name].slice();
        order.push(name);
      });
    });
    return { directives: out, order: uniq(order) };
  }

  // ---------------------------------------------------------------------
  // Explanations
  // ---------------------------------------------------------------------

  function explainDirective(name) {
    var entry = CATALOG_BY_NAME[name];
    if (entry) return entry.desc;
    if (name.indexOf("-src") !== -1) return "Source list controlling where " + name.replace(/-src$/, "") + " resources may be loaded from.";
    return "Directive " + name + ".";
  }

  /**
   * Describe the effective, resolved policy: which directives apply, where each
   * value comes from, and the resolved sources.
   */
  function explainPolicy(parsed) {
    var directives = parsed.directives || {};
    var names = uniq(Object.keys(directives).concat([
      "default-src", "script-src", "style-src", "img-src", "connect-src",
      "font-src", "object-src", "frame-ancestors", "base-uri", "form-action"
    ])).sort();

    return names.map(function (name) {
      var eff = effectiveSources(parsed, name);
      return {
        name: name,
        set: !!directives[name],
        description: explainDirective(name),
        sources: eff.sources ? eff.sources.slice() : null,
        inheritedFrom: eff.from && eff.from !== name ? eff.from : null,
        deprecated: !!DEPRECATED[name]
      };
    });
  }

  // ---------------------------------------------------------------------
  // Security audit
  // ---------------------------------------------------------------------

  /**
   * Score a policy 0–100 and produce a grade plus findings.
   */
  function auditPolicy(parsed) {
    var directives = parsed.directives || {};
    var findings = [];
    var score = 0;

    function add(points, level, message) {
      score += points;
      findings.push({ level: level, message: message });
    }

    if (directives["default-src"]) add(10, "good", "default-src is set");
    else add(0, "bad", "no default-src — unlisted fetch directives are unrestricted");

    var script = sourcesFor(parsed, "script-src");
    if (directives["script-src"] || directives["default-src"]) {
      if (script.indexOf("'unsafe-inline'") !== -1) add(0, "bad", "script-src allows 'unsafe-inline'");
      else add(15, "good", "script-src does not allow 'unsafe-inline'");
      if (script.indexOf("'unsafe-eval'") !== -1) add(0, "bad", "script-src allows 'unsafe-eval'");
      else add(10, "good", "script-src does not allow 'unsafe-eval'");
      if (script.indexOf("*") !== -1) add(0, "bad", "script-src allows any origin (*)");
      else add(5, "good", "script-src is not a wildcard");
    } else {
      add(0, "bad", "script-src is not restricted");
    }

    var objectSrc = directives["object-src"] || (directives["default-src"] ? directives["default-src"] : []);
    if (objectSrc.indexOf("'none'") !== -1) add(10, "good", "object-src is 'none'");
    else add(0, "bad", "object-src is not 'none'");

    if (directives["base-uri"]) add(8, "good", "base-uri is set");
    else if (directives["default-src"]) add(3, "warn", "base-uri is not set (falls back to default-src)");
    else add(0, "bad", "base-uri is not set");

    if (directives["frame-ancestors"]) add(10, "good", "frame-ancestors is set");
    else add(0, "warn", "frame-ancestors is not set");

    if (directives["form-action"]) add(7, "good", "form-action is set");
    else add(0, "warn", "form-action is not set");

    if (directives["upgrade-insecure-requests"]) add(5, "good", "upgrade-insecure-requests is set");
    else add(0, "info", "upgrade-insecure-requests is not set");

    if (directives["report-to"] || directives["report-uri"]) add(5, "good", "violation reporting is configured");
    else add(0, "info", "no violation reporting endpoint configured");

    var def = directives["default-src"] || [];
    if (def.indexOf("*") !== -1) add(0, "bad", "default-src allows any origin (*)");
    else add(10, "good", "default-src is not a wildcard");

    var httpSources = [];
    Object.keys(directives).forEach(function (name) {
      directives[name].forEach(function (s) {
        if (/^http:/.test(s)) httpSources.push(name + " " + s);
      });
    });
    if (httpSources.length === 0) add(5, "good", "no plaintext http: sources");
    else add(0, "bad", "plaintext http: sources present: " + httpSources.join(", "));

    if (score > 100) score = 100;
    var grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 55 ? "D" : "F";

    return { score: score, grade: grade, findings: findings };
  }

  // ---------------------------------------------------------------------
  // Export formats
  // ---------------------------------------------------------------------

  /**
   * Render a policy in a named export format.
   * @param {string} format header|meta|apache|nginx|cloudflare|netlify|report-only|json
   * @param {string|object} policy
   */
  function exportPolicy(format, policy) {
    var isObj = policy && typeof policy === "object";
    var directives = isObj ? (policy.directives || policy) : null;
    var text = isObj ? buildPolicy(directives) : String(policy || "");
    var reportOnly = isObj ? !!policy.reportOnly : false;
    var headerName = reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";

    switch (format) {
      case "header":
        return headerName + ": " + text;
      case "report-only":
        return "Content-Security-Policy-Report-Only: " + text;
      case "meta":
        return '<meta http-equiv="Content-Security-Policy" content="' + escapeAttr(text) + '">';
      case "apache":
        return 'Header always set ' + headerName + " \"" + escapeApache(text) + '"';
      case "nginx":
        return "add_header " + headerName + ' "' + text + '" always;';
      case "cloudflare":
        return "# Cloudflare Transform Rule → Add response header\n# Header name: " + headerName + "\n# Value:\n" + text;
      case "netlify":
        return "/*\n  " + headerName + ": " + text;
      case "json":
        return JSON.stringify({ header: headerName, value: text, directives: directives || undefined }, null, 2);
      default:
        return text;
    }
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escapeApache(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // ---------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------

  function applyPreset(name) {
    var preset = PRESETS[name];
    if (!preset) return {};
    var out = {};
    Object.keys(preset).forEach(function (k) {
      out[k] = preset[k].split(/\s+/).filter(Boolean);
    });
    return out;
  }

  function presetNames() {
    return Object.keys(PRESETS);
  }

  // ---------------------------------------------------------------------
  // Metadata helpers for the UI
  // ---------------------------------------------------------------------

  function catalog() {
    return CATALOG.map(function (d) {
      return { name: d.name, label: d.label, group: d.group, default: d.default, desc: d.desc, known: d.known };
    });
  }

  function sourceSuggestions() {
    return ["'self'", "'none'", "'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "*", "data:", "https:", "blob:", "https://example.com"];
  }

  // ---------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------

  return {
    CATALOG: CATALOG,
    PRESETS: PRESETS,
    DEPRECATED: DEPRECATED,
    parseCSP: parseCSP,
    buildPolicy: buildPolicy,
    directiveToString: directiveToString,
    effectiveSources: effectiveSources,
    validatePolicy: validatePolicy,
    validateSource: validateSource,
    intersectPolicies: intersectPolicies,
    mergePolicies: mergePolicies,
    explainPolicy: explainPolicy,
    explainDirective: explainDirective,
    auditPolicy: auditPolicy,
    exportPolicy: exportPolicy,
    applyPreset: applyPreset,
    presetNames: presetNames,
    catalog: catalog,
    sourceSuggestions: sourceSuggestions
  };
});
