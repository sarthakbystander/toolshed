/* Toolshed - Image Lab
 * Core logic,dependency-free. Loads in browser as
 * window.Toolshed.imageLab and in Node via require() for tests.
 *
 * All pixel functions operate on Uint8ClampedArray RGBA buffers,
 * row-major,and never mutate the source. No external dependencies.
 */
(function (root,factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.imageLab = factory();
  }
})(typeof self !== "undefined" ? self : this,function () {
  "use strict";

  function clamp255(v) {
    if (v < 0) return 0;
    if (v > 255) return 255;
    return v;
  }

  function toNumber(value,fallback,min,max) {
    if (typeof value !== "number") return fallback;
    if (!isFinite(value)) return fallback;
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function normalizeAdjustments(adj) {
    adj = adj || {};
    var out = {};
    out.brightness = toNumber(adj.brightness,0,-100,100);
    out.contrast = toNumber(adj.contrast,0,-100,100);
    out.saturation = toNumber(adj.saturation,1,0,2);
    out.blur = Math.round(toNumber(adj.blur,0,0,50));
    out.sharpen = toNumber(adj.sharpen,0,0,2);
    return out;
  }

  function copyPixels(src,dst) {
    if (!dst) dst = new Uint8ClampedArray(src.length);
    dst.set(src);
    return dst;
  }

  function grayscale(src,width,height,out) {
    out = copyPixels(src,out);
    for (var i = 0; i < src.length; i +=  4) {
      var lum =  0.299*src[i] +  0.587*src[i+1] +  0.114*src[i+2];
      out[i] = clamp255(lum);
      out[i+1] = clamp255(lum);
      out[i+2] = clamp255(lum);
    }
    return out;

  }

  function sepia(src,width,height,out) {
    out = copyPixels(src,out);
    for (var i = 0; i < src.length; i +=  4) {
      var r = src[i]; var g = src[i+1]; var b = src[i+2];
      out[i] = clamp255((0.393*r) + (0.769*g) + (0.189*b));
      out[i+1] = clamp255((0.349*r) + (0.686*g) + (0.168*b));
      out[i+2] = clamp255((0.272*r) + (0.534*g) + (0.131*b));
    }
    return out;

  }

  function saturate(src,width,height,amount,out) {
    out = copyPixels(src,out);
    var a = toNumber(amount,1,0,2);
    for (var i = 0; i < src.length; i +=  4) {
      var r = src[i]; var g = src[i+1]; var b = src[i+2];
      var lum =  0.299*r +  0.587*g +  0.114*b;
      out[i] = clamp255(lum + (r-lum)*a);
      out[i+1] = clamp255(lum + (g-lum)*a);
      out[i+2] = clamp255(lum + (b-lum)*a);
    }
    return out;

  }

  function contrastFactor(amount) {
    var c = amount *  2.55;
    return (259 * (c+255)) / (255 * (259-c));
  }

  function applyTone(src,dst,adj) {
    var cf = contrastFactor(adj.contrast);
    var br = adj.brightness;
    var sat = adj.saturation;
    for (var i = 0; i < src.length; i +=  4) {
      var r = src[i] + br;
      var g = src[i+1] + br;
      var b = src[i+2] + br;
      r =  128 + (r-128)*cf;
      g =  128 + (g-128)*cf;
      b =  128 + (b-128)*cf;
      var lum =  0.299*r +  0.587*g +  0.114*b;
      dst[i] = clamp255(lum + (r-lum)*sat);
      dst[i+1] = clamp255(lum + (g-lum)*sat);
      dst[i+2] = clamp255(lum + (b-lum)*sat);
    }
  }

  // Separable box blur. Both passes are O(width*height) regardless of
  // radius: each row/column is reduced with a prefix-sum table, so the
  // sliding window average is O(1) per pixel instead of O(radius).
  // The window is clipped at the borders (a smaller sample at the edges)
  // and divided by the real sample count, so no edge darkening occurs.
  // Float64 prefix sums are exact for 8-bit channel values, so the result
  // is identical to summing the window directly.
  function boxBlurH(src,width,height,radius,out) {
    if (!out) out = new Uint8ClampedArray(src.length);
    var r = Math.max(1,radius);
    var pref = new Float64Array(width + 1);
    for (var y = 0; y < height; y++) {
      var row = y * width;
      for (var ch = 0; ch < 4; ch++) {
        pref[0] = 0;
        for (var x = 0; x < width; x++) {
          pref[x+1] = pref[x] + src[((row+x)*4)+ch];
        }
        for (var x2 = 0; x2 < width; x2++) {
          var lo = x2 - r; if (lo < 0) lo = 0;
          var hi = x2 + r; if (hi > width - 1) hi = width - 1;
          out[((row+x2)*4)+ch] = (pref[hi+1] - pref[lo]) / (hi - lo + 1);
        }
      }
    }
    return out;

  }

  function boxBlurV(src,width,height,radius,out) {
    if (!out) out = new Uint8ClampedArray(src.length);
    var r = Math.max(1,radius);
    var pref = new Float64Array(height + 1);
    for (var x = 0; x < width; x++) {
      for (var ch = 0; ch < 4; ch++) {
        pref[0] = 0;
        for (var y = 0; y < height; y++) {
          pref[y+1] = pref[y] + src[((y*width)+x)*4+ch];
        }
        for (var y2 = 0; y2 < height; y2++) {
          var lo = y2 - r; if (lo < 0) lo = 0;
          var hi = y2 + r; if (hi > height - 1) hi = height - 1;
          out[((y2*width)+x)*4+ch] = (pref[hi+1] - pref[lo]) / (hi - lo + 1);
        }
      }
    }
    return out;

  }

  function blur(src,width,height,radius,out) {
    if (!out) out = new Uint8ClampedArray(src.length);
    var r = Math.round(toNumber(radius,0,0,50));
    if (r < 1) return copyPixels(src,out);
    var tmp = boxBlurH(src,width,height,r,null);
    return boxBlurV(tmp,width,height,r,out);
  }

  function sharpen(src,width,height,amount,out) {
    var a = toNumber(amount,0,0,2);
    if (a <= 0) return copyPixels(src,out);
    // Preserve alpha (and the source untouched) when allocating the
    // destination, since only RGB channels are rewritten below.
    if (!out) out = copyPixels(src);
    var tmp = new Uint8ClampedArray(src.length);
    tmp.set(src);
    var i =  0;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var yy0 = y > 0 ? y - 1 : 0;
        var yy1 = y < height - 1 ? y + 1 : height - 1;
        var xx0 = x > 0 ? x - 1 : 0;
        var xx1 = x < width - 1 ? x + 1 : width - 1;
        var oN = ((yy0*width)+x)*4;
        var oS = ((yy1*width)+x)*4;
        var oW = ((y*width)+xx0)*4;
        var oE = ((y*width)+xx1)*4;
        for (var ch = 0; ch < 3; ch++) {
          var lap = tmp[oN+ch] + tmp[oS+ch] + tmp[oW+ch] + tmp[oE+ch] - (4*tmp[i+ch]);
          out[i+ch] = clamp255(tmp[i+ch] - (lap*a));
        }
        i +=  4;
      }
    }
    return out;

  }

  function applyAdjustments(src,width,height,adj,out) {
    if (!src) return null;
    if (!width) return null;
    if (!height) return null;
    var a = normalizeAdjustments(adj);
    if (!out) out = new Uint8ClampedArray(src.length);
    if (a.blur >  0) {
      out = blur(src,width,height,a.blur,out);
    } else {
      out = copyPixels(src,out);
    }
    if ((a.brightness !==  0) || (a.contrast !==  0) || (a.saturation !==  1)) {
      applyTone(out,out,a);
    }
    if (a.sharpen >  0) {
      out = sharpen(out,width,height,a.sharpen,out);
    }
    return out;

  }

  function toDataURL(data,width,height,mime,quality) {
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");
    var img = ctx.createImageData(width,height);
    img.data.set(data);
    ctx.putImageData(img,0,0);
    return canvas.toDataURL(mime,quality);
  }

  return {
    normalizeAdjustments: normalizeAdjustments,
    blur: blur,
    saturate: saturate,
    sharpen: sharpen,
    applyAdjustments: applyAdjustments,
    toDataURL:toDataURL,
    copyPixels:copyPixels,
    grayscale:grayscale,
    sepia:sepia
  };
});
