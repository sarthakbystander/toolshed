(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.csvToJson = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Parse a CSV string into an array of arrays (raw cell values as strings).
   * Handles quoted fields, escaped quotes (""), embedded newlines, commas
   * inside quotes, and CRLF line endings.
   */
  function parseCSV(input, delimiter) {
    var delim = delimiter || ",";
    var text = String(input == null ? "" : input);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
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
    // trailing content after final newline
    if (field !== "" || row.length > 0) {
      pushRow();
    }
    // drop fully-empty trailing row caused by a final newline
    if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
      rows.pop();
    }
    return rows;
  }

  /** Guess the delimiter from a CSV header line. */
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

  /** Infer a JSON value from a string cell. */
  function inferValue(raw) {
    if (raw === "") return "";
    if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) {
      var num = Number(raw);
      if (isFinite(num)) return num;
    }
    var low = raw.toLowerCase();
    if (low === "true") return true;
    if (low === "false") return false;
    if (low === "null") return null;
    return raw;
  }

  /**
   * Convert parsed CSV rows to JSON.
   * @param {Array<Array<string>>} rows
   * @param {Object} options { delimiter, inferTypes }
   * @returns {Array|Object}
   */
  function rowsToJson(rows, options) {
    options = options || {};
    var infer = options.inferTypes !== false;

    function val(cell) {
      return infer ? inferValue(cell) : cell;
    }

    if (rows.length === 0) return [];

    // --- simple array mode: single column, no header ------------------------
    if (rows[0].length === 1 && !options.header) {
      return rows.map(function (r) { return val(r[0]); });
    }

    var useHeader = options.header;
    if (useHeader === undefined) {
      // detect: header row if every non-empty cell looks like a plain label
      var head = rows[0];
      useHeader = head.every(function (cell) {
        return cell !== "" && !/^[-+]?\d*(\.\d+)?([eE][-+]?\d+)?$/.test(cell) && cell !== "true" && cell !== "false" && cell !== "null";
      });
      if (rows.length === 1 && useHeader) useHeader = true;
    }

    var dataRows = rows;
    var headerCols = null;
    if (useHeader) {
      headerCols = rows[0].map(function (h) { return h.trim(); });
      dataRows = rows.slice(1);
    }

    var out = [];
    dataRows.forEach(function (r) {
      var i = 0;
      if (useHeader) {
        var obj = {};
        headerCols.forEach(function (col, idx) {
          var cell = idx < r.length ? r[idx] : "";
          var key = col || ("field_" + (idx + 1));
          if (obj.hasOwnProperty(key)) {
            // duplicate header: combine into array
            if (Array.isArray(obj[key])) obj[key].push(val(cell));
            else obj[key] = [obj[key], val(cell)];
          } else {
            obj[key] = val(cell);
          }
        });
        if (options.columns && options.columns === "auto") {
          // unused columns beyond header length
          for (i = headerCols.length; i < r.length; i++) {
            obj["extra_" + (i + 1)] = val(r[i]);
          }
        }
        // missing columns become null instead of empty string when requested
        if (options.fillMissing) {
          headerCols.forEach(function (col, idx) {
            var key = col || ("field_" + (idx + 1));
            if (idx >= r.length) obj[key] = null;
          });
        }
        out.push(obj);
      } else {
        out.push(r.map(function (cell) { return val(cell); }));
      }
    });
    return out;
  }

  /**
   * Full pipeline: CSV text to JSON (array or object) with a useful error.
   * @returns {{ok:true,json:Array|Object,count:number,rows:number}|{ok:false,error:string}}
   */
  function convert(input, options) {
    try {
      var rows = parseCSV(input, (options || {}).delimiter);
      if (rows.length === 0) {
        return { ok: true, json: [], count: 0, rows: 0 };
      }
      var json = rowsToJson(rows, options || {});
      return { ok: true, json: json, count: rows.length, rows: rows.length };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  return {
    parseCSV: parseCSV,
    detectDelimiter: detectDelimiter,
    inferValue: inferValue,
    rowsToJson: rowsToJson,
    convert: convert
  };
});