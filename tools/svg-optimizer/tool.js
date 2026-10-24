/* Toolshed — SVG Optimizer
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.svgOptimizer and in Node via require() for tests.
 *
 * The module parses SVG (XML) into a small tree, applies a set of safe,
 * well-understood optimizations, serializes it back, and audits the result
 * for accessibility, contrast and security problems. Everything runs in
 * memory: it never touches the network, never uses eval or dynamic code
 * execution, and never executes anything from the input.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.svgOptimizer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Elements whose text content is significant and must not be re-whitespaced.
  var PRESERVE_WS = { text: 1, tspan: 1, textPath: 1, style: 1, script: 1, title: 1, desc: 1 };

  // Editor/export namespaces that never affect rendering and can be dropped.
  var EDITOR_NS = {
    sodipodi: 1, inkscape: 1, sketch: 1, adobe: 1, serif: 1,
    i: 1, graph: 1, figma: 1, dc: 1, cc: 1, rdf: 1
  };

  // Attributes whose value is the element's default and can be omitted.
  var DEFAULT_ATTRS = {
    svg: { x: "0", y: "0" },
    rect: { x: "0", y: "0", rx: "0", ry: "0" },
    circle: { cx: "0", cy: "0" },
    ellipse: { cx: "0", cy: "0" },
    line: { x1: "0", y1: "0", x2: "0", y2: "0" },
    use: { x: "0", y: "0" },
    image: { x: "0", y: "0" },
    text: { x: "0", y: "0" }
  };

  // Containers that can be dropped when they end up empty.
  var DROPPABLE_EMPTY = {
    g: 1, defs: 1, symbol: 1, marker: 1, mask: 1, clipPath: 1,
    pattern: 1, linearGradient: 1, radialGradient: 1, filter: 1
  };

  // Attributes whose value is one or more plain numbers and safe to round.
  var NUMERIC_ATTRS = {
    x: 1, y: 1, x1: 1, y1: 1, x2: 1, y2: 1, cx: 1, cy: 1, r: 1, rx: 1, ry: 1,
    width: 1, height: 1, "stroke-width": 1, "stroke-dashoffset": 1, "font-size": 1,
    offset: 1, opacity: 1, "fill-opacity": 1, "stroke-opacity": 1, "stop-opacity": 1
  };

  // Reference attributes that may contain url(#id) values.
  var REF_ATTRS = /^(?:clip-path|mask|fill|stroke|filter|marker-start|marker-mid|marker-end|style)$/;

  var NAMED_COLORS = {
    aliceblue: "#f0f8ff", antiquewhite: "#faebd7", aqua: "#00ffff", aquamarine: "#7fffd4",
    azure: "#f0ffff", beige: "#f5f5dc", bisque: "#ffe4c4", black: "#000000",
    blanchedalmond: "#ffebcd", blue: "#0000ff", blueviolet: "#8a2be2", brown: "#a52a2a",
    burlywood: "#deb887", cadetblue: "#5f9ea0", chartreuse: "#7fff00", chocolate: "#d2691e",
    coral: "#ff7f50", cornflowerblue: "#6495ed", cornsilk: "#fff8dc", crimson: "#dc143c",
    cyan: "#00ffff", darkblue: "#00008b", darkcyan: "#008b8b", darkgoldenrod: "#b8860b",
    darkgray: "#a9a9a9", darkgreen: "#006400", darkgrey: "#a9a9a9", darkkhaki: "#bdb76b",
    darkmagenta: "#8b008b", darkolivegreen: "#556b2f", darkorange: "#ff8c00",
    darkorchid: "#9932cc", darkred: "#8b0000", darksalmon: "#e9967a", darkseagreen: "#8fbc8f",
    darkslateblue: "#483d8b", darkslategray: "#2f4f4f", darkslategrey: "#2f4f4f",
    darkturquoise: "#00ced1", darkviolet: "#9400d3", deeppink: "#ff1493",
    deepskyblue: "#00bfff", dimgray: "#696969", dimgrey: "#696969", dodgerblue: "#1e90ff",
    firebrick: "#b22222", floralwhite: "#fffaf0", forestgreen: "#228b22", fuchsia: "#ff00ff",
    gainsboro: "#dcdcdc", ghostwhite: "#f8f8ff", gold: "#ffd700", goldenrod: "#daa520",
    gray: "#808080", green: "#008000", greenyellow: "#adff2f", grey: "#808080",
    honeydew: "#f0fff0", hotpink: "#ff69b4", indianred: "#cd5c5c", indigo: "#4b0082",
    ivory: "#fffff0", khaki: "#f0e68c", lavender: "#e6e6fa", lavenderblush: "#fff0f5",
    lawngreen: "#7cfc00", lemonchiffon: "#fffacd", lightblue: "#add8e6", lightcoral: "#f08080",
    lightcyan: "#e0ffff", lightgoldenrodyellow: "#fafad2", lightgray: "#d3d3d3",
    lightgreen: "#90ee90", lightgrey: "#d3d3d3", lightpink: "#ffb6c1", lightsalmon: "#ffa07a",
    lightseagreen: "#20b2aa", lightskyblue: "#87cefa", lightslategray: "#778899",
    lightslategrey: "#778899", lightsteelblue: "#b0c4de", lightyellow: "#ffffe0",
    lime: "#00ff00", limegreen: "#32cd32", linen: "#faf0e6", magenta: "#ff00ff",
    maroon: "#800000", mediumaquamarine: "#66cdaa", mediumblue: "#0000cd",
    mediumorchid: "#ba55d3", mediumpurple: "#9370db", mediumseagreen: "#3cb371",
    mediumslateblue: "#7b68ee", mediumspringgreen: "#00fa9a", mediumturquoise: "#48d1cc",
    mediumvioletred: "#c71585", midnightblue: "#191970", mintcream: "#f5fffa",
    mistyrose: "#ffe4e1", moccasin: "#ffe4b5", navajowhite: "#ffdead", navy: "#000080",
    oldlace: "#fdf5e6", olive: "#808000", olivedrab: "#6b8e23", orange: "#ffa500",
    orangered: "#ff4500", orchid: "#da70d6", palegoldenrod: "#eee8aa", palegreen: "#98fb98",
    paleturquoise: "#afeeee", palevioletred: "#db7093", papayawhip: "#ffefd5",
    peachpuff: "#ffdab9", peru: "#cd853f", pink: "#ffc0cb", plum: "#dda0dd",
    powderblue: "#b0e0e6", purple: "#800080", rebeccapurple: "#663399", red: "#ff0000",
    rosybrown: "#bc8f8f", royalblue: "#4169e1", saddlebrown: "#8b4513", salmon: "#fa8072",
    sandybrown: "#f4a460", seagreen: "#2e8b57", seashell: "#fff5ee", sienna: "#a0522d",
    silver: "#c0c0c0", skyblue: "#87ceeb", slateblue: "#6a5acd", slategray: "#708090",
    slategrey: "#708090", snow: "#fffafa", springgreen: "#00ff7f", steelblue: "#4682b4",
    tan: "#d2b48c", teal: "#008080", thistle: "#d8bfd8", tomato: "#ff6347",
    turquoise: "#40e0d0", violet: "#ee82ee", wheat: "#f5deb3", white: "#ffffff",
    whitesmoke: "#f5f5f5", yellow: "#ffff00", yellowgreen: "#9acd32"
  };

  // ---------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------

  var NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

  function decodeEntities(value) {
    return String(value).replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9._-]*);/g, function (match, body) {
      if (body.charAt(0) === "#") {
        var code = body.charAt(1) === "x" || body.charAt(1) === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (isFinite(code) && code >= 0 && code <= 0x10ffff) {
          try { return String.fromCodePoint(code); } catch (err) { return match; }
        }
        return match;
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
    });
  }

  function escapeText(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }

  function escapeAttr(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  // ---------------------------------------------------------------------
  // XML parsing
  // ---------------------------------------------------------------------

  var NAME_START = /[A-Za-z_:]/;
  var NAME_CHAR = /[A-Za-z0-9_:.\-]/;

  function positionOf(text, index) {
    var line = 1;
    var column = 1;
    for (var i = 0; i < index && i < text.length; i++) {
      if (text.charCodeAt(i) === 10) { line++; column = 1; } else { column++; }
    }
    return { line: line, column: column };
  }

  /**
   * Parse XML/SVG into a lightweight node tree.
   * @param {string} input
   * @returns {{ok:true, nodes:Array, root:Object}|{ok:false, error:Object}}
   */
  function parseXML(input) {
    var text = String(input == null ? "" : input);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var n = text.length;
    var i = 0;
    var top = [];
    var stack = [];
    var root = null;

    function fail(message, index) {
      var at = index == null ? i : index;
      var pos = positionOf(text, at);
      return { ok: false, error: { message: message, line: pos.line, column: pos.column, index: at } };
    }
    function siblings() {
      return stack.length ? stack[stack.length - 1].children : top;
    }

    while (i < n) {
      if (text.charAt(i) !== "<") {
        var nextLt = text.indexOf("<", i);
        if (nextLt === -1) nextLt = n;
        siblings().push({ type: "text", value: decodeEntities(text.slice(i, nextLt)) });
        i = nextLt;
        continue;
      }

      if (text.substr(i, 4) === "<!--") {
        var cEnd = text.indexOf("-->", i + 4);
        if (cEnd === -1) return fail("Unterminated comment", i);
        siblings().push({ type: "comment", value: text.slice(i + 4, cEnd) });
        i = cEnd + 3;
      } else if (text.substr(i, 9) === "<![CDATA[") {
        var cdEnd = text.indexOf("]]>", i + 9);
        if (cdEnd === -1) return fail("Unterminated CDATA section", i);
        siblings().push({ type: "cdata", value: text.slice(i + 9, cdEnd) });
        i = cdEnd + 3;
      } else if (text.substr(i, 2) === "<?") {
        var piEnd = text.indexOf("?>", i + 2);
        if (piEnd === -1) return fail("Unterminated processing instruction", i);
        siblings().push({ type: "pi", value: text.slice(i + 2, piEnd) });
        i = piEnd + 2;
      } else if (text.substr(i, 9).toUpperCase() === "<!DOCTYPE") {
        var j = i + 9;
        var depth = 0;
        var dEnd = -1;
        while (j < n) {
          var ch = text.charAt(j);
          if (ch === "[") depth++;
          else if (ch === "]") depth--;
          else if (ch === ">" && depth <= 0) { dEnd = j; break; }
          j++;
        }
        if (dEnd === -1) return fail("Unterminated DOCTYPE declaration", i);
        siblings().push({ type: "doctype", value: text.slice(i + 2, dEnd) });
        i = dEnd + 1;
      } else if (text.charAt(i + 1) === "/") {
        var closeEnd = text.indexOf(">", i + 2);
        if (closeEnd === -1) return fail("Unterminated closing tag", i);
        var closeName = text.slice(i + 2, closeEnd).trim();
        if (!stack.length) return fail("Unexpected closing tag </" + closeName + ">", i);
        var open = stack.pop();
        if (open.name !== closeName) {
          return fail("Mismatched closing tag: <" + open.name + "> is closed by </" + closeName + ">", i);
        }
        i = closeEnd + 1;
      } else {
        var k = i + 1;
        if (!NAME_START.test(text.charAt(k))) return fail("Invalid tag name", i);
        var nameStart = k;
        while (k < n && NAME_CHAR.test(text.charAt(k))) k++;
        var name = text.slice(nameStart, k);
        var attrs = [];
        var selfClosing = false;

        while (true) {
          while (k < n && /\s/.test(text.charAt(k))) k++;
          if (k >= n) return fail("Unterminated start tag <" + name + ">", i);
          if (text.charAt(k) === "/") {
            if (text.charAt(k + 1) !== ">") return fail("Malformed start tag <" + name + ">", k);
            selfClosing = true;
            k += 2;
            break;
          }
          if (text.charAt(k) === ">") { k += 1; break; }
          if (!NAME_START.test(text.charAt(k))) return fail("Malformed attribute in <" + name + ">", k);
          var aStart = k;
          while (k < n && NAME_CHAR.test(text.charAt(k))) k++;
          var attrName = text.slice(aStart, k);
          while (k < n && /\s/.test(text.charAt(k))) k++;
          var attrValue = "";
          if (text.charAt(k) === "=") {
            k++;
            while (k < n && /\s/.test(text.charAt(k))) k++;
            var quote = text.charAt(k);
            if (quote !== '"' && quote !== "'") {
              return fail("Attribute \"" + attrName + "\" on <" + name + "> must be quoted", k);
            }
            var vStart = k + 1;
            var vEnd = text.indexOf(quote, vStart);
            if (vEnd === -1) return fail("Unterminated value for attribute \"" + attrName + "\"", k);
            attrValue = decodeEntities(text.slice(vStart, vEnd));
            k = vEnd + 1;
          }
          attrs.push({ name: attrName, value: attrValue });
        }

        var node = { type: "element", name: name, attrs: attrs, children: [] };
        siblings().push(node);
        if (stack.length === 0 && !root) root = node;
        if (!selfClosing) stack.push(node);
        i = k;
      }
    }

    if (stack.length) {
      return fail("Unclosed element <" + stack[stack.length - 1].name + ">", Math.max(0, n - 1));
    }
    if (!root) {
      return { ok: false, error: { message: "No root element found — this does not look like XML", line: 1, column: 1, index: 0 } };
    }
    return { ok: true, nodes: top, root: root };
  }

  // ---------------------------------------------------------------------
  // Node helpers
  // ---------------------------------------------------------------------

  function localName(name) {
    var colon = name.indexOf(":");
    return colon === -1 ? name : name.slice(colon + 1);
  }

  function namespaceOf(name) {
    var colon = name.indexOf(":");
    return colon === -1 ? "" : name.slice(0, colon);
  }

  function isElement(node) {
    return node.type === "element";
  }

  function tagOf(node) {
    return localName(node.name);
  }

  function getAttr(node, name) {
    for (var i = 0; i < node.attrs.length; i++) {
      if (node.attrs[i].name === name) return node.attrs[i].value;
    }
    return null;
  }

  function removeAttr(node, name) {
    node.attrs = node.attrs.filter(function (attr) { return attr.name !== name; });
  }

  function hasElementChildren(node) {
    return node.children.some(isElement);
  }

  // ---------------------------------------------------------------------
  // Numbers
  // ---------------------------------------------------------------------

  function formatNumber(value, precision) {
    if (typeof precision !== "number") precision = 3;
    if (!isFinite(value)) return String(value);
    if (value === 0) return "0";
    var rounded = Number(value.toFixed(precision));
    var out = String(rounded);
    if (out.indexOf("e") !== -1 || out.indexOf("E") !== -1) return out;
    if (out.indexOf(".") !== -1) out = out.replace(/0+$/, "").replace(/\.$/, "");
    return out === "-0" ? "0" : out;
  }

  // Round every plain number inside an attribute value, leaving units,
  // percentages, and anything non-numeric untouched.
  function roundAttributeValue(value, precision) {
    return String(value).replace(/-?(?:\d+\.\d+|\d+|\.\d+)(?:[eE][-+]?\d+)?/g, function (match) {
      return formatNumber(parseFloat(match), precision);
    });
  }
  // ---------------------------------------------------------------------
  // Path data
  // ---------------------------------------------------------------------

  var COMMANDS = "MmZzLlHhVvCcSsQqTtAa";

  /**
   * Normalize path data: consistent command spacing, rounded coordinates,
   * and compact arc-flag syntax. The command sequence is preserved exactly,
   * so the rendered shape is unchanged.
   */
  function optimizePathData(data, precision) {
    if (typeof precision !== "number") precision = 2;
    var source = String(data == null ? "" : data);
    var tokens = [];
    var i = 0;
    var n = source.length;
    var numRe = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

    while (i < n) {
      var ch = source.charAt(i);
      if (ch === " " || ch === "," || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
      if (COMMANDS.indexOf(ch) !== -1) {
        tokens.push({ cmd: ch, numbers: [] });
        i++;
        continue;
      }
      numRe.lastIndex = i;
      var m = numRe.exec(source);
      if (!m || m.index !== i) { i++; continue; }
      if (tokens.length === 0) tokens.push({ cmd: "M", numbers: [] });
      tokens[tokens.length - 1].numbers.push(parseFloat(m[0]));
      i = m.index + m[0].length;
    }

    if (tokens.length === 0) return "";

    var out = "";
    for (var t = 0; t < tokens.length; t++) {
      var cmd = tokens[t].cmd;
      var numbers = tokens[t].numbers;
      if (cmd === "Z" || cmd === "z") { out += cmd; continue; }
      if (numbers.length === 0) continue;
      out += (out === "" ? "" : " ") + cmd;
      var isArc = cmd === "A" || cmd === "a";
      for (var p = 0; p < numbers.length; p++) {
        var text = formatNumber(numbers[p], precision);
        // Arc flags are single characters, so the two of them can sit flush
        // against each other ("0 11 10"). The space before the first flag
        // must stay: it separates the flag from the rotation value, which
        // may itself end in digits ("0.5" + "1" would read as "0.51").
        var flush = isArc && p % 7 === 4;
        out += (p === 0 || flush ? "" : " ") + text;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Colors and contrast
  // ---------------------------------------------------------------------

  function parseColor(input) {
    if (input == null) return null;
    var value = String(input).trim().toLowerCase();
    if (value === "" || value === "none" || value === "currentcolor" ||
        value === "transparent" || value === "inherit") return null;
    if (value.charAt(0) === "#") {
      var hex = value.slice(1);
      if (hex.length === 3 || hex.length === 4) {
        hex = hex.split("").map(function (c) { return c + c; }).join("");
      }
      if (hex.length === 6) hex = hex + "ff";
      if (hex.length !== 8 || !/^[0-9a-f]{8}$/.test(hex)) return null;
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255
      };
    }
    var rgb = value.match(/^rgba?\(([^)]+)\)$/);
    if (rgb) {
      var parts = rgb[1].split(/[\s,\/]+/).filter(function (s) { return s !== ""; });
      if (parts.length < 3) return null;
      var toByte = function (s) {
        return s.indexOf("%") !== -1 ? Math.round(parseFloat(s) / 100 * 255) : Math.round(parseFloat(s));
      };
      var alpha = parts.length >= 4
        ? (parts[3].indexOf("%") !== -1 ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]))
        : 1;
      var color = { r: toByte(parts[0]), g: toByte(parts[1]), b: toByte(parts[2]), a: isFinite(alpha) ? alpha : 1 };
      if (!isFinite(color.r) || !isFinite(color.g) || !isFinite(color.b)) return null;
      return color;
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, value)) return parseColor(NAMED_COLORS[value]);
    return null;
  }

  function hexOf(color) {
    if (!color) return null;
    var toHex = function (v) {
      var h = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return h.length === 1 ? "0" + h : h;
    };
    return "#" + toHex(color.r) + toHex(color.g) + toHex(color.b);
  }

  function relativeLuminance(color) {
    var channel = function (v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  function contrastRatio(a, b) {
    var la = relativeLuminance(a);
    var lb = relativeLuminance(b);
    var lighter = Math.max(la, lb);
    var darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
  }
  // ---------------------------------------------------------------------
  // Options
  // ---------------------------------------------------------------------

  var OPTION_KEYS = [
    "removeComments", "removeMetadata", "removeEditorData", "removeEmptyContainers",
    "collapseGroups", "removeDefaults", "removeDimensions", "roundNumbers",
    "numberPrecision", "optimizePaths", "minifyColors", "shortenIds",
    "sortAttributes", "trimWhitespace"
  ];

  function defaultOptions(overrides) {
    var options = {
      removeComments: true,
      removeMetadata: true,
      removeEditorData: true,
      removeEmptyContainers: true,
      collapseGroups: true,
      removeDefaults: true,
      removeDimensions: false,
      roundNumbers: true,
      numberPrecision: 2,
      optimizePaths: true,
      minifyColors: true,
      shortenIds: false,
      sortAttributes: true,
      trimWhitespace: true
    };
    if (overrides) {
      for (var key in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, key) &&
            OPTION_KEYS.indexOf(key) !== -1) {
          options[key] = overrides[key];
        }
      }
    }
    if (typeof options.numberPrecision !== "number" || !isFinite(options.numberPrecision)) {
      options.numberPrecision = 2;
    }
    options.numberPrecision = Math.max(0, Math.min(6, Math.round(options.numberPrecision)));
    return options;
  }

  // ---------------------------------------------------------------------
  // Tree utilities
  // ---------------------------------------------------------------------

  function countNodes(nodes) {
    var elements = 0;
    var others = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.type === "element") {
        elements++;
        var inner = countNodes(node.children);
        elements += inner.elements;
        others += inner.others;
      } else {
        others++;
      }
    }
    return { elements: elements, others: others };
  }

  function collectIds(nodes, out) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.type !== "element") continue;
      var id = getAttr(node, "id");
      if (id) out.push(id);
      collectIds(node.children, out);
    }
    return out;
  }

  // Namespace declarations for prefixes that never appear in the document are
  // dead weight. xmlns (the default namespace) is always kept.
  function pruneUnusedNamespaces(root, stats) {
    var used = {};
    (function scan(node) {
      if (node.type !== "element") return;
      var prefix = namespaceOf(node.name);
      if (prefix) used[prefix] = true;
      for (var i = 0; i < node.attrs.length; i++) {
        var attrPrefix = namespaceOf(node.attrs[i].name);
        if (attrPrefix && attrPrefix !== "xmlns") used[attrPrefix] = true;
      }
      for (var c = 0; c < node.children.length; c++) scan(node.children[c]);
    })(root);

    root.attrs = root.attrs.filter(function (attr) {
      var match = attr.name.match(/^xmlns:([A-Za-z_][\w.\-]*)$/);
      if (!match) return true;
      if (used[match[1]]) return true;
      stats.removedNamespaces++;
      return false;
    });
  }

  // ---------------------------------------------------------------------
  // Color minification helpers
  // ---------------------------------------------------------------------

  function shortestHex(color) {
    var full = hexOf(color);
    if (!full) return null;
    if (full.charAt(1) === full.charAt(2) &&
        full.charAt(3) === full.charAt(4) &&
        full.charAt(5) === full.charAt(6)) {
      return "#" + full.charAt(1) + full.charAt(3) + full.charAt(5);
    }
    return full;
  }

  function minifyColorValue(value) {
    var parsed = parseColor(value);
    if (!parsed || parsed.a !== 1) return value;
    var short = shortestHex(parsed);
    return short && short.length < String(value).length ? short : value;
  }

  // ---------------------------------------------------------------------
  // Optimization pass
  // ---------------------------------------------------------------------

  function processNode(node, options, stats, isRoot) {
    var tag = tagOf(node);
    var ns = namespaceOf(node.name);

    // Editor/export namespaces never affect rendering.
    if (options.removeEditorData && ns && Object.prototype.hasOwnProperty.call(EDITOR_NS, ns)) {
      stats.removedEditorData++;
      return null;
    }
    // Metadata blocks are not needed in the asset. <title> and <desc> are
    // kept: they carry the text alternative the audit checks for.
    if (options.removeMetadata && (ns === "metadata" || tag === "metadata")) {
      stats.removedMetadata++;
      return null;
    }

    // Recurse first, so containers can be judged after their children.
    var kept = [];
    var hadElementChild = hasElementChildren(node);
    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      if (child.type === "element") {
        var result = processNode(child, options, stats, false);
        if (result) kept.push(result);
      } else if (child.type === "comment") {
        if (options.removeComments) stats.removedComments++;
        else kept.push(child);
      } else if (child.type === "text") {
        if (options.trimWhitespace && !PRESERVE_WS[tag] &&
            child.value.trim() === "" && hadElementChild) {
          stats.removedWhitespace++;
        } else {
          kept.push(child);
        }
      } else {
        kept.push(child);
      }
    }
    node.children = kept;

    // Drop containers that ended up with nothing in them.
    if (options.removeEmptyContainers && !isRoot &&
        DROPPABLE_EMPTY[tag] && node.children.length === 0) {
      stats.removedEmptyContainers++;
      return null;
    }

    // Collapse a <g> with no attributes of its own around a single element.
    if (options.collapseGroups && tag === "g" && node.attrs.length === 0 &&
        node.children.length === 1 && isElement(node.children[0])) {
      stats.collapsedGroups++;
      return node.children[0];
    }

    // Attributes whose value is the element's own default.
    if (options.removeDefaults && DEFAULT_ATTRS[tag]) {
      var defaults = DEFAULT_ATTRS[tag];
      var before = node.attrs.length;
      node.attrs = node.attrs.filter(function (attr) {
        return !(Object.prototype.hasOwnProperty.call(defaults, attr.name) && attr.value === defaults[attr.name]);
      });
      stats.removedDefaults += before - node.attrs.length;
    }

    // Attribute-level numeric, path and color cleanup.
    for (var a = 0; a < node.attrs.length; a++) {
      var attr = node.attrs[a];
      if (options.optimizePaths && attr.name === "d" && tag === "path") {
        var optimized = optimizePathData(attr.value, options.numberPrecision);
        if (optimized && optimized !== attr.value) stats.optimizedPaths++;
        attr.value = optimized;
      } else if (options.roundNumbers && Object.prototype.hasOwnProperty.call(NUMERIC_ATTRS, attr.name)) {
        attr.value = roundAttributeValue(attr.value, options.numberPrecision);
      } else if (options.minifyColors &&
                 (attr.name === "fill" || attr.name === "stroke" || attr.name === "stop-color" || attr.name === "color")) {
        var minified = minifyColorValue(attr.value);
        if (minified !== attr.value) { attr.value = minified; stats.minifiedColors++; }
      }
    }

    return node;
  }

  // ---------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------

  function indent(depth) {
    var out = "";
    for (var i = 0; i < depth; i++) out += "  ";
    return out;
  }

  function serializeNode(node, options, depth, out) {
    if (node.type === "comment") { out.push("<!--" + node.value + "-->"); return; }
    if (node.type === "cdata") { out.push("<![CDATA[" + node.value + "]]>"); return; }
    if (node.type === "pi") { out.push("<?" + node.value + "?>"); return; }
    if (node.type === "doctype") { out.push("<!" + node.value + ">"); return; }
    if (node.type === "text") { out.push(escapeText(node.value)); return; }

    var attrs = node.attrs.slice();
    if (options.sortAttributes) {
      attrs.sort(function (x, y) { return x.name < y.name ? -1 : x.name > y.name ? 1 : 0; });
    }
    var attrText = "";
    for (var i = 0; i < attrs.length; i++) {
      attrText += " " + attrs[i].name + '="' + escapeAttr(attrs[i].value) + '"';
    }

    if (node.children.length === 0) {
      out.push("<" + node.name + attrText + "/>");
      return;
    }
    out.push("<" + node.name + attrText + ">");
    for (var c = 0; c < node.children.length; c++) {
      serializeNode(node.children[c], options, depth + 1, out);
    }
    out.push("</" + node.name + ">");
  }

  function serializeNodes(nodes, options) {
    var pretty = !!(options && options.pretty);
    var raw = [];
    for (var i = 0; i < nodes.length; i++) serializeNode(nodes[i], options || {}, 0, raw);
    return raw.join("").trim();
  }

  function prettyPrint(svgText) {
    var parsed = parseXML(svgText);
    if (!parsed.ok) return svgText;
    var out = [];
    for (var i = 0; i < parsed.nodes.length; i++) {
      prettyNode(parsed.nodes[i], { sortAttributes: false }, 0, out);
    }
    return out.join("\n");
  }

  function prettyNode(node, options, depth, out) {
    var pad = indent(depth);
    if (node.type !== "element") {
      var single = [];
      serializeNode(node, options, depth, single);
      out.push(pad + single.join(""));
      return;
    }
    var attrs = node.attrs.slice();
    if (options.sortAttributes) {
      attrs.sort(function (x, y) { return x.name < y.name ? -1 : x.name > y.name ? 1 : 0; });
    }
    var attrText = "";
    for (var i = 0; i < attrs.length; i++) {
      attrText += " " + attrs[i].name + '="' + escapeAttr(attrs[i].value) + '"';
    }
    if (node.children.length === 0) {
      out.push(pad + "<" + node.name + attrText + "/>");
      return;
    }
    var onlyText = node.children.every(function (c) { return c.type !== "element"; });
    if (onlyText) {
      var inner = [];
      for (var c = 0; c < node.children.length; c++) serializeNode(node.children[c], options, 0, inner);
      out.push(pad + "<" + node.name + attrText + ">" + inner.join("") + "</" + node.name + ">");
      return;
    }
    out.push(pad + "<" + node.name + attrText + ">");
    for (var d = 0; d < node.children.length; d++) {
      prettyNode(node.children[d], options, depth + 1, out);
    }
    out.push(pad + "</" + node.name + ">");
  }

  function minify(svgText) {
    var parsed = parseXML(svgText);
    if (!parsed.ok) return svgText;
    return serializeNodes(parsed.nodes, { pretty: false, sortAttributes: false });
  }
  // ---------------------------------------------------------------------
  // Audit (accessibility, contrast, security)
  // ---------------------------------------------------------------------

  var EVENT_ATTR_RE = /^on[a-z]+$/i;
  var SCRIPT_URI_RE = /^\s*(?:javascript|vbscript)\s*:/i;
  var DATA_URI_RE = /^\s*data\s*:/i;

  function audit(root, meta) {
    var result = {
      issues: [],
      elements: 0,
      textElements: 0,
      hasTitle: false,
      hasDesc: false,
      hasRole: false,
      hasViewBox: !!meta.hasViewBox,
      hasDimensions: !!meta.hasDimensions,
      hasScript: !!meta.hasScript,
      colors: {},
      contrasts: []
    };

    function issue(level, code, message) {
      result.issues.push({ level: level, code: code, message: message });
    }

    function walk(node, isRoot) {
      if (node.type !== "element") return;
      var tag = tagOf(node);
      result.elements++;

      if (tag === "title") result.hasTitle = true;
      if (tag === "desc") result.hasDesc = true;
      if (tag === "text" || tag === "tspan") result.textElements++;
      if (isRoot && getAttr(node, "role")) result.hasRole = true;

      for (var i = 0; i < node.attrs.length; i++) {
        var attr = node.attrs[i];
        var isLink = attr.name === "href" || attr.name === "xlink:href";
        if (EVENT_ATTR_RE.test(attr.name)) {
          issue("error", "event-handler",
            "Event handler attribute \"" + attr.name + "\" on <" + tag + "> can run code when the SVG is opened or embedded.");
        }
        if (isLink && SCRIPT_URI_RE.test(attr.value)) {
          issue("error", "dangerous-uri",
            "Link on <" + tag + "> uses a scriptable URL scheme: " + attr.value.slice(0, 40));
        }
        // A data: URI is legitimate for an embedded image or font, but a
        // data: URI carrying SVG can execute script in some viewers.
        if (isLink && DATA_URI_RE.test(attr.value)) {
          var isSvgData = /^data:image\/svg\+xml/i.test(attr.value);
          issue(isSvgData ? "warn" : "info", "data-uri",
            isSvgData
              ? "Embedded SVG data: URI on <" + tag + "> can execute script in some viewers."
              : "Embedded data: URI on <" + tag + "> — verify the payload is trusted.");
        }
        if ((attr.name === "fill" || attr.name === "stroke" || attr.name === "stop-color") && attr.value !== "none") {
          var parsed = parseColor(attr.value);
          if (parsed && parsed.a === 1) {
            var hex = hexOf(parsed);
            result.colors[hex] = (result.colors[hex] || 0) + 1;
          }
        }
      }

      for (var c = 0; c < node.children.length; c++) walk(node.children[c], false);
    }

    walk(root, true);

    var keys = Object.keys(result.colors);
    for (var a = 0; a < keys.length; a++) {
      for (var b = a + 1; b < keys.length; b++) {
        var ratio = contrastRatio(parseColor(keys[a]), parseColor(keys[b]));
        if (ratio < 3) result.contrasts.push({ a: keys[a], b: keys[b], ratio: ratio });
      }
    }

    if (!result.hasTitle) {
      issue("warn", "no-title", "No <title> element — screen readers and hover tooltips have no text alternative.");
    }
    if (!result.hasRole) {
      issue("info", "no-role", "No role=\"img\" on the root — assistive tech cannot tell whether this is a meaningful or decorative image.");
    }
    if (!meta.hasViewBox) {
      issue("warn", "no-viewbox", "No viewBox — the image will not scale cleanly to fit its container.");
    }
    if (!meta.hasDimensions) {
      issue("info", "no-dimensions", "No width/height — the browser cannot reserve layout space before the image loads.");
    }
    if (result.textElements > 0) {
      issue("info", "text-elements", "Contains live <text> — it renders in the viewer's fonts, not the ones the designer chose.");
    }
    if (meta.hasScript) {
      issue("error", "script-tag", "Contains a <script> element — SVG scripts can execute when the file is opened or embedded.");
    }

    return result;
  }

  function hasScriptElement(node) {
    if (node.type !== "element") return false;
    if (tagOf(node) === "script") return true;
    for (var i = 0; i < node.children.length; i++) {
      if (hasScriptElement(node.children[i])) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Id shortening
  // ---------------------------------------------------------------------

  function idName(index) {
    var alphabet = "abcdefghijklmnopqrstuvwxyz";
    var out = "";
    var v = index;
    do {
      out = alphabet.charAt(v % 26) + out;
      v = Math.floor(v / 26) - 1;
    } while (v >= 0);
    return out;
  }

  function shortenUrlRefs(value, map) {
    return String(value).replace(/url\((['"]?)#([A-Za-z_][\w.\-:]*)\1\)/g, function (match, quote, id) {
      return Object.prototype.hasOwnProperty.call(map, id) ? "url(#" + map[id] + ")" : match;
    });
  }

  function rewriteIds(nodes, map, stats) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.type !== "element") continue;
      for (var a = 0; a < node.attrs.length; a++) {
        var attr = node.attrs[a];
        if (attr.name === "id" && Object.prototype.hasOwnProperty.call(map, attr.value)) {
          attr.value = map[attr.value];
          stats.shortenedIds++;
        } else if (attr.name === "href" || attr.name === "xlink:href") {
          if (attr.value.charAt(0) === "#" &&
              Object.prototype.hasOwnProperty.call(map, attr.value.slice(1))) {
            attr.value = "#" + map[attr.value.slice(1)];
          }
        } else if (REF_ATTRS.test(attr.name)) {
          attr.value = shortenUrlRefs(attr.value, map);
        }
      }
      // CSS inside <style> can reference ids with url(#id).
      if (tagOf(node) === "style") {
        for (var t = 0; t < node.children.length; t++) {
          if (node.children[t].type === "text") {
            node.children[t].value = shortenUrlRefs(node.children[t].value, map);
          }
        }
      }
      rewriteIds(node.children, map, stats);
    }
  }

  // ---------------------------------------------------------------------
  // Top-level API
  // ---------------------------------------------------------------------

  function byteLength(text) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
    return unescape(encodeURIComponent(text)).length;
  }

  function optimize(input, overrides) {
    var options = defaultOptions(overrides);
    var source = String(input == null ? "" : input);
    var parsed = parseXML(source);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, input: source };
    }
    if (localName(parsed.root.name) !== "svg") {
      return {
        ok: false,
        input: source,
        error: {
          message: "Root element is <" + parsed.root.name + ">, not <svg> — this is not an SVG document",
          line: 1, column: 1, index: 0
        }
      };
    }

    var stats = {
      removedComments: 0,
      removedMetadata: 0,
      removedEditorData: 0,
      removedEmptyContainers: 0,
      collapsedGroups: 0,
      removedDefaults: 0,
      removedWhitespace: 0,
      optimizedPaths: 0,
      minifiedColors: 0,
      shortenedIds: 0,
      removedDimensions: 0,
      removedProlog: 0,
      removedNamespaces: 0
    };

    var before = {
      bytes: byteLength(source),
      elements: countNodes(parsed.nodes).elements
    };

    if (options.shortenIds) {
      var ids = collectIds(parsed.nodes, []);
      var originalIds = {};
      for (var o = 0; o < ids.length; o++) originalIds[ids[o]] = true;
      var map = {};
      var taken = {};
      var next = 0;
      for (var i = 0; i < ids.length; i++) {
        if (Object.prototype.hasOwnProperty.call(map, ids[i]) || ids[i].length <= 1) continue;
        var candidate = idName(next++);
        // Never collide with an id that is staying in the document.
        while (Object.prototype.hasOwnProperty.call(originalIds, candidate) ||
               Object.prototype.hasOwnProperty.call(taken, candidate)) {
          candidate = idName(next++);
        }
        map[ids[i]] = candidate;
        taken[candidate] = true;
      }
      if (Object.keys(map).length > 0) rewriteIds(parsed.nodes, map, stats);
    }

    var processed = [];
    for (var n = 0; n < parsed.nodes.length; n++) {
      var node = parsed.nodes[n];
      if (node.type === "element") {
        var result = processNode(node, options, stats, node === parsed.root);
        if (result) processed.push(result);
      } else if (node.type === "comment") {
        if (options.removeComments) stats.removedComments++;
        else processed.push(node);
      } else if (node.type === "pi" || node.type === "doctype") {
        // The XML declaration and a DOCTYPE add nothing to an inline asset.
        if (options.removeMetadata) stats.removedProlog++;
        else processed.push(node);
      } else {
        processed.push(node);
      }
    }

    var outputRoot = null;
    for (var p = 0; p < processed.length; p++) {
      if (isElement(processed[p])) { outputRoot = processed[p]; break; }
    }
    if (!outputRoot) { processed.push(parsed.root); outputRoot = parsed.root; }

    if (options.removeDimensions && getAttr(outputRoot, "viewBox")) {
      var dropped = 0;
      if (getAttr(outputRoot, "width")) { removeAttr(outputRoot, "width"); dropped++; }
      if (getAttr(outputRoot, "height")) { removeAttr(outputRoot, "height"); dropped++; }
      stats.removedDimensions = dropped;
    }

    if (options.removeEditorData) pruneUnusedNamespaces(outputRoot, stats);

    var meta = {
      hasViewBox: !!getAttr(outputRoot, "viewBox"),
      hasDimensions: !!(getAttr(outputRoot, "width") && getAttr(outputRoot, "height")),
      hasScript: hasScriptElement(outputRoot)
    };

    var serialized = serializeNodes(processed, {
      pretty: false,
      sortAttributes: options.sortAttributes
    });
    var afterBytes = byteLength(serialized);
    var afterCounts = countNodes(processed);

    return {
      ok: true,
      input: source,
      output: serialized,
      prettyOutput: prettyPrint(serialized),
      stats: stats,
      options: options,
      before: before,
      after: { bytes: afterBytes, elements: afterCounts.elements },
      savedBytes: Math.max(0, before.bytes - afterBytes),
      savedPercent: before.bytes > 0 ? (1 - afterBytes / before.bytes) : 0,
      audit: audit(outputRoot, meta),
      truncated: false
    };
  }

  // ---------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------

  function toReport(result) {
    if (!result.ok) {
      return "# SVG Optimizer report\n\nCould not parse the SVG: " + result.error.message +
        " (line " + result.error.line + ", column " + result.error.column + ").\n";
    }
    var lines = [];
    lines.push("# SVG Optimizer report");
    lines.push("");
    lines.push("## Size");
    lines.push("");
    lines.push("- Before: " + result.before.bytes + " bytes (" + result.before.elements + " elements)");
    lines.push("- After: " + result.after.bytes + " bytes (" + result.after.elements + " elements)");
    lines.push("- Saved: " + result.savedBytes + " bytes (" + (result.savedPercent * 100).toFixed(1) + "%)");
    lines.push("");
    lines.push("## Changes");
    lines.push("");
    var stats = result.stats;
    var rows = [
      ["Comments removed", stats.removedComments],
      ["Metadata elements removed", stats.removedMetadata],
      ["Editor data removed", stats.removedEditorData],
      ["Empty containers removed", stats.removedEmptyContainers],
      ["Groups collapsed", stats.collapsedGroups],
      ["Default attributes removed", stats.removedDefaults],
      ["Whitespace nodes removed", stats.removedWhitespace],
      ["Path data optimized", stats.optimizedPaths],
      ["Colors minified", stats.minifiedColors],
      ["Ids shortened", stats.shortenedIds],
      ["Width/height removed", stats.removedDimensions],
      ["Namespace declarations removed", stats.removedNamespaces],
      ["XML declaration/DOCTYPE removed", stats.removedProlog]
    ];
    var any = false;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][1] > 0) { lines.push("- " + rows[i][0] + ": " + rows[i][1]); any = true; }
    }
    if (!any) lines.push("- No structural changes were needed.");
    lines.push("");
    lines.push("## Review");
    lines.push("");
    if (result.audit.issues.length === 0) {
      lines.push("- No issues found.");
    } else {
      for (var j = 0; j < result.audit.issues.length; j++) {
        var item = result.audit.issues[j];
        lines.push("- [" + item.level.toUpperCase() + "] " + item.message);
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  return {
    parseXML: parseXML,
    decodeEntities: decodeEntities,
    escapeText: escapeText,
    escapeAttr: escapeAttr,
    localName: localName,
    namespaceOf: namespaceOf,
    getAttr: getAttr,
    removeAttr: removeAttr,
    countNodes: countNodes,
    formatNumber: formatNumber,
    roundAttributeValue: roundAttributeValue,
    optimizePathData: optimizePathData,
    parseColor: parseColor,
    hexOf: hexOf,
    shortestHex: shortestHex,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    defaultOptions: defaultOptions,
    processNode: processNode,
    serializeNodes: serializeNodes,
    prettyPrint: prettyPrint,
    minify: minify,
    audit: audit,
    optimize: optimize,
    toReport: toReport,
    byteLength: byteLength,
    NAMED_COLORS: NAMED_COLORS,
    EDITOR_NS: EDITOR_NS
  };
});






