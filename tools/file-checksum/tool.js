/* Toolshed - File Checksum
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.fileChecksum and in Node via require() for tests.
 *
 * SHA-1 / SHA-256 / SHA-384 come from Web Crypto; MD5 is implemented
 * in plain JavaScript (RFC 1321) so it works in every browser, even
 * those that do not expose MD5 through SubtleCrypto.
 *
 * All inputs are read fully into a Uint8Array before hashing, consistent
 * with the other Toolshed tools.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.fileChecksum = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SUPPORTED = [
    { id: "SHA-1", name: "SHA-1" },
    { id: "SHA-256", name: "SHA-256" },
    { id: "SHA-384", name: "SHA-384" },
    { id: "MD5", name: "MD5" },
  ];

  var MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  // K[i] = floor(abs(sin(i + 1)) * 2^32), the RFC 1321 constants.
  var MD5_K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];

  function md5(bytes) {
    var n = bytes.length;
    var bitLenLow = (n * 8) % 0x100000000;
    var bitLenHigh = Math.floor(n / 0x20000000);
    var paddedLen = (Math.floor((n + 8) / 64) + 1) * 64;
    var padded = new Uint8Array(paddedLen);
    padded.set(bytes, 0);
    padded[n] = 0x80;

    var dv = new DataView(padded.buffer);
    dv.setUint32(paddedLen - 8, bitLenLow, true);
    dv.setUint32(paddedLen - 4, bitLenHigh, true);

    var a = 0x67452301;
    var b = 0xefcdab89;
    var c = 0x98badcfe;
    var d = 0x10325476;
    var M = new Uint32Array(16);

    for (var offset = 0; offset < paddedLen; offset += 64) {
      for (var i = 0; i < 16; i++) {
        M[i] = dv.getUint32(offset + i * 4, true);
      }

      var A = a, B = b, C = c, D = d;

      for (i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) % 16;
        }
        F = (F + A + MD5_K[i] + M[g]) | 0;
        A = D;
        D = C;
        C = B;
        B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) | 0;
      }

      a = (a + A) | 0;
      b = (b + B) | 0;
      c = (c + C) | 0;
      d = (d + D) | 0;
    }

    var out = new Uint8Array(16);
    var outView = new DataView(out.buffer);
    outView.setUint32(0, a, true);
    outView.setUint32(4, b, true);
    outView.setUint32(8, c, true);
    outView.setUint32(12, d, true);
    return out;
  }

  function normalizeAlgorithm(id) {
    var lower = String(id == null ? "" : id).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (lower === "sha1") return "SHA-1";
    if (lower === "sha256") return "SHA-256";
    if (lower === "sha384") return "SHA-384";
    if (lower === "md5") return "MD5";
    return null;
  }

  function formatBytes(n) {
    if (!isFinite(n) || n < 0) return "0 B";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MiB";
    return (n / (1024 * 1024 * 1024)).toFixed(1) + " GiB";
  }

  function validateInput(input) {
    if (input == null) {
      return { ok: false, message: "No file selected." };
    }
    if (
      typeof input.arrayBuffer === "function" &&
      typeof input.size === "number"
    ) {
      return { ok: true };
    }
    if (
      typeof input === "string" ||
      input instanceof Uint8Array ||
      input instanceof ArrayBuffer
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      message: "Unsupported input. Choose a file or drop one onto the dashed area.",
    };
  }

  async function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof input === "string") return new TextEncoder().encode(input);
    if (typeof input.arrayBuffer === "function" && typeof input.size === "number") {
      return new Uint8Array(await input.arrayBuffer());
    }
    throw new Error("Unsupported input for checksum computation.");
  }

  function hex(bytesArray) {
    var out = "";
    for (var i = 0; i < bytesArray.length; i++) {
      var h = bytesArray[i].toString(16);
      if (h.length < 2) h = "0" + h;
      out += h;
    }
    return out;
  }

  /**
   * Compute checksums for an input.
   *
   * input   - File, Blob, string, Uint8Array or ArrayBuffer.
   * options - { algorithms: ["SHA-256", ...] } (defaults to ["SHA-256"]).
   *
   * Returns a Promise of { ok: true, digests, bytes } or { ok: false, message }.
   */
  async function compute(input, options) {
    if (typeof crypto === "undefined" || !crypto.subtle || !crypto.subtle.digest) {
      return { ok: false, message: "Web Crypto is unavailable in this browser." };
    }

    var checked = validateInput(input);
    if (!checked.ok) {
      return { ok: false, message: checked.message };
    }

    var opts = options || {};
    var requested = opts.algorithms || ["SHA-256"];
    if (!Array.isArray(requested) || requested.length === 0) {
      return { ok: false, message: "Choose at least one algorithm." };
    }

    var algorithms = [];
    for (var i = 0; i < requested.length; i++) {
      var norm = normalizeAlgorithm(requested[i]);
      if (!norm) {
        return { ok: false, message: "Unknown algorithm: " + String(requested[i]) };
      }
      if (algorithms.indexOf(norm) === -1) algorithms.push(norm);
    }

    var data;
    try {
      data = await toBytes(input);
    } catch (err) {
      return {
        ok: false,
        message: "Could not read input: " + (err && err.message ? err.message : String(err)),
      };
    }

    var digests = Object.create(null);
    for (var j = 0; j < algorithms.length; j++) {
      var algo = algorithms[j];
      if (algo === "MD5") {
        digests[algo] = hex(md5(data));
      } else {
        try {
          var raw = await crypto.subtle.digest(algo, data);
          digests[algo] = hex(new Uint8Array(raw));
        } catch (err) {
          return {
            ok: false,
            message:
              algo + " is not supported by this browser's Web Crypto (" +
              (err && err.message ? err.message : String(err)) + ").",
          };
        }
      }
    }
    return { ok: true, digests: digests, bytes: data.byteLength };
  }

  return {
    SUPPORTED: SUPPORTED,
    md5: md5,
    normalizeAlgorithm: normalizeAlgorithm,
    formatBytes: formatBytes,
    validateInput: validateInput,
    compute: compute,
  };
});