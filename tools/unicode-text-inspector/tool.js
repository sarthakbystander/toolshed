/* Toolshed — Unicode & Text Inspector
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.unicodeTextInspector and in Node via require() for tests.
 *
 * This module answers the question "what is actually in this string?" at the
 * level a developer, security reviewer or localization engineer needs:
 *
 *   - walk the text as characters, code points, UTF-8 bytes and Unicode
 *     grapheme clusters (what a reader perceives as one character);
 *   - name every code point, give its category and block, and flag the
 *     invisible ones;
 *   - find the homoglyph and bidi attacks — zero-width characters, directional
 *     controls, Cyrillic/Greek look-alikes, mixed scripts — that hide in text
 *     pasted from the web;
 *   - normalize (NFC/NFD/NFKC/NFKD) and compare a string with its normalized
 *     form to expose "text that looks the same but is not";
 *   - convert between the many escape formats people paste between
 *     (\uXXXX, \u{...}, HTML entities, URL percent-encoding, CSS escapes,
 *     JSON) and render them back.
 *
 * Everything runs in memory. The module never touches the network, never uses
 * eval or dynamic code execution, and never writes to storage. It is written
 * to stay responsive on large inputs by capping the number of characters it
 * names in detail and using linear-time, backtracking-safe patterns.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.unicodeTextInspector = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Limits & shared helpers
  // ---------------------------------------------------------------------

  // Characters given a full per-character row. Beyond this the tool still
  // reports counts, scans for issues and exports, but does not build the
  // detailed table, so a multi-megabyte paste cannot freeze the tab.
  var MAX_DETAIL_CHARS = 20000;

  var HAS_SEGMENTER = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";
  var HAS_ENCODER = typeof TextEncoder === "function";
  var HAS_DECODER = typeof TextDecoder === "function";

  function clampInt(n, min, max, fallback) {
    n = typeof n === "number" ? n : parseInt(n, 10);
    if (!isFinite(n)) return fallback;
    n = Math.floor(n);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function padStart(str, len, ch) {
    str = String(str);
    ch = ch || " ";
    while (str.length < len) str = ch + str;
    return str;
  }

  function isWhitespace(cp) {
    // Space separators plus the common controls people mean by "whitespace".
    return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x0b ||
      cp === 0x0c || cp === 0xa0 || cp === 0x85 || cp === 0x2028 || cp === 0x2029;
  }

  // ---------------------------------------------------------------------
  // Code point category names
  // ---------------------------------------------------------------------

  var CATEGORY_NAMES = {
    Lu: "Uppercase Letter", Ll: "Lowercase Letter", Lt: "Titlecase Letter",
    Lm: "Modifier Letter", Lo: "Other Letter",
    Mn: "Nonspacing Mark", Mc: "Spacing Mark", Me: "Enclosing Mark",
    Nd: "Decimal Number", Nl: "Letter Number", No: "Other Number",
    Pc: "Connector Punctuation", Pd: "Dash Punctuation", Ps: "Open Punctuation",
    Pe: "Close Punctuation", Pi: "Initial Punctuation", Pf: "Final Punctuation",
    Po: "Other Punctuation",
    Sm: "Math Symbol", Sc: "Currency Symbol", Sk: "Modifier Symbol", So: "Other Symbol",
    Zs: "Space Separator", Zl: "Line Separator", Zp: "Paragraph Separator",
    Cc: "Control", Cf: "Format", Cs: "Surrogate", Co: "Private Use", Cn: "Unassigned"
  };

  // ---------------------------------------------------------------------
  // Unicode blocks
  // ---------------------------------------------------------------------
  //
  // Sorted by start; lookup walks the list and returns the containing range.
  // This is a compact hand-maintained table of the ranges a reviewer meets in
  // practice, not a full UCD dump.

  var BLOCKS = [
    [0x0000, 0x007f, "Basic Latin"],
    [0x0080, 0x00ff, "Latin-1 Supplement"],
    [0x0100, 0x017f, "Latin Extended-A"],
    [0x0180, 0x024f, "Latin Extended-B"],
    [0x0250, 0x02af, "IPA Extensions"],
    [0x02b0, 0x02ff, "Spacing Modifier Letters"],
    [0x0300, 0x036f, "Combining Diacritical Marks"],
    [0x0370, 0x03ff, "Greek and Coptic"],
    [0x0400, 0x04ff, "Cyrillic"],
    [0x0500, 0x052f, "Cyrillic Supplement"],
    [0x0530, 0x058f, "Armenian"],
    [0x0590, 0x05ff, "Hebrew"],
    [0x0600, 0x06ff, "Arabic"],
    [0x0700, 0x074f, "Syriac"],
    [0x0750, 0x077f, "Arabic Supplement"],
    [0x0780, 0x07bf, "Thaana"],
    [0x0900, 0x097f, "Devanagari"],
    [0x0980, 0x09ff, "Bengali"],
    [0x0a00, 0x0a7f, "Gurmukhi"],
    [0x0a80, 0x0aff, "Gujarati"],
    [0x0b00, 0x0b7f, "Oriya"],
    [0x0b80, 0x0bff, "Tamil"],
    [0x0c00, 0x0c7f, "Telugu"],
    [0x0c80, 0x0cff, "Kannada"],
    [0x0d00, 0x0d7f, "Malayalam"],
    [0x0d80, 0x0dff, "Sinhala"],
    [0x0e00, 0x0e7f, "Thai"],
    [0x0e80, 0x0eff, "Lao"],
    [0x0f00, 0x0fff, "Tibetan"],
    [0x1000, 0x109f, "Myanmar"],
    [0x10a0, 0x10ff, "Georgian"],
    [0x1100, 0x11ff, "Hangul Jamo"],
    [0x1200, 0x137f, "Ethiopic"],
    [0x13a0, 0x13ff, "Cherokee"],
    [0x1400, 0x167f, "Unified Canadian Aboriginal Syllabics"],
    [0x1680, 0x169f, "Ogham"],
    [0x16a0, 0x16ff, "Runic"],
    [0x1780, 0x17ff, "Khmer"],
    [0x1800, 0x18af, "Mongolian"],
    [0x1e00, 0x1eff, "Latin Extended Additional"],
    [0x1f00, 0x1fff, "Greek Extended"],
    [0x2000, 0x206f, "General Punctuation"],
    [0x2070, 0x209f, "Superscripts and Subscripts"],
    [0x20a0, 0x20cf, "Currency Symbols"],
    [0x20d0, 0x20ff, "Combining Diacritical Marks for Symbols"],
    [0x2100, 0x214f, "Letterlike Symbols"],
    [0x2150, 0x218f, "Number Forms"],
    [0x2190, 0x21ff, "Arrows"],
    [0x2200, 0x22ff, "Mathematical Operators"],
    [0x2300, 0x23ff, "Miscellaneous Technical"],
    [0x2400, 0x243f, "Control Pictures"],
    [0x2440, 0x245f, "Optical Character Recognition"],
    [0x2460, 0x24ff, "Enclosed Alphanumerics"],
    [0x2500, 0x257f, "Box Drawing"],
    [0x2580, 0x259f, "Block Elements"],
    [0x25a0, 0x25ff, "Geometric Shapes"],
    [0x2600, 0x26ff, "Miscellaneous Symbols"],
    [0x2700, 0x27bf, "Dingbats"],
    [0x27c0, 0x27ef, "Miscellaneous Mathematical Symbols-A"],
    [0x27f0, 0x27ff, "Supplemental Arrows-A"],
    [0x2800, 0x28ff, "Braille Patterns"],
    [0x2900, 0x297f, "Supplemental Arrows-B"],
    [0x2980, 0x29ff, "Miscellaneous Mathematical Symbols-B"],
    [0x2a00, 0x2aff, "Supplemental Mathematical Operators"],
    [0x2b00, 0x2bff, "Miscellaneous Symbols and Arrows"],
    [0x2e80, 0x2eff, "CJK Radicals Supplement"],
    [0x2f00, 0x2fdf, "Kangxi Radicals"],
    [0x3000, 0x303f, "CJK Symbols and Punctuation"],
    [0x3040, 0x309f, "Hiragana"],
    [0x30a0, 0x30ff, "Katakana"],
    [0x3100, 0x312f, "Bopomofo"],
    [0x3130, 0x318f, "Hangul Compatibility Jamo"],
    [0x3190, 0x319f, "Kanbun"],
    [0x31c0, 0x31ef, "CJK Strokes"],
    [0x3200, 0x32ff, "Enclosed CJK Letters and Months"],
    [0x3300, 0x33ff, "CJK Compatibility"],
    [0x3400, 0x4dbf, "CJK Unified Ideographs Extension A"],
    [0x4dc0, 0x4dff, "Yijing Hexagram Symbols"],
    [0x4e00, 0x9fff, "CJK Unified Ideographs"],
    [0xa000, 0xa48f, "Yi Syllables"],
    [0xa490, 0xa4cf, "Yi Radicals"],
    [0xa640, 0xa69f, "Cyrillic Extended-B"],
    [0xa700, 0xa71f, "Modifier Tone Letters"],
    [0xa720, 0xa7ff, "Latin Extended-D"],
    [0xa800, 0xa82f, "Syloti Nagri"],
    [0xab00, 0xab2f, "Ethiopic Extended-A"],
    [0xac00, 0xd7af, "Hangul Syllables"],
    [0xd7b0, 0xd7ff, "Hangul Jamo Extended-B"],
    [0xe000, 0xf8ff, "Private Use Area"],
    [0xf900, 0xfaff, "CJK Compatibility Ideographs"],
    [0xfb00, 0xfb4f, "Alphabetic Presentation Forms"],
    [0xfb50, 0xfdff, "Arabic Presentation Forms-A"],
    [0xfe00, 0xfe0f, "Variation Selectors"],
    [0xfe10, 0xfe1f, "Vertical Forms"],
    [0xfe20, 0xfe2f, "Combining Half Marks"],
    [0xfe30, 0xfe4f, "CJK Compatibility Forms"],
    [0xfe50, 0xfe6f, "Small Form Variants"],
    [0xfe70, 0xfeff, "Arabic Presentation Forms-B"],
    [0xff00, 0xffef, "Halfwidth and Fullwidth Forms"],
    [0xfff0, 0xffff, "Specials"],
    [0x10000, 0x1007f, "Linear B Syllabary"],
    [0x10140, 0x1018f, "Ancient Greek Numbers"],
    [0x101d0, 0x101ff, "Phaistos Disc"],
    [0x10280, 0x102df, "Lycian"],
    [0x10300, 0x1032f, "Old Italic"],
    [0x10330, 0x1034f, "Gothic"],
    [0x10380, 0x1039f, "Ugaritic"],
    [0x103a0, 0x103df, "Old Persian"],
    [0x10400, 0x1044f, "Deseret"],
    [0x10450, 0x1047f, "Shavian"],
    [0x10480, 0x104af, "Osmanya"],
    [0x10500, 0x1052f, "Elbasan"],
    [0x10800, 0x1083f, "Cypriot Syllabary"],
    [0x10900, 0x1091f, "Phoenician"],
    [0x10a00, 0x10a5f, "Kharoshthi"],
    [0x12000, 0x123ff, "Cuneiform"],
    [0x13000, 0x1342f, "Egyptian Hieroglyphs"],
    [0x1d000, 0x1d0ff, "Byzantine Musical Symbols"],
    [0x1d100, 0x1d1ff, "Musical Symbols"],
    [0x1d200, 0x1d24f, "Ancient Greek Musical Notation"],
    [0x1d300, 0x1d35f, "Tai Xuan Jing Symbols"],
    [0x1d360, 0x1d37f, "Counting Rod Numerals"],
    [0x1d400, 0x1d7ff, "Mathematical Alphanumeric Symbols"],
    [0x1f000, 0x1f02f, "Mahjong Tiles"],
    [0x1f030, 0x1f09f, "Domino Tiles"],
    [0x1f300, 0x1f5ff, "Miscellaneous Symbols and Pictographs"],
    [0x1f600, 0x1f64f, "Emoticons"],
    [0x1f680, 0x1f6ff, "Transport and Map Symbols"],
    [0x1f700, 0x1f77f, "Alchemical Symbols"],
    [0x1f900, 0x1f9ff, "Supplemental Symbols and Pictographs"],
    [0x20000, 0x2a6df, "CJK Unified Ideographs Extension B"],
    [0xe0000, 0xe007f, "Tags"],
    [0xf0000, 0xffffd, "Supplementary Private Use Area-A"],
    [0x100000, 0x10fffd, "Supplementary Private Use Area-B"]
  ];

  function blockOf(cp) {
    for (var i = 0; i < BLOCKS.length; i++) {
      if (cp >= BLOCKS[i][0] && cp <= BLOCKS[i][1]) return BLOCKS[i][2];
    }
    return "No Block";
  }

  // ---------------------------------------------------------------------
  // Individual named characters & the "notable" registry
  // ---------------------------------------------------------------------

  // Named code points shown verbatim in the table. Anything absent is shown by
  // its hex code point.
  var NAMED = {
    0x0000: "NULL", 0x0009: "CHARACTER TABULATION (Tab)", 0x000a: "LINE FEED (LF)",
    0x000b: "LINE TABULATION", 0x000c: "FORM FEED (FF)", 0x000d: "CARRIAGE RETURN (CR)",
    0x001b: "ESCAPE", 0x007f: "DELETE", 0x0085: "NEXT LINE (NEL)",
    0x00a0: "NO-BREAK SPACE", 0x00ad: "SOFT HYPHEN", 0x00b7: "MIDDLE DOT",
    0x034f: "COMBINING GRAPHEME JOINER", 0x061c: "ARABIC LETTER MARK",
    0x1680: "OGHAM SPACE MARK", 0x180e: "MONGOLIAN VOWEL SEPARATOR",
    0x2000: "EN QUAD", 0x2001: "EM QUAD", 0x2002: "EN SPACE", 0x2003: "EM SPACE",
    0x2004: "THREE-PER-EM SPACE", 0x2005: "FOUR-PER-EM SPACE", 0x2006: "SIX-PER-EM SPACE",
    0x2007: "FIGURE SPACE", 0x2008: "PUNCTUATION SPACE", 0x2009: "THIN SPACE",
    0x200a: "HAIR SPACE", 0x200b: "ZERO WIDTH SPACE", 0x200c: "ZERO WIDTH NON-JOINER",
    0x200d: "ZERO WIDTH JOINER", 0x200e: "LEFT-TO-RIGHT MARK", 0x200f: "RIGHT-TO-LEFT MARK",
    0x2010: "HYPHEN", 0x2011: "NON-BREAKING HYPHEN", 0x2012: "FIGURE DASH",
    0x2013: "EN DASH", 0x2014: "EM DASH", 0x2015: "HORIZONTAL BAR",
    0x2018: "LEFT SINGLE QUOTATION MARK", 0x2019: "RIGHT SINGLE QUOTATION MARK",
    0x201a: "SINGLE LOW-9 QUOTATION MARK", 0x201b: "SINGLE HIGH-REVERSED-9 QUOTATION MARK",
    0x201c: "LEFT DOUBLE QUOTATION MARK", 0x201d: "RIGHT DOUBLE QUOTATION MARK",
    0x201e: "DOUBLE LOW-9 QUOTATION MARK", 0x201f: "DOUBLE HIGH-REVERSED-9 QUOTATION MARK",
    0x2024: "ONE DOT LEADER", 0x2026: "HORIZONTAL ELLIPSIS", 0x2027: "HYPHENATION POINT",
    0x2028: "LINE SEPARATOR", 0x2029: "PARAGRAPH SEPARATOR", 0x202a: "LEFT-TO-RIGHT EMBEDDING",
    0x202b: "RIGHT-TO-LEFT EMBEDDING", 0x202c: "POP DIRECTIONAL FORMATTING",
    0x202d: "LEFT-TO-RIGHT OVERRIDE", 0x202e: "RIGHT-TO-LEFT OVERRIDE",
    0x202f: "NARROW NO-BREAK SPACE", 0x2030: "PER MILLE SIGN", 0x2032: "PRIME",
    0x2033: "DOUBLE PRIME", 0x2039: "SINGLE LEFT-POINTING ANGLE QUOTATION MARK",
    0x203a: "SINGLE RIGHT-POINTING ANGLE QUOTATION MARK", 0x2044: "FRACTION SLASH",
    0x205f: "MEDIUM MATHEMATICAL SPACE", 0x2060: "WORD JOINER",
    0x2061: "FUNCTION APPLICATION", 0x2062: "INVISIBLE TIMES", 0x2063: "INVISIBLE SEPARATOR",
    0x2064: "INVISIBLE PLUS", 0x2066: "LEFT-TO-RIGHT ISOLATE", 0x2067: "RIGHT-TO-LEFT ISOLATE",
    0x2068: "FIRST STRONG ISOLATE", 0x2069: "POP DIRECTIONAL ISOLATE",
    0x206a: "INHIBIT SYMMETRIC SWAPPING", 0x206b: "ACTIVATE SYMMETRIC SWAPPING",
    0x206c: "INHIBIT ARABIC FORM SHAPING", 0x206d: "ACTIVATE ARABIC FORM SHAPING",
    0x206e: "NATIONAL DIGIT SHAPES", 0x206f: "NOMINAL DIGIT SHAPES",
    0x2212: "MINUS SIGN", 0x2215: "DIVISION SLASH", 0x2264: "LESS-THAN OR EQUAL TO",
    0x2265: "GREATER-THAN OR EQUAL TO", 0x2e3a: "TWO-EM DASH", 0x2e3b: "THREE-EM DASH",
    0x3000: "IDEOGRAPHIC SPACE",
    0xfe00: "VARIATION SELECTOR-1", 0xfe01: "VARIATION SELECTOR-2", 0xfe02: "VARIATION SELECTOR-3",
    0xfe03: "VARIATION SELECTOR-4", 0xfe04: "VARIATION SELECTOR-5", 0xfe05: "VARIATION SELECTOR-6",
    0xfe06: "VARIATION SELECTOR-7", 0xfe07: "VARIATION SELECTOR-8", 0xfe08: "VARIATION SELECTOR-9",
    0xfe09: "VARIATION SELECTOR-10", 0xfe0a: "VARIATION SELECTOR-11", 0xfe0b: "VARIATION SELECTOR-12",
    0xfe0c: "VARIATION SELECTOR-13", 0xfe0d: "VARIATION SELECTOR-14", 0xfe0e: "VARIATION SELECTOR-15",
    0xfe0f: "VARIATION SELECTOR-16", 0xfeff: "ZERO WIDTH NO-BREAK SPACE (BOM)",
    0xfff9: "INTERLINEAR ANNOTATION ANCHOR", 0xfffa: "INTERLINEAR ANNOTATION SEPARATOR",
    0xfffb: "INTERLINEAR ANNOTATION TERMINATOR", 0xfffc: "OBJECT REPLACEMENT CHARACTER",
    0xfffd: "REPLACEMENT CHARACTER",
    0x1f1e6: "REGIONAL INDICATOR SYMBOL LETTER A"
  };

  // Characters that are invisible or that silently change how text is read.
  // `level` is "high" for the ones used in spoofing and smuggling attacks,
  // "medium" for ones that usually just cause confusion.
  var NOTABLE = {
    0x00a0: { level: "medium", label: "No-break space", why: "Looks like a space but is not U+0020; breaks plain-text comparisons and CSV parsing." },
    0x00ad: { level: "medium", label: "Soft hyphen", why: "Invisible unless the line wraps; often inserted by copy/paste or word processors." },
    0x034f: { level: "medium", label: "Combining grapheme joiner", why: "An invisible combining mark that changes normalization." },
    0x061c: { level: "high", label: "Arabic letter mark", why: "A bidi control; can reorder how surrounding text is displayed." },
    0x115f: { level: "medium", label: "Hangul choseong filler", why: "Invisible filler used to pad Hangul; sometimes used to smuggle data." },
    0x1160: { level: "medium", label: "Hangul jungseong filler", why: "Invisible filler used to pad Hangul." },
    0x17b4: { level: "medium", label: "Khmer vowel inherent AQ", why: "Invisible Khmer vowel." },
    0x17b5: { level: "medium", label: "Khmer vowel inherent AA", why: "Invisible Khmer vowel." },
    0x180b: { level: "medium", label: "Mongolian free variation selector one", why: "Invisible variation selector." },
    0x180c: { level: "medium", label: "Mongolian free variation selector two", why: "Invisible variation selector." },
    0x180d: { level: "medium", label: "Mongolian free variation selector three", why: "Invisible variation selector." },
    0x180e: { level: "medium", label: "Mongolian vowel separator", why: "Invisible space-like separator." },
    0x200b: { level: "high", label: "Zero-width space", why: "Invisible; breaks word matching and can hide payloads in identifiers and URLs." },
    0x200c: { level: "high", label: "Zero-width non-joiner", why: "Invisible; changes rendering in some scripts and can defeat comparison." },
    0x200d: { level: "high", label: "Zero-width joiner", why: "Invisible; joins emoji sequences and can hide between identifier characters." },
    0x200e: { level: "high", label: "Left-to-right mark", why: "A bidi control; can reorder displayed text." },
    0x200f: { level: "high", label: "Right-to-left mark", why: "A bidi control; can reorder displayed text." },
    0x202a: { level: "high", label: "Left-to-right embedding", why: "A bidi control used in the 'Trojan Source' display-spoofing attack." },
    0x202b: { level: "high", label: "Right-to-left embedding", why: "A bidi control used in the 'Trojan Source' display-spoofing attack." },
    0x202c: { level: "high", label: "Pop directional formatting", why: "Closes a bidi embedding; used in display-spoofing attacks." },
    0x202d: { level: "high", label: "Left-to-right override", why: "Forces left-to-right display order regardless of content." },
    0x202e: { level: "high", label: "Right-to-left override", why: "Reverses display order of following text; a classic filename and source spoofing trick." },
    0x2060: { level: "high", label: "Word joiner", why: "Invisible; prevents line breaks and can hide between characters." },
    0x2061: { level: "medium", label: "Function application", why: "Invisible mathematical formatting character." },
    0x2062: { level: "medium", label: "Invisible times", why: "Invisible mathematical formatting character." },
    0x2063: { level: "medium", label: "Invisible separator", why: "Invisible mathematical formatting character." },
    0x2064: { level: "medium", label: "Invisible plus", why: "Invisible mathematical formatting character." },
    0x2066: { level: "high", label: "Left-to-right isolate", why: "A bidi isolate; can reorder displayed text." },
    0x2067: { level: "high", label: "Right-to-left isolate", why: "A bidi isolate; can reorder displayed text." },
    0x2068: { level: "high", label: "First strong isolate", why: "A bidi isolate; can reorder displayed text." },
    0x2069: { level: "high", label: "Pop directional isolate", why: "Closes a bidi isolate; used in display-spoofing attacks." },
    0x206a: { level: "medium", label: "Inhibit symmetric swapping", why: "Deprecated format control." },
    0x206b: { level: "medium", label: "Activate symmetric swapping", why: "Deprecated format control." },
    0x206c: { level: "medium", label: "Inhibit Arabic form shaping", why: "Deprecated format control." },
    0x206d: { level: "medium", label: "Activate Arabic form shaping", why: "Deprecated format control." },
    0x206e: { level: "medium", label: "National digit shapes", why: "Deprecated format control." },
    0x206f: { level: "medium", label: "Nominal digit shapes", why: "Deprecated format control." },
    0x3164: { level: "medium", label: "Hangul filler", why: "Invisible filler." },
    0xfeff: { level: "high", label: "Byte order mark / zero-width no-break space", why: "An invisible BOM at the start of text; elsewhere it is an invisible zero-width character." },
    0xffa0: { level: "medium", label: "Halfwidth Hangul filler", why: "Invisible filler." },
    0xfff9: { level: "medium", label: "Interlinear annotation anchor", why: "Invisible annotation control." },
    0xfffa: { level: "medium", label: "Interlinear annotation separator", why: "Invisible annotation control." },
    0xfffb: { level: "medium", label: "Interlinear annotation terminator", why: "Invisible annotation control." },
    0x1d173: { level: "medium", label: "Musical symbol begin beam", why: "Invisible format control." },
    0x1d174: { level: "medium", label: "Musical symbol end beam", why: "Invisible format control." },
    0x1d175: { level: "medium", label: "Musical symbol begin tie", why: "Invisible format control." },
    0x1d176: { level: "medium", label: "Musical symbol end tie", why: "Invisible format control." },
    0x1d177: { level: "medium", label: "Musical symbol begin slur", why: "Invisible format control." },
    0x1d178: { level: "medium", label: "Musical symbol end slur", why: "Invisible format control." },
    0x1d179: { level: "medium", label: "Musical symbol begin phrase", why: "Invisible format control." },
    0x1d17a: { level: "medium", label: "Musical symbol end phrase", why: "Invisible format control." },
    0xe0001: { level: "high", label: "Language tag", why: "Invisible tag character; the ASCII 'tag' block can smuggle hidden text into a string." },
    0xe0020: { level: "high", label: "Tag space", why: "Invisible; part of the hidden tag-character smuggling technique." },
    0xe007f: { level: "high", label: "Cancel tag", why: "Invisible; terminates a hidden tag-character sequence." }
  };

  // Fill in the rest of the tag block (U+E0020..U+E007E map to ASCII).
  (function () {
    for (var cp = 0xe0020; cp <= 0xe007e; cp++) {
      if (!NOTABLE[cp]) {
        NOTABLE[cp] = {
          level: "high",
          label: "Tag character " + String.fromCharCode(cp - 0xe0000),
          why: "Invisible tag character; can hide text inside a plain-looking string."
        };
      }
    }
  })();

  // Format characters that are invisible but otherwise benign in moderation.
  var FORMAT_CONTROLS = {
    0x00ad: true, 0x0600: true, 0x0601: true, 0x0602: true, 0x0603: true, 0x0604: true,
    0x0605: true, 0x061c: true, 0x06dd: true, 0x070f: true, 0x08e2: true, 0x180e: true,
    0x200b: true, 0x200c: true, 0x200d: true, 0x200e: true, 0x200f: true, 0x202a: true,
    0x202b: true, 0x202c: true, 0x202d: true, 0x202e: true, 0x2060: true, 0x2061: true,
    0x2062: true, 0x2063: true, 0x2064: true, 0x2066: true, 0x2067: true, 0x2068: true,
    0x2069: true, 0x206a: true, 0x206b: true, 0x206c: true, 0x206d: true, 0x206e: true,
    0x206f: true, 0xfeff: true, 0xfff9: true, 0xfffa: true, 0xfffb: true
  };

  // The bidi controls at the heart of "Trojan Source" and filename spoofing.
  var BIDI_CONTROLS = {
    0x061c: true, 0x200e: true, 0x200f: true,
    0x202a: true, 0x202b: true, 0x202c: true, 0x202d: true, 0x202e: true,
    0x2066: true, 0x2067: true, 0x2068: true, 0x2069: true
  };

  // Cyrillic and Greek code points whose glyphs mimic Latin letters.
  var HOMOGLYPH_MAP = {
    0x0410: "A", 0x0412: "B", 0x0415: "E", 0x0417: "3", 0x041a: "K", 0x041c: "M",
    0x041d: "H", 0x041e: "O", 0x0420: "P", 0x0421: "C", 0x0422: "T", 0x0423: "Y",
    0x0425: "X", 0x0430: "a", 0x0432: "b", 0x0435: "e", 0x043e: "o", 0x0440: "p",
    0x0441: "c", 0x0443: "y", 0x0445: "x", 0x0455: "s", 0x0456: "i", 0x0458: "j",
    0x0501: "d", 0x051a: "Q", 0x051c: "W",
    0x0391: "A", 0x0392: "B", 0x0395: "E", 0x0396: "Z", 0x0397: "H", 0x0399: "I",
    0x039a: "K", 0x039c: "M", 0x039d: "N", 0x039f: "O", 0x03a1: "P", 0x03a4: "T",
    0x03a5: "Y", 0x03a7: "X", 0x03bf: "o", 0x03c1: "p", 0x03bd: "v", 0x03c4: "t",
    0x03c5: "u", 0x03b9: "i", 0x03ba: "k", 0x03b1: "a", 0x03b5: "e", 0x03b7: "n",
    0x03b3: "y"
  };

  // Latin code points that look like plain ASCII but are not, such as the
  // fullwidth forms used in East Asian text and pasted into identifiers.
  var CONFUSABLE_LATIN = {
    0x0130: "I", 0x0131: "i", 0x017f: "f", 0x01c0: "l", 0x01c1: "ll", 0x0223: "3",
    0x0261: "g", 0x0269: "i", 0x026a: "I", 0x0274: "N", 0x0278: "o", 0x0280: "R",
    0x028f: "Y", 0x0299: "B", 0x029c: "H", 0x029f: "L", 0x02b3: "r",
    0xff21: "A", 0xff22: "B", 0xff23: "C", 0xff24: "D", 0xff25: "E", 0xff26: "F",
    0xff27: "G", 0xff28: "H", 0xff29: "I", 0xff2a: "J", 0xff2b: "K", 0xff2c: "L",
    0xff2d: "M", 0xff2e: "N", 0xff2f: "O", 0xff30: "P", 0xff31: "Q", 0xff32: "R",
    0xff33: "S", 0xff34: "T", 0xff35: "U", 0xff36: "V", 0xff37: "W", 0xff38: "X",
    0xff39: "Y", 0xff3a: "Z", 0xff41: "a", 0xff42: "b", 0xff43: "c", 0xff44: "d",
    0xff45: "e", 0xff46: "f", 0xff47: "g", 0xff48: "h", 0xff49: "i", 0xff4a: "j",
    0xff4b: "k", 0xff4c: "l", 0xff4d: "m", 0xff4e: "n", 0xff4f: "o", 0xff50: "p",
    0xff51: "q", 0xff52: "r", 0xff53: "s", 0xff54: "t", 0xff55: "u", 0xff56: "v",
    0xff57: "w", 0xff58: "x", 0xff59: "y", 0xff5a: "z"
  };

  // Scripts recognized for the mixed-script check: [name, start, end].
  var SCRIPT_RANGES = [
    ["Latin", 0x0041, 0x005a], ["Latin", 0x0061, 0x007a],
    ["Latin", 0x00c0, 0x024f], ["Latin", 0x1e00, 0x1eff],
    ["Greek", 0x0370, 0x03ff], ["Greek", 0x1f00, 0x1fff],
    ["Cyrillic", 0x0400, 0x04ff], ["Cyrillic", 0x0500, 0x052f], ["Cyrillic", 0xa640, 0xa69f],
    ["Arabic", 0x0600, 0x06ff], ["Arabic", 0x0750, 0x077f],
    ["Hebrew", 0x0590, 0x05ff],
    ["Han", 0x3400, 0x4dbf], ["Han", 0x4e00, 0x9fff], ["Han", 0xf900, 0xfaff],
    ["Hiragana", 0x3040, 0x309f],
    ["Katakana", 0x30a0, 0x30ff],
    ["Hangul", 0x1100, 0x11ff], ["Hangul", 0x3130, 0x318f], ["Hangul", 0xac00, 0xd7af],
    ["Devanagari", 0x0900, 0x097f],
    ["Bengali", 0x0980, 0x09ff],
    ["Thai", 0x0e00, 0x0e7f],
    ["Armenian", 0x0530, 0x058f],
    ["Georgian", 0x10a0, 0x10ff],
    ["Ethiopic", 0x1200, 0x137f]
  ];

  function scriptOf(cp) {
    for (var i = 0; i < SCRIPT_RANGES.length; i++) {
      if (cp >= SCRIPT_RANGES[i][1] && cp <= SCRIPT_RANGES[i][2]) return SCRIPT_RANGES[i][0];
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Unicode property helpers (linear-time, no catastrophic backtracking)
  // ---------------------------------------------------------------------

  var RE_UPPER = null, RE_LOWER = null, RE_MARK = null, RE_LETTER = null;
  var RE_DIGIT = null, RE_ALNUM = null;
  try {
    RE_UPPER = new RegExp("\\p{Lu}", "u");
    RE_LOWER = new RegExp("\\p{Ll}", "u");
    RE_MARK = new RegExp("\\p{M}", "u");
    RE_LETTER = new RegExp("\\p{L}", "u");
    RE_DIGIT = new RegExp("\\p{N}", "u");
    RE_ALNUM = new RegExp("[\\p{L}\\p{N}]", "u");
  } catch (e) {
    RE_UPPER = RE_LOWER = RE_MARK = RE_LETTER = RE_DIGIT = RE_ALNUM = null;
  }

  function isLetter(ch) {
    if (RE_LETTER) return RE_LETTER.test(ch);
    var cp = ch.codePointAt(0);
    return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp > 0x7f;
  }
  function isUpper(ch) {
    if (RE_UPPER) return RE_UPPER.test(ch);
    return ch >= "A" && ch <= "Z";
  }
  function isLower(ch) {
    if (RE_LOWER) return RE_LOWER.test(ch);
    return ch >= "a" && ch <= "z";
  }
  function isMark(ch) {
    if (RE_MARK) return RE_MARK.test(ch);
    return false;
  }
  function isDigit(ch) {
    if (RE_DIGIT) return RE_DIGIT.test(ch);
    return ch >= "0" && ch <= "9";
  }
  function isAlnum(ch) {
    if (RE_ALNUM) return RE_ALNUM.test(ch);
    var cp = ch.codePointAt(0);
    return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp > 0x7f;
  }

  // ---------------------------------------------------------------------
  // Character classification & analysis
  // ---------------------------------------------------------------------

  function categoryOf(cp) {
    var ch = String.fromCodePoint(cp);
    if (cp >= 0xd800 && cp <= 0xdfff) return "Cs";
    if (cp >= 0xe000 && cp <= 0xf8ff) return "Co";
    if (cp === 0x20) return "Zs";
    if (cp === 0xa0 || cp === 0x2000 || cp === 0x2028 || cp === 0x2029 || cp === 0x3000) return "Zs";
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x00 && cp <= 0x1f) || cp === 0x7f) return "Cc";
    if (RE_UPPER) {
      if (RE_UPPER.test(ch)) return "Lu";
      if (RE_LOWER.test(ch)) return "Ll";
      if (RE_MARK.test(ch)) return "Mn";
      if (RE_LETTER.test(ch)) return "Lo";
      if (RE_DIGIT.test(ch)) return "Nd";
    } else {
      if (cp >= 0x41 && cp <= 0x5a) return "Lu";
      if (cp >= 0x61 && cp <= 0x7a) return "Ll";
      if (cp >= 0x30 && cp <= 0x39) return "Nd";
    }
    if (FORMAT_CONTROLS[cp]) return "Cf";
    if (cp >= 0xfe00 && cp <= 0xfe0f) return "Mn";
    if (cp >= 0x1f300 && cp <= 0x1faff) return "So";
    if (cp >= 0x2600 && cp <= 0x27bf) return "So";
    if (cp >= 0x2190 && cp <= 0x21ff) return "Sm";
    if (cp >= 0x2200 && cp <= 0x22ff) return "Sm";
    if (cp >= 0x20a0 && cp <= 0x20cf) return "Sc";
    return "Po";
  }

  function codePointName(cp) {
    if (Object.prototype.hasOwnProperty.call(NAMED, cp)) return NAMED[cp];
    if (cp === 0x20) return "SPACE";
    if (cp >= 0x21 && cp <= 0x7e) return "ASCII '" + String.fromCharCode(cp) + "'";
    if (cp >= 0x4e00 && cp <= 0x9fff) return "CJK UNIFIED IDEOGRAPH-" + cp.toString(16).toUpperCase();
    if (cp >= 0xac00 && cp <= 0xd7a3) return "HANGUL SYLLABLE";
    if (cp >= 0x1f300 && cp <= 0x1faff) return "EMOJI / SYMBOL";
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return "REGIONAL INDICATOR SYMBOL";
    if (cp >= 0xe000 && cp <= 0xf8ff) return "PRIVATE USE CHARACTER";
    return "U+" + cp.toString(16).toUpperCase();
  }

  function utf8BytesOf(cp) {
    var bytes = [];
    if (cp <= 0x7f) {
      bytes.push(cp);
    } else if (cp <= 0x7ff) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return bytes;
  }

  function utf8HexOf(cp) {
    var bytes = utf8BytesOf(cp);
    var out = [];
    for (var i = 0; i < bytes.length; i++) {
      out.push((bytes[i] < 16 ? "0" : "") + bytes[i].toString(16).toUpperCase());
    }
    return out.join(" ");
  }

  function encodeUTF8(str) {
    if (HAS_ENCODER) return new TextEncoder().encode(str);
    var bytes = [];
    for (var i = 0; i < str.length; ) {
      var cp = str.codePointAt(i);
      var ch = String.fromCodePoint(cp);
      var b = utf8BytesOf(cp);
      for (var j = 0; j < b.length; j++) bytes.push(b[j]);
      i += ch.length;
    }
    return new Uint8Array(bytes);
  }

  function decodeUTF8(bytes) {
    if (HAS_DECODER) {
      try {
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch (e) { /* fall through */ }
    }
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function escapeCodePoint(cp) {
    if (cp <= 0xffff) {
      return "\\u" + padStart(cp.toString(16).toUpperCase(), 4, "0");
    }
    return "\\u{" + cp.toString(16).toUpperCase() + "}";
  }

  // A short, honest description of how a character renders.
  function describe(cp) {
    var notable = NOTABLE[cp];
    if (notable) {
      return notable.level === "high" ? "Invisible / spoofing risk" : "Invisible / easy to miss";
    }
    if (cp === 0x20) return "Space";
    var cat = categoryOf(cp);
    if (cat === "Cc") return "Control character";
    if (cat === "Cs") return "Surrogate half";
    if (cat === "Co") return "Private use";
    if (cp >= 0xfe00 && cp <= 0xfe0f) return "Variation selector";
    if (isWhitespace(cp)) return "Whitespace";
    if (cat === "Mn" || cat === "Mc" || cat === "Me") return "Combining mark";
    if (cat.charAt(0) === "L") return "Letter";
    if (cat.charAt(0) === "N") return "Number";
    return CATEGORY_NAMES[cat] || "Character";
  }

  // The key security view of one character.
  function analyzeChar(cp, index) {
    var ch = String.fromCodePoint(cp);
    var notable = NOTABLE[cp];
    var flags = [];
    var risk = "none";

    if (notable) {
      flags.push("invisible");
      risk = notable.level === "high" ? "high" : "low";
    }
    if (BIDI_CONTROLS[cp]) {
      flags.push("bidi");
      risk = "high";
    }
    if (cp === 0xfeff) flags.push("bom");
    if (HOMOGLYPH_MAP[cp]) {
      flags.push("confusable");
      if (risk === "none" || risk === "low") risk = "medium";
    }
    if (cp === 0xfffd) {
      flags.push("replacement");
      if (risk === "none") risk = "low";
    }
    if (cp >= 0xd800 && cp <= 0xdfff) {
      flags.push("surrogate");
      risk = "high";
    }
    if (cp >= 0xe000 && cp <= 0xf8ff) {
      flags.push("private-use");
      if (risk === "none") risk = "low";
    }
    if (cp >= 0xe0020 && cp <= 0xe007f) {
      flags.push("tag");
      risk = "high";
    }
    if (cp >= 0xfe00 && cp <= 0xfe0f) {
      flags.push("variation-selector");
      if (risk === "none") risk = "low";
    }
    if (cp === 0x00a0 || cp === 0x202f || cp === 0x2007 || cp === 0x2009 ||
        cp === 0x200a || cp === 0x2000 || cp === 0x2001 || cp === 0x2002 || cp === 0x2003) {
      flags.push("odd-space");
      if (risk === "none") risk = "low";
    }
    if (cp === 0x2018 || cp === 0x2019 || cp === 0x201c || cp === 0x201d) {
      flags.push("smart-quote");
    }

    return {
      index: index,
      cp: cp,
      char: ch,
      name: codePointName(cp),
      category: categoryOf(cp),
      categoryName: CATEGORY_NAMES[categoryOf(cp)] || "Character",
      block: blockOf(cp),
      script: scriptOf(cp),
      utf8: utf8HexOf(cp),
      htmlEntity: "&#x" + cp.toString(16).toUpperCase() + ";",
      css: "\\" + cp.toString(16).toUpperCase(),
      js: escapeCodePoint(cp),
      describe: describe(cp),
      flags: flags,
      risk: risk,
      confusable: HOMOGLYPH_MAP[cp] || CONFUSABLE_LATIN[cp] || null,
      notable: notable || null
    };
  }

  // ---------------------------------------------------------------------
  // Iteration, grapheme clusters and normalization
  // ---------------------------------------------------------------------

  function toCodePoints(text) {
    var out = [];
    for (var i = 0; i < text.length; ) {
      var cp = text.codePointAt(i);
      var ch = String.fromCodePoint(cp);
      out.push(cp);
      i += ch.length;
    }
    return out;
  }

  function splitGraphemes(text) {
    if (!text) return [];
    if (HAS_SEGMENTER) {
      try {
        var seg = new Intl.Segmenter("en", { granularity: "grapheme" });
        var out = [];
        var it = seg.segment(text)[Symbol.iterator]();
        var step = it.next();
        while (!step.done) {
          out.push(step.value.segment);
          step = it.next();
        }
        return out;
      } catch (e) { /* fall through */ }
    }
    return approxGraphemes(text);
  }

  function countGraphemes(text) {
    return splitGraphemes(text).length;
  }

  // Approximate segmentation: a base plus any following combining marks,
  // variation selectors and ZWJ-joined characters count as one cluster. This
  // is the fallback when Intl.Segmenter is unavailable and what tests exercise
  // when the segmenter is absent.
  function approxGraphemes(text) {
    if (!text) return [];
    var cps = toCodePoints(text);
    var out = [];
    var current = "";
    for (var i = 0; i < cps.length; i++) {
      var cp = cps[i];
      var isExtend = (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) ||
        (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) ||
        (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f) ||
        (cp >= 0xe0100 && cp <= 0xe01ef) || cp === 0x200d ||
        (cp >= 0x1f3fb && cp <= 0x1f3ff);
      if (cp === 0x0d && i + 1 < cps.length && cps[i + 1] === 0x0a) {
        current += "\r\n";
        i++;
        out.push(current);
        current = "";
        continue;
      }
      if (isExtend && current !== "") {
        current += String.fromCodePoint(cp);
        continue;
      }
      if (current !== "") out.push(current);
      current = String.fromCodePoint(cp);
    }
    if (current !== "") out.push(current);
    return out;
  }

  function normalize(text, form) {
    form = (form || "NFC").toUpperCase();
    if (["NFC", "NFD", "NFKC", "NFKD"].indexOf(form) === -1) form = "NFC";
    if (typeof String.prototype.normalize !== "function") return text;
    try {
      return text.normalize(form);
    } catch (e) {
      return text;
    }
  }

  // ---------------------------------------------------------------------
  // Issue detection
  // ---------------------------------------------------------------------

  function detectMixedScripts(cps) {
    // Walk runs of letters/marks and report a Latin run that also contains a
    // suspicious second script (Cyrillic or Greek), which is the classic
    // identifier-spoofing pattern.
    var i = 0;
    while (i < cps.length) {
      if (!isLetter(String.fromCodePoint(cps[i]))) { i++; continue; }
      var start = i;
      var scripts = {};
      var count = 0;
      while (i < cps.length && (isLetter(String.fromCodePoint(cps[i])) || isMark(String.fromCodePoint(cps[i])))) {
        var s = scriptOf(cps[i]);
        if (s) { scripts[s] = (scripts[s] || 0) + 1; count++; }
        i++;
      }
      var names = Object.keys(scripts);
      if (names.indexOf("Latin") !== -1 && count >= 2) {
        var suspicious = names.filter(function (n) {
          return n === "Cyrillic" || n === "Greek";
        });
        if (suspicious.length) {
          var sample = [];
          for (var k = start; k < i; k++) {
            var cpk = cps[k];
            if (scriptOf(cpk) === suspicious[0] || HOMOGLYPH_MAP[cpk]) {
              sample.push({ index: k, cp: cpk, char: String.fromCodePoint(cpk), script: scriptOf(cpk) || "Unknown", looksLike: HOMOGLYPH_MAP[cpk] || null });
            }
            if (sample.length >= 20) break;
          }
          return {
            id: "mixed-script",
            level: "high",
            title: "Mixed scripts in one word (possible homoglyph spoof)",
            count: sample.length,
            positions: sample.map(function (c) { return c.index; }),
            codePoints: sample.map(function (c) { return { cp: c.cp, name: codePointName(c.cp), char: c.char, looksLike: c.looksLike, script: c.script }; }),
            why: "This word mixes Latin with " + suspicious.join(" and ") + ". Attackers swap one or two Latin letters for visually identical letters from another script so a name, domain or identifier passes visual review but compares unequal."
          };
        }
      }
    }
    return null;
  }

  function detectIssues(text, cps) {
    var issues = [];
    var i;

    var groups = {
      "zero-width": { label: "Zero-width characters", level: "high", cps: [], positions: [], why: "Invisible characters such as ZWSP, ZWNJ and ZWJ hide inside words and identifiers and silently break search, comparison and validation." },
      "bidi": { label: "Bidirectional control characters", level: "high", cps: [], positions: [], why: "Bidi controls (RLO, LRO, isolates) can reorder displayed text. This is the basis of the 'Trojan Source' source-code spoof and of misleading filenames." },
      "bom": { label: "Byte order mark / zero-width no-break space", level: "high", cps: [], positions: [], why: "A U+FEFF at the start of text is a BOM; anywhere else it is an invisible zero-width character that can defeat exact matching." },
      "tag": { label: "Hidden tag characters", level: "high", cps: [], positions: [], why: "The Unicode tag block encodes invisible ASCII. It is used to smuggle hidden instructions or payloads into otherwise plain strings." },
      "variation-selector": { label: "Variation selectors", level: "low", cps: [], positions: [], why: "Variation selectors choose a glyph form. A long run of them is unusual and can hide data." },
      "other-invisible": { label: "Other invisible formatting characters", level: "medium", cps: [], positions: [], why: "Invisible formatting and filler characters that are easy to miss when reviewing text." }
    };

    for (i = 0; i < cps.length; i++) {
      var cp = cps[i];
      var kind = null;
      if (cp === 0x200b || cp === 0x200c || cp === 0x200d) kind = "zero-width";
      else if (BIDI_CONTROLS[cp]) kind = "bidi";
      else if (cp === 0xfeff) kind = "bom";
      else if (cp >= 0xe0020 && cp <= 0xe007f) kind = "tag";
      else if (cp >= 0xfe00 && cp <= 0xfe0f) kind = "variation-selector";
      else if (NOTABLE[cp] || FORMAT_CONTROLS[cp]) kind = "other-invisible";
      if (kind) {
        groups[kind].cps.push(cp);
        groups[kind].positions.push(i);
      }
    }

    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      if (!g.cps.length) return;
      var seen = {};
      var uniqueList = [];
      for (var k = 0; k < g.cps.length; k++) {
        if (!seen[g.cps[k]]) { seen[g.cps[k]] = true; uniqueList.push(g.cps[k]); }
      }
      issues.push({
        id: key,
        level: g.level,
        title: g.label,
        count: g.cps.length,
        positions: g.positions.slice(0, 200),
        codePoints: uniqueList.map(function (c) {
          return { cp: c, name: codePointName(c), char: String.fromCodePoint(c), looksLike: HOMOGLYPH_MAP[c] || null };
        }),
        why: g.why
      });
    });

    if (cps.length && cps[0] === 0xfeff) {
      issues.push({
        id: "bom-start", level: "medium", title: "Leading byte order mark", count: 1, positions: [0],
        codePoints: [{ cp: 0xfeff, name: codePointName(0xfeff), char: "\uFEFF" }],
        why: "The text starts with a BOM. Some parsers keep it as an invisible character, which breaks the first field of the first line."
      });
    }

    // Mark the characters that sit inside a word mixing Latin with Cyrillic or
    // Greek. Only there is a look-alike letter evidence of spoofing rather than
    // the ordinary spelling of another language (a pure Cyrillic word legitimately
    // contains letters that resemble Latin ones).
    var inMixedWord = {};
    (function () {
      var j = 0;
      while (j < cps.length) {
        if (!isLetter(String.fromCodePoint(cps[j]))) { j++; continue; }
        var runStart = j;
        var runLatin = false, runOther = false;
        while (j < cps.length && (isLetter(String.fromCodePoint(cps[j])) || isMark(String.fromCodePoint(cps[j])))) {
          var sc = scriptOf(cps[j]);
          if (sc === "Latin") runLatin = true;
          else if (sc === "Cyrillic" || sc === "Greek") runOther = true;
          j++;
        }
        if (runLatin && runOther) {
          for (var k = runStart; k < j; k++) inMixedWord[k] = true;
        }
      }
    })();

    // Homoglyphs: characters that look like a different (usually Latin) letter.
    var confusables = [];
    for (i = 0; i < cps.length; i++) {
      var mapped = HOMOGLYPH_MAP[cps[i]];
      if (mapped && inMixedWord[i]) {
        confusables.push({ index: i, cp: cps[i], char: String.fromCodePoint(cps[i]), looksLike: mapped, block: blockOf(cps[i]) });
      }
    }
    if (confusables.length) {
      issues.push({
        id: "homoglyph", level: "high",
        title: "Homoglyphs — letters from another script that look Latin",
        count: confusables.length,
        positions: confusables.map(function (c) { return c.index; }),
        codePoints: confusables.map(function (c) { return { cp: c.cp, name: codePointName(c.cp), char: c.char, looksLike: c.looksLike }; }),
        why: "Cyrillic and Greek letters such as а, е, о and р render like Latin a, e, o and p. A domain, username or identifier built from them can pass visual review while comparing unequal."
      });
    }

    var mixed = detectMixedScripts(cps);
    if (mixed) issues.push(mixed);

    var lookalikes = [];
    for (i = 0; i < cps.length; i++) {
      var c2 = cps[i];
      if (c2 === 0x2018 || c2 === 0x2019 || c2 === 0x201c || c2 === 0x201d) {
        lookalikes.push({ index: i, cp: c2, char: String.fromCodePoint(c2), name: codePointName(c2) });
      }
    }
    if (lookalikes.length) {
      issues.push({
        id: "smart-quotes", level: "low", title: "Curly quotation marks", count: lookalikes.length,
        positions: lookalikes.map(function (c) { return c.index; }),
        codePoints: lookalikes.map(function (c) { return { cp: c.cp, name: c.name, char: c.char }; }),
        why: "Typographic quotes differ from ASCII ' and \". They break string literals and exact matches pasted from documents."
      });
    }

    var oddSpace = [];
    for (i = 0; i < cps.length; i++) {
      var c3 = cps[i];
      if (c3 === 0x00a0 || c3 === 0x2007 || c3 === 0x202f || c3 === 0x2000 || c3 === 0x2001 ||
          c3 === 0x2002 || c3 === 0x2003 || c3 === 0x2004 || c3 === 0x2005 || c3 === 0x2006 ||
          c3 === 0x2008 || c3 === 0x2009 || c3 === 0x200a || c3 === 0x205f || c3 === 0x3000) {
        oddSpace.push({ index: i, cp: c3, char: String.fromCodePoint(c3), name: codePointName(c3) });
      }
    }
    if (oddSpace.length) {
      issues.push({
        id: "odd-space", level: "low", title: "Unusual space characters", count: oddSpace.length,
        positions: oddSpace.map(function (c) { return c.index; }),
        codePoints: oddSpace.map(function (c) { return { cp: c.cp, name: c.name, char: c.char }; }),
        why: "These look like spaces but are not U+0020. They break naive splitting, trimming and database equality checks."
      });
    }

    var replacement = [];
    for (i = 0; i < cps.length; i++) {
      if (cps[i] === 0xfffd) replacement.push({ index: i, cp: 0xfffd, char: "\uFFFD", name: codePointName(0xfffd) });
    }
    if (replacement.length) {
      issues.push({
        id: "replacement-char", level: "medium", title: "Replacement characters", count: replacement.length,
        positions: replacement.map(function (c) { return c.index; }),
        codePoints: replacement.map(function (c) { return { cp: c.cp, name: c.name, char: c.char }; }),
        why: "U+FFFD marks a character that was already lost in an encoding round-trip. The original byte sequence cannot be recovered from the text alone."
      });
    }

    var surrogates = [];
    for (i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdfff) {
        var next = text.charCodeAt(i + 1);
        var isPair = code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
        if (!isPair) surrogates.push({ index: i, code: code });
        else i++;
      }
    }
    if (surrogates.length) {
      issues.push({
        id: "lone-surrogate", level: "high", title: "Lone surrogate code units", count: surrogates.length,
        positions: surrogates.map(function (c) { return c.index; }),
        codePoints: surrogates.map(function (c) { return { cp: c.code, name: "Lone surrogate U+" + c.code.toString(16).toUpperCase(), char: "" }; }),
        why: "A UTF-16 surrogate without its pair is not valid Unicode. It becomes U+FFFD when encoded and breaks round-trips."
      });
    }

    if (typeof String.prototype.normalize === "function") {
      try {
        if (text.normalize("NFC") !== text) {
          issues.push({
            id: "not-normalized", level: "medium",
            title: "Text is not in Unicode Normalization Form C",
            count: 1, positions: [], codePoints: [],
            why: "The string changes under NFC normalization. Two visually identical strings can compare unequal if one is composed and the other decomposed. Use Normalize → NFC to compare reliably."
          });
        }
      } catch (e) { /* ignore */ }
    }

    var order = { high: 0, medium: 1, low: 2 };
    issues.sort(function (a, b) {
      if (order[a.level] !== order[b.level]) return order[a.level] - order[b.level];
      var ap = a.positions.length ? a.positions[0] : 1e9;
      var bp = b.positions.length ? b.positions[0] : 1e9;
      return ap - bp;
    });
    return issues;
  }

  // ---------------------------------------------------------------------
  // Full report
  // ---------------------------------------------------------------------

  function analyze(text, options) {
    options = options || {};
    text = typeof text === "string" ? text : String(text == null ? "" : text);

    var cps = toCodePoints(text);
    var bytes = encodeUTF8(text);
    var graphemes = splitGraphemes(text);

    var detailLimit = clampInt(options.maxDetail, 1, 100000, MAX_DETAIL_CHARS);
    var detailChars = [];
    var limit = Math.min(cps.length, detailLimit);
    for (var i = 0; i < limit; i++) {
      detailChars.push(analyzeChar(cps[i], i));
    }

    var issues = detectIssues(text, cps);

    var risk = "none";
    for (i = 0; i < issues.length; i++) {
      if (issues[i].level === "high") { risk = "high"; break; }
      if (issues[i].level === "medium") risk = "medium";
      else if (risk === "none") risk = "low";
    }

    var scriptCounts = {};
    var blockCounts = {};
    var categoryCounts = {};
    for (i = 0; i < cps.length; i++) {
      var s = scriptOf(cps[i]) || "Other";
      scriptCounts[s] = (scriptCounts[s] || 0) + 1;
      var b = blockOf(cps[i]);
      blockCounts[b] = (blockCounts[b] || 0) + 1;
      var cat = categoryOf(cps[i]);
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    var bytesPerChar = cps.length ? Math.round((bytes.length / cps.length) * 100) / 100 : 0;

    return {
      text: text,
      codePoints: cps,
      length: cps.length,
      utf16Length: text.length,
      byteLength: bytes.length,
      graphemeCount: graphemes.length,
      bytesPerChar: bytesPerChar,
      chars: detailChars,
      detailTruncated: cps.length > detailLimit,
      issues: issues,
      risk: risk,
      scriptCounts: scriptCounts,
      blockCounts: blockCounts,
      categoryCounts: categoryCounts,
      hasSegmenter: HAS_SEGMENTER,
      summary: {
        chars: cps.length,
        utf16Units: text.length,
        bytes: bytes.length,
        graphemes: graphemes.length,
        lines: text === "" ? 0 : text.split(/\r\n|\r|\n/).length,
        words: (text.match(/[^\s]+/g) || []).length,
        nonAscii: cps.filter(function (c) { return c > 0x7f; }).length,
        invisible: issues.filter(function (x) { return x.id === "zero-width" || x.id === "bidi" || x.id === "tag" || x.id === "bom" || x.id === "other-invisible"; }).reduce(function (n, x) { return n + x.count; }, 0),
        issues: issues.length,
        highIssues: issues.filter(function (x) { return x.level === "high"; }).length
      }
    };
  }

  // ---------------------------------------------------------------------
  // Escape-format conversion
  // ---------------------------------------------------------------------

  var MAX_ESCAPE_ITERATIONS = 6;
  var ESCAPE_HEX_ENTITY = /&#x([0-9a-fA-F]{1,6});/g;
  var ESCAPE_DEC_ENTITY = /&#([0-9]{1,7});/g;
  var ESCAPE_NAMED_ENTITY = /&([a-zA-Z][a-zA-Z0-9]{1,31});/g;
  var ESCAPE_JS_BRACE = /\\u\{([0-9a-fA-F]{1,6})\}/g;
  var ESCAPE_JS_SIMPLE = /\\u([0-9a-fA-F]{4})/g;
  var ESCAPE_CSS = /\\([0-9a-fA-F]{1,6})\s?/g;

  // A tiny subset of named HTML entities — the ones people actually paste.
  var NAMED_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0",
    copy: "\u00a9", reg: "\u00ae", trade: "\u2122", hellip: "\u2026",
    mdash: "\u2014", ndash: "\u2013", lsquo: "\u2018", rsquo: "\u2019",
    ldquo: "\u201c", rdquo: "\u201d", laquo: "\u00ab", raquo: "\u00bb",
    times: "\u00d7", divide: "\u00f7", deg: "\u00b0", plusmn: "\u00b1",
    frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be", sup2: "\u00b2",
    sup3: "\u00b3", middot: "\u00b7", bull: "\u2022", dagger: "\u2020",
    euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2",
    sect: "\u00a7", para: "\u00b6", micro: "\u00b5", shy: "\u00ad"
  };

  function codePointToUtf8String(cp) {
    if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
    try {
      return String.fromCodePoint(cp);
    } catch (e) {
      return "";
    }
  }

  function decodePercentWithUtf8(text) {
    // Collect byte runs so multi-byte UTF-8 sequences decode as characters.
    return text.replace(/(?:%[0-9a-fA-F]{2})+/g, function (run) {
      var bytes = [];
      var parts = run.match(/%[0-9a-fA-F]{2}/g) || [];
      for (var i = 0; i < parts.length; i++) bytes.push(parseInt(parts[i].slice(1), 16));
      return decodeUTF8(new Uint8Array(bytes));
    });
  }

  function decodeEscapes(text, format) {
    if (typeof text !== "string") text = String(text == null ? "" : text);
    var out = text;

    if (format === "auto" || format === "all") {
      var previous;
      var iterations = 0;
      do {
        previous = out;
        out = decodeEscapes(out, "html");
        out = decodeEscapes(out, "js");
        out = decodeEscapes(out, "css");
        out = decodeEscapes(out, "percent");
        iterations++;
      } while (out !== previous && iterations < MAX_ESCAPE_ITERATIONS);
      return out;
    }

    if (format === "html") {
      out = out.replace(ESCAPE_HEX_ENTITY, function (m, hex) { return codePointToUtf8String(parseInt(hex, 16)); });
      out = out.replace(ESCAPE_DEC_ENTITY, function (m, dec) { return codePointToUtf8String(parseInt(dec, 10)); });
      out = out.replace(ESCAPE_NAMED_ENTITY, function (m, name) {
        var lower = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : m;
      });
      return out;
    }

    if (format === "js") {
      out = out.replace(ESCAPE_JS_BRACE, function (m, hex) { return codePointToUtf8String(parseInt(hex, 16)); });
      out = out.replace(ESCAPE_JS_SIMPLE, function (m, hex) { return codePointToUtf8String(parseInt(hex, 16)); });
      return out;
    }

    if (format === "css") {
      out = out.replace(ESCAPE_CSS, function (m, hex) { return codePointToUtf8String(parseInt(hex, 16)); });
      return out;
    }

    if (format === "percent" || format === "url") {
      out = decodePercentWithUtf8(out);
      out = out.replace(/\+/g, " ");
      return out;
    }

    if (format === "json") {
      try {
        var parsed = JSON.parse(text);
        if (typeof parsed === "string") return parsed;
        return JSON.stringify(parsed, null, 2);
      } catch (e) {
        return text;
      }
    }

    return out;
  }

  function encodeEscapes(text, format) {
    if (typeof text !== "string") text = String(text == null ? "" : text);
    var cps = toCodePoints(text);
    var out = [];
    var i;

    if (format === "js") {
      for (i = 0; i < cps.length; i++) {
        var cp = cps[i];
        if (cp === 0x0a) out.push("\\n");
        else if (cp === 0x0d) out.push("\\r");
        else if (cp === 0x09) out.push("\\t");
        else if (cp === 0x5c) out.push("\\\\");
        else if (cp === 0x27) out.push("\\'");
        else if (cp === 0x22) out.push('\\"');
        else if (cp < 0x20 || cp > 0x7e) out.push(escapeCodePoint(cp));
        else out.push(String.fromCharCode(cp));
      }
      return out.join("");
    }

    if (format === "css") {
      for (i = 0; i < cps.length; i++) {
        var cpc = cps[i];
        if (cpc < 0x20 || cpc > 0x7e) out.push("\\" + cpc.toString(16).toUpperCase() + " ");
        else out.push(String.fromCharCode(cpc));
      }
      return out.join("");
    }

    if (format === "html") {
      for (i = 0; i < cps.length; i++) {
        var cph = cps[i];
        if (cph === 0x26) out.push("&amp;");
        else if (cph === 0x3c) out.push("&lt;");
        else if (cph === 0x3e) out.push("&gt;");
        else if (cph === 0x22) out.push("&quot;");
        else if (cph < 0x20 || cph > 0x7e) out.push("&#x" + cph.toString(16).toUpperCase() + ";");
        else out.push(String.fromCharCode(cph));
      }
      return out.join("");
    }

    if (format === "percent" || format === "url") {
      var bytes = encodeUTF8(text);
      for (i = 0; i < bytes.length; i++) {
        var b = bytes[i];
        var ch = String.fromCharCode(b);
        if (/[A-Za-z0-9\-_.~]/.test(ch)) out.push(ch);
        else out.push("%" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase());
      }
      return out.join("");
    }

    if (format === "json") {
      return JSON.stringify(text);
    }

    if (format === "codepoints") {
      var parts = [];
      for (i = 0; i < cps.length; i++) parts.push("U+" + padStart(cps[i].toString(16).toUpperCase(), 4, "0"));
      return parts.join(" ");
    }

    return text;
  }

  // ---------------------------------------------------------------------
  // Sanitizing (local, deterministic transformations)
  // ---------------------------------------------------------------------

  function removeInvisible(text) {
    var cps = toCodePoints(text);
    var out = "";
    for (var i = 0; i < cps.length; i++) {
      var cp = cps[i];
      if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 ||
          cp === 0xfeff || cp === 0x00ad || BIDI_CONTROLS[cp] ||
          (cp >= 0xe0020 && cp <= 0xe007f) ||
          (cp >= 0xfe00 && cp <= 0xfe0f) ||
          cp === 0x034f || cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0) {
        continue;
      }
      out += String.fromCodePoint(cp);
    }
    return out;
  }

  function replaceOddSpaces(text) {
    var cps = toCodePoints(text);
    var out = "";
    for (var i = 0; i < cps.length; i++) {
      var cp = cps[i];
      if (cp === 0x00a0 || cp === 0x2007 || cp === 0x202f || cp === 0x2000 || cp === 0x2001 ||
          cp === 0x2002 || cp === 0x2003 || cp === 0x2004 || cp === 0x2005 || cp === 0x2006 ||
          cp === 0x2008 || cp === 0x2009 || cp === 0x200a || cp === 0x205f || cp === 0x3000) {
        out += " ";
      } else {
        out += String.fromCodePoint(cp);
      }
    }
    return out;
  }

  function replaceSmartQuotes(text) {
    return text
      .replace(/\u2018|\u2019/g, "'")
      .replace(/\u201c|\u201d/g, '"')
      .replace(/\u2013|\u2014|\u2015/g, "-")
      .replace(/\u2026/g, "...");
  }

  function sanitize(text, options) {
    options = options || {};
    var out = text;
    if (options.removeInvisible !== false) out = removeInvisible(out);
    if (options.replaceSpaces) out = replaceOddSpaces(out);
    if (options.replaceQuotes) out = replaceSmartQuotes(out);
    if (options.normalize) out = normalize(out, options.normalize === true ? "NFC" : options.normalize);
    return out;
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------

  function csvField(value) {
    var s = value == null ? "" : String(value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCSV(analysis) {
    var header = ["index", "code_point", "char", "name", "category", "block", "script", "utf8_bytes", "risk", "flags"];
    var rows = [header.join(",")];
    var chars = analysis.chars || [];
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i];
      rows.push([
        c.index,
        "U+" + c.cp.toString(16).toUpperCase(),
        c.char,
        c.name,
        c.category,
        c.block,
        c.script || "",
        c.utf8,
        c.risk,
        c.flags.join(" ")
      ].map(csvField).join(","));
    }
    return rows.join("\n") + "\n";
  }

  function exportJSON(analysis) {
    var chars = (analysis.chars || []).map(function (c) {
      return {
        index: c.index,
        codePoint: "U+" + c.cp.toString(16).toUpperCase(),
        decimal: c.cp,
        char: c.char,
        name: c.name,
        category: c.category,
        categoryName: c.categoryName,
        block: c.block,
        script: c.script,
        utf8Bytes: c.utf8,
        risk: c.risk,
        flags: c.flags,
        confusableWith: c.confusable
      };
    });
    return JSON.stringify({
      summary: analysis.summary,
      risk: analysis.risk,
      issues: analysis.issues.map(function (it) {
        return { id: it.id, level: it.level, title: it.title, count: it.count, why: it.why };
      }),
      characters: chars,
      detailTruncated: analysis.detailTruncated
    }, null, 2);
  }

  return {
    // analysis
    analyze: analyze,
    analyzeChar: analyzeChar,
    toCodePoints: toCodePoints,
    // segmentation & normalization
    splitGraphemes: splitGraphemes,
    countGraphemes: countGraphemes,
    normalize: normalize,
    // classification
    codePointName: codePointName,
    categoryOf: categoryOf,
    blockOf: blockOf,
    scriptOf: scriptOf,
    describe: describe,
    // issues
    detectIssues: detectIssues,
    // escapes
    decodeEscapes: decodeEscapes,
    encodeEscapes: encodeEscapes,
    // sanitizing
    removeInvisible: removeInvisible,
    replaceOddSpaces: replaceOddSpaces,
    replaceSmartQuotes: replaceSmartQuotes,
    sanitize: sanitize,
    // export
    exportCSV: exportCSV,
    exportJSON: exportJSON,
    // helpers & constants
    utf8HexOf: utf8HexOf,
    escapeCodePoint: escapeCodePoint,
    encodeUTF8: encodeUTF8,
    decodeUTF8: decodeUTF8,
    CATEGORY_NAMES: CATEGORY_NAMES,
    MAX_DETAIL_CHARS: MAX_DETAIL_CHARS,
    HAS_SEGMENTER: HAS_SEGMENTER,
    BLOCKS: BLOCKS,
    SCRIPT_RANGES: SCRIPT_RANGES
  };
});
