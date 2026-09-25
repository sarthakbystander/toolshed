/* Toolshed — Regex Tester
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.regexTester and in Node via require() for tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.regexTester = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var FLAG_PATTERN = /^[dgimsuvy]*$/;
  // Safety ceiling so pathologically match-heavy inputs cannot hang the UI.
  var MAX_MATCHES = 5000;

  /**
   * Validate and compile a JavaScript regular expression.
   * @param {string} source - pattern text (without delimiters).
   * @param {string} flags - flag letters, e.g. "gi".
   * @returns {{ ok: true, regex: RegExp }|{ ok: false, message: string }}
   */
  function compilePattern(source, flags) {
    if (typeof source !== "string" || source.trim() === "") {
      return { ok: false, message: "Type a pattern to match against your text." };
    }
    if (typeof flags !== "string") flags = "";
    if (!FLAG_PATTERN.test(flags)) {
      return {
        ok: false,
        message: "Invalid flags \"" + flags + "\". Allowed: d, g, i, m, s, u, v, y."
      };
    }
    try {
      return { ok: true, regex: new RegExp(source, flags) };
    } catch (err) {
      return {
        ok: false,
        message: "Invalid regular expression: " + (err && err.message ? err.message : String(err))
      };
    }
  }

  /** Run one pass of regex.exec, advancing safely. */
  function execAt(regex, str, pos) {
    regex.lastIndex = pos;
    return regex.exec(str);
  }

  /**
   * Split text into non-overlapping match and gap segments so a
   * highlighter can render them without innerHTML.

   * @param {RegExp} regex - a compiled pattern (any flags).
   * @param {string} text - the subject text.
   * @returns {{ segments: Array, truncated: boolean }}
   *   segment: { type: "match"|"gap", start: number, end: number,
   *                match?: string, captures?: Array, groups?: Object|null }
   */
  function collectSegments(regex, text) {
    var str = String(text == null ? "" : text);
    var out = [];
    if (str === "") {
      return { segments: out, truncated: false };
    }

    // Sticky and global regexes natively walk via lastIndex. For a plain
    // (non-global, non-sticky) pattern we scan with a global copy so that
    // every non-overlapping match is found — anchoring (^/$) still applies to
    // the whole string, just as it would for the original pattern.

    var scan = regex;
    if (!regex.global && !regex.sticky) {
      try {
        scan = new RegExp(regex.source, regex.flags + "g");
      } catch (e) {
        scan = regex;
      }
    }

    var pos = 0;
    var truncated = false;
    var attempts = 0;

    while (pos <= str.length) {
      var m = execAt(scan, str, pos);
      if (!m) break;
      attempts++;
      var start = m.index;
      var end = start + m[0].length;

      if (start > pos) {
        out.push({ type: "gap", start: pos, end: start });
      }
      out.push({
        type: "match",
        start: start,
        end: end,
        match: m[0],
        captures: Array.prototype.slice.call(m, 1),
        groups: m.groups || null
      });

      if (out.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      // JS regexes already advance lastIndex past zero-width matches;
      // guard anyway so pathological patterns cannot loop forever.


      pos = end > pos ? end : pos + 1;
    }

    if (pos <= str.length && !truncated) {
      var lastEnd = out.length > 0 ? out[out.length - 1].end : 0;
      if (lastEnd < str.length) {
        out.push({ type: "gap", start: lastEnd, end: str.length });
      }
    }

    return { segments: out, truncated: truncated };
  }

  /**
   * Aggregate stats for the summary line.
   * @returns {{ count: number, chars: number, truncated: boolean }}
   */
  function countMatches(regex, text) {
    var res = collectSegments(regex, text);
    var count = 0;
    var chars = 0;
    res.segments.forEach(function (seg) {
      if (seg.type === "match") {
        count++;
        chars += seg.end - seg.start;
      }
    });
    return { count: count, chars: chars, truncated: res.truncated };
  }

  return {
    compilePattern: compilePattern,
    collectSegments: collectSegments,
    countMatches: countMatches,
    MAX_MATCHES: MAX_MATCHES
  };
});