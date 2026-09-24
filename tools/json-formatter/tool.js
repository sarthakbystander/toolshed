/* Toolshed — JSON Formatter
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.jsonFormatter and in Node via require() for tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.jsonFormatter = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Parse JSON and return either a value or a useful, position-aware error.
   * @param {string} text
   * @returns {{ ok: true, value: * }|{ ok: false, message: string, line: number, column: number }}
   */
  function parseJSON(text) {
    if (typeof text !== "string") {
      return { ok: false, message: "Input is not a string.", line: 1, column: 1 };
    }
    if (text.trim() === "") {
      return { ok: false, message: "Input is empty. Paste some JSON to get started.", line: 1, column: 1 };
    }
    try {
      const value = JSON.parse(text);
      return { ok: true, value: value };
    } catch (err) {
      // Provide a reasonable position from the error message where possible.
      const match = /position (\d+)/.exec(String(err.message));
      const pos = match ? Number(match[1]) : 0;
      let line = 1;
      let column = 1;
      for (let i = 0; i < Math.min(pos, text.length); i++) {
        if (text[i] === "\n") {
          line++;
          column = 1;
        } else {
          column++;
        }
      }
      const message = String(err.message).replace(/\bposition \d+\b/, "").replace(/^JSON\.parse:\s*/i, "").trim();
      return { ok: false, message: message || "Invalid JSON.", line: line, column: column };
    }
  }

  /**
   * Pretty-print JSON with 2-space indentation.
   * @param {*} value
   * @returns {string}
   */
  function format(value) {
    return JSON.stringify(value, null, 2);
  }

  /**
   * Minify JSON to its most compact form.
   * @param {*} value
   * @returns {string}
   */
  function minify(value) {
    return JSON.stringify(value);
  }

  /**
   * Format a JSON string. Returns { ok, text } or { ok: false, error }.
   * @param {string} text
   * @returns {{ ok: boolean, text?: string, error?: object }}
   */
  function formatText(text) {
    const parsed = parseJSON(text);
    if (!parsed.ok) {
      return { ok: false, error: parsed };
    }
    return { ok: true, text: format(parsed.value) };
  }

  /**
   * Minify a JSON string. Returns { ok, text } or { ok: false, error }.
   * @param {string} text
   * @returns {{ ok: boolean, text?: string, error?: object }}
   */
  function minifyText(text) {
    const parsed = parseJSON(text);
    if (!parsed.ok) {
      return { ok: false, error: parsed };
    }
    return { ok: true, text: minify(parsed.value) };
  }

  return {
    parseJSON: parseJSON,
    format: format,
    minify: minify,
    formatText: formatText,
    minifyText: minifyText
  };
});