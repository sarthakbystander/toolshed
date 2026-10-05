/* Toolshed — Cron Expression Lab
 * Core logic, dependency-free (standard JavaScript only). Loads in the browser
 * as window.Toolshed.cronExpressionLab and in Node via require() for tests.
 *
 * The module parses a cron expression, validates it, describes it in plain
 * language, and computes the next fire times in a chosen IANA time zone.
 * Everything happens in memory: no network, no eval, no storage.
 *
 * Time zones are handled with Intl.DateTimeFormat, so DST transitions are
 * observed from real wall-clock values rather than by assuming a fixed offset.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.cronExpressionLab = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // -------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------

  var MONTH_NAMES = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12
  };
  var DOW_NAMES = {
    SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6
  };

  var MONTH_LABELS = ["", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  var DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Field definitions. `normalize` maps aliases onto canonical values (cron
  // accepts both 0 and 7 for Sunday).
  var FIELD_DEFS = {
    second: { min: 0, max: 59 },
    minute: { min: 0, max: 59 },
    hour: { min: 0, max: 23 },
    dom: { min: 1, max: 31 },
    month: { min: 1, max: 12, names: MONTH_NAMES },
    // Range accepts 0-7; 7 is folded onto 0 for matching.
    dow: { min: 0, max: 7, names: DOW_NAMES, normalize: function (v) { return v === 7 ? 0 : v; } },
    year: { min: 1970, max: 2099 }
  };

  // Available field layouts. Order matters: it is the positional order of the
  // whitespace-separated fields.
  var LAYOUTS = {
    standard: { label: "5 fields — min hour day month weekday", fields: ["minute", "hour", "dom", "month", "dow"] },
    "with-seconds": { label: "6 fields — sec min hour day month weekday", fields: ["second", "minute", "hour", "dom", "month", "dow"] },
    "with-year": { label: "6 fields — min hour day month weekday year", fields: ["minute", "hour", "dom", "month", "dow", "year"] },
    full: { label: "7 fields — sec min hour day month weekday year", fields: ["second", "minute", "hour", "dom", "month", "dow", "year"] }
  };

  // Macros (@daily, @hourly, ...). `@reboot` has no schedule and is special.
  var MACROS = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *"
  };

  var DOM_DOW_MODES = ["or", "and", "dom", "dow"];

  // -------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function sortNumbers(set) {
    return Array.from(set).map(Number).sort(function (a, b) { return a - b; });
  }

  function joinList(items) {
    if (items.length === 0) return "";
    if (items.length === 1) return items[0];
    if (items.length === 2) return items[0] + " and " + items[1];
    return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
  }

  function isLayout(id) {
    return Object.prototype.hasOwnProperty.call(LAYOUTS, id);
  }

  function listLayouts() {
    return Object.keys(LAYOUTS).map(function (id) {
      return { id: id, label: LAYOUTS[id].label, fields: LAYOUTS[id].fields.slice() };
    });
  }

  function listDomDowModes() {
    return [
      { id: "or", label: "Standard — day OR weekday matches" },
      { id: "and", label: "Quartz-style — day AND weekday must both match" },
      { id: "dom", label: "Ignore weekday, use day-of-month only" },
      { id: "dow", label: "Ignore day-of-month, use weekday only" }
    ];
  }

  // -------------------------------------------------------------------
  // Field parsing
  // -------------------------------------------------------------------

  function parseFieldToken(token, def) {
    var t = String(token).trim().toUpperCase();
    if (t === "") return null;
    if (def.names && Object.prototype.hasOwnProperty.call(def.names, t)) {
      return def.names[t];
    }
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    return null;
  }

  /**
   * Expand one cron field into the set of matching numeric values.
   * Supports `*`, `a`, `a-b`, `a-b/step`, wildcard/step, `a/step`, comma
   * unions, and three-letter names for months and weekdays.
   * @returns {{ok:true, values:Set<number>, restricted:boolean, raw:string, step:number|null} | {ok:false, error:string}}
   */
  function expandField(raw, def) {
    var text = String(raw == null ? "" : raw).trim();
    if (text === "") return { ok: false, error: "empty field" };

    // `?` is a synonym for `*` in day-of-month / day-of-week.
    if (text === "?") text = "*";

    var values = new Set();
    var steps = [];
    var segments = text.split(",");

    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s].trim();
      if (seg === "") return { ok: false, error: 'empty list item in "' + raw + '"' };

      var step = 1;
      var slash = seg.indexOf("/");
      if (slash !== -1) {
        var pieces = seg.split("/");
        if (pieces.length !== 2 || pieces[0] === "" || pieces[1] === "") {
          return { ok: false, error: 'invalid step syntax in "' + seg + '"' };
        }
        var stepStr = pieces[1].trim();
        if (!/^\d+$/.test(stepStr)) return { ok: false, error: 'step must be a positive integer in "' + seg + '"' };
        step = parseInt(stepStr, 10);
        if (step < 1) return { ok: false, error: 'step must be at least 1 in "' + seg + '"' };
        seg = pieces[0].trim();
      }
      steps.push(step);

      if (seg === "*" || seg === "") {
        addRange(values, def.min, def.max, step);
        continue;
      }

      var dash = seg.indexOf("-");
      if (dash !== -1) {
        var rp = seg.split("-");
        if (rp.length !== 2) return { ok: false, error: 'invalid range in "' + seg + '"' };
        var a = parseFieldToken(rp[0], def);
        var b = parseFieldToken(rp[1], def);
        if (a === null || b === null) return { ok: false, error: 'invalid range value in "' + seg + '"' };
        if (a > b) return { ok: false, error: 'range start is greater than end in "' + seg + '"' };
        addRange(values, a, b, step);
        continue;
      }

      var single = parseFieldToken(seg, def);
      if (single === null) return { ok: false, error: 'invalid value "' + seg + '"' };
      if (single < def.min || single > def.max) {
        return { ok: false, error: '"' + seg + '" is outside the allowed range ' + def.min + "-" + def.max };
      }
      if (step > 1) {
        addRange(values, single, def.max, step);
      } else {
        values.add(single);
      }
    }

    // Normalize aliases (e.g. day-of-week 7 -> 0) and validate bounds once more.
    var normalized = new Set();
    values.forEach(function (v) {
      if (v < def.min || v > def.max) return;
      normalized.add(def.normalize ? def.normalize(v) : v);
    });
    if (normalized.size === 0) {
      return { ok: false, error: 'field "' + raw + '" matches no values' };
    }

    var fullSize = def.normalize ? (def.max - def.min) : (def.max - def.min + 1);
    var restricted = normalized.size !== fullSize;
    var stepInfo = null;
    if (steps.length === 1 && steps[0] > 1) stepInfo = steps[0];

    return { ok: true, values: normalized, restricted: restricted, raw: text, step: stepInfo };
  }

  function addRange(set, from, to, step) {
    for (var v = from; v <= to; v += step) set.add(v);
  }

  /**
   * Compact a set of values into a range string, e.g. [1,2,3,5] -> "1–3, 5".
   * Used by the UI to summarise what a field matches without listing hundreds
   * of individual numbers.
   */
  function summarizeRanges(values) {
    var sorted = sortNumbers(values);
    if (sorted.length === 0) return "—";
    var parts = [];
    var start = sorted[0];
    var prev = sorted[0];
    for (var i = 1; i < sorted.length; i++) {
      if (sorted[i] === prev + 1) {
        prev = sorted[i];
      } else {
        parts.push(start === prev ? String(start) : start + "–" + prev);
        start = prev = sorted[i];
      }
    }
    parts.push(start === prev ? String(start) : start + "–" + prev);
    return parts.join(", ");
  }

  // -------------------------------------------------------------------
  // Expression parsing
  // -------------------------------------------------------------------

  /**
   * Resolve a macro to its expansion. Returns null when the input is not a macro.
   */
  function expandMacro(expr) {
    var key = String(expr == null ? "" : expr).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MACROS, key)) {
      return { expression: MACROS[key], macro: key };
    }
    if (key === "@reboot") {
      return { error: "@reboot has no fixed schedule — it runs once when the machine boots, so there are no next fire times to compute." };
    }
    return null;
  }

  function detectLayout(fieldCount, tokens) {
    if (fieldCount === 5) return "standard";
    if (fieldCount === 7) return "full";
    if (fieldCount === 6) {
      // A trailing four-digit value (or one beyond the seconds range) is far
      // more likely a year than a day-of-week, so prefer "with-year".
      if (tokens && tokens.length === 6 && /^\d{4}$/.test(String(tokens[5]).trim())) return "with-year";
      return "with-seconds";
    }
    return null;
  }

  /**
   * Parse a cron expression into validated field sets.
   * @param {string} expr
   * @param {{layout?:string, domDowMode?:string}} [options]
   * @returns {{ok:true, ...} | {ok:false, error:string}}
   */
  function parseCron(expr, options) {
    options = options || {};
    var raw = String(expr == null ? "" : expr).trim();
    if (raw === "") return { ok: false, error: "Enter a cron expression." };

    var macro = expandMacro(raw);
    var macroName = null;
    if (macro) {
      if (macro.error) return { ok: false, error: macro.error };
      raw = macro.expression;
      macroName = macro.macro;
    }

    var tokens = raw.split(/\s+/).filter(function (t) { return t !== ""; });
    var layoutId = options.layout && options.layout !== "auto" ? options.layout : detectLayout(tokens.length, tokens);
    if (!layoutId || !isLayout(layoutId)) {
      return { ok: false, error: "A cron expression needs 5, 6 or 7 fields; got " + tokens.length + "." };
    }

    var fieldNames = LAYOUTS[layoutId].fields;
    if (tokens.length !== fieldNames.length) {
      return {
        ok: false,
        error: "This expression has " + tokens.length + " fields but the selected layout expects " + fieldNames.length + "."
      };
    }

    var mode = options.domDowMode || "or";
    if (DOM_DOW_MODES.indexOf(mode) === -1) mode = "or";

    var fields = {};
    for (var i = 0; i < fieldNames.length; i++) {
      var name = fieldNames[i];
      var result = expandField(tokens[i], FIELD_DEFS[name]);
      if (!result.ok) {
        return { ok: false, error: "Problem in the " + name.replace("dom", "day-of-month").replace("dow", "day-of-week").replace("second", "seconds") + " field: " + result.error + "." };
      }
      fields[name] = result;
    }

    var hasSeconds = fieldNames.indexOf("second") !== -1;
    var hasYear = fieldNames.indexOf("year") !== -1;
    if (!hasSeconds) fields.second = expandField("0", FIELD_DEFS.second); // fires once per minute at :00
    if (!hasYear) fields.year = expandField("*", FIELD_DEFS.year);

    return {
      ok: true,
      input: String(expr == null ? "" : expr).trim(),
      canonical: fieldNames.map(function (n) { return fields[n].raw; }).join(" "),
      layout: layoutId,
      fields: fields,
      hasSeconds: hasSeconds,
      hasYear: hasYear,
      domDowMode: mode,
      macro: macroName
    };
  }

  // -------------------------------------------------------------------
  // Matching
  // -------------------------------------------------------------------

  function dayMatches(parsed, day, weekday, mode) {
    var domR = parsed.fields.dom.restricted;
    var dowR = parsed.fields.dow.restricted;
    var domM = parsed.fields.dom.values.has(day);
    var dowM = parsed.fields.dow.values.has(weekday);

    if (mode === "dom") return domM;
    if (mode === "dow") return dowM;
    if (mode === "and") return domM && dowM;
    if (!domR && !dowR) return true;
    if (domR && !dowR) return domM;
    if (!domR && dowR) return dowM;
    return domM || dowM;
  }

  /**
   * Does a set of already-resolved wall-clock parts match the expression?
   * @param {object} parsed
   * @param {{year:number,month:number,day:number,hour:number,minute:number,second:number,weekday:number}} parts
   * @param {string} [mode]
   */
  function matchesParts(parsed, parts, mode) {
    mode = mode || parsed.domDowMode || "or";
    if (!parsed.fields.year.values.has(parts.year)) return false;
    if (!parsed.fields.month.values.has(parts.month)) return false;
    if (!dayMatches(parsed, parts.day, parts.weekday, mode)) return false;
    if (!parsed.fields.hour.values.has(parts.hour)) return false;
    if (!parsed.fields.minute.values.has(parts.minute)) return false;
    if (!parsed.fields.second.values.has(parts.second)) return false;
    return true;
  }

  // -------------------------------------------------------------------
  // Time zones
  // -------------------------------------------------------------------

  var formatterCache = {};

  function getFormatter(tz) {
    if (!formatterCache[tz]) {
      formatterCache[tz] = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
    }
    return formatterCache[tz];
  }

  /**
   * Resolve the wall-clock parts of an instant in a time zone.
   * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number,weekday:number}}
   */
  function getTimeZoneParts(date, tz) {
    var parts = getFormatter(tz).formatToParts(date);
    var o = {};
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.type === "literal") continue;
      var n = parseInt(p.value, 10);
      if (!isNaN(n)) o[p.type] = n;
    }
    o.weekday = new Date(Date.UTC(o.year, o.month - 1, o.day)).getUTCDay();
    return o;
  }

  function localMsFromInstant(date, tz) {
    var p = getTimeZoneParts(date, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }

  function offsetMs(date, tz) {
    return localMsFromInstant(date, tz) - date.getTime();
  }

  /**
   * Convert a wall-clock value (ms as if UTC) to the real instant in `tz`,
   * resolving the offset twice so DST boundaries settle. The instant may not
   * exist (spring-forward gap); the caller should verify round-tripping.
   */
  function localToUtcMs(localMs, tz) {
    var guess = localMs - offsetMs(new Date(localMs), tz);
    var off1 = offsetMs(new Date(guess), tz);
    var result = localMs - off1;
    var off2 = offsetMs(new Date(result), tz);
    if (off2 !== off1) result = localMs - off2;
    return result;
  }

  function formatInstant(date, tz, opts) {
    opts = opts || {};
    var options = {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    };
    if (opts.weekday) options.weekday = "short";
    if (opts.seconds) options.second = "2-digit";
    if (opts.zoneName !== false) options.timeZoneName = "short";
    try {
      return new Intl.DateTimeFormat("en-US", options).format(date);
    } catch (e) {
      return date.toISOString();
    }
  }

  var FALLBACK_ZONES = [
    "UTC", "Africa/Cairo", "Africa/Johannesburg", "America/Anchorage", "America/Chicago",
    "America/Denver", "America/Los_Angeles", "America/Mexico_City", "America/New_York",
    "America/Sao_Paulo", "Asia/Dubai", "Asia/Hong_Kong", "Asia/Kolkata", "Asia/Shanghai",
    "Asia/Singapore", "Asia/Tokyo", "Australia/Perth", "Australia/Sydney", "Europe/Amsterdam",
    "Europe/Berlin", "Europe/London", "Europe/Madrid", "Europe/Paris", "Europe/Rome",
    "Pacific/Auckland"
  ];

  function listTimeZones() {
    var zones = null;
    try {
      if (typeof Intl.supportedValuesOf === "function") {
        zones = Intl.supportedValuesOf("timeZone");
      }
    } catch (e) { /* fall through to the curated list */ }
    if (!zones || !zones.length) zones = FALLBACK_ZONES.slice();
    if (zones.indexOf("UTC") === -1) zones.push("UTC");
    return zones.slice().sort();
  }

  function isValidTimeZone(tz) {
    if (typeof tz !== "string" || tz === "") return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch (e) {
      return false;
    }
  }

  // -------------------------------------------------------------------
  // Next occurrences
  // -------------------------------------------------------------------

  var DEFAULT_MAX_JUMPS = 100000;

  /**
   * Compute the next fire times after `start` in time zone `tz`.
   *
   * The search runs on wall-clock values and jumps whole days/hours/minutes
   * when a field does not match, so even yearly schedules resolve quickly.
   * @param {object} parsed - result of parseCron
   * @param {{tz?:string, start?:Date|string|number, count?:number, domDowMode?:string, maxJumps?:number}} [opts]
   */
  function nextOccurrences(parsed, opts) {
    opts = opts || {};
    if (!parsed || !parsed.ok) return { ok: false, error: "Nothing to schedule — parse the expression first." };

    var tz = opts.tz || "UTC";
    if (!isValidTimeZone(tz)) return { ok: false, error: "Unknown time zone: " + tz };

    var count = Math.max(1, Math.min(50, opts.count || 5));
    var start = opts.start ? new Date(opts.start) : new Date();
    if (isNaN(start.getTime())) return { ok: false, error: "Invalid start date." };
    var mode = opts.domDowMode || parsed.domDowMode || "or";
    var maxJumps = opts.maxJumps || DEFAULT_MAX_JUMPS;

    // Start one second after the given instant, on the wall clock.
    var local = localMsFromInstant(start, tz) + 1000;
    // Horizon keeps a contradictory schedule (e.g. 31 February) from looping.
    var horizon = local + 366 * 24 * 3600 * 1000 * 20;

    var occurrences = [];
    var jumps = 0;

    while (occurrences.length < count && jumps < maxJumps && local <= horizon) {
      jumps++;
      var probe = new Date(local);
      var Y = probe.getUTCFullYear();
      var Mo = probe.getUTCMonth() + 1;
      var D = probe.getUTCDate();
      var H = probe.getUTCHours();
      var Mi = probe.getUTCMinutes();
      var S = probe.getUTCSeconds();

      if (!parsed.fields.year.values.has(Y)) {
        local = Date.UTC(Y + 1, 0, 1, 0, 0, 0);
        continue;
      }
      if (!parsed.fields.month.values.has(Mo)) {
        local = Date.UTC(Y, Mo, 1, 0, 0, 0); // Mo is 1-based, so month index Mo is the next month
        continue;
      }
      var weekday = new Date(Date.UTC(Y, Mo - 1, D)).getUTCDay();
      if (!dayMatches(parsed, D, weekday, mode)) {
        local = Date.UTC(Y, Mo - 1, D + 1, 0, 0, 0);
        continue;
      }
      if (!parsed.fields.hour.values.has(H)) {
        local = Date.UTC(Y, Mo - 1, D, H + 1, 0, 0);
        continue;
      }
      if (!parsed.fields.minute.values.has(Mi)) {
        local = Date.UTC(Y, Mo - 1, D, H, Mi + 1, 0);
        continue;
      }
      if (!parsed.fields.second.values.has(S)) {
        local += 1000;
        continue;
      }

      var utcMs = localToUtcMs(local, tz);
      var instant = new Date(utcMs);
      var actual = getTimeZoneParts(instant, tz);
      // Reject wall times that do not exist (DST spring-forward gap).
      if (actual.year === Y && actual.month === Mo && actual.day === D &&
          actual.hour === H && actual.minute === Mi && actual.second === S) {
        occurrences.push({ date: instant, parts: actual, formatted: formatInstant(instant, tz, { weekday: true, seconds: parsed.hasSeconds }) });
      }
      local += 1000;
    }

    return {
      ok: true,
      occurrences: occurrences,
      exhausted: occurrences.length < count,
      tz: tz
    };
  }

  // -------------------------------------------------------------------
  // Plain-language description
  // -------------------------------------------------------------------

  function detectStep(values) {
    if (values.length < 2) return null;
    var step = values[1] - values[0];
    if (step < 2) return null;
    for (var i = 2; i < values.length; i++) {
      if (values[i] - values[i - 1] !== step) return null;
    }
    return step;
  }

  function describeValues(values, labels, unit, plural) {
    values = values.slice().sort(function (a, b) { return a - b; });
    if (labels) return joinList(values.map(function (v) { return labels[v]; }));
    var step = detectStep(values);
    if (step && values.length >= 3) {
      return "every " + step + " " + plural + " from " + values[0] + " through " + values[values.length - 1];
    }
    return joinList(values.map(String));
  }

  function describeMonths(field) {
    if (!field.restricted) return "";
    var values = sortNumbers(field.values);
    var step = detectStep(values);
    if (step && values.length >= 3) {
      return "every " + step + " months starting " + MONTH_LABELS[values[0]];
    }
    return "in " + joinList(values.map(function (v) { return MONTH_LABELS[v]; }));
  }

  function describeDays(parsed) {
    var dom = parsed.fields.dom;
    var dow = parsed.fields.dow;
    var mode = parsed.domDowMode;

    if (!dom.restricted && !dow.restricted) return "every day";

    var domText = dom.restricted ? "day " + describeValues(sortNumbers(dom.values), null, "day", "days") : null;
    var dowValues = sortNumbers(dow.values);
    var dowText = dow.restricted ? joinList(dowValues.map(function (v) { return DOW_LABELS[v]; })) : null;

    if (dom.restricted && !dow.restricted) return "on " + domText;
    if (!dom.restricted && dow.restricted) return "on " + dowText;
    if (mode === "and") return "on " + domText + " that also falls on " + dowText;
    if (mode === "dom") return "on " + domText;
    if (mode === "dow") return "on " + dowText;
    return "on " + domText + " or on " + dowText;
  }

  function describeTime(parsed) {
    var f = parsed.fields;
    var minute = f.minute;
    var hour = f.hour;
    var second = f.second;

    var mValues = sortNumbers(minute.values);
    var hValues = sortNumbers(hour.values);
    var minAll = !minute.restricted;
    var hrAll = !hour.restricted;
    var hoursText = joinList(hValues.map(function (h) { return pad2(h) + ":00"; }));

    var timePart;
    if (minAll && hrAll) {
      timePart = "every minute";
    } else if (minAll) {
      timePart = "every minute during " + hoursText;
    } else if (minute.step && hrAll) {
      timePart = "every " + minute.step + " minutes";
    } else if (minute.step) {
      timePart = "every " + minute.step + " minutes during " + hoursText;
    } else if (mValues.length === 1 && hrAll) {
      timePart = "every hour at :" + pad2(mValues[0]);
    } else if (mValues.length === 1) {
      timePart = "at " + joinList(hValues.map(function (h) { return pad2(h) + ":" + pad2(mValues[0]); }));
    } else if (hrAll) {
      timePart = "at minute " + joinList(mValues.map(String)) + " of every hour";
    } else {
      var combos = [];
      for (var hi = 0; hi < hValues.length; hi++) {
        for (var mi = 0; mi < mValues.length; mi++) {
          combos.push(pad2(hValues[hi]) + ":" + pad2(mValues[mi]));
        }
      }
      timePart = combos.length <= 12
        ? "at " + joinList(combos)
        : "at minute " + joinList(mValues.map(String)) + " during " + hoursText;
    }

    if (parsed.hasSeconds && second.restricted) {
      var sValues = sortNumbers(second.values);
      timePart = "at second " + joinList(sValues.map(String)) + ", " + timePart;
    }
    return timePart;
  }

  /**
   * A plain-language description of a parsed expression.
   */
  function describeCron(parsed) {
    if (!parsed || !parsed.ok) return "";
    var parts = [];
    parts.push(describeTime(parsed));
    parts.push(describeDays(parsed));
    var months = describeMonths(parsed.fields.month);
    if (months) parts.push(months);
    if (parsed.fields.year.restricted) {
      parts.push("in " + describeValues(sortNumbers(parsed.fields.year.values), null, "year", "year"));
    }
    var text = parts.join(", ");
    return text.charAt(0).toUpperCase() + text.slice(1) + ".";
  }

  // -------------------------------------------------------------------
  // Expression builder
  // -------------------------------------------------------------------

  /**
   * Build a cron string from per-field choices.
   * @param {{layout?:string, fields?:object, domDowMode?:string}} spec
   */
  function buildCron(spec) {
    spec = spec || {};
    var layoutId = spec.layout || "standard";
    if (!isLayout(layoutId)) return { ok: false, error: "Unknown layout: " + layoutId };
    var names = LAYOUTS[layoutId].fields;
    var given = spec.fields || {};
    var tokens = [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var value = given[name];
      if (value === undefined || value === null || String(value).trim() === "") {
        value = name === "second" ? "0" : "*";
      }
      var check = expandField(String(value), FIELD_DEFS[name]);
      if (!check.ok) {
        return { ok: false, error: "Invalid " + name + " field: " + check.error + "." };
      }
      tokens.push(String(value).trim());
    }
    return { ok: true, expression: tokens.join(" ") };
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  return {
    MONTH_NAMES: MONTH_NAMES,
    DOW_NAMES: DOW_NAMES,
    MONTH_LABELS: MONTH_LABELS,
    DOW_LABELS: DOW_LABELS,
    FIELD_DEFS: FIELD_DEFS,
    MACROS: MACROS,
    DOM_DOW_MODES: DOM_DOW_MODES,
    listLayouts: listLayouts,
    listDomDowModes: listDomDowModes,
    isLayout: isLayout,
    expandField: expandField,
    expandMacro: expandMacro,
    parseCron: parseCron,
    matchesParts: matchesParts,
    dayMatches: dayMatches,
    summarizeRanges: summarizeRanges,
    nextOccurrences: nextOccurrences,
    describeCron: describeCron,
    buildCron: buildCron,
    listTimeZones: listTimeZones,
    isValidTimeZone: isValidTimeZone,
    getTimeZoneParts: getTimeZoneParts,
    formatInstant: formatInstant,
    localToUtcMs: localToUtcMs
  };
});
