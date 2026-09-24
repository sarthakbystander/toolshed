/* Toolshed — Color Converter
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.colorConverter and in Node via require() for tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.colorConverter = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  /** Convert a CSS color string to { r, g, b } in [0,255]. Throws on invalid. */
  function toRGB(input) {
    if (typeof input !== "string") {
      throw new Error("Color must be a string.");
    }
    var str = input.trim();
    if (str === "") {
      throw new Error("Color is empty.");
    }

    // HEX
    if (/^#?[0-9a-fA-F]{3}$/.test(str)) {
      var s = str.replace("#", "");
      return {
        r: parseInt(s[0] + s[0], 16),
        g: parseInt(s[1] + s[1], 16),
        b: parseInt(s[2] + s[2], 16)
      };
    }
    if (/^#?[0-9a-fA-F]{6}$/.test(str)) {
      var t = str.replace("#", "");
      return {
        r: parseInt(t.slice(0, 2), 16),
        g: parseInt(t.slice(2, 4), 16),
        b: parseInt(t.slice(4, 6), 16)
      };
    }

    // rgb() / rgba() — numbers may be floats or negative (clamped later)
    var rgbMatch = /^rgba?\(\s*(-?[0-9.]+)[,\s]+(-?[0-9.]+)[,\s]+(-?[0-9.]+)\s*(?:[,\/]\s*([0-9.]+)\s*)?\)$/i.exec(str);
    if (rgbMatch) {
      var r = Number(rgbMatch[1]);
      var g = Number(rgbMatch[2]);
      var b = Number(rgbMatch[3]);
      if ([r, g, b].some(function (n) { return isNaN(n); })) {
        throw new Error("Invalid RGB value: " + str);
      }
      return {
        r: clamp(Math.round(r), 0, 255),
        g: clamp(Math.round(g), 0, 255),
        b: clamp(Math.round(b), 0, 255)
      };
    }

    // hsl() / hsla() — saturation and lightness must be percentages (CSS spec)
    var hslMatch = /^hsla?\(\s*(-?[0-9.]+)[,\s]+(-?[0-9.]+)%[,\s]+(-?[0-9.]+)%\s*(?:[,\/]\s*([0-9.]+)\s*)?\)$/i.exec(str);
    if (hslMatch) {
      var h = Number(hslMatch[1]);
      var s = Number(hslMatch[2]);
      var l = Number(hslMatch[3]);
      if ([h, s, l].some(function (n) { return isNaN(n); })) {
        throw new Error("Invalid HSL value: " + str);
      }
      return hslToRGB(h, s, l);
    }

    // Named compatibility for a small common set.
    var named = { red: [255, 0, 0], green: [0, 128, 0], lime: [0, 255, 0], blue: [0, 0, 255], black: [0, 0, 0], white: [255, 255, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], orange: [255, 165, 0], purple: [128, 0, 128], pink: [255, 192, 203], brown: [165, 42, 42], transparent: [0, 0, 0] };
    if (named[str.toLowerCase()]) {
      var nx = named[str.toLowerCase()];
      return { r: nx[0], g: nx[1], b: nx[2] };
    }

    throw new Error("Unrecognized color: " + str);
  }

  /** @returns {string} #rrggbb lowercase */
  function toHEX(input) {
    var rgb = toRGB(input);
    function h(n) {
      return ("0" + n.toString(16)).slice(-2);
    }
    return "#" + h(rgb.r) + h(rgb.g) + h(rgb.b);
  }

  /** @returns {string} rgb(r, g, b) */
  function toRGBString(input) {
    var rgb = toRGB(input);
    return "rgb(" + rgb.r + ", " + rgb.g + ", " + rgb.b + ")";
  }

  /** @returns {string} hsl(h, s%, l%) with h normalized to [0,360) */
  function toHSL(input) {
    var rgb = toRGB(input);
    var out = rgbToHSL(rgb.r, rgb.g, rgb.b);
    return "hsl(" + round(out.h) + ", " + round(out.s) + "%, " + round(out.l) + "%)";
  }

  /** @returns {{r:number,g:number,b:number}} */
  function hslToRGB(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 100);
    l = clamp(l, 0, 100);
    var c = (1 - Math.abs(2 * l / 100 - 1)) * (s / 100);
    var hp = h / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r1 = 0, g1 = 0, b1 = 0;
    if (hp >= 0 && hp < 1) { r1 = c; g1 = x; }
    else if (hp < 2) { r1 = x; g1 = c; }
    else if (hp < 3) { g1 = c; b1 = x; }
    else if (hp < 4) { g1 = x; b1 = c; }
    else if (hp < 5) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    var m = l / 100 - c / 2;
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255)
    };
  }

  /** @returns {{h:number,s:number,l:number}} h in [0,360), s,l in [0,100] */
  function rgbToHSL(r, g, b) {
    r = clamp(r, 0, 255) / 255;
    g = clamp(g, 0, 255) / 255;
    b = clamp(b, 0, 255) / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) {
        h = (g - b) / d + (g < b ? 6 : 0);
      } else if (max === g) {
        h = (b - r) / d + 2;
      } else {
        h = (r - g) / d + 4;
      }
      h *= 60;
    }
    return { h: h, s: s * 100, l: l * 100 };
  }

  /** Returns all three representations of the input as strings. Throws on invalid. */
  function convert(input) {
    var hex = toHEX(input);
    var rgb = toRGBString(input);
    var hsl = toHSL(input);
    return { hex: hex, rgb: rgb, hsl: hsl };
  }

  return {
    toRGB: toRGB,
    toHEX: toHEX,
    toRGBString: toRGBString,
    toHSL: toHSL,
    hslToRGB: hslToRGB,
    rgbToHSL: rgbToHSL,
    convert: convert,
    HEX_RE: HEX_RE
  };
});