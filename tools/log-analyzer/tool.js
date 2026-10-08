/* Toolshed — Log Analyzer
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.logAnalyzer and in Node via require() for tests.
 *
 * The module parses application and server log text line by line: it detects
 * timestamps across common formats, classifies severity levels, extracts a
 * logger/source and a message, understands JSON and logfmt lines, normalizes
 * messages into templates so similar lines group together, and produces
 * statistics (level counts, time range, throughput, top messages, top errors,
 * exception types, per-bucket histogram).
 *
 * Everything runs in memory. The module never touches the network, never uses
 * eval or dynamic code execution, and never writes to storage. It is written
 * to stay responsive on large inputs by working over a capped number of lines
 * and using linear-time, backtracking-safe patterns.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.logAnalyzer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Limits & constants
  // ---------------------------------------------------------------------

  // Lines parsed in one pass. Realistic logs (tens of MB) stay well under
  // this; the cap protects the main thread from pathological input.
  var MAX_LINES = 200000;

  // Upper bound on a user-supplied search pattern, to keep compilation and
  // matching bounded.
  var MAX_REGEX_LENGTH = 2000;

  // Year used to anchor syslog timestamps, which carry no year. All such lines
  // share this anchor, so their relative order is preserved.
  var SYSLOG_REFERENCE_YEAR = 2000;
  var SYSLOG_MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };

  // Canonical severities, ordered from most to least severe.
  var SEVERITIES = ["fatal", "error", "warning", "notice", "info", "debug", "trace"];
  var SEVERITY_RANK = { fatal: 6, error: 5, warning: 4, notice: 3, info: 2, debug: 1, trace: 0, unknown: -1 };

  var LEVEL_ALIASES = {
    fatal: "fatal", critical: "fatal", crit: "fatal", severe: "fatal",
    emergency: "fatal", emerg: "fatal", alert: "fatal", panic: "fatal",
    error: "error", err: "error", fail: "error", failure: "error", erro: "error",
    warning: "warning", warn: "warning",
    notice: "notice",
    info: "info", informational: "info", information: "info",
    debug: "debug", dbg: "debug",
    trace: "trace", verbose: "trace", fine: "trace"
  };

  var LEVEL_TOKEN_RE = /^(?:fatal|critical|crit|severe|emergency|emerg|alert|panic|error|err|fail|failure|warning|warn|notice|info|informational|information|debug|dbg|trace|verbose|fine)$/i;

  var TIMESTAMP_FIELDS = ["timestamp", "time", "ts", "@timestamp", "datetime", "date", "logged_at", "eventtime"];
  var LEVEL_FIELDS = ["level", "severity", "lvl", "log_level", "loglevel", "priority"];
  var MESSAGE_FIELDS = ["message", "msg", "event", "text", "log"];
  var SOURCE_FIELDS = ["logger", "name", "service", "source", "component", "module", "context", "logger_name"];

  var MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---------------------------------------------------------------------
  // Timestamp parsing
  // ---------------------------------------------------------------------
  //
  // Each pattern captures year/month/day/hour/minute/second (and optional
  // milliseconds and UTC offset). Patterns are anchored at the start of the
  // line and contain no nested quantifiers, so they cannot backtrack
  // catastrophically.

  var TS_PATTERNS = [
    {
      id: "iso",
      re: /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?/,
      map: isoMap
    },
    {
      id: "slash-ymd",
      re: /^(\d{4})\/(\d{2})\/(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?/,
      map: isoMap
    },
    {
      id: "common",
      re: /^\[?(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))? ?([+-]\d{4})?\]?/,
      map: commonMap
    },
    {
      id: "syslog",
      re: /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})/,
      map: syslogMap
    },
    {
      id: "time-only",
      re: /^(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?/,
      map: timeOnlyMap
    }
  ];

  function isoMap(m) {
    return parts(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), m[7], m[8]);
  }
  function commonMap(m) {
    var month = SYSLOG_MONTHS[String(m[2]).toLowerCase()];
    return parts(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]), m[7], m[8]);
  }
  function syslogMap(m) {
    var month = SYSLOG_MONTHS[String(m[1]).toLowerCase()];
    return parts(SYSLOG_REFERENCE_YEAR, month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), null, null);
  }
  function timeOnlyMap(m) {
    return parts(1970, 1, 1, Number(m[1]), Number(m[2]), Number(m[3]), m[4], null);
  }

  function parts(year, month, day, hour, minute, second, fraction, zone) {
    if (!isValidDate(year, month, day, hour, minute, second)) return null;
    var ms = fractionToMs(fraction);
    var offsetMinutes = zoneToMinutes(zone);
    var epoch = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60000;
    return {
      epoch: epoch,
      hasZone: zone != null,
      iso: buildIso(year, month, day, hour, minute, second, ms),
      source: null,
      y: year, mo: month, d: day, h: hour, mi: minute, s: second, ms: ms,
      zoneMinutes: offsetMinutes
    };
  }

  /**
   * Re-anchor a timestamp onto a different year. Used for formats that carry
   * no year (syslog, time-only) so their relative position stays consistent
   * with full timestamps elsewhere in the same file.
   * @param {object} ts
   * @param {number} year
   * @returns {object}
   */
  function reanchorYear(ts, year) {
    var epoch = Date.UTC(year, ts.mo - 1, ts.d, ts.h, ts.mi, ts.s, ts.ms) - ts.zoneMinutes * 60000;
    return {
      epoch: epoch,
      hasZone: ts.hasZone,
      iso: buildIso(year, ts.mo, ts.d, ts.h, ts.mi, ts.s, ts.ms),
      source: ts.source,
      y: year, mo: ts.mo, d: ts.d, h: ts.h, mi: ts.mi, s: ts.s, ms: ts.ms,
      zoneMinutes: ts.zoneMinutes
    };
  }

  function isValidDate(y, mo, d, h, mi, s) {
    if (!(mo >= 1 && mo <= 12)) return false;
    if (!(d >= 1 && d <= 31)) return false;
    if (!(h >= 0 && h <= 23)) return false;
    if (!(mi >= 0 && mi <= 59)) return false;
    if (!(s >= 0 && s <= 60)) return false;
    if (y < 1000 || y > 9999) return false;
    return true;
  }

  function fractionToMs(fraction) {
    if (fraction == null) return 0;
    var digits = String(fraction).slice(0, 3);
    while (digits.length < 3) digits += "0";
    return Number(digits);
  }

  function zoneToMinutes(zone) {
    if (zone == null || zone === "Z" || zone === "z") return 0;
    var sign = zone[0] === "-" ? -1 : 1;
    var body = zone.slice(1).replace(":", "");
    var hh = Number(body.slice(0, 2));
    var mm = Number(body.slice(2, 4)) || 0;
    return sign * (hh * 60 + mm);
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = "0" + s;
    return s;
  }

  function buildIso(y, mo, d, h, mi, s, ms) {
    var base = pad(y, 4) + "-" + pad(mo, 2) + "-" + pad(d, 2) + "T" + pad(h, 2) + ":" + pad(mi, 2) + ":" + pad(s, 2);
    if (ms) base += "." + pad(ms, 3);
    return base;
  }

  /**
   * Try to read a timestamp from the start of a line.
   * @param {string} text
   * @param {string} [hint] one of the pattern ids, or "auto"
   * @returns {{ raw: string, rest: string, timestamp: object }|null}
   */
  function parseTimestamp(text, hint) {
    for (var i = 0; i < TS_PATTERNS.length; i++) {
      var pattern = TS_PATTERNS[i];
      if (hint && hint !== "auto" && hint !== pattern.id) continue;
      var m = pattern.re.exec(text);
      if (!m) continue;
      var stamp = pattern.map(m);
      if (!stamp) continue;
      stamp.source = pattern.id;
      return { raw: m[0], rest: text.slice(m[0].length), timestamp: stamp };
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Structured line parsing (JSON and logfmt)
  // ---------------------------------------------------------------------

  function pickField(obj, names) {
    for (var i = 0; i < names.length; i++) {
      var key = names[i];
      if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null && obj[key] !== "") {
        return { key: key, value: obj[key] };
      }
    }
    return null;
  }

  function tryParseJSONLine(text) {
    var trimmed = text.trim();
    var first = trimmed.charAt(0);
    if (first !== "{" && first !== "[") return null;
    var obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      return null;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    return obj;
  }

  var LOGFMT_RE = /([A-Za-z_][A-Za-z0-9_.\-]*)=("(?:[^"\\]|\\.)*"|\S+)/g;

  function tryParseLogfmt(text) {
    var pairs = [];
    var re = new RegExp(LOGFMT_RE.source, "g");
    var m;
    while ((m = re.exec(text)) !== null) {
      pairs.push([m[1], m[2]]);
      if (pairs.length > 200) break;
    }
    if (pairs.length < 2) return null;
    // Require the line to actually look like structured logging: at least one
    // recognized field key, or enough pairs that it cannot be incidental text.
    var recognized = false;
    for (var r = 0; r < pairs.length; r++) {
      if (isKnownField(pairs[r][0])) { recognized = true; break; }
    }
    if (!recognized && pairs.length < 4) return null;
    var obj = {};
    for (var i = 0; i < pairs.length; i++) {
      var key = pairs[i][0];
      var value = pairs[i][1];
      if (value.charAt(0) === '"') {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      if (!(key in obj)) obj[key] = value;
    }
    return obj;
  }

  function isKnownField(key) {
    var lower = String(key).toLowerCase();
    var all = TIMESTAMP_FIELDS.concat(LEVEL_FIELDS, MESSAGE_FIELDS, SOURCE_FIELDS);
    for (var i = 0; i < all.length; i++) {
      if (all[i] === lower) return true;
    }
    return false;
  }

  function levelFromValue(value) {
    if (value == null) return null;
    if (typeof value === "number") {
      // Common numeric severities: 0-7 (syslog), 10-60 (Serilog/bunyan).
      if (value >= 50) return "fatal";
      if (value >= 40) return "error";
      if (value >= 30) return "warning";
      if (value >= 20) return "info";
      if (value >= 10) return "debug";
      if (value >= 0) return "info";
      return null;
    }
    var token = String(value).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEVEL_ALIASES, token)) return LEVEL_ALIASES[token];
    // Values like "ERROR " or "[WARN]".
    var stripped = token.replace(/[^a-z]/g, "");
    if (Object.prototype.hasOwnProperty.call(LEVEL_ALIASES, stripped)) return LEVEL_ALIASES[stripped];
    return null;
  }

  // ---------------------------------------------------------------------
  // Message normalization (template extraction)
  // ---------------------------------------------------------------------

  var NORMALIZERS = [
    [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "<uuid>"],
    [/\b0x[0-9a-fA-F]+\b/g, "<hex>"],
    [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>"],
    [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<ts>"],
    [/"[^"\n]{0,200}"/g, '"<str>"'],
    [/'[^'\n]{0,200}'/g, "'<str>'"],
    [/\b\d+(?:\.\d+)?(?:ms|s|us|ns|kb|mb|gb)?\b/gi, "<n>"]
  ];

  /**
   * Turn a message into a stable template by replacing variable content
   * (ids, addresses, numbers, timestamps, quoted strings) with placeholders,
   * so lines that differ only in those values group together.
   * @param {string} message
   * @returns {string}
   */
  function normalizeMessage(message) {
    var out = String(message == null ? "" : message);
    for (var i = 0; i < NORMALIZERS.length; i++) {
      out = out.replace(NORMALIZERS[i][0], NORMALIZERS[i][1]);
    }
    return out.replace(/\s+/g, " ").trim();
  }

  var EXCEPTION_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*?(?:Error|Exception|Throwable))\b/g;

  /**
   * Find exception/error class names mentioned in a message.
   * @param {string} message
   * @returns {string[]}
   */
  function extractExceptionTypes(message) {
    var found = [];
    var seen = Object.create(null);
    var re = new RegExp(EXCEPTION_RE.source, "g");
    var m;
    while ((m = re.exec(String(message))) !== null) {
      var name = m[1];
      if (!seen[name]) {
        seen[name] = true;
        found.push(name);
      }
    }
    return found;
  }

  // ---------------------------------------------------------------------
  // Line parsing
  // ---------------------------------------------------------------------

  var SOURCE_COLON_RE = /^([A-Za-z0-9_.\-/]{1,64}):$/;
  var SOURCE_BRACKET_RE = /^\[([^\]]{1,64})\]$/;
  var SOURCE_DOTTED_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

  // Tokenize while preserving each token's source offset, so the message can
  // be sliced from the original text (quotes and spacing intact) rather than
  // reassembled from unquoted tokens.
  function tokenize(text) {
    var tokens = [];
    var re = /\S+/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    return tokens;
  }

  /**
   * Parse a single log line into an entry.
   * @param {string} raw
   * @param {number} lineNumber 1-based
   * @param {object} [options] { format: "auto"|"iso"|"syslog"|"common"|"time-only"|"json"|"logfmt"|"plain" }
   * @returns {object} entry
   */
  function parseLine(raw, lineNumber, options) {
    options = options || {};
    var format = options.format || "auto";
    var entry = {
      n: lineNumber,
      raw: raw,
      timestamp: null,
      level: null,
      severity: -1,
      source: null,
      message: "",
      template: "",
      fields: null,
      format: "plain"
    };

    var trimmed = raw.replace(/^\uFEFF/, "").replace(/^\s+/, "");
    if (trimmed === "") {
      entry.format = "blank";
      return entry;
    }

    // 1. Structured lines.
    if (format === "auto" || format === "json") {
      var json = tryParseJSONLine(trimmed);
      if (json) {
        applyStructured(entry, json, "json");
        entry.raw = raw;
        finalize(entry, trimmed);
        return entry;
      }
    }
    if (format === "auto" || format === "logfmt") {
      var logfmt = tryParseLogfmt(trimmed);
      if (logfmt) {
        applyStructured(entry, logfmt, "logfmt");
        entry.raw = raw;
        finalize(entry, trimmed);
        return entry;
      }
    }

    var rest = trimmed;

    // 2. Timestamp.
    if (format !== "plain" && format !== "json" && format !== "logfmt") {
      var stamp = parseTimestamp(rest, format);
      if (stamp) {
        entry.timestamp = stamp.timestamp;
        rest = stamp.rest.replace(/^\s+/, "");
      }
    }

    // 3. Level + optional source, from the first few tokens.
    var tokens = tokenize(rest);
    var consumed = 0;
    var level = null;
    var source = null;
    for (var i = 0; i < tokens.length && i < 6; i++) {
      var token = tokens[i].text;
      if (level == null) {
        var stripped = token.replace(/^[<[(]+/, "").replace(/[>\])]+$/, "").replace(/:$/, "");
        if (LEVEL_TOKEN_RE.test(stripped)) {
          level = levelFromValue(stripped);
          consumed = i + 1;
          continue;
        }
        // level=value inside a plain line
        var eq = /^level=(\S+)$/i.exec(token);
        if (eq) {
          level = levelFromValue(eq[1]);
          consumed = i + 1;
          continue;
        }
      } else if (source == null) {
        var s = sourceFromToken(token);
        if (s) {
          source = s;
          consumed = i + 1;
        }
        break;
      }
    }
    if (level != null) {
      entry.level = level;
      entry.severity = SEVERITY_RANK[level];
    }
    if (source != null) entry.source = source;

    // 4. Message is the original text after the consumed tokens, so quoting
    //    and internal spacing survive intact.
    if (consumed > 0 && consumed <= tokens.length) {
      entry.message = rest.slice(tokens[consumed - 1].end).trim();
    } else {
      entry.message = rest.trim();
    }
    entry.message = entry.message.replace(/^[\s:|-]+/, "").trim();
    if (entry.message === "" && rest) entry.message = rest.trim();

    finalize(entry, trimmed);
    return entry;
  }

  function sourceFromToken(token) {
    var m = SOURCE_BRACKET_RE.exec(token);
    if (m) return m[1];
    m = SOURCE_COLON_RE.exec(token);
    if (m) return m[1];
    if (SOURCE_DOTTED_RE.test(token)) return token;
    return null;
  }

  function applyStructured(entry, obj, kind) {
    entry.format = kind;
    entry.fields = obj;

    var levelField = pickField(obj, LEVEL_FIELDS);
    if (levelField) {
      var level = levelFromValue(levelField.value);
      if (level) {
        entry.level = level;
        entry.severity = SEVERITY_RANK[level];
      }
    }

    var tsField = pickField(obj, TIMESTAMP_FIELDS);
    if (tsField) {
      var parsed = parseStructuredTimestamp(tsField.value);
      if (parsed) entry.timestamp = parsed;
    }

    var srcField = pickField(obj, SOURCE_FIELDS);
    if (srcField && typeof srcField.value !== "object") entry.source = String(srcField.value);

    var msgField = pickField(obj, MESSAGE_FIELDS);
    if (msgField && typeof msgField.value !== "object") {
      entry.message = String(msgField.value);
    } else {
      entry.message = "";
    }
  }

  function parseStructuredTimestamp(value) {
    if (typeof value === "number" && isFinite(value)) {
      // Epoch seconds (10 digits) or milliseconds (13 digits).
      var ms = value > 1e11 ? value : value * 1000;
      return { epoch: ms, hasZone: true, iso: new Date(ms).toISOString(), source: "epoch" };
    }
    if (typeof value !== "string") return null;
    var text = value.trim();
    if (/^\d{10}(?:\.\d+)?$/.test(text)) {
      var sec = Number(text);
      return { epoch: Math.round(sec * 1000), hasZone: true, iso: new Date(sec * 1000).toISOString(), source: "epoch" };
    }
    if (/^\d{13}$/.test(text)) {
      var msec = Number(text);
      return { epoch: msec, hasZone: true, iso: new Date(msec).toISOString(), source: "epoch" };
    }
    var direct = parseTimestamp(text, "auto");
    if (direct) return direct.timestamp;
    // "2024-05-01 10:00:00,123" style with comma already covered; try Date as a
    // last resort for RFC 2822 and similar forms.
    var t = Date.parse(text);
    if (!isNaN(t)) return { epoch: t, hasZone: true, iso: new Date(t).toISOString(), source: "date" };
    return null;
  }

  function finalize(entry, trimmed) {
    if (entry.level == null) entry.severity = SEVERITY_RANK.unknown;
    if (entry.message === "") entry.message = trimmed;
    entry.template = normalizeMessage(entry.message) || "(empty)";
    entry.malformed =
      entry.timestamp == null &&
      entry.level == null &&
      entry.source == null &&
      entry.format === "plain";
  }

  // ---------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------

  function splitLines(text) {
    if (typeof text !== "string") return [];
    // Handle \r\n and lone \r; a trailing newline does not create an empty line.
    var lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  /**
   * Parse a block of log text.
   * @param {string} text
   * @param {object} [options] { format }
   * @returns {object} { entries, totalLines, processedLines, truncated, options }
   */
  function analyze(text, options) {
    options = options || {};
    var lines = splitLines(text);
    var totalLines = lines.length;
    var truncated = totalLines > MAX_LINES;
    var limit = truncated ? MAX_LINES : totalLines;
    var entries = new Array(limit);
    for (var i = 0; i < limit; i++) {
      entries[i] = parseLine(lines[i], i + 1, options);
    }
    resolveYearAnchors(entries);
    return {
      entries: entries,
      totalLines: totalLines,
      processedLines: limit,
      truncated: truncated,
      options: { format: options.format || "auto" }
    };
  }

  // Formats that carry no year (syslog, bare time) are first parsed against a
  // fixed reference year. Once the whole file is read, re-anchor them onto a
  // year inferred from the first full timestamp, so a mixed file keeps a
  // coherent timeline instead of spanning decades.
  function resolveYearAnchors(entries) {
    var reference = null;
    for (var i = 0; i < entries.length; i++) {
      var ts = entries[i].timestamp;
      if (ts && ts.source !== "syslog" && ts.source !== "time-only") {
        reference = ts;
        break;
      }
    }
    if (!reference) return;
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      if (!e.timestamp) continue;
      if (e.timestamp.source === "syslog") {
        e.timestamp = nearestYear(e.timestamp, reference);
      } else if (e.timestamp.source === "time-only") {
        e.timestamp = reanchorDay(e.timestamp, reference);
      }
    }
  }

  function nearestYear(ts, reference) {
    var best = null;
    for (var delta = -1; delta <= 1; delta++) {
      var candidate = reanchorYear(ts, reference.y + delta);
      if (best == null || Math.abs(candidate.epoch - reference.epoch) < Math.abs(best.epoch - reference.epoch)) {
        best = candidate;
      }
    }
    return best;
  }

  function reanchorDay(ts, reference) {
    var epoch = Date.UTC(reference.y, reference.mo - 1, reference.d, ts.h, ts.mi, ts.s, ts.ms);
    return {
      epoch: epoch,
      hasZone: false,
      iso: buildIso(reference.y, reference.mo, reference.d, ts.h, ts.mi, ts.s, ts.ms),
      source: ts.source,
      y: reference.y, mo: reference.mo, d: reference.d, h: ts.h, mi: ts.mi, s: ts.s, ms: ts.ms,
      zoneMinutes: 0
    };
  }

  // ---------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------

  function summarize(entries, options) {
    options = options || {};
    var topCount = options.top || 15;
    var stats = {
      total: entries.length,
      blank: 0,
      malformed: 0,
      withTimestamp: 0,
      withLevel: 0,
      levels: emptyLevelCounts(),
      levelRanks: { fatal: 0, error: 0, warning: 0, notice: 0, info: 0, debug: 0, trace: 0 },
      sources: [],
      exceptions: [],
      groups: [],
      errors: [],
      timeRange: null,
      buckets: [],
      peakRatePerMinute: 0,
      errorRate: 0
    };

    var groupMap = Object.create(null);
    var sourceMap = Object.create(null);
    var exceptionMap = Object.create(null);
    var start = Infinity;
    var end = -Infinity;
    var stamps = [];

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.format === "blank") {
        stats.blank++;
        continue;
      }
      if (e.malformed) stats.malformed++;
      if (e.timestamp) {
        stats.withTimestamp++;
        if (e.timestamp.epoch < start) start = e.timestamp.epoch;
        if (e.timestamp.epoch > end) end = e.timestamp.epoch;
        if (stamps.length < 200000) stamps.push(e.timestamp.epoch);
      }
      if (e.level) {
        stats.withLevel++;
        stats.levels[e.level]++;
        stats.levelRanks[e.level]++;
      }
      if (e.source) {
        sourceMap[e.source] = (sourceMap[e.source] || 0) + 1;
      }

      var key = e.template;
      var group = groupMap[key];
      if (!group) {
        group = {
          template: key,
          count: 0,
          level: e.level,
          severity: e.severity,
          sample: e.message,
          sampleLine: e.n,
          firstLine: e.n,
          lastLine: e.n,
          sources: Object.create(null)
        };
        groupMap[key] = group;
      }
      group.count++;
      group.lastLine = e.n;
      if (e.severity > group.severity) {
        group.severity = e.severity;
        group.level = e.level;
      }
      if (e.source) group.sources[e.source] = (group.sources[e.source] || 0) + 1;

      if (e.level === "error" || e.level === "fatal") {
        var types = extractExceptionTypes(e.message);
        for (var t = 0; t < types.length; t++) {
          exceptionMap[types[t]] = (exceptionMap[types[t]] || 0) + 1;
        }
      }
    }

    stats.errorRate = stats.total
      ? (stats.levels.error + stats.levels.fatal) / stats.total
      : 0;

    if (start !== Infinity) {
      stats.timeRange = {
        start: start,
        end: end,
        durationMs: Math.max(0, end - start)
      };
      stats.buckets = buildBuckets(stamps, start, end, options.buckets);
      var peak = 0;
      for (var b = 0; b < stats.buckets.length; b++) {
        if (stats.buckets[b].count > peak) peak = stats.buckets[b].count;
      }
      if (stats.buckets.length && stats.buckets[0].spanMs > 0) {
        stats.peakRatePerMinute = peak / (stats.buckets[0].spanMs / 60000);
      }
    }

    stats.groups = sortGroups(groupMap, topCount, false);
    stats.errors = sortGroups(groupMap, topCount, true);
    stats.sources = sortCounts(sourceMap, topCount);
    stats.exceptions = sortCounts(exceptionMap, topCount);
    return stats;
  }

  function emptyLevelCounts() {
    var counts = {};
    for (var i = 0; i < SEVERITIES.length; i++) counts[SEVERITIES[i]] = 0;
    return counts;
  }

  function sortGroups(groupMap, top, errorsOnly) {
    var out = [];
    for (var key in groupMap) {
      var g = groupMap[key];
      if (errorsOnly && g.severity < SEVERITY_RANK.error) continue;
      out.push({
        template: g.template,
        count: g.count,
        level: g.level,
        severity: g.severity,
        sample: g.sample,
        sampleLine: g.sampleLine,
        firstLine: g.firstLine,
        lastLine: g.lastLine,
        sources: Object.keys(g.sources).sort(function (a, b) {
          return g.sources[b] - g.sources[a] || a.localeCompare(b);
        }).slice(0, 5)
      });
    }
    out.sort(function (a, b) {
      return b.count - a.count || a.template.localeCompare(b.template);
    });
    return out.slice(0, top);
  }

  function sortCounts(map, top) {
    var out = [];
    for (var key in map) out.push({ name: key, count: map[key] });
    out.sort(function (a, b) {
      return b.count - a.count || a.name.localeCompare(b.name);
    });
    return out.slice(0, top);
  }

  // ---------------------------------------------------------------------
  // Histogram
  // ---------------------------------------------------------------------

  var NICE_STEPS = [
    1000, 5000, 10000, 30000,
    60000, 300000, 600000, 1800000,
    3600000, 10800000, 21600000, 43200000,
    86400000, 604800000, 2592000000
  ];

  function niceStep(raw) {
    for (var i = 0; i < NICE_STEPS.length; i++) {
      if (NICE_STEPS[i] >= raw) return NICE_STEPS[i];
    }
    return NICE_STEPS[NICE_STEPS.length - 1];
  }

  /**
   * Bucket timestamps into evenly-spaced intervals for a throughput chart.
   * @param {number[]} stamps epoch ms
   * @param {number} start
   * @param {number} end
   * @param {number} [maxBuckets]
   * @returns {Array<{start:number,end:number,count:number,spanMs:number}>}
   */
  function buildBuckets(stamps, start, end, maxBuckets) {
    var limit = maxBuckets && maxBuckets > 0 ? maxBuckets : 40;
    var duration = Math.max(0, end - start);
    var spanMs = duration > 0 ? niceStep(Math.max(1, Math.ceil(duration / limit))) : 60000;
    var origin = Math.floor(start / spanMs) * spanMs;
    var count = Math.floor((end - origin) / spanMs) + 1;
    if (count < 1) count = 1;
    if (count > 2000) count = 2000;
    var buckets = new Array(count);
    for (var i = 0; i < count; i++) {
      buckets[i] = { start: origin + i * spanMs, end: origin + (i + 1) * spanMs, count: 0, spanMs: spanMs };
    }
    for (var s = 0; s < stamps.length; s++) {
      var idx = Math.floor((stamps[s] - origin) / spanMs);
      if (idx < 0) idx = 0;
      if (idx >= count) idx = count - 1;
      buckets[idx].count++;
    }
    return buckets;
  }

  // ---------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------

  /**
   * Filter parsed entries. All criteria are optional and combine with AND.
   * @param {object[]} entries
   * @param {object} [options]
   *   { text, regex, caseSensitive, levels: string[], source, since, until }
   * @returns {object[]}
   */
  function filterEntries(entries, options) {
    options = options || {};
    var text = options.text ? String(options.text) : "";
    var source = options.source ? String(options.source) : "";
    var levels = options.levels && options.levels.length ? options.levels : null;
    var levelSet = levels ? arrayToSet(levels) : null;
    var caseSensitive = !!options.caseSensitive;
    var needle = caseSensitive ? text : text.toLowerCase();

    var re = null;
    if (options.regex) {
      re = compileRegex(options.regex, caseSensitive);
      if (!re) return [];
    }

    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (levelSet && !(e.level && levelSet[e.level])) continue;
      if (source && e.source !== source) continue;
      if (options.since != null && (e.timestamp == null || e.timestamp.epoch < options.since)) continue;
      if (options.until != null && (e.timestamp == null || e.timestamp.epoch > options.until)) continue;
      if (needle) {
        var haystack = caseSensitive ? e.raw : e.raw.toLowerCase();
        if (haystack.indexOf(needle) === -1) continue;
      }
      if (re) {
        re.lastIndex = 0;
        if (!re.test(e.raw)) continue;
      }
      out.push(e);
    }
    return out;
  }

  function arrayToSet(list) {
    var set = Object.create(null);
    for (var i = 0; i < list.length; i++) set[list[i]] = true;
    return set;
  }

  /**
   * Compile a user-supplied regular expression safely. Returns null when the
   * pattern is invalid or too long to be reasonable.
   * @param {string} pattern
   * @param {boolean} [caseSensitive]
   * @returns {RegExp|null}
   */
  function compileRegex(pattern, caseSensitive) {
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_REGEX_LENGTH) return null;
    try {
      return new RegExp(pattern, caseSensitive ? "g" : "gi");
    } catch (e) {
      return null;
    }
  }

  /**
   * Character ranges in a line that match the active search, for highlighting.
   * Returns an empty array when there is nothing to highlight. Never returns
   * overlapping ranges.
   * @param {string} line
   * @param {object} options { text, regex, caseSensitive }
   * @returns {Array<[number,number]>}
   */
  function highlightRanges(line, options) {
    options = options || {};
    var ranges = [];
    if (options.regex) {
      var re = compileRegex(options.regex, options.caseSensitive);
      if (re) {
        var m;
        var guard = 0;
        while ((m = re.exec(line)) !== null && guard < 500) {
          guard++;
          if (m[0] === "") { re.lastIndex++; continue; }
          ranges.push([m.index, m.index + m[0].length]);
        }
      }
    } else if (options.text) {
      var haystack = options.caseSensitive ? line : line.toLowerCase();
      var needle = options.caseSensitive ? String(options.text) : String(options.text).toLowerCase();
      if (needle) {
        var from = 0;
        var at;
        while ((at = haystack.indexOf(needle, from)) !== -1) {
          ranges.push([at, at + needle.length]);
          from = at + needle.length;
          if (ranges.length > 500) break;
        }
      }
    }
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    for (var i = 0; i < ranges.length; i++) {
      var last = merged[merged.length - 1];
      if (last && ranges[i][0] <= last[1]) {
        last[1] = Math.max(last[1], ranges[i][1]);
      } else {
        merged.push([ranges[i][0], ranges[i][1]]);
      }
    }
    return merged;
  }

  // ---------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------

  /**
   * Human-readable duration, e.g. "1h 2m 3s", "450ms".
   * @param {number} ms
   * @returns {string}
   */
  function formatDuration(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "—";
    if (ms < 1000) return Math.round(ms) + "ms";
    var totalSeconds = Math.floor(ms / 1000);
    var days = Math.floor(totalSeconds / 86400);
    var hours = Math.floor((totalSeconds % 86400) / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    var parts = [];
    if (days) parts.push(days + "d");
    if (hours) parts.push(hours + "h");
    if (minutes) parts.push(minutes + "m");
    if (seconds && !days) parts.push(seconds + "s");
    return parts.join(" ") || "0s";
  }

  /**
   * Format an epoch as a compact UTC label.
   * @param {number} epoch
   * @returns {string}
   */
  function formatEpoch(epoch) {
    if (epoch == null || !isFinite(epoch)) return "—";
    var d = new Date(epoch);
    return d.toISOString().replace("T", " ").replace(".000Z", "Z");
  }

  /**
   * Export the given entries as CSV (one row per line).
   * @param {object[]} entries
   * @returns {string}
   */
  function exportCSV(entries) {
    var rows = [["line", "timestamp", "level", "source", "message"]];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      rows.push([
        String(e.n),
        e.timestamp ? e.timestamp.iso : "",
        e.level || "",
        e.source || "",
        e.message
      ]);
    }
    return rows.map(function (row) {
      return row.map(csvCell).join(",");
    }).join("\n");
  }

  function csvCell(value) {
    var s = String(value == null ? "" : value);
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * Export entries as newline-delimited JSON with the extracted fields.
   * @param {object[]} entries
   * @returns {string}
   */
  function exportJSONL(entries) {
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      out.push(JSON.stringify({
        line: e.n,
        timestamp: e.timestamp ? e.timestamp.iso : null,
        level: e.level,
        source: e.source,
        message: e.message
      }));
    }
    return out.join("\n");
  }

  // Translate a UI filter — where `regex` is a mode flag — into the options
  // shape filterEntries expects, where `regex` is the pattern string. Returns
  // the matched entries, whether the pattern was valid, and the highlight
  // configuration for the matched view.
  function query(entries, filter) {
    filter = filter || {};
    var text = filter.text ? String(filter.text) : "";
    var regexMode = !!filter.regex;
    var caseSensitive = !!filter.caseSensitive;
    var options = {
      levels: filter.levels,
      source: filter.source,
      since: filter.since,
      until: filter.until,
      caseSensitive: caseSensitive
    };
    var valid = true;
    if (regexMode) {
      if (text) {
        valid = !!compileRegex(text, caseSensitive);
        options.regex = text;
      }
    } else {
      options.text = text;
    }
    return {
      entries: valid ? filterEntries(entries, options) : [],
      regex: regexMode,
      regexValid: valid,
      highlight: {
        text: regexMode ? "" : text,
        regex: regexMode ? text : "",
        caseSensitive: caseSensitive
      }
    };
  }

  return {
    // parsing
    analyze: analyze,
    parseLine: parseLine,
    parseTimestamp: parseTimestamp,
    normalizeMessage: normalizeMessage,
    extractExceptionTypes: extractExceptionTypes,
    splitLines: splitLines,
    // statistics
    summarize: summarize,
    buildBuckets: buildBuckets,
    // filtering
    filterEntries: filterEntries,
    query: query,
    compileRegex: compileRegex,
    highlightRanges: highlightRanges,
    // formatting
    formatDuration: formatDuration,
    formatEpoch: formatEpoch,
    exportCSV: exportCSV,
    exportJSONL: exportJSONL,
    // tables
    SEVERITIES: SEVERITIES,
    SEVERITY_RANK: SEVERITY_RANK,
    LEVEL_ALIASES: LEVEL_ALIASES,
    TIMESTAMP_PATTERNS: TS_PATTERNS.map(function (p) { return p.id; }),
    MONTHS_SHORT: MONTHS_SHORT,
    MAX_LINES: MAX_LINES,
    MAX_REGEX_LENGTH: MAX_REGEX_LENGTH
  };
});
