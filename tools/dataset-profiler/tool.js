/* Toolshed — Dataset Profiler
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.datasetProfiler and in Node via require() for tests.
 *
 * The module parses CSV/TSV/JSON datasets entirely in memory, infers each
 * column's type, and computes summary statistics (counts, nulls, distinct
 * values, quartiles, outliers, histograms, correlations). It never touches
 * the network and never uses eval/dynamic code execution.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.datasetProfiler = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Bounds so pathologically large inputs cannot exhaust memory or freeze
  // the page. Values beyond these limits are recorded as truncated.
  var MAX_ROWS = 500000;
  var MAX_DISTINCT = 50000;
  var MAX_TOP_ENTRIES = 20000;
  var MAX_DUP_KEYS = 200000;
  var MAX_CORR_COLUMNS = 20;

  var NULL_STRINGS = ["", "null", "na", "n/a", "nan"];
  var NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

  // ---------------------------------------------------------------------
  // CSV parsing
  // ---------------------------------------------------------------------

  /**
   * Parse delimited text into an array of arrays.
   * Handles quoted fields, escaped quotes (""), embedded newlines, commas
   * inside quotes, CRLF line endings, and a leading UTF-8 BOM.
   * @param {string} input
   * @param {string} [delimiter]
   * @returns {Array<Array<string>>}
   */
  function parseDelimited(input, delimiter) {
    var delim = delimiter || ",";
    var text = String(input == null ? "" : input);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = 0;
    var n = text.length;

    function pushField() {
      row.push(field);
      field = "";
    }
    function pushRow() {
      pushField();
      rows.push(row);
      row = [];
    }

    while (i < n) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            inQuotes = false;
            i++;
          }
        } else {
          field += c;
          i++;
        }
      } else if (c === '"' && field === "") {
        inQuotes = true;
        i++;
      } else if (c === delim) {
        pushField();
        i++;
      } else if (c === "\r") {
        if (text[i + 1] === "\n") i++;
        pushRow();
        i++;
      } else if (c === "\n") {
        pushRow();
        i++;
      } else {
        field += c;
        i++;
      }
    }
    if (field !== "" || row.length > 0) pushRow();
    if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
      rows.pop();
    }
    return rows;
  }

  /** Guess the delimiter used by a delimited file from its first line. */
  function detectDelimiter(text) {
    var head = String(text == null ? "" : text).split(/\r?\n/, 1)[0];
    var counts = { ",": 0, ";": 0, "\t": 0, "|": 0 };
    var inQuotes = false;
    for (var i = 0; i < head.length; i++) {
      var c = head[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (!inQuotes && counts[c] !== undefined) counts[c]++;
    }
    var best = ",";
    var max = -1;
    for (var d in counts) {
      if (counts[d] > max) { max = counts[d]; best = d; }
    }
    return best;
  }

  /**
   * Make column names unique and non-empty.
   * @param {Array} rawNames
   * @returns {Array<string>}
   */
  function normalizeHeaders(rawNames) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < rawNames.length; i++) {
      var base = String(rawNames[i] == null ? "" : rawNames[i]).trim();
      if (base === "") base = "column_" + (i + 1);
      var name = base;
      if (seen[base] !== undefined) {
        seen[base] += 1;
        name = base + "_" + seen[base];
        while (seen[name] !== undefined) {
          seen[base] += 1;
          name = base + "_" + seen[base];
        }
      }
      seen[name] = 0;
      out.push(name);
    }
    return out;
  }

  /**
   * Read delimited text into a dataset. The first row is treated as a header
   * unless header is explicitly false.
   * @returns {{columns: Array<string>, rows: Array<Array<string>>}}
   */
  function readDelimited(text, options) {
    options = options || {};
    var delimiter = options.delimiter || detectDelimiter(text);
    var raw = parseDelimited(text, delimiter);
    if (raw.length === 0) return { columns: [], rows: [] };

    var width = 0;
    for (var i = 0; i < raw.length; i++) {
      if (raw[i].length > width) width = raw[i].length;
    }

    var header = options.header !== false;
    var columns;
    var body;
    if (header) {
      columns = normalizeHeaders(raw[0]);
      body = raw.slice(1);
    } else {
      columns = [];
      for (var c = 0; c < width; c++) columns.push("column_" + (c + 1));
      body = raw;
    }
    // Pad short rows so every row has a value for every column.
    for (var r = 0; r < body.length; r++) {
      while (body[r].length < columns.length) body[r].push("");
      if (body[r].length > columns.length) body[r] = body[r].slice(0, columns.length);
    }
    return { columns: columns, rows: body };
  }

  /**
   * Read a JSON document into a dataset. Accepts an array of objects, an
   * array of arrays, or an array of primitives (single column).
   * @returns {{columns: Array<string>, rows: Array<Array>}}
   */
  function readJSONDataset(text) {
    var parsed = JSON.parse(String(text));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // A top-level object with a single array property is a common shape.
      var keys = Object.keys(parsed);
      if (keys.length === 1 && Array.isArray(parsed[keys[0]])) parsed = parsed[keys[0]];
      else return { columns: ["value"], rows: [[parsed]] };
    }
    if (!Array.isArray(parsed)) {
      return { columns: ["value"], rows: [[parsed]] };
    }
    if (parsed.length === 0) return { columns: [], rows: [] };

    if (Array.isArray(parsed[0])) {
      var width = 0;
      for (var i = 0; i < parsed.length; i++) {
        if (parsed[i].length > width) width = parsed[i].length;
      }
      var cols = [];
      for (var c = 0; c < width; c++) cols.push("column_" + (c + 1));
      return { columns: cols, rows: parsed };
    }

    if (parsed[0] !== null && typeof parsed[0] === "object") {
      var names = [];
      var index = Object.create(null);
      for (var r = 0; r < parsed.length; r++) {
        var obj = parsed[r];
        if (obj === null || typeof obj !== "object") continue;
        for (var k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          if (index[k] === undefined) {
            index[k] = names.length;
            names.push(k);
          }
        }
      }
      var rows = [];
      for (var r2 = 0; r2 < parsed.length; r2++) {
        var o = parsed[r2];
        var line = new Array(names.length);
        for (var ci = 0; ci < names.length; ci++) {
          var key = names[ci];
          line[ci] = o && typeof o === "object" && key in o ? o[key] : null;
        }
        rows.push(line);
      }
      return { columns: normalizeHeaders(names), rows: rows };
    }

    // Array of primitives.
    var prim = [];
    for (var p = 0; p < parsed.length; p++) prim.push([parsed[p]]);
    return { columns: ["value"], rows: prim };
  }

  /**
   * Turn a JSON.parse error into a short, user-facing message with a
   * best-effort line/column, instead of echoing the raw engine text.
   * @returns {string}
   */
  function describeParseError(err, text) {
    var message = String((err && err.message) || err || "Invalid JSON.");
    var where = "";

    var posMatch = /position (\d+)/.exec(message);
    var lcMatch = /line (\d+) column (\d+)/i.exec(message);
    if (posMatch) {
      var pos = Number(posMatch[1]);
      var line = 1;
      var column = 1;
      for (var i = 0; i < Math.min(pos, text.length); i++) {
        if (text[i] === "\n") {
          line++;
          column = 1;
        } else {
          column++;
        }
      }
      where = " (line " + line + ", column " + column + ")";
    } else if (lcMatch) {
      where = " (line " + lcMatch[1] + ", column " + lcMatch[2] + ")";
    }

    // Drop the position hints, then any leftover engine phrasing.
    message = message
      .replace(/\bin JSON at position \d+\b/gi, "")
      .replace(/\bin JSON at\s*\(line \d+ column \d+\)/gi, "")
      .replace(/\bin JSON at line \d+ column \d+\b/gi, "")
      .replace(/\(\s*line \d+ column \d+\s*\)/gi, "")
      .replace(/\bat line \d+ column \d+\b/gi, "")
      .replace(/\bposition \d+\b/gi, "")
      .replace(/^JSON\.parse:\s*/i, "")
      .replace(/\bin JSON\b/gi, "")
      .replace(/[,;]?\s*at\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();

    // Newer V8 echoes the offending source snippet before "is not valid JSON".
    if (/is not valid JSON$/i.test(message)) {
      var cut = message.search(/,\s*(\.\.\.|")/);
      message = cut === -1 ? message.replace(/\s*is not valid JSON$/i, "") : message.slice(0, cut);
    }

    if (message) message = message.charAt(0).toLowerCase() + message.slice(1);
    return "Invalid JSON: " + (message || "could not parse the document.") + where;
  }

  /**
   * Parse text as JSON or delimited data, deciding by the first non-space
   * character. Returns a useful error instead of throwing.
   * @returns {{ok:true, dataset:Object, format:string}|{ok:false, error:string}}
   */
  function parseDataset(text, options) {
    options = options || {};
    var raw = String(text == null ? "" : text).replace(/^\s+/, "");
    if (raw === "") {
      return { ok: false, error: "There is no dataset to parse — paste or upload some data first." };
    }
    try {
      if (raw[0] === "[" || raw[0] === "{") {
        return { ok: true, dataset: readJSONDataset(raw), format: "json" };
      }
      return { ok: true, dataset: readDelimited(raw, options), format: "delimited" };
    } catch (err) {
      return { ok: false, error: describeParseError(err, raw) };
    }
  }

  // ---------------------------------------------------------------------
  // Value normalization
  // ---------------------------------------------------------------------

  function isNullValue(value, nullStrings) {
    if (value === null || value === undefined) return true;
    if (typeof value === "number") return false;
    if (typeof value === "boolean") return false;
    var s = String(value).trim();
    return nullStrings.indexOf(s.toLowerCase()) !== -1;
  }

  function toNumber(value) {
    if (typeof value === "number") return isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    var s = value.trim();
    if (!NUMBER_RE.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  function toDateValue(value) {
    if (typeof value !== "string" || !DATE_RE.test(value.trim())) return null;
    var t = Date.parse(value.trim());
    return isNaN(t) ? null : value.trim();
  }

  // ---------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------

  /** Linear-interpolation percentile (numpy / R type 7). Sorted input. */
  function percentile(sorted, p) {
    var n = sorted.length;
    if (n === 0) return NaN;
    if (n === 1) return sorted[0];
    var idx = (n - 1) * p;
    var lo = Math.floor(idx);
    var hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  /** Build equal-width histogram bins from numeric values. */
  function buildHistogram(values, binCount) {
    var bins = Math.max(1, Math.min(50, binCount || 10));
    var n = values.length;
    var out = { edges: [], counts: [], maxCount: 0 };
    if (n === 0) return out;

    var min = values[0];
    var max = values[0];
    for (var i = 1; i < n; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    if (min === max) {
      out.edges = [min, max];
      out.counts = [n];
      out.maxCount = n;
      return out;
    }
    var width = (max - min) / bins;
    var counts = new Array(bins);
    var e;
    for (e = 0; e < bins; e++) counts[e] = 0;
    for (var j = 0; j < n; j++) {
      var b = Math.floor((values[j] - min) / width);
      if (b < 0) b = 0;
      if (b >= bins) b = bins - 1;
      counts[b]++;
    }
    out.counts = counts;
    out.edges = [];
    for (e = 0; e <= bins; e++) out.edges.push(min + width * e);
    var maxCount = 0;
    for (e = 0; e < counts.length; e++) if (counts[e] > maxCount) maxCount = counts[e];
    out.maxCount = maxCount;
    return out;
  }

  /**
   * Profile a single column.
   * @returns {Object} column profile plus internals used by profileDataset
   */
  function profileColumn(name, rows, colIndex, options) {
    options = options || {};
    var nullStrings = options.nullStrings || NULL_STRINGS;
    var raw = options.rawValues || null; // optional pre-extracted values

    var count = 0;
    var nulls = 0;
    var numericCount = 0;
    var boolCount = 0;
    var dateCount = 0;
    var otherCount = 0;
    var integer = true;
    var distinctSet = new Set();
    var distinctTruncated = false;
    var topMap = new Map();
    var topTruncated = false;
    var minLength = Infinity;
    var maxLength = 0;
    var numericValues = [];
    var dateValues = [];
    var trueCount = 0;
    var falseCount = 0;

    var n = raw ? raw.length : rows.length;
    for (var i = 0; i < n; i++) {
      var value = raw ? raw[i] : rows[i][colIndex];

      if (isNullValue(value, nullStrings)) {
        nulls++;
        continue;
      }
      count++;

      // Classify the value first so the distinct/top tallies use one
      // canonical key per logical value (e.g. "TRUE" and "true" are equal).
      var str;
      var boolValue = null;
      var num = null;
      if (typeof value === "number") {
        num = value;
      } else if (typeof value === "boolean") {
        boolValue = value;
      } else {
        str = String(value);
        if (str.length < minLength) minLength = str.length;
        if (str.length > maxLength) maxLength = str.length;
        num = toNumber(str);
        if (num === null) {
          var low = str.toLowerCase();
          if (low === "true") boolValue = true;
          else if (low === "false") boolValue = false;
        }
      }

      var key;
      if (typeof value === "number") key = "n:" + value;
      else if (boolValue !== null) key = "s:" + boolValue;
      else key = "s:" + str;

      if (!distinctTruncated) {
        if (distinctSet.size < MAX_DISTINCT) distinctSet.add(key);
        else distinctTruncated = true;
      }
      if (!topTruncated) {
        if (topMap.has(key)) topMap.set(key, topMap.get(key) + 1);
        else if (topMap.size < MAX_TOP_ENTRIES) topMap.set(key, 1);
        else topTruncated = true;
      }

      if (boolValue !== null) {
        boolCount++;
        if (boolValue) trueCount++;
        else falseCount++;
      } else if (num !== null) {
        numericCount++;
        numericValues.push(num);
        if (!Number.isInteger(num)) integer = false;
      } else {
        var dateVal = toDateValue(str);
        if (dateVal !== null) {
          dateCount++;
          dateValues.push(dateVal);
        } else {
          otherCount++;
        }
      }
    }

    var type;
    if (count === 0) type = "empty";
    else if (otherCount === 0 && numericCount === count) type = integer ? "integer" : "number";
    else if (otherCount === 0 && boolCount === count) type = "boolean";
    else if (otherCount === 0 && dateCount === count) type = "date";
    else type = "text";

    var profile = {
      name: name,
      index: colIndex,
      type: type,
      count: count,
      nulls: nulls,
      nullRatio: rows.length > 0 ? nulls / rows.length : 0,
      distinct: distinctTruncated ? MAX_DISTINCT : distinctSet.size,
      distinctTruncated: distinctTruncated,
      topTruncated: topTruncated
    };

    if (type === "text") {
      profile.minLength = minLength === Infinity ? 0 : minLength;
      profile.maxLength = maxLength;
    }
    if (type === "boolean") {
      profile.trueCount = trueCount;
      profile.falseCount = falseCount;
    }
    if (type === "date") {
      var sortedDates = dateValues.slice().sort();
      profile.min = sortedDates[0];
      profile.max = sortedDates[sortedDates.length - 1];
    }
    if (type === "integer" || type === "number") {
      profile.numeric = summarizeNumbers(numericValues, options.binCount);
    }
    if (type === "text" || type === "date" || type === "boolean") {
      profile.top = topValues(topMap, 5);
    }

    return { profile: profile, numericValues: numericValues, topMap: topMap };
  }

  /** Compute summary statistics for an array of numbers. */
  function summarizeNumbers(values, binCount) {
    var n = values.length;
    var out = {
      min: null, max: null, sum: 0, mean: null,
      median: null, q1: null, q3: null, iqr: null,
      variance: null, stdev: null, outliers: 0,
      histogram: null
    };
    if (n === 0) return out;

    var sum = 0;
    for (var i = 0; i < n; i++) sum += values[i];
    var mean = sum / n;

    var min = values[0];
    var max = values[0];
    var ss = 0;
    for (var j = 0; j < n; j++) {
      var v = values[j];
      if (v < min) min = v;
      if (v > max) max = v;
      var d = v - mean;
      ss += d * d;
    }

    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var q1 = percentile(sorted, 0.25);
    var median = percentile(sorted, 0.5);
    var q3 = percentile(sorted, 0.75);
    var iqr = q3 - q1;

    var outliers = 0;
    if (iqr > 0) {
      var loFence = q1 - 1.5 * iqr;
      var hiFence = q3 + 1.5 * iqr;
      for (var k = 0; k < n; k++) {
        if (sorted[k] < loFence || sorted[k] > hiFence) outliers++;
      }
    }

    out.min = min;
    out.max = max;
    out.sum = sum;
    out.mean = mean;
    out.median = median;
    out.q1 = q1;
    out.q3 = q3;
    out.iqr = iqr;
    out.variance = n > 1 ? ss / (n - 1) : 0;
    out.stdev = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
    out.outliers = outliers;
    out.histogram = buildHistogram(values, binCount);
    out.sorted = sorted;
    return out;
  }

  /** The most frequent values, sorted by count then value, up to `limit`. */
  function topValues(topMap, limit) {
    var entries = [];
    topMap.forEach(function (count, key) {
      entries.push({ value: key.slice(2), count: count, isNumber: key.slice(0, 2) === "n:" });
    });
    entries.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return String(a.value).localeCompare(String(b.value));
    });
    return entries.slice(0, limit);
  }

  /** Pearson correlation over indices where both series have values. */
  function pearson(a, b) {
    var n = Math.min(a.length, b.length);
    var count = 0;
    var sumA = 0;
    var sumB = 0;
    for (var i = 0; i < n; i++) {
      if (a[i] === null || b[i] === null || a[i] === undefined || b[i] === undefined) continue;
      sumA += a[i];
      sumB += b[i];
      count++;
    }
    if (count < 2) return null;
    var meanA = sumA / count;
    var meanB = sumB / count;
    var cov = 0;
    var varA = 0;
    var varB = 0;
    for (var j = 0; j < n; j++) {
      if (a[j] === null || b[j] === null || a[j] === undefined || b[j] === undefined) continue;
      var da = a[j] - meanA;
      var db = b[j] - meanB;
      cov += da * db;
      varA += da * da;
      varB += db * db;
    }
    if (varA === 0 || varB === 0) return null;
    return cov / Math.sqrt(varA * varB);
  }

  // ---------------------------------------------------------------------
  // Dataset profiling
  // ---------------------------------------------------------------------

  /**
   * Profile a whole dataset.
   * @param {{columns: Array<string>, rows: Array<Array>}} dataset
   * @param {Object} [options] { binCount, nullStrings }
   * @returns {Object} profile
   */
  function profileDataset(dataset, options) {
    options = options || {};
    var columns = (dataset && dataset.columns) || [];
    var rows = (dataset && dataset.rows) || [];
    var rowCount = rows.length;

    var columnProfiles = [];
    var numericSeries = [];
    for (var c = 0; c < columns.length; c++) {
      var result = profileColumn(columns[c], rows, c, options);
      columnProfiles.push(result.profile);
      if (result.profile.numeric) {
        numericSeries.push({ name: columns[c], values: result.numericValues });
      }
    }

    var totalCells = rowCount * columns.length;
    var totalNulls = 0;
    for (var p = 0; p < columnProfiles.length; p++) totalNulls += columnProfiles[p].nulls;

    var profile = {
      generatedBy: "Toolshed Dataset Profiler",
      rowCount: rowCount,
      columnCount: columns.length,
      cellCount: totalCells,
      missingCells: totalNulls,
      missingRatio: totalCells > 0 ? totalNulls / totalCells : 0,
      truncated: rowCount > MAX_ROWS,
      duplicateRows: countDuplicateRows(rows),
      columns: stripInternal(columnProfiles),
      correlations: buildCorrelations(numericSeries)
    };
    return profile;
  }

  /** Remove the non-serializable `sorted` helper from numeric summaries. */
  function stripInternal(profiles) {
    return profiles.map(function (col) {
      if (!col.numeric || !col.numeric.sorted) return col;
      var copy = {};
      for (var key in col.numeric) {
        if (key === "sorted") continue;
        copy[key] = col.numeric[key];
      }
      var out = {};
      for (var k in col) {
        if (k === "numeric") out.numeric = copy;
        else out[k] = col[k];
      }
      return out;
    });
  }

  /** Count rows that appear more than once. */
  function countDuplicateRows(rows) {
    var seen = new Set();
    var duplicates = 0;
    var limit = Math.min(rows.length, MAX_DUP_KEYS);
    for (var i = 0; i < limit; i++) {
      var key = "";
      var row = rows[i];
      for (var j = 0; j < row.length; j++) {
        key += (row[j] === null || row[j] === undefined ? "\u0000" : String(row[j])) + "\u0001";
      }
      if (seen.has(key)) duplicates++;
      else seen.add(key);
    }
    return duplicates;
  }

  /** Pearson correlation matrix across numeric columns (bounded). */
  function buildCorrelations(numericSeries) {
    if (numericSeries.length < 2) return null;
    var series = numericSeries.slice(0, MAX_CORR_COLUMNS);
    var names = [];
    var matrix = [];
    for (var i = 0; i < series.length; i++) names.push(series[i].name);
    for (var r = 0; r < series.length; r++) {
      var row = [];
      for (var c = 0; c < series.length; c++) {
        row.push(r === c ? 1 : pearson(series[r].values, series[c].values));
      }
      matrix.push(row);
    }
    return { columns: names, matrix: matrix };
  }

  /**
   * Parse and profile text in one call.
   * @returns {{ok:true, profile:Object, format:string}|{ok:false, error:string}}
   */
  function profileText(text, options) {
    var parsed = parseDataset(text, options);
    if (!parsed.ok) return parsed;
    try {
      var profile = profileDataset(parsed.dataset, options);
      profile.format = parsed.format;
      return { ok: true, profile: profile, format: parsed.format };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  // ---------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------

  /** Format a number for display without losing small magnitudes. */
  function formatNumber(value) {
    if (value === null || value === undefined) return "—";
    if (typeof value !== "number" || !isFinite(value)) return String(value);
    if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
    var abs = Math.abs(value);
    if (abs !== 0 && (abs < 0.001 || abs >= 1e9)) return value.toExponential(3);
    return String(Math.round(value * 1000) / 1000);
  }

  /** Render a profile as a Markdown report. */
  function toMarkdown(profile) {
    var lines = [];
    lines.push("# Dataset profile");
    lines.push("");
    lines.push("- Rows: " + profile.rowCount);
    lines.push("- Columns: " + profile.columnCount);
    lines.push("- Missing cells: " + profile.missingCells +
      " (" + (profile.missingRatio * 100).toFixed(1) + "%)");
    lines.push("- Duplicate rows: " + profile.duplicateRows);
    lines.push("");

    for (var i = 0; i < profile.columns.length; i++) {
      var col = profile.columns[i];
      lines.push("## " + col.name + " (" + col.type + ")");
      lines.push("");
      lines.push("- Non-null: " + col.count + " / " + profile.rowCount +
        " (" + (col.nullRatio * 100).toFixed(1) + "% missing)");
      lines.push("- Distinct: " + col.distinct + (col.distinctTruncated ? "+" : ""));

      if (col.numeric) {
        var n = col.numeric;
        lines.push("- Min: " + formatNumber(n.min) + ", Max: " + formatNumber(n.max));
        lines.push("- Mean: " + formatNumber(n.mean) + ", Median: " + formatNumber(n.median));
        lines.push("- Q1: " + formatNumber(n.q1) + ", Q3: " + formatNumber(n.q3) +
          ", IQR: " + formatNumber(n.iqr));
        lines.push("- Std dev: " + formatNumber(n.stdev));
        lines.push("- Outliers (1.5 × IQR): " + n.outliers);
      }
      if (col.type === "date") {
        lines.push("- Earliest: " + col.min + ", Latest: " + col.max);
      }
      if (col.type === "boolean") {
        lines.push("- True: " + col.trueCount + ", False: " + col.falseCount);
      }
      if (col.top && col.top.length > 0) {
        lines.push("- Top values: " + col.top.map(function (t) {
          return "`" + t.value + "` (" + t.count + ")";
        }).join(", "));
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  return {
    parseDelimited: parseDelimited,
    detectDelimiter: detectDelimiter,
    normalizeHeaders: normalizeHeaders,
    readDelimited: readDelimited,
    readJSONDataset: readJSONDataset,
    parseDataset: parseDataset,
    isNullValue: isNullValue,
    toNumber: toNumber,
    percentile: percentile,
    buildHistogram: buildHistogram,
    summarizeNumbers: summarizeNumbers,
    profileColumn: function (name, rows, colIndex, options) {
      return profileColumn(name, rows, colIndex, options).profile;
    },
    profileDataset: profileDataset,
    pearson: pearson,
    buildCorrelations: buildCorrelations,
    countDuplicateRows: countDuplicateRows,
    profileText: profileText,
    formatNumber: formatNumber,
    toMarkdown: toMarkdown,
    NULL_STRINGS: NULL_STRINGS,
    MAX_DISTINCT: MAX_DISTINCT
  };
});
