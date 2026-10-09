/* Toolshed — Text Case Lab
 * Core logic, dependency-free (standard JavaScript only). Loads in the browser
 * as window.Toolshed.textCaseLab and in Node via require() for tests.
 *
 * The module detects the casing style of a snippet, converts it between the
 * common programming and prose conventions, and offers a set of text cleanup
 * transforms. Everything happens in memory: no network, no eval, no storage.
 *
 * Conversions use one of two strategies:
 *   "literal"  — operate on the original string, preserving punctuation
 *                (lower, UPPER, Title, Sentence)
 *   "wordlist" — split into words, then join with a separator and a
 *                capitalisation rule (camel, snake, kebab, ...)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.textCaseLab = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // -------------------------------------------------------------------
  // Case definitions
  // -------------------------------------------------------------------

  var CASES = [
    { id: "lower", label: "lowercase", kind: "literal", apply: function (s) { return s.toLowerCase(); } },
    { id: "upper", label: "UPPERCASE", kind: "literal", apply: function (s) { return s.toUpperCase(); } },
    { id: "title", label: "Title Case", kind: "literal", apply: titleCase },
    { id: "sentence", label: "Sentence case", kind: "literal", apply: sentenceCase },
    { id: "camel", label: "camelCase", kind: "wordlist", separator: "", style: "camel" },
    { id: "pascal", label: "PascalCase", kind: "wordlist", separator: "", style: "pascal" },
    { id: "snake", label: "snake_case", kind: "wordlist", separator: "_", style: "lower" },
    { id: "constant", label: "CONSTANT_CASE", kind: "wordlist", separator: "_", style: "upper" },
    { id: "kebab", label: "kebab-case", kind: "wordlist", separator: "-", style: "lower" },
    { id: "train", label: "Train-Case", kind: "wordlist", separator: "-", style: "pascal" },
    { id: "dot", label: "dot.case", kind: "wordlist", separator: ".", style: "lower" },
    { id: "path", label: "path/case", kind: "wordlist", separator: "/", style: "lower" },
    { id: "ada", label: "Ada_Case", kind: "wordlist", separator: "_", style: "pascal" }
  ];

  var CASE_BY_ID = {};
  CASES.forEach(function (c) { CASE_BY_ID[c.id] = c; });

  // -------------------------------------------------------------------
  // Text transforms (whole-text cleanup, not casing)
  // -------------------------------------------------------------------

  var TRANSFORMS = [
    { id: "trim-lines", label: "Trim each line", apply: trimLines },
    { id: "collapse-spaces", label: "Collapse spaces and tabs", apply: collapseSpaces },
    { id: "single-line", label: "Join into a single line", apply: singleLine },
    { id: "remove-blank-lines", label: "Remove blank lines", apply: removeBlankLines },
    { id: "strip-diacritics", label: "Strip accents and diacritics", apply: stripDiacritics },
    { id: "ascii-punctuation", label: "Normalise curly punctuation to ASCII", apply: asciiPunctuation },
    { id: "dedupe-lines", label: "Remove duplicate lines", apply: dedupeLines },
    { id: "sort-lines", label: "Sort lines (A–Z)", apply: sortLines },
    { id: "reverse-lines", label: "Reverse line order", apply: reverseLines }
  ];

  var TRANSFORM_BY_ID = {};
  TRANSFORMS.forEach(function (t) { TRANSFORM_BY_ID[t.id] = t; });

  // -------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------

  function asString(input) {
    return typeof input === "string" ? input : "";
  }

  function capitalize(word) {
    if (!word) return "";
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }

  // -------------------------------------------------------------------
  // Word splitting
  // -------------------------------------------------------------------
  //
  // Identifiers are split on separators and on camel/Pascal case boundaries,
  // then on any remaining non letter/digit character. Apostrophes between
  // letters are dropped so "don't" reads as one word.

  function splitWords(input) {
    var s = asString(input);
    if (s.normalize) s = s.normalize("NFKC");
    s = s.replace(/(\p{L})['\u2019](\p{L})/gu, "$1$2");
    s = s
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")   // aB / 1A
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")   // HTTPServer
      .replace(/(\p{L})(\p{N})/gu, "$1 $2")            // user2
      .replace(/(\p{N})(\p{L})/gu, "$1 $2");           // 2fa
    return s.split(/[^\p{L}\p{N}]+/u).filter(function (w) { return w.length > 0; });
  }

  function joinWords(input, mode) {
    var words = splitWords(input);
    if (!words.length) return "";
    if (mode.style === "camel") {
      return words.map(function (w, i) {
        return i === 0 ? w.toLowerCase() : capitalize(w);
      }).join(mode.separator);
    }
    return words.map(function (w) { return style(mode.style, w); }).join(mode.separator);
  }

  function style(rule, word) {
    if (rule === "upper") return word.toUpperCase();
    if (rule === "pascal") return capitalize(word);
    return word.toLowerCase();
  }

  // -------------------------------------------------------------------
  // Prose cases (preserve original punctuation and spacing)
  // -------------------------------------------------------------------

  var WORD_CHARS = /[\p{L}\p{N}][\p{L}\p{N}'\u2019]*/gu;

  function titleCase(input) {
    return asString(input).replace(WORD_CHARS, capitalize);
  }

  function sentenceCase(input) {
    var lower = asString(input).toLowerCase();
    var out = "";
    var capitalizeNext = true;
    for (var i = 0; i < lower.length; i++) {
      var ch = lower.charAt(i);
      if (capitalizeNext && /\p{L}/u.test(ch)) {
        out += ch.toUpperCase();
        capitalizeNext = false;
      } else {
        out += ch;
        if (ch === "." || ch === "!" || ch === "?" || ch === "\n") capitalizeNext = true;
      }
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Transforms
  // -------------------------------------------------------------------

  function trimLines(s) {
    return asString(s).split("\n").map(function (line) { return line.trim(); }).join("\n");
  }

  function collapseSpaces(s) {
    return asString(s).replace(/[ \t\f\v]+/g, " ");
  }

  function singleLine(s) {
    return asString(s).replace(/\s*\n+\s*/g, " ").trim();
  }

  function removeBlankLines(s) {
    return asString(s).split("\n").filter(function (line) { return line.trim() !== ""; }).join("\n");
  }

  function stripDiacritics(s) {
    var base = asString(s);
    if (base.normalize) base = base.normalize("NFD");
    return base.replace(/[\u0300-\u036f]/g, "");
  }

  function asciiPunctuation(s) {
    return asString(s)
      .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
      .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
      .replace(/[\u2013\u2014\u2015]/g, "-")
      .replace(/\u2026/g, "...")
      .replace(/\u00a0/g, " ");
  }

  function dedupeLines(s) {
    var seen = Object.create(null);
    return asString(s).split("\n").filter(function (line) {
      if (seen[line]) return false;
      seen[line] = true;
      return true;
    }).join("\n");
  }

  function sortLines(s) {
    return asString(s).split("\n").slice().sort(function (a, b) {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    }).join("\n");
  }

  function reverseLines(s) {
    return asString(s).split("\n").reverse().join("\n");
  }

  // -------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------
  //
  // Detection is a heuristic. It looks at the separators present in the string
  // and how each word is capitalised; anything ambiguous is reported as
  // "Mixed / unknown" rather than guessed at.

  function isUpperWord(w) { return w === w.toUpperCase() && /[\p{L}]/u.test(w); }
  function isLowerWord(w) { return w === w.toLowerCase() && /[\p{L}]/u.test(w); }
  function isTitleWord(w) { return /[\p{L}]/u.test(w) && w === capitalize(w); }

  function classifyWords(t) {
    var words = splitWords(t);
    return words.every(isUpperWord) ? "upper"
      : words.every(isLowerWord) ? "lower"
      : words.every(isTitleWord) ? "title"
      : "mixed";
  }

  function detectCase(input) {
    var t = asString(input).trim();
    if (t === "") return { id: "empty", label: "Empty" };

    var words = splitWords(t);
    if (!words.length) return { id: "unknown", label: "Mixed / unknown" };

    var shape = classifyWords(t);
    var hasSpace = /\s/.test(t);

    // Identifiers never contain whitespace; check separators only when the
    // string has none, so that a normal sentence with a full stop is not
    // mistaken for dot.case.
    if (!hasSpace) {
      if (t.indexOf("_") !== -1) {
        if (shape === "upper") return { id: "constant", label: "CONSTANT_CASE" };
        if (shape === "lower") return { id: "snake", label: "snake_case" };
        return { id: "unknown", label: "Mixed / unknown" };
      }
      if (t.indexOf("-") !== -1) {
        if (shape === "lower") return { id: "kebab", label: "kebab-case" };
        if (shape === "title") return { id: "train", label: "Train-Case" };
        return { id: "unknown", label: "Mixed / unknown" };
      }
      if (t.indexOf(".") !== -1) {
        if (shape === "lower") return { id: "dot", label: "dot.case" };
        return { id: "unknown", label: "Mixed / unknown" };
      }
      if (t.indexOf("/") !== -1) {
        if (shape === "lower") return { id: "path", label: "path/case" };
        return { id: "unknown", label: "Mixed / unknown" };
      }
    }

    if (hasSpace) {
      if (shape === "lower") return { id: "lower", label: "lowercase" };
      if (shape === "upper") return { id: "upper", label: "UPPERCASE" };
      if (shape === "title") return { id: "title", label: "Title Case" };
      if (words[0] === capitalize(words[0]) && words.slice(1).every(isLowerWord)) {
        return { id: "sentence", label: "Sentence case" };
      }
      return { id: "unknown", label: "Mixed / unknown" };
    }

    // A single token with no separators.
    if (shape === "lower") return { id: "lower", label: "lowercase" };
    if (shape === "upper") return { id: "upper", label: "UPPERCASE" };
    if (shape === "title") return { id: "pascal", label: "PascalCase" };
    if (/^\p{Ll}[\p{Ll}\p{N}]*(?:\p{Lu}[\p{Ll}\p{N}]*)+$/u.test(t)) return { id: "camel", label: "camelCase" };
    if (/^\p{Lu}[\p{Ll}\p{N}]*(?:\p{Lu}[\p{Ll}\p{N}]*)+$/u.test(t)) return { id: "pascal", label: "PascalCase" };
    return { id: "unknown", label: "Mixed / unknown" };
  }

  // -------------------------------------------------------------------
  // Conversion
  // -------------------------------------------------------------------

  function convertTo(input, caseId) {
    var spec = CASE_BY_ID[caseId];
    if (!spec) return "";
    var s = asString(input);
    if (spec.kind === "literal") return spec.apply(s);
    return joinWords(s, spec);
  }

  function convertAll(input) {
    return CASES.map(function (spec) {
      return { id: spec.id, label: spec.label, value: convertTo(input, spec.id) };
    });
  }

  function applyTransform(input, transformId) {
    var t = TRANSFORM_BY_ID[transformId];
    return t ? t.apply(asString(input)) : asString(input);
  }

  // -------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------

  function proseTokens(input) {
    var t = asString(input).trim();
    if (t === "") return [];
    return t.split(/\s+/).filter(function (w) { return /[\p{L}\p{N}]/u.test(w); });
  }

  function countWords(input) {
    return proseTokens(input).length;
  }

  function countSentences(input) {
    var t = asString(input).trim();
    if (t === "") return 0;
    var matches = t.match(/[^.!?]*[.!?]+/g);
    var count = matches ? matches.length : 0;
    var rest = t.replace(/[^.!?]*[.!?]+/g, "").trim();
    if (rest !== "") count += 1;
    return count;
  }

  function countLines(input) {
    var s = asString(input);
    return s === "" ? 0 : s.split("\n").length;
  }

  function uniqueWords(input) {
    var seen = Object.create(null);
    var count = 0;
    proseTokens(input).forEach(function (w) {
      var key = w.toLowerCase();
      if (!seen[key]) { seen[key] = true; count++; }
    });
    return count;
  }

  // -------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------

  function analyze(input) {
    var s = asString(input);
    return {
      detected: detectCase(s),
      stats: {
        characters: s.length,
        charactersNoSpaces: s.replace(/\s/g, "").length,
        words: countWords(s),
        uniqueWords: uniqueWords(s),
        sentences: countSentences(s),
        lines: countLines(s)
      },
      cases: convertAll(s),
      transforms: TRANSFORMS.map(function (t) {
        return { id: t.id, label: t.label, value: t.apply(s) };
      })
    };
  }

  function toJSON(input) {
    return JSON.stringify(analyze(input), null, 2);
  }

  function toMarkdown(input) {
    var a = analyze(input);
    var lines = [
      "# Text Case Lab",
      "",
      "Detected: **" + a.detected.label + "**",
      "",
      "## Statistics",
      "",
      "| Metric | Value |",
      "| --- | --- |",
      "| Characters | " + a.stats.characters + " |",
      "| Characters (no spaces) | " + a.stats.charactersNoSpaces + " |",
      "| Words | " + a.stats.words + " |",
      "| Unique words | " + a.stats.uniqueWords + " |",
      "| Sentences | " + a.stats.sentences + " |",
      "| Lines | " + a.stats.lines + " |",
      "",
      "## Conversions",
      "",
      "| Case | Result |",
      "| --- | --- |"
    ];
    a.cases.forEach(function (c) {
      lines.push("| " + c.label + " | " + escapeCell(c.value) + " |");
    });
    return lines.join("\n");
  }

  function escapeCell(value) {
    return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  return {
    CASES: CASES,
    TRANSFORMS: TRANSFORMS,
    listCases: function () { return CASES.map(function (c) { return { id: c.id, label: c.label }; }); },
    listTransforms: function () { return TRANSFORMS.map(function (t) { return { id: t.id, label: t.label }; }); },
    splitWords: splitWords,
    detectCase: detectCase,
    convertTo: convertTo,
    convertAll: convertAll,
    applyTransform: applyTransform,
    titleCase: titleCase,
    sentenceCase: sentenceCase,
    countWords: countWords,
    countSentences: countSentences,
    countLines: countLines,
    uniqueWords: uniqueWords,
    analyze: analyze,
    toJSON: toJSON,
    toMarkdown: toMarkdown
  };
});
