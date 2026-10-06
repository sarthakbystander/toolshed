/* Toolshed — Design Token Studio
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.designTokenStudio and in Node via require() for tests.
 *
 * The module parses design tokens from JSON (DTCG or flat), CSS custom
 * properties, SCSS variables and Less variables; normalizes values (colors,
 * numbers, dimensions); resolves alias references such as {color.brand} and
 * var(--color-brand); checks WCAG contrast; and serializes the result back to
 * JSON, DTCG, CSS, SCSS, Less, Tailwind, Swift and Android resources.
 *
 * Everything runs in memory. No network, no eval, no storage.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.designTokenStudio = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // -------------------------------------------------------------------
  // Small value parsers
  // -------------------------------------------------------------------

  var NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;
  var DIMENSION_RE = /^([-+]?(?:\d+\.?\d*|\.\d+))([a-z%]+)$/i;
  var HEX_RE = /^#([0-9a-fA-F]{3,8})$/;
  var FUNC_RE = /^(rgba?|hsla?)\(([^)]*)\)$/i;
  var REF_RE = /\{([^{}]+)\}|var\(\s*(--[A-Za-z0-9_.-]+)\s*(?:,[^()]*)?\)/g;

  /**
   * Extract alias references from a raw value. Recognizes DTCG braces
   * ({color.brand}) and CSS custom-property functions (var(--color-brand)).
   * @param {*} value
   * @returns {string[]}
   */
  function extractRefs(value) {
    var s = String(value == null ? "" : value);
    var refs = [];
    var re = new RegExp(REF_RE.source, "g");
    var m;
    while ((m = re.exec(s)) !== null) {
      var ref = (m[1] || m[2] || "").trim();
      if (ref) refs.push(ref);
    }
    return refs;
  }

  function clampByte(n) {
    n = Math.round(n);
    if (n < 0) return 0;
    if (n > 255) return 255;
    return n;
  }

  function clamp01(n) {
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  function round(n, places) {
    var f = Math.pow(10, places == null ? 4 : places);
    return Math.round(n * f) / f;
  }

  // -------------------------------------------------------------------
  // Colors
  // -------------------------------------------------------------------

  function hexToRgb(hex) {
    var m = String(hex == null ? "" : hex).trim().match(HEX_RE);
    if (!m) return null;
    var h = m[1];
    var r, g, b, a = 1;
    if (h.length === 3 || h.length === 4) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
      if (h.length === 4) a = parseInt(h[3] + h[3], 16) / 255;
    } else if (h.length === 6 || h.length === 8) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
    } else {
      return null;
    }
    return { r: r, g: g, b: b, a: a };
  }

  function rgbToHex(r, g, b, a) {
    function two(n) {
      var s = clampByte(n).toString(16);
      return s.length === 1 ? "0" + s : s;
    }
    var hex = "#" + two(r) + two(g) + two(b);
    if (a != null && a < 1) hex += two(a * 255);
    return hex;
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var h = 0, s = 0;
    var l = (max + min) / 2;
    var d = max - min;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: round(h, 2), s: round(s * 100, 2), l: round(l * 100, 2) };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp01(s / 100);
    l = clamp01(l / 100);
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return {
      r: clampByte((r + m) * 255),
      g: clampByte((g + m) * 255),
      b: clampByte((b + m) * 255)
    };
  }

  function parseNumberOrPercent(token, scale) {
    var s = String(token).trim();
    if (s.endsWith("%")) return parseFloat(s) / 100 * scale;
    return parseFloat(s);
  }

  function parseRgbArgs(args) {
    var body = String(args).trim();
    var alpha = 1;
    var slash = body.split("/");
    var main = slash[0].trim();
    if (slash.length > 1) alpha = parseNumberOrPercent(slash[1].trim(), 1);
    var parts = main.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    var r = parseNumberOrPercent(parts[0], 255);
    var g = parseNumberOrPercent(parts[1], 255);
    var b = parseNumberOrPercent(parts[2], 255);
    if (parts.length > 3) alpha = parseNumberOrPercent(parts[3], 1);
    if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(alpha)) return null;
    return { r: clampByte(r), g: clampByte(g), b: clampByte(b), a: round(clamp01(alpha), 4) };
  }

  function parseHslArgs(args) {
    var body = String(args).trim();
    var alpha = 1;
    var slash = body.split("/");
    var main = slash[0].trim();
    if (slash.length > 1) alpha = parseNumberOrPercent(slash[1].trim(), 1);
    var parts = main.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    var h = parseFloat(parts[0]);
    var s = parseFloat(parts[1]);
    var l = parseFloat(parts[2]);
    if (parts.length > 3) alpha = parseNumberOrPercent(parts[3], 1);
    if (isNaN(h) || isNaN(s) || isNaN(l) || isNaN(alpha)) return null;
    var rgb = hslToRgb(h, s, l);
    return { r: rgb.r, g: rgb.g, b: rgb.b, a: round(clamp01(alpha), 4) };
  }

  /**
   * Parse a CSS color value into RGBA. Supports #rgb/#rgba/#rrggbb/#rrggbbaa,
   * rgb()/rgba() and hsl()/hsla() in comma or space syntax.
   * @param {string} input
   * @returns {{r:number,g:number,b:number,a:number,hex:string}|null}
   */
  function parseColor(input) {
    var s = String(input == null ? "" : input).trim();
    var rgba = null;
    if (HEX_RE.test(s)) {
      rgba = hexToRgb(s);
    } else {
      var m = s.match(FUNC_RE);
      if (m) {
        var fn = m[1].toLowerCase();
        rgba = fn.charAt(0) === "r" ? parseRgbArgs(m[2]) : parseHslArgs(m[2]);
      }
    }
    if (!rgba) return null;
    rgba.hex = rgbToHex(rgba.r, rgba.g, rgba.b, rgba.a);
    return rgba;
  }

  /**
   * Classify a raw token value.
   * @param {*} value
   * @returns {{kind:string,text:string,alpha:number,color?:object,unit?:string,number?:number}}
   */
  function parseValue(value) {
    if (value == null) return { kind: "empty", text: "", alpha: 1 };
    if (typeof value === "number") {
      return { kind: "number", text: String(value), number: value, alpha: 1 };
    }
    if (typeof value === "boolean") {
      return { kind: "number", text: String(value), number: value ? 1 : 0, alpha: 1 };
    }
    var s = String(value).trim();
    if (s === "") return { kind: "empty", text: "", alpha: 1 };
    var color = parseColor(s);
    if (color) return { kind: "color", text: s, color: color, alpha: color.a };
    if (NUMBER_RE.test(s)) return { kind: "number", text: s, number: parseFloat(s), alpha: 1 };
    var m = s.match(DIMENSION_RE);
    if (m) {
      return { kind: "dimension", text: s, number: parseFloat(m[1]), unit: m[2].toLowerCase(), alpha: 1 };
    }
    return { kind: "other", text: s, alpha: 1 };
  }

  function srgbChannel(c) {
    var v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(color) {
    var c = typeof color === "string" ? parseColor(color) : color;
    if (!c) return null;
    return 0.2126 * srgbChannel(c.r) + 0.7152 * srgbChannel(c.g) + 0.0722 * srgbChannel(c.b);
  }

  /**
   * WCAG 2.1 contrast ratio between two colors.
   * @returns {number|null} ratio rounded to two decimals, or null for bad input
   */
  function contrastRatio(a, b) {
    var la = relativeLuminance(a);
    var lb = relativeLuminance(b);
    if (la == null || lb == null) return null;
    var hi = Math.max(la, lb);
    var lo = Math.min(la, lb);
    return round((hi + 0.05) / (lo + 0.05), 2);
  }

  function wcagRating(ratio) {
    if (ratio == null) return null;
    return {
      ratio: ratio,
      aaa: ratio >= 7,
      aa: ratio >= 4.5,
      aaLarge: ratio >= 3,
      level: ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA Large" : "Fail"
    };
  }

  /**
   * Composite a translucent foreground over an opaque background.
   * @param {object} fg
   * @param {object} [bg] defaults to white
   * @param {number} [alpha] overrides fg.a
   * @returns {{r:number,g:number,b:number,a:number,hex:string}}
   */
  function blend(fg, bg, alpha) {
    var a = alpha == null ? fg.a : alpha;
    a = clamp01(a);
    var base = bg || { r: 255, g: 255, b: 255 };
    var out = {
      r: clampByte(fg.r * a + base.r * (1 - a)),
      g: clampByte(fg.g * a + base.g * (1 - a)),
      b: clampByte(fg.b * a + base.b * (1 - a)),
      a: 1
    };
    out.hex = rgbToHex(out.r, out.g, out.b, 1);
    return out;
  }

  // -------------------------------------------------------------------
  // Name normalization and references
  // -------------------------------------------------------------------

  /**
   * Normalize a token name or reference to a comparable key: strip a leading
   * --, $ or @ and turn dots into dashes.
   * @param {string} name
   * @returns {string}
   */
  function normalizeName(name) {
    return String(name == null ? "" : name)
      .trim()
      .replace(/^\{/, "")
      .replace(/\}$/, "")
      .replace(/^--/, "")
      .replace(/^\$/, "")
      .replace(/^@/, "")
      .replace(/\./g, "-");
  }

  function buildIndex(tokens) {
    var map = Object.create(null);
    var duplicates = [];
    for (var i = 0; i < tokens.length; i++) {
      var key = normalizeName(tokens[i].name);
      if (key in map) duplicates.push(tokens[i].name);
      else map[key] = tokens[i];
    }
    return { map: map, duplicates: duplicates };
  }

  /**
   * Resolve every token's value, following references. Detects broken and
   * circular references instead of throwing.
   * @param {Array<object>} tokens
   * @returns {{map:object, issues:{duplicates:string[],broken:string[],cycles:string[]}}}
   */
  function resolveAll(tokens) {
    var index = buildIndex(tokens);
    var cache = Object.create(null);
    var broken = [];
    var cycles = [];

    function resolveKey(key, stack) {
      if (key in cache) return cache[key];
      var token = index.map[key];
      if (!token) return { ok: false, error: "Unknown reference: " + key, missing: key };
      if (stack.indexOf(key) !== -1) {
        if (cycles.indexOf(key) === -1) cycles.push(key);
        return { ok: false, error: "Circular reference: " + key, cycle: true };
      }
      var nextStack = stack.concat([key]);
      var raw = String(token.value == null ? "" : token.value);
      var failed = null;
      var replaced = raw.replace(REF_RE, function (match, brace, varName) {
        var refKey = normalizeName(brace || varName);
        var r = resolveKey(refKey, nextStack);
        if (!r.ok) {
          if (!failed) failed = r;
          return match;
        }
        return r.value;
      });
      var result;
      if (failed) {
        result = { ok: false, error: failed.error, missing: failed.missing, cycle: failed.cycle, raw: raw };
        if (broken.indexOf(token.name) === -1) broken.push(token.name);
      } else {
        result = { ok: true, value: replaced, raw: raw };
      }
      cache[key] = result;
      return result;
    }

    for (var i = 0; i < tokens.length; i++) {
      resolveKey(normalizeName(tokens[i].name), []);
    }

    return {
      map: cache,
      issues: { duplicates: index.duplicates, broken: broken, cycles: cycles }
    };
  }

  // -------------------------------------------------------------------
  // Parsing — JSON (DTCG and flat)
  // -------------------------------------------------------------------

  function detectDtcg(data) {
    if (Array.isArray(data) || typeof data !== "object" || data === null) return false;
    var stack = [data];
    while (stack.length) {
      var node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Object.prototype.hasOwnProperty.call(node, "$value")) return true;
      for (var k in node) {
        if (k.charAt(0) === "$") continue;
        if (node[k] && typeof node[k] === "object") stack.push(node[k]);
      }
    }
    return false;
  }

  function makeToken(name, value, group, description, type) {
    var parsed = parseValue(value);
    return {
      name: name,
      value: value,
      raw: String(value == null ? "" : value),
      group: group || "",
      description: description || "",
      type: type || "",
      kind: parsed.kind,
      alpha: parsed.alpha,
      color: parsed.color || null,
      refs: extractRefs(value)
    };
  }

  function walkDtcg(node, path, inheritedType, tokens) {
    for (var key in node) {
      if (key.charAt(0) === "$") continue;
      var value = node[key];
      var type = (value && typeof value === "object" && !Array.isArray(value) && value.$type) || inheritedType || "";
      var nextPath = path.concat(key);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        // A node may carry a value and still have children (a group with a
        // value of its own), so record the value and keep descending.
        if (Object.prototype.hasOwnProperty.call(value, "$value")) {
          tokens.push(makeToken(nextPath.join("-"), value.$value,
            path.join("-"), value.$description, type));
        }
        walkDtcg(value, nextPath, type, tokens);
      } else {
        tokens.push(makeToken(nextPath.join("-"), value, path.join("-"), "", type));
      }
    }
  }

  function walkFlat(node, path, tokens) {
    for (var key in node) {
      var value = node[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        walkFlat(value, path.concat(key), tokens);
      } else if (Array.isArray(value)) {
        tokens.push(makeToken(path.concat(key).join("-"), JSON.stringify(value), path.join("-"), "", ""));
      } else {
        tokens.push(makeToken(path.concat(key).join("-"), value, path.join("-"), "", ""));
      }
    }
  }

  function parseJsonTokens(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { error: "Invalid JSON: " + err.message };
    }
    var tokens = [];
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) {
        var item = data[i];
        if (item && typeof item === "object" && ("value" in item || "$value" in item)) {
          var v = item.$value !== undefined ? item.$value : item.value;
          tokens.push(makeToken(String(item.name || item.$name || ("token-" + i)), v,
            item.group || "", item.description || item.$description, item.$type || item.type || ""));
        }
      }
      if (!tokens.length) return { error: "JSON array did not contain any { name, value } tokens." };
      return { tokens: tokens };
    }
    if (typeof data !== "object" || data === null) {
      return { error: "JSON must be an object of tokens or an array of { name, value } objects." };
    }
    if (detectDtcg(data)) walkDtcg(data, [], "", tokens);
    else walkFlat(data, [], tokens);
    if (!tokens.length) return { error: "No tokens found in the JSON." };
    return { tokens: tokens };
  }

  // -------------------------------------------------------------------
  // Parsing — CSS / SCSS / Less declarations
  // -------------------------------------------------------------------

  function parseDeclarations(text) {
    var out = [];
    var i = 0;
    var n = text.length;
    var groupStack = [];

    function skipComment() {
      if (text[i] === "/" && text[i + 1] === "*") {
        var end = text.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
        return true;
      }
      if (text[i] === "/" && text[i + 1] === "/") {
        var nl = text.indexOf("\n", i);
        i = nl === -1 ? n : nl + 1;
        return true;
      }
      return false;
    }

    while (i < n) {
      while (i < n && /\s/.test(text[i])) i++;
      if (i >= n) break;
      if (skipComment()) continue;
      if (text[i] === "}") { groupStack.pop(); i++; continue; }
      if (text[i] === ";") { i++; continue; }

      // Read one statement up to ';', '{' or '}' at paren depth 0.
      var buf = "";
      var depth = 0;
      var quote = null;
      while (i < n) {
        var c = text[i];
        if (quote) {
          buf += c;
          if (c === "\\") { buf += text[i + 1] || ""; i += 2; continue; }
          if (c === quote) quote = null;
          i++;
          continue;
        }
        if (c === '"' || c === "'") { quote = c; buf += c; i++; continue; }
        if (skipComment()) continue;
        if (c === "(") depth++;
        if (c === ")") depth--;
        if (depth <= 0 && (c === ";" || c === "{" || c === "}")) break;
        buf += c;
        i++;
      }
      if (i >= n) break;
      var term = text[i];
      if (term === "{") {
        // A selector such as `:root` or `.btn` carries no property; anything
        // else before the brace is a block label used as the group name.
        var blockHead = buf.trim().replace(/:\s*$/, "");
        if (blockHead && !/^[.:#\[]/.test(blockHead)) {
          groupStack.push(blockHead.replace(/^[$@]/, ""));
        } else {
          groupStack.push("");
        }
        i++;
        continue;
      }
      if (term === "}") { groupStack.pop(); i++; continue; }

      // buf is a `name: value` declaration (possibly split across a colon).
      var colon = buf.indexOf(":");
      if (colon !== -1) {
        var name = buf.slice(0, colon).trim();
        var value = buf.slice(colon + 1).trim();
        if (name) out.push({ name: name, value: value, group: groupStack.filter(Boolean).join("-") });
      }
      i++; // consume ';'
    }
    return out;
  }

  var PREFIXES = { css: "--", scss: "$", less: "@" };

  function parseVariableTokens(text, syntax) {
    var decls = parseDeclarations(text);
    var prefix = PREFIXES[syntax];
    var tokens = [];
    for (var i = 0; i < decls.length; i++) {
      var name = decls[i].name;
      if (name.indexOf(prefix) !== 0) continue;
      tokens.push(makeToken(name.slice(prefix.length), decls[i].value, decls[i].group, "", ""));
    }
    if (!tokens.length) {
      var hint = syntax === "css" ? "--name" : syntax === "scss" ? "$name" : "@name";
      return { error: "No " + syntax.toUpperCase() + " variables found. Variables must start with " + hint + "." };
    }
    return { tokens: tokens };
  }

  // -------------------------------------------------------------------
  // Format detection and top-level parse
  // -------------------------------------------------------------------

  function detectFormat(text) {
    var t = String(text == null ? "" : text).trim();
    if (!t) return "";
    var first = t.charAt(0);
    if (first === "{" || first === "[") return "json";
    if (/^\$[A-Za-z0-9_-]+\s*:/.test(t)) return "scss";
    if (/^@[A-Za-z0-9_-]+\s*:/.test(t)) return "less";
    if (/^:root\b/.test(t)) return "css";
    if (/^--[A-Za-z0-9_-]+\s*:/.test(t)) return "css";
    if (/\$[A-Za-z0-9_-]+\s*:/.test(t)) return "scss";
    if (/@[A-Za-z0-9_-]+\s*:/.test(t)) return "less";
    if (/--[A-Za-z0-9_-]+\s*:/.test(t)) return "css";
    if (/[{};]/.test(t)) return "css";
    return "";
  }

  /**
   * Parse token input into a normalized token list.
   * @param {string} text
   * @param {{format?:string}} [options]
   * @returns {{ok:boolean,error?:string,format?:string,tokens?:Array,groups?:string[]}}
   */
  function parseTokens(text, options) {
    options = options || {};
    var input = String(text == null ? "" : text);
    if (input.trim() === "") {
      return { ok: false, error: "Nothing to parse — paste or load some tokens first." };
    }
    var format = options.format && options.format !== "auto" ? options.format : detectFormat(input);
    if (!format) {
      return {
        ok: false,
        error: "Could not detect the format. Pick JSON, CSS, SCSS or Less, or paste a :root { } block."
      };
    }
    var result;
    if (format === "json") result = parseJsonTokens(input);
    else if (format === "css" || format === "scss" || format === "less") result = parseVariableTokens(input, format);
    else return { ok: false, error: "Unsupported input format: " + format };

    if (result.error) return { ok: false, error: result.error, format: format };

    var groups = [];
    result.tokens.forEach(function (t) {
      if (!t.group) t.group = groupOf(t.name);
      if (t.group && groups.indexOf(t.group) === -1) groups.push(t.group);
    });
    return { ok: true, format: format, tokens: result.tokens, groups: groups.sort() };
  }

  // -------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------

  function emptyCounts() {
    return { color: 0, number: 0, dimension: 0, other: 0, empty: 0 };
  }

  function groupOf(name) {
    var parts = String(name).split("-");
    return parts.length > 1 ? parts.slice(0, -1).join("-") : "";
  }

  /**
   * Resolve references, compute effective values and WCAG contrast, and
   * summarize the token set. Returns annotated token copies (input is not
   * mutated).
   * @param {Array<object>} tokens
   * @returns {object}
   */
  function analyzeTokens(tokens) {
    var list = Array.isArray(tokens) ? tokens : [];
    var resolved = resolveAll(list);
    var counts = emptyCounts();
    var annotated = [];
    var groups = [];
    var groupMap = Object.create(null);

    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var res = resolved.map[normalizeName(t.name)];
      var effective = res && res.ok ? res.value : String(t.value == null ? "" : t.value);
      var parsed = parseValue(effective);
      var kind = parsed.kind === "empty" && t.kind !== "empty" ? t.kind : parsed.kind;
      if (counts[kind] == null) counts.other++;
      else counts[kind]++;

      // A token's own group: use the explicit group when the source provided
      // one, otherwise derive it from the name segments so flat JSON tokens
      // still group correctly.
      var group = t.group || groupOf(t.name);
      if (group && groups.indexOf(group) === -1) groups.push(group);
      if (!groupMap[group]) groupMap[group] = [];

      var annotatedToken = {
        name: t.name,
        raw: String(t.value == null ? "" : t.value),
        value: effective,
        group: group,
        description: t.description || "",
        type: t.type || "",
        kind: kind,
        alpha: parsed.alpha,
        color: parsed.color || null,
        refs: t.refs || extractRefs(t.value),
        resolved: !!(res && res.ok),
        error: res && !res.ok ? res.error : null
      };
      annotatedToken.refCount = annotatedToken.refs.length;
      annotated.push(annotatedToken);
      groupMap[group].push(annotatedToken);
    }

    // How many times each token is referenced by another token.
    var usage = Object.create(null);
    annotated.forEach(function (tk) {
      tk.refs.forEach(function (ref) {
        var key = normalizeName(ref);
        usage[key] = (usage[key] || 0) + 1;
      });
    });
    annotated.forEach(function (tk) {
      tk.usedBy = usage[normalizeName(tk.name)] || 0;
    });

    return {
      tokens: annotated,
      groups: groups.sort(),
      counts: counts,
      issues: resolved.issues,
      groupMap: groupMap
    };
  }

  // -------------------------------------------------------------------
  // Flattening helpers
  // -------------------------------------------------------------------

  function toSnake(name) {
    return String(name).replace(/-/g, "_");
  }

  function toCamel(name) {
    return String(name).replace(/[-_]+([a-zA-Z0-9])/g, function (_, c) { return c.toUpperCase(); });
  }

  function toPascal(name) {
    var camel = toCamel(name);
    return camel.charAt(0).toUpperCase() + camel.slice(1);
  }

  /**
   * Assign a value into a nested object along a key path. Order-independent:
   * when a leaf and a group occupy the same key (e.g. color-brand and
   * color-brand-strong) the leaf is moved under `leafKey` so no value is lost.
   * @param {object} root
   * @param {string[]} parts
   * @param {*} value
   * @param {string} [leafKey]
   */
  function assignNested(root, parts, value, leafKey) {
    leafKey = leafKey || "_value";
    var node = root;
    for (var i = 0; i < parts.length - 1; i++) {
      var key = parts[i];
      var existing = node[key];
      if (existing === undefined) {
        node[key] = {};
      } else if (typeof existing !== "object" || Array.isArray(existing)) {
        var promoted = {};
        promoted[leafKey] = existing;
        node[key] = promoted;
      }
      node = node[key];
    }
    var last = parts[parts.length - 1];
    if (node[last] !== undefined && typeof node[last] === "object" && !Array.isArray(node[last])) {
      node[last][leafKey] = value;
    } else {
      node[last] = value;
    }
  }

  /**
   * Build a nested object from dash-separated names.
   * @param {Array<object>} tokens
   * @param {{leaf?:Function,leafKey?:string}} [options]
   * @returns {object}
   */
  function nestByDash(tokens, options) {
    options = options || {};
    var leaf = options.leaf || function (t) { return t.value; };
    var root = {};
    tokens.forEach(function (t) {
      assignNested(root, String(t.name).split("-"), leaf(t), options.leafKey);
    });
    return root;
  }

  function unflatten(tokens, options) {
    options = options || {};
    var mode = options.mode || "nested";
    var out = {};
    tokens.forEach(function (t) {
      var key;
      if (mode === "kebab") key = t.name;
      else if (mode === "snake") key = toSnake(t.name);
      else if (mode === "camel") key = toCamel(t.name);
      else if (mode === "pascal") key = toPascal(t.name);
      else key = t.name;
      out[key] = t.value;
    });
    return out;
  }

  // -------------------------------------------------------------------
  // Serializers
  // -------------------------------------------------------------------

  function groupSorted(tokens) {
    var byGroup = Object.create(null);
    var order = [];
    tokens.forEach(function (t) {
      var g = t.group || "";
      if (!byGroup[g]) { byGroup[g] = []; order.push(g); }
      byGroup[g].push(t);
    });
    // Sort tokens inside each group so output is independent of input order.
    order.sort().forEach(function (g) {
      byGroup[g].sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    });
    return order.map(function (g) { return { group: g, tokens: byGroup[g] }; });
  }

  function serializeJson(tokens, options) {
    options = options || {};
    var nested = options.nested !== false;
    var data;
    if (nested) {
      data = nestByDash(tokens, { leaf: function (t) { return t.value; } });
    } else {
      var mode = options.nameCase || "kebab";
      data = unflatten(tokens, { mode: mode });
    }
    return JSON.stringify(data, null, 2);
  }

  function serializeDtcg(tokens, options) {
    options = options || {};
    var root = {};
    tokens.forEach(function (t) {
      var parts = String(t.name).split("-");
      var leaf = { $value: t.value };
      if (t.type) leaf.$type = t.type;
      if (t.description) leaf.$description = t.description;
      var node = root;
      for (var i = 0; i < parts.length - 1; i++) {
        var key = parts[i];
        if (node[key] === undefined) node[key] = {};
        else if (typeof node[key] !== "object" || Array.isArray(node[key])) node[key] = { $value: node[key] };
        node = node[key];
      }
      var last = parts[parts.length - 1];
      if (node[last] && typeof node[last] === "object" && !Array.isArray(node[last])) {
        // A group already occupies this name (e.g. color.brand and
        // color.brand.strong). Keep the group's children and move the leaf
        // value under $value, which is the DTCG way to attach a value to a
        // group node. The parser reads $value before descending, so this
        // round-trips to the same name.
        node[last].$value = t.value;
        if (t.type) node[last].$type = t.type;
        if (t.description) node[last].$description = t.description;
      } else {
        node[last] = leaf;
      }
    });
    return JSON.stringify(root, null, 2);
  }

  function cssVarName(name) {
    return "--" + String(name);
  }

  function serializeCss(tokens, options) {
    options = options || {};
    var resolver = options.resolver || function () { return null; };
    var lines = [":root {"];
    var groups = groupSorted(tokens);
    groups.forEach(function (g, gi) {
      if (gi > 0) lines.push("");
      if (g.group) lines.push("  /* " + g.group + " */");
      g.tokens.forEach(function (t) {
        var value = resolver(t) || t.value;
        lines.push("  " + cssVarName(t.name) + ": " + value + ";");
      });
    });
    lines.push("}");
    return lines.join("\n");
  }

  function serializeScss(tokens, options) {
    options = options || {};
    var resolver = options.resolver || function () { return null; };
    var lines = [];
    var groups = groupSorted(tokens);
    groups.forEach(function (g, gi) {
      if (gi > 0) lines.push("");
      if (g.group) lines.push("// " + g.group);
      g.tokens.forEach(function (t) {
        var value = resolver(t) || t.value;
        lines.push("$" + t.name + ": " + value + ";");
      });
    });
    return lines.join("\n");
  }

  function serializeLess(tokens, options) {
    options = options || {};
    var resolver = options.resolver || function () { return null; };
    var lines = [];
    var groups = groupSorted(tokens);
    groups.forEach(function (g, gi) {
      if (gi > 0) lines.push("");
      if (g.group) lines.push("// " + g.group);
      g.tokens.forEach(function (t) {
        var value = resolver(t) || t.value;
        lines.push("@" + t.name + ": " + value + ";");
      });
    });
    return lines.join("\n");
  }

  function serializeTailwind(tokens, options) {
    options = options || {};
    var resolver = options.resolver || function () { return null; };
    var theme = {};
    tokens.forEach(function (t) {
      var parts = String(t.name).split("-");
      var namespace = parts[0];
      var rest = parts.slice(1);
      if (!theme[namespace]) theme[namespace] = {};
      assignNested(theme[namespace], rest.length ? rest : ["DEFAULT"], resolver(t) || t.value, "_value");
    });
    return [
      "module.exports = {",
      "  theme: {",
      "    extend: " + JSON.stringify(theme, null, 2).replace(/\n/g, "\n    ") + ",",
      "  },",
      "};"
    ].join("\n");
  }

  function serializeSwift(tokens, options) {
    options = options || {};
    var resolver = options.resolver || function () { return null; };
    var lines = ["import UIKit", "", "public enum DesignTokens {"];
    groupSorted(tokens).forEach(function (g) {
      if (g.group) lines.push("  // MARK: " + g.group);
      g.tokens.forEach(function (t) {
        var value = resolver(t) || t.value;
        var name = toCamel(t.name);
        if (t.kind === "color" && t.color) {
          lines.push("  public static let " + name + " = UIColor(red: " +
            round(t.color.r / 255, 4) + ", green: " + round(t.color.g / 255, 4) +
            ", blue: " + round(t.color.b / 255, 4) + ", alpha: " + t.color.a + ")");
        } else {
          lines.push("  public static let " + name + " = \"" + String(value).replace(/"/g, "\\\"") + "\"");
        }
      });
    });
    lines.push("}");
    return lines.join("\n");
  }

  function serializeAndroid(tokens, options) {
    options = options || {};
    var resolver = options.resolver || function () { return null; };
    var colors = [];
    var dimens = [];
    var others = [];
    tokens.forEach(function (t) {
      var name = toSnake(t.name);
      var value = resolver(t) || t.value;
      if (t.kind === "color" && t.color) {
        colors.push("  <color name=\"" + name + "\">" + t.color.hex + "</color>");
      } else if (t.kind === "dimension") {
        dimens.push("  <dimen name=\"" + name + "\">" + value + "</dimen>");
      } else {
        others.push("  <string name=\"" + name + "\">" + escapeXml(value) + "</string>");
      }
    });
    var lines = ["<?xml version=\"1.0\" encoding=\"utf-8\"?>", "<resources>"];
    if (colors.length) {
      lines.push("");
      colors.forEach(function (l) { lines.push(l); });
    }
    if (dimens.length) {
      lines.push("");
      dimens.forEach(function (l) { lines.push(l); });
    }
    if (others.length) {
      lines.push("");
      others.forEach(function (l) { lines.push(l); });
    }
    lines.push("</resources>");
    return lines.join("\n");
  }

  function escapeXml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  var FORMATS = [
    { id: "json", label: "JSON", hint: "Plain nested JSON (values only)" },
    { id: "dtcg", label: "DTCG", hint: "W3C design-tokens draft format" },
    { id: "css", label: "CSS", hint: ":root custom properties" },
    { id: "scss", label: "SCSS", hint: "SCSS variables" },
    { id: "less", label: "Less", hint: "Less variables" },
    { id: "tailwind", label: "Tailwind", hint: "Tailwind theme.extend config" },
    { id: "swift", label: "Swift", hint: "UIKit enum" },
    { id: "android", label: "Android", hint: "res/values resources XML" }
  ];

  function listFormats() {
    return FORMATS.map(function (f) { return { id: f.id, label: f.label, hint: f.hint }; });
  }

  /**
   * Serialize tokens to a target format.
   * @param {string} format
   * @param {Array<object>} tokens annotated tokens
   * @param {{nested?:boolean,nameCase?:string,resolver?:Function}} [options]
   * @returns {{ok:boolean,output?:string,error?:string}}
   */
  function serialize(format, tokens, options) {
    if (!tokens || !tokens.length) return { ok: false, error: "No tokens to export." };
    options = options || {};
    // Deterministic output: serialize in name order regardless of input order.
    tokens = tokens.slice().sort(function (a, b) {
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    switch (format) {
      case "json": return { ok: true, output: serializeJson(tokens, options) };
      case "dtcg": return { ok: true, output: serializeDtcg(tokens, options) };
      case "css": return { ok: true, output: serializeCss(tokens, options) };
      case "scss": return { ok: true, output: serializeScss(tokens, options) };
      case "less": return { ok: true, output: serializeLess(tokens, options) };
      case "tailwind": return { ok: true, output: serializeTailwind(tokens, options) };
      case "swift": return { ok: true, output: serializeSwift(tokens, options) };
      case "android": return { ok: true, output: serializeAndroid(tokens, options) };
      default: return { ok: false, error: "Unknown export format: " + format };
    }
  }

  // -------------------------------------------------------------------
  // Filtering and grouping
  // -------------------------------------------------------------------

  /**
   * Case-insensitive filter over name, group, value, kind and type.
   * @param {Array<object>} tokens
   * @param {{query?:string,kind?:string}} [filter]
   * @returns {Array<object>}
   */
  function filterTokens(tokens, filter) {
    filter = filter || {};
    var q = String(filter.query || "").trim().toLowerCase();
    var kind = filter.kind || "all";
    return tokens.filter(function (t) {
      if (kind !== "all" && t.kind !== kind) return false;
      if (!q) return true;
      return (t.name + " " + t.group + " " + t.value + " " + t.kind + " " + t.type)
        .toLowerCase().indexOf(q) !== -1;
    });
  }

  function groupTokens(tokens) {
    var map = Object.create(null);
    var order = [];
    tokens.forEach(function (t) {
      var g = t.group || "(ungrouped)";
      if (!map[g]) { map[g] = []; order.push(g); }
      map[g].push(t);
    });
    return order.sort().map(function (g) { return { group: g, tokens: map[g] }; });
  }

  // -------------------------------------------------------------------
  // Samples
  // -------------------------------------------------------------------

  var SAMPLES = {
    "dtcg-json": JSON.stringify({
      color: {
        $type: "color",
        brand: { $value: "#b3402a", $description: "Primary brand color" },
        "brand-strong": { $value: "{color.brand}", $description: "Alias of brand" },
        surface: { $value: "#fbf8f1" },
        ink: { $value: "#211d17" },
        "ink-muted": { $value: "rgba(33, 29, 23, 0.6)" },
        danger: { $value: "#c0392b" }
      },
      space: {
        $type: "dimension",
        sm: { $value: "4px" },
        md: { $value: "8px" },
        lg: { $value: "16px" }
      },
      radius: {
        $type: "dimension",
        sm: { $value: "6px" },
        md: { $value: "10px" }
      },
      "font-size": {
        $type: "dimension",
        base: { $value: "16px" },
        lg: { $value: "20px" }
      }
    }, null, 2),
    "css-vars": [
      ":root {",
      "  /* color */",
      "  --color-brand: #b3402a;",
      "  --color-brand-strong: var(--color-brand);",
      "  --color-surface: #fbf8f1;",
      "  --color-ink: #211d17;",
      "  --color-ink-muted: rgba(33, 29, 23, 0.6);",
      "",
      "  /* space */",
      "  --space-sm: 4px;",
      "  --space-md: 8px;",
      "  --space-lg: 16px;",
      "",
      "  /* radius */",
      "  --radius-sm: 6px;",
      "  --radius-md: 10px;",
      "}"
    ].join("\n"),
    "flat-json": JSON.stringify({
      "color-brand": "#b3402a",
      "color-brand-strong": "{color.brand}",
      "color-surface": "#fbf8f1",
      "color-ink": "#211d17",
      "space-md": "8px",
      "radius-md": "10px"
    }, null, 2),
    scss: [
      "// color",
      "$color-brand: #b3402a;",
      "$color-brand-strong: $color-brand;",
      "$color-surface: #fbf8f1;",
      "$color-ink: #211d17;",
      "",
      "// space",
      "$space-sm: 4px;",
      "$space-md: 8px;",
      "$space-lg: 16px;"
    ].join("\n")
  };

  function listSamples() {
    return [
      { id: "dtcg-json", label: "DTCG JSON" },
      { id: "css-vars", label: "CSS variables" },
      { id: "flat-json", label: "Flat JSON" },
      { id: "scss", label: "SCSS variables" }
    ];
  }

  function getSample(id) {
    var s = SAMPLES[id];
    return typeof s === "string" ? s : null;
  }

  return {
    parseColor: parseColor,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    rgbToHsl: rgbToHsl,
    hslToRgb: hslToRgb,
    parseValue: parseValue,
    extractRefs: extractRefs,
    normalizeName: normalizeName,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    wcagRating: wcagRating,
    blend: blend,
    resolveAll: resolveAll,
    analyzeTokens: analyzeTokens,
    detectFormat: detectFormat,
    parseTokens: parseTokens,
    filterTokens: filterTokens,
    groupTokens: groupTokens,
    nestByDash: nestByDash,
    unflatten: unflatten,
    toCamel: toCamel,
    toPascal: toPascal,
    toSnake: toSnake,
    listFormats: listFormats,
    serialize: serialize,
    serializeJson: serializeJson,
    serializeDtcg: serializeDtcg,
    serializeCss: serializeCss,
    serializeScss: serializeScss,
    serializeLess: serializeLess,
    serializeTailwind: serializeTailwind,
    serializeSwift: serializeSwift,
    serializeAndroid: serializeAndroid,
    listSamples: listSamples,
    getSample: getSample
  };
});
