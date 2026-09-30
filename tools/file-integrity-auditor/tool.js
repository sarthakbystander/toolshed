/* Toolshed — File Integrity Auditor
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.fileIntegrityAuditor and in Node via require() for tests.
 *
 * The module computes MD5, SHA-1, SHA-256, SHA-384 and SHA-512 digests with
 * the Web Crypto API (SHA family) and a self-contained MD5 implementation,
 * parses common checksum manifests (GNU coreutils, BSD, sha*sum --tag,
 * RFC 9530 HTTP digests, plain "digest  filename" lists and CSV), and audits a
 * set of files against a manifest.
 *
 * Everything is computed from the user's input in memory. The module never
 * touches the network, never uses eval/dynamic code execution, and never
 * writes to storage.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.fileIntegrityAuditor = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function toBytes(input) {
    if (input == null) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    return new Uint8Array(0);
  }

  function bytesToHex(bytes) {
    var hex = "";
    for (var i = 0; i < bytes.length; i++) {
      hex += (bytes[i] >>> 4).toString(16) + (bytes[i] & 15).toString(16);
    }
    return hex;
  }

  function bytesToBase64(bytes) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var out = "";
    var i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + chars[(n >> 6) & 63] + chars[n & 63];
    }
    if (i < bytes.length) {
      var rem = bytes.length - i;
      var m = (bytes[i] << 16) | (rem === 2 ? bytes[i + 1] << 8 : 0);
      out += chars[(m >> 18) & 63] + chars[(m >> 12) & 63] + (rem === 2 ? chars[(m >> 6) & 63] : "=") + "=";
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // MD5 (self-contained, no dependencies)
  // ---------------------------------------------------------------------
  //
  // MD5 is not a cryptographic hash — it is included only because it is still
  // ubiquitous in legacy manifests (md5sum, release checksums, download
  // listings). It is computed locally and never used for authentication.

  var MD5_SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

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
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ];

  function rotl32(x, c) {
    return ((x << c) | (x >>> (32 - c))) >>> 0;
  }

  function md5(input) {
    var h = md5Create();
    h.update(toBytes(input));
    return h.digest();
  }

  /**
   * Incremental MD5 so large files can be hashed in chunks without holding
   * the whole buffer twice in memory.
   */
  function md5Create() {
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    var block = new Uint8Array(64);
    var blockLen = 0;
    var totalBytes = 0;
    var view = new DataView(block.buffer);
    var M = new Array(16);

    function processBlock() {
      for (var j = 0; j < 16; j++) M[j] = view.getUint32(j * 4, true);
      var A = a0, B = b0, C = c0, D = d0;
      for (var i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + MD5_K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rotl32(F, MD5_SHIFTS[i])) >>> 0;
      }
      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }

    function update(bytes) {
      var i = 0;
      totalBytes += bytes.length;
      if (blockLen > 0) {
        while (blockLen < 64 && i < bytes.length) block[blockLen++] = bytes[i++];
        if (blockLen === 64) { processBlock(); blockLen = 0; }
      }
      while (i + 64 <= bytes.length) {
        for (var j = 0; j < 16; j++) M[j] = (bytes[i + j * 4]) | (bytes[i + j * 4 + 1] << 8) |
          (bytes[i + j * 4 + 2] << 16) | (bytes[i + j * 4 + 3] << 24);
        var A = a0, B = b0, C = c0, D = d0;
        for (var k = 0; k < 64; k++) {
          var F, g;
          if (k < 16) { F = (B & C) | (~B & D); g = k; }
          else if (k < 32) { F = (D & B) | (~D & C); g = (5 * k + 1) % 16; }
          else if (k < 48) { F = B ^ C ^ D; g = (3 * k + 5) % 16; }
          else { F = C ^ (B | ~D); g = (7 * k) % 16; }
          F = (F + A + MD5_K[k] + M[g]) >>> 0;
          A = D; D = C; C = B;
          B = (B + rotl32(F, MD5_SHIFTS[k])) >>> 0;
        }
        a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
        c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
        i += 64;
      }
      while (i < bytes.length) block[blockLen++] = bytes[i++];
    }

    function finish() {
      var bitLenLo = (totalBytes << 3) >>> 0;
      var bitLenHi = Math.floor(totalBytes / 536870912) >>> 0;
      block[blockLen++] = 0x80;
      if (blockLen > 56) {
        while (blockLen < 64) block[blockLen++] = 0;
        processBlock();
        blockLen = 0;
      }
      while (blockLen < 56) block[blockLen++] = 0;
      block[56] = bitLenLo & 0xff;
      block[57] = (bitLenLo >>> 8) & 0xff;
      block[58] = (bitLenLo >>> 16) & 0xff;
      block[59] = (bitLenLo >>> 24) & 0xff;
      block[60] = bitLenHi & 0xff;
      block[61] = (bitLenHi >>> 8) & 0xff;
      block[62] = (bitLenHi >>> 16) & 0xff;
      block[63] = (bitLenHi >>> 24) & 0xff;
      processBlock();

      var digest = new Uint8Array(16);
      var out = new DataView(digest.buffer);
      out.setUint32(0, a0, true);
      out.setUint32(4, b0, true);
      out.setUint32(8, c0, true);
      out.setUint32(12, d0, true);
      return digest;
    }

    return { update: update, digest: finish };
  }

  // ---------------------------------------------------------------------
  // Digest algorithms
  // ---------------------------------------------------------------------

  // name -> { bits, bytes, crypto, label, insecure }
  var ALGORITHMS = {
    md5: { name: "md5", bits: 128, bytes: 16, crypto: null, label: "MD5", insecure: true },
    "sha-1": { name: "sha-1", bits: 160, bytes: 20, crypto: "SHA-1", label: "SHA-1", insecure: true },
    "sha-256": { name: "sha-256", bits: 256, bytes: 32, crypto: "SHA-256", label: "SHA-256", insecure: false },
    "sha-384": { name: "sha-384", bits: 384, bytes: 48, crypto: "SHA-384", label: "SHA-384", insecure: false },
    "sha-512": { name: "sha-512", bits: 512, bytes: 64, crypto: "SHA-512", label: "SHA-512", insecure: false }
  };

  var CRYPTO_REQUIRED = new Set(["sha-1", "sha-256", "sha-384", "sha-512"]);

  // Maps the many spellings found in manifests to a canonical algorithm name.
  var ALIASES = {
    md5: "md5",
    "md-5": "md5",
    sha1: "sha-1",
    "sha-1": "sha-1",
    sha: "sha-1",
    "sha-1-1": "sha-1",
    sha256: "sha-256",
    "sha-256": "sha-256",
    "sha-256-256": "sha-256",
    sha384: "sha-384",
    "sha-384": "sha-384",
    sha512: "sha-512",
    "sha-512": "sha-512",
    sha2: "sha-256"
  };

  function canonicalAlgorithm(name) {
    if (name == null) return null;
    var key = String(name).toLowerCase().replace(/[\s_]/g, "").replace(/-+/g, "-");
    key = key.replace(/^sha-(\d+)$/, "sha-$1");
    if (ALIASES[key]) return ALIASES[key];
    var plain = key.replace(/-/g, "");
    if (ALIASES[plain]) return ALIASES[plain];
    return null;
  }

  function algorithmInfo(name) {
    var canonical = canonicalAlgorithm(name);
    return canonical ? ALGORITHMS[canonical] : null;
  }

  /**
   * Compute a digest. MD5 is computed in pure JavaScript; the SHA family uses
   * the Web Crypto API when available, falling back to pure JavaScript so the
   * module also works under Node's test runner and in older browsers.
   * @returns {Promise<{algorithm:string, bytes:Uint8Array, hex:string, base64:string}>}
   */
  function digest(algorithm, data) {
    var info = algorithmInfo(algorithm);
    if (!info) return Promise.reject(new Error("unsupported algorithm: " + algorithm));
    var bytes = toBytes(data);

    if (info.crypto && typeof globalThis !== "undefined" &&
        globalThis.crypto && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === "function") {
      // subtle.digest requires an ArrayBuffer whose byte length is exact.
      // Copy the view's own bytes rather than relying on slice(), because
      // Buffer.prototype.slice() returns a view over the whole pool.
      var view;
      if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
        view = bytes.buffer;
      } else {
        var exact = new Uint8Array(bytes.byteLength);
        exact.set(bytes);
        view = exact.buffer;
      }
      return globalThis.crypto.subtle.digest(info.crypto, view).then(function (buffer) {
        var out = new Uint8Array(buffer);
        return { algorithm: info.name, bytes: out, hex: bytesToHex(out), base64: bytesToBase64(out) };
      });
    }
    var result = info.name === "md5" ? md5(bytes) : shaFallback(info.name, bytes);
    return Promise.resolve({ algorithm: info.name, bytes: result, hex: bytesToHex(result), base64: bytesToBase64(result) });
  }

  /**
   * Pure-JavaScript SHA-1 / SHA-256 / SHA-384 / SHA-512, used only when the
   * Web Crypto API is unavailable. Works on the whole buffer at once.
   */
  function shaFallback(name, bytes) {
    var K, H, blockSize, outWords, lenBits;
    if (name === "sha-1") {
      K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];
      H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
      blockSize = 64;
      outWords = 5;
      lenBits = bytes.length * 8;
      var padded1 = padMessage(bytes, blockSize, lenBits, false);
      var view1 = new DataView(padded1.buffer);
      var w1 = new Array(80);
      for (var off1 = 0; off1 < padded1.length; off1 += 64) {
        for (var i = 0; i < 16; i++) w1[i] = view1.getUint32(off1 + i * 4, false);
        for (i = 16; i < 80; i++) w1[i] = rotl32(w1[i - 3] ^ w1[i - 8] ^ w1[i - 14] ^ w1[i - 16], 1);
        var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4];
        for (i = 0; i < 80; i++) {
          var f, k;
          if (i < 20) { f = (b & c) | (~b & d); k = K[0]; }
          else if (i < 40) { f = b ^ c ^ d; k = K[1]; }
          else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = K[2]; }
          else { f = b ^ c ^ d; k = K[3]; }
          var t = (rotl32(a, 5) + f + e + k + w1[i]) >>> 0;
          e = d; d = c; c = rotl32(b, 30); b = a; a = t;
        }
        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0;
        H[3] = (H[3] + d) >>> 0; H[4] = (H[4] + e) >>> 0;
      }
      var out1 = new Uint8Array(20);
      var dv1 = new DataView(out1.buffer);
      for (i = 0; i < outWords; i++) dv1.setUint32(i * 4, H[i], false);
      return out1;
    }

    if (name === "sha-256") {
      K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
      ];
      H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
      blockSize = 64;
      outWords = 8;
      lenBits = bytes.length * 8;
      var padded2 = padMessage(bytes, blockSize, lenBits, false);
      var view2 = new DataView(padded2.buffer);
      var w2 = new Array(64);
      for (var off2 = 0; off2 < padded2.length; off2 += 64) {
        for (i = 0; i < 16; i++) w2[i] = view2.getUint32(off2 + i * 4, false);
        for (i = 16; i < 64; i++) {
          var s0 = (rotr32(w2[i - 15], 7) ^ rotr32(w2[i - 15], 18) ^ (w2[i - 15] >>> 3)) >>> 0;
          var s1 = (rotr32(w2[i - 2], 17) ^ rotr32(w2[i - 2], 19) ^ (w2[i - 2] >>> 10)) >>> 0;
          w2[i] = (w2[i - 16] + s0 + w2[i - 7] + s1) >>> 0;
        }
        a = H[0]; b = H[1]; c = H[2]; d = H[3];
        var e2 = H[4], f2 = H[5], g2 = H[6], h2 = H[7];
        for (i = 0; i < 64; i++) {
          var S1 = (rotr32(e2, 6) ^ rotr32(e2, 11) ^ rotr32(e2, 25)) >>> 0;
          var ch = ((e2 & f2) ^ (~e2 & g2)) >>> 0;
          var temp1 = (h2 + S1 + ch + K[i] + w2[i]) >>> 0;
          var S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
          var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
          var temp2 = (S0 + maj) >>> 0;
          h2 = g2; g2 = f2; f2 = e2; e2 = (d + temp1) >>> 0;
          d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e2) >>> 0; H[5] = (H[5] + f2) >>> 0; H[6] = (H[6] + g2) >>> 0; H[7] = (H[7] + h2) >>> 0;
      }
      var out2 = new Uint8Array(32);
      var dv2 = new DataView(out2.buffer);
      for (i = 0; i < outWords; i++) dv2.setUint32(i * 4, H[i], false);
      return out2;
    }

    // SHA-384 / SHA-512 — 64-bit words represented as hi/lo 32-bit pairs.
    var is384 = name === "sha-384";
    K = SHA512_K;
    var H512 = is384
      ? [[0xcbbb9d5d, 0xc1059ed8], [0x629a292a, 0x367cd507], [0x9159015a, 0x3070dd17], [0x152fecd8, 0xf70e5939],
         [0x67332667, 0xffc00b31], [0x8eb44a87, 0x68581511], [0xdb0c2e0d, 0x64f98fa7], [0x47b5481d, 0xbefa4fa4]]
      : [[0x6a09e667, 0xf3bcc908], [0xbb67ae85, 0x84caa73b], [0x3c6ef372, 0xfe94f82b], [0xa54ff53a, 0x5f1d36f1],
         [0x510e527f, 0xade682d1], [0x9b05688c, 0x2b3e6c1f], [0x1f83d9ab, 0xfb41bd6b], [0x5be0cd19, 0x137e2179]];
    blockSize = 128;
    var padded = padMessage(bytes, blockSize, bytes.length * 8, true);
    var view = new DataView(padded.buffer);
    var w = [];
    for (var off = 0; off < padded.length; off += 128) {
      for (i = 0; i < 16; i++) {
        w[i] = [view.getUint32(off + i * 8, false), view.getUint32(off + i * 8 + 4, false)];
      }
      for (i = 16; i < 80; i++) {
        var w15 = w[i - 15], w2b = w[i - 2];
        var gs0 = xor64(rotr64(w15, 1), rotr64(w15, 8), shr64(w15, 7));
        var gs1 = xor64(rotr64(w2b, 19), rotr64(w2b, 61), shr64(w2b, 6));
        w[i] = add64(add64(w[i - 16], gs0), add64(w[i - 7], gs1));
      }
      var ah = H512[0][0], al = H512[0][1], bh = H512[1][0], bl = H512[1][1];
      var ch2 = H512[2][0], cl = H512[2][1], dh = H512[3][0], dl = H512[3][1];
      var eh = H512[4][0], el = H512[4][1], fh = H512[5][0], fl = H512[5][1];
      var gh = H512[6][0], gl = H512[6][1], hh = H512[7][0], hl = H512[7][1];
      for (i = 0; i < 80; i++) {
        var S1h_lo = xor64(rotr64([eh, el], 14), rotr64([eh, el], 18), rotr64([eh, el], 41));
        var chh = [((eh & fh) ^ (~eh & gh)) >>> 0, ((el & fl) ^ (~el & gl)) >>> 0];
        var t1 = add64(add64(add64([hh, hl], S1h_lo), chh), add64(K[i], w[i]));
        var S0h_lo = xor64(rotr64([ah, al], 28), rotr64([ah, al], 34), rotr64([ah, al], 39));
        var majh = [((ah & bh) ^ (ah & ch2) ^ (bh & ch2)) >>> 0, ((al & bl) ^ (al & cl) ^ (bl & cl)) >>> 0];
        var t2 = add64(S0h_lo, majh);
        hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
        var newE = add64([dh, dl], t1);
        eh = newE[0]; el = newE[1];
        dh = ch2; dl = cl; ch2 = bh; cl = bl; bh = ah; bl = al;
        var newA = add64(t1, t2);
        ah = newA[0]; al = newA[1];
      }
      H512[0] = add64(H512[0], [ah, al]);
      H512[1] = add64(H512[1], [bh, bl]);
      H512[2] = add64(H512[2], [ch2, cl]);
      H512[3] = add64(H512[3], [dh, dl]);
      H512[4] = add64(H512[4], [eh, el]);
      H512[5] = add64(H512[5], [fh, fl]);
      H512[6] = add64(H512[6], [gh, gl]);
      H512[7] = add64(H512[7], [hh, hl]);
    }
    var words = is384 ? 6 : 8;
    var out = new Uint8Array(words * 8);
    var outView = new DataView(out.buffer);
    for (i = 0; i < words; i++) {
      outView.setUint32(i * 8, H512[i][0], false);
      outView.setUint32(i * 8 + 4, H512[i][1], false);
    }
    return out;
  }

  // SHA-512 round constants (80 pairs of hi/lo 32-bit words).
  var SHA512_K = [
    [0x428a2f98, 0xd728ae22], [0x71374491, 0x23ef65cd], [0xb5c0fbcf, 0xec4d3b2f], [0xe9b5dba5, 0x8189dbbc],
    [0x3956c25b, 0xf348b538], [0x59f111f1, 0xb605d019], [0x923f82a4, 0xaf194f9b], [0xab1c5ed5, 0xda6d8118],
    [0xd807aa98, 0xa3030242], [0x12835b01, 0x45706fbe], [0x243185be, 0x4ee4b28c], [0x550c7dc3, 0xd5ffb4e2],
    [0x72be5d74, 0xf27b896f], [0x80deb1fe, 0x3b1696b1], [0x9bdc06a7, 0x25c71235], [0xc19bf174, 0xcf692694],
    [0xe49b69c1, 0x9ef14ad2], [0xefbe4786, 0x384f25e3], [0x0fc19dc6, 0x8b8cd5b5], [0x240ca1cc, 0x77ac9c65],
    [0x2de92c6f, 0x592b0275], [0x4a7484aa, 0x6ea6e483], [0x5cb0a9dc, 0xbd41fbd4], [0x76f988da, 0x831153b5],
    [0x983e5152, 0xee66dfab], [0xa831c66d, 0x2db43210], [0xb00327c8, 0x98fb213f], [0xbf597fc7, 0xbeef0ee4],
    [0xc6e00bf3, 0x3da88fc2], [0xd5a79147, 0x930aa725], [0x06ca6351, 0xe003826f], [0x14292967, 0x0a0e6e70],
    [0x27b70a85, 0x46d22ffc], [0x2e1b2138, 0x5c26c926], [0x4d2c6dfc, 0x5ac42aed], [0x53380d13, 0x9d95b3df],
    [0x650a7354, 0x8baf63de], [0x766a0abb, 0x3c77b2a8], [0x81c2c92e, 0x47edaee6], [0x92722c85, 0x1482353b],
    [0xa2bfe8a1, 0x4cf10364], [0xa81a664b, 0xbc423001], [0xc24b8b70, 0xd0f89791], [0xc76c51a3, 0x0654be30],
    [0xd192e819, 0xd6ef5218], [0xd6990624, 0x5565a910], [0xf40e3585, 0x5771202a], [0x106aa070, 0x32bbd1b8],
    [0x19a4c116, 0xb8d2d0c8], [0x1e376c08, 0x5141ab53], [0x2748774c, 0xdf8eeb99], [0x34b0bcb5, 0xe19b48a8],
    [0x391c0cb3, 0xc5c95a63], [0x4ed8aa4a, 0xe3418acb], [0x5b9cca4f, 0x7763e373], [0x682e6ff3, 0xd6b2b8a3],
    [0x748f82ee, 0x5defb2fc], [0x78a5636f, 0x43172f60], [0x84c87814, 0xa1f0ab72], [0x8cc70208, 0x1a6439ec],
    [0x90befffa, 0x23631e28], [0xa4506ceb, 0xde82bde9], [0xbef9a3f7, 0xb2c67915], [0xc67178f2, 0xe372532b],
    [0xca273ece, 0xea26619c], [0xd186b8c7, 0x21c0c207], [0xeada7dd6, 0xcde0eb1e], [0xf57d4f7f, 0xee6ed178],
    [0x06f067aa, 0x72176fba], [0x0a637dc5, 0xa2c898a6], [0x113f9804, 0xbef90dae], [0x1b710b35, 0x131c471b],
    [0x28db77f5, 0x23047d84], [0x32caab7b, 0x40c72493], [0x3c9ebe0a, 0x15c9bebc], [0x431d67c4, 0x9c100d4c],
    [0x4cc5d4be, 0xcb3e42b6], [0x597f299c, 0xfc657e2a], [0x5fcb6fab, 0x3ad6faec], [0x6c44198c, 0x4a475817]
  ];

  function rotr32(x, c) { return ((x >>> c) | (x << (32 - c))) >>> 0; }

  function rotr64(pair, c) {
    var hi = pair[0], lo = pair[1];
    if (c === 32) return [lo, hi];
    if (c < 32) {
      return [((hi >>> c) | (lo << (32 - c))) >>> 0, ((lo >>> c) | (hi << (32 - c))) >>> 0];
    }
    var s = c - 32;
    return [((lo >>> s) | (hi << (32 - s))) >>> 0, ((hi >>> s) | (lo << (32 - s))) >>> 0];
  }

  function shr64(pair, c) {
    if (c === 0) return [pair[0], pair[1]];
    if (c < 32) return [(pair[0] >>> c) >>> 0, ((pair[1] >>> c) | (pair[0] << (32 - c))) >>> 0];
    return [0, (pair[0] >>> (c - 32)) >>> 0];
  }

  function xor64(a, b, c) {
    var d = c || [0, 0];
    return [(a[0] ^ b[0] ^ d[0]) >>> 0, (a[1] ^ b[1] ^ d[1]) >>> 0];
  }

  function add64(a, b) {
    var lo = (a[1] + b[1]) >>> 0;
    var carry = lo < (a[1] >>> 0) ? 1 : 0;
    var hi = (a[0] + b[0] + carry) >>> 0;
    return [hi, lo];
  }

  function padMessage(bytes, blockSize, lenBits, bigEndianLength) {
    var withPad = (((bytes.length + 8) >> 6) + 1) << 6;
    // For 128-byte blocks the length field is 16 bytes (SHA-512/384).
    if (blockSize === 128) {
      withPad = (Math.floor((bytes.length + 16) / 128) + 1) * 128;
    }
    var buf = new Uint8Array(withPad);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    var view = new DataView(buf.buffer);
    if (blockSize === 128) {
      // 128-bit big-endian bit length; JS numbers cover up to 2^53 bits.
      var hiBits = Math.floor(lenBits / 4294967296);
      view.setUint32(withPad - 8, hiBits, false);
      view.setUint32(withPad - 4, lenBits >>> 0, false);
    } else if (bigEndianLength) {
      view.setUint32(withPad - 8, Math.floor(lenBits / 4294967296), false);
      view.setUint32(withPad - 4, lenBits >>> 0, false);
    } else {
      view.setUint32(withPad - 8, Math.floor(lenBits / 4294967296), false);
      view.setUint32(withPad - 4, lenBits >>> 0, false);
    }
    return buf;
  }

  // ---------------------------------------------------------------------
  // File hashing helper
  // ---------------------------------------------------------------------

  // Files above this size are hashed with progress reporting; MD5 is chunked
  // so a large file does not need a second full copy in memory.
  var CHUNK_SIZE = 1 << 20; // 1 MiB

  /**
   * Hash raw file bytes with one or more algorithms.
   *
   * @param {Uint8Array} bytes
   * @param {string[]} algorithms canonical or alias names
   * @param {{onProgress?:function(number), yieldEvery?:number}} [options]
   * @returns {Promise<Object<string, {hex:string, base64:string}>>}
   */
  function hashBytes(bytes, algorithms, options) {
    var opts = options || {};
    var wanted = (algorithms || []).map(function (a) { return canonicalAlgorithm(a); })
      .filter(function (a) { return !!a; });
    var result = {};

    function shaStep(index) {
      if (index >= wanted.length) return Promise.resolve(result);
      var algo = wanted[index];
      if (algo !== "md5") {
        return digest(algo, bytes).then(function (out) {
          result[algo] = { hex: out.hex, base64: out.base64 };
          return shaStep(index + 1);
        });
      }
      // Chunked MD5 with a chance for the UI to breathe between chunks.
      var h = md5Create();
      var offset = 0;
      function md5Step() {
        var end = Math.min(offset + CHUNK_SIZE, bytes.length);
        h.update(bytes.subarray(offset, end));
        offset = end;
        if (typeof opts.onProgress === "function") opts.onProgress(bytes.length ? offset / bytes.length : 1);
        if (offset < bytes.length) {
          return pause().then(md5Step);
        }
        var out = h.digest();
        result.md5 = { hex: bytesToHex(out), base64: bytesToBase64(out) };
        return shaStep(index + 1);
      }
      return md5Step();
    }

    return shaStep(0);
  }

  function pause() {
    return new Promise(function (resolve) {
      if (typeof setTimeout === "function") setTimeout(resolve, 0);
      else resolve();
    });
  }

  // ---------------------------------------------------------------------
  // Manifest parsing
  // ---------------------------------------------------------------------

  function looksLikeHex(value) {
    return typeof value === "string" && /^[0-9a-fA-F]+$/.test(value);
  }

  /**
   * Normalize a digest string: strip an algorithm prefix ("sha256:"),
   * lowercase it, and trim surrounding whitespace. Returns "" when the value
   * is clearly not a hex digest.
   */
  function normalizeDigest(value) {
    if (value == null) return "";
    var text = String(value).trim();
    if (!text) return "";
    var colon = text.indexOf(":");
    if (colon > 0 && canonicalAlgorithm(text.slice(0, colon))) {
      text = text.slice(colon + 1).trim();
    }
    text = text.replace(/[\s]/g, "").toLowerCase();
    return looksLikeHex(text) ? text : "";
  }

  /**
   * Infer the algorithm from a digest's length. Returns null when the length
   * matches no supported algorithm.
   */
  function algorithmFromLength(hex) {
    switch (hex.length) {
      case 32: return "md5";
      case 40: return "sha-1";
      case 64: return "sha-256";
      case 96: return "sha-384";
      case 128: return "sha-512";
      default: return null;
    }
  }

  function stripStarPrefix(name) {
    var out = String(name).trim();
    // GNU coreutils text mode marker: "*filename".
    if (out.charAt(0) === "*") out = out.slice(1);
    return out.trim();
  }

  function stripPath(name) {
    // Compare on the basename so "dist/app.js" matches an uploaded "app.js".
    return String(name).replace(/^\.\//, "").split("/").pop();
  }

  var ENTRY = function (filename, digest, algorithm, raw, escaped) {
    return {
      filename: filename,
      path: stripPath(filename),
      digest: digest,
      algorithm: algorithm,
      raw: raw,
      escaped: !!escaped
    };
  };

  /**
   * Parse a checksum manifest into a list of entries.
   * Supported shapes:
   *   - GNU coreutils:      "d41d8cd9...  filename"  /  "... *filename"
   *   - BSD md5/shasum:     "MD5 (filename) = d41d8..."
   *   - sha*sum --tag:      "SHA256 (filename) = d41d8..."
   *   - RFC 9530 / Content-Digest: "sha-256=:base64:" or "sha-256=hex"
   *   - plain digest list:  "d41d8cd9...  filename" (algorithm inferred)
   *   - CSV:                "filename,digest" or "digest,filename"
   * Comment lines (#) and blank lines are ignored.
   * @returns {{entries:Array, skipped:Array<{line:number, text:string}>}}
   */
  function parseManifest(text) {
    var entries = [];
    var skipped = [];
    var lines = String(text == null ? "" : text).split(/\r\n|\r|\n/);

    for (var i = 0; i < lines.length; i++) {
      var rawLine = lines[i];
      var line = rawLine.trim();
      if (line === "" || line.charAt(0) === "#") continue;

      var entry = parseManifestLine(line, i + 1);
      if (entry) {
        entry.line = i + 1;
        entries.push(entry);
      } else {
        skipped.push({ line: i + 1, text: rawLine });
      }
    }
    return { entries: entries, skipped: skipped };
  }

  function parseManifestLine(line, lineNumber) {
    // 1. Tagged form: NAME (filename) = digest  /  NAME(filename)= digest
    var tagged = line.match(/^([A-Za-z0-9_-]+)\s*\((.*)\)\s*=\s*(\S+)\s*$/);
    if (tagged) {
      var taggedAlgo = canonicalAlgorithm(tagged[1]);
      var taggedDigest = normalizeDigest(tagged[3]);
      if (taggedAlgo && taggedDigest) {
        return ENTRY(tagged[2].trim(), taggedDigest, taggedAlgo, line, false);
      }
    }

    // 2. RFC 9530 / Content-Digest structured field: algo=:base64:
    //    Base64 payloads carry no filename, so these entries are recorded as
    //    digest-only references rather than matched against a file.
    var structured = line.match(/^([A-Za-z0-9_-]+)\s*=\s*:([A-Za-z0-9+/=]+):\s*$/);
    if (structured) {
      var sAlgo = canonicalAlgorithm(structured[1]);
      if (sAlgo) return ENTRY("", structured[2], sAlgo, line, false);
    }

    // 3. GNU coreutils / plain "digest  filename"
    var coreutils = line.match(/^(\S+)\s+(\*?)(.+)$/);
    if (coreutils) {
      var cDigest = normalizeDigest(coreutils[1]);
      if (cDigest) {
        var cAlgo = algorithmFromLength(cDigest);
        if (cAlgo) {
          var cName = stripStarPrefix(coreutils[2] + coreutils[3]);
          if (cName) return ENTRY(cName, cDigest, cAlgo, line, coreutils[2] === "*");
        }
      }
    }

    // 4. CSV: filename,digest or digest,filename
    var csv = splitCsvLine(line);
    if (csv.length >= 2) {
      var first = normalizeDigest(csv[0]);
      var second = normalizeDigest(csv[1]);
      if (first && algorithmFromLength(first)) {
        return ENTRY(csv[1].trim(), first, algorithmFromLength(first), line, false);
      }
      if (second && algorithmFromLength(second)) {
        return ENTRY(csv[0].trim(), second, algorithmFromLength(second), line, false);
      }
    }

    return null;
  }

  function splitCsvLine(line) {
    var out = [];
    var field = "";
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"' && field === "") {
        inQuotes = true;
      } else if (c === ",") {
        out.push(field);
        field = "";
      } else {
        field += c;
      }
    }
    out.push(field);
    return out;
  }

  // ---------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------

  var STATUS = {
    MATCH: "match",
    MISMATCH: "mismatch",
    MISSING: "missing",
    EXTRA: "extra",
    UNKNOWN: "unknown"
  };

  function normalizeFileName(name) {
    return String(name == null ? "" : name).replace(/\\/g, "/").replace(/^\.\//, "").trim();
  }

  function buildIndex(names) {
    var byPath = new Map();
    var byBase = new Map();
    for (var i = 0; i < names.length; i++) {
      var path = normalizeFileName(names[i]);
      if (!path) continue;
      byPath.set(path.toLowerCase(), path);
      var base = path.split("/").pop().toLowerCase();
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push(path);
    }
    return { byPath: byPath, byBase: byBase };
  }

  /**
   * Find the provided file that corresponds to a manifest entry, matching on
   * the full relative path first and then on the basename.
   */
  function resolveEntry(entry, index) {
    var target = normalizeFileName(entry.path || entry.filename).toLowerCase();
    if (!target) return null;
    if (index.byPath.has(target)) return index.byPath.get(target);
    var base = target.split("/").pop();
    var candidates = index.byBase.get(base);
    if (candidates && candidates.length === 1) return candidates[0];
    return null;
  }

  /**
   * Audit a set of provided files against a manifest.
   *
   * @param {Array<{name:string, digests:Object<string,string>}>} files
   *        One entry per provided file. `digests` maps a canonical algorithm
   *        name (e.g. "sha-256") to its lowercase hex digest.
   * @param {Array} entries Parsed manifest entries.
   * @param {{checkExtras?:boolean}} [options]
   * @returns {{rows:Array, summary:Object}}
   */
  function audit(files, entries, options) {
    var opts = options || {};
    var index = buildIndex(files.map(function (f) { return f.name; }));
    // A manifest may legitimately list several algorithms for one file, so
    // ambiguity is only flagged when the same file+algorithm appears twice.
    var used = new Set();
    var usedPaths = new Set();
    var rows = [];
    var summary = { total: 0, match: 0, mismatch: 0, missing: 0, extra: 0, unknown: 0 };

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var expected = normalizeDigest(entry.digest);
      var status;
      var provided = null;
      var file = null;
      var note = "";

      if (!entry.filename) {
        status = STATUS.UNKNOWN;
        note = "No filename in this manifest entry — digest-only record.";
      } else {
        provided = resolveEntry(entry, index);
        var key = provided ? provided + "\u0000" + (entry.algorithm || "") : null;
        if (!provided) {
          status = STATUS.MISSING;
        } else if (used.has(key)) {
          status = STATUS.MISMATCH;
          note = "This file and algorithm appear more than once in the manifest.";
        } else {
          used.add(key);
          usedPaths.add(provided);
          for (var f = 0; f < files.length; f++) {
            if (files[f].name === provided) { file = files[f]; break; }
          }
          var actual = file && file.digests ? normalizeDigest(file.digests[entry.algorithm]) : "";
          if (!entry.algorithm) {
            status = STATUS.UNKNOWN;
            note = "Manifest entry has no recognisable algorithm.";
          } else if (!actual) {
            status = STATUS.UNKNOWN;
            note = "File was not hashed with " + entry.algorithm + ".";
          } else if (!expected) {
            status = STATUS.UNKNOWN;
            note = "Manifest digest is not a valid hex digest.";
          } else if (actual === expected) {
            status = STATUS.MATCH;
          } else {
            status = STATUS.MISMATCH;
          }
        }
      }

      summary.total++;
      summary[status]++;
      rows.push({
        status: status,
        filename: entry.filename,
        expected: expected,
        actual: actualDigestFor(file, entry.algorithm),
        algorithm: entry.algorithm,
        note: note,
        line: entry.line
      });
    }

    if (opts.checkExtras) {
      for (var k = 0; k < files.length; k++) {
        if (usedPaths.has(files[k].name)) continue;
        summary.total++;
        summary.extra++;
        rows.push({
          status: STATUS.EXTRA,
          filename: files[k].name,
          expected: "",
          actual: firstDigest(files[k]),
          algorithm: firstAlgorithm(files[k]),
          note: "Not listed in the manifest.",
          line: null
        });
      }
    }

    return { rows: rows, summary: summary };
  }

  function firstAlgorithm(file) {
    if (!file || !file.digests) return "";
    var keys = Object.keys(file.digests);
    return keys.length ? keys[0] : "";
  }

  function firstDigest(file) {
    var algo = firstAlgorithm(file);
    return algo ? file.digests[algo] : "";
  }

  function actualDigestFor(file, algorithm) {
    if (!file || !file.digests) return "";
    if (algorithm && file.digests[algorithm]) return file.digests[algorithm];
    return firstDigest(file);
  }

  // ---------------------------------------------------------------------
  // Formatting / export
  // ---------------------------------------------------------------------

  var STATUS_LABELS = {
    match: "OK",
    mismatch: "MISMATCH",
    missing: "MISSING",
    extra: "EXTRA",
    unknown: "UNKNOWN"
  };

  function csvEscape(value) {
    var text = value == null ? "" : String(value);
    if (/[",\r\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function toCsv(rows, includeExtras) {
    var header = ["status", "filename", "expected", "actual", "algorithm", "note"];
    var lines = [header.join(",")];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!includeExtras && row.status === STATUS.EXTRA) continue;
      lines.push([
        STATUS_LABELS[row.status] || row.status,
        csvEscape(row.filename),
        csvEscape(row.expected),
        csvEscape(row.actual),
        csvEscape(row.algorithm),
        csvEscape(row.note)
      ].join(","));
    }
    return lines.join("\n") + "\n";
  }

  function toReport(rows, summary) {
    var lines = [];
    lines.push("File Integrity Audit");
    lines.push("====================");
    lines.push("Total entries: " + summary.total);
    lines.push("  OK:        " + summary.match);
    lines.push("  MISMATCH:  " + summary.mismatch);
    lines.push("  MISSING:   " + summary.missing);
    lines.push("  EXTRA:     " + summary.extra);
    lines.push("  UNKNOWN:   " + summary.unknown);
    lines.push("");
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      lines.push("[" + (STATUS_LABELS[row.status] || row.status) + "] " + row.filename +
        (row.note ? " — " + row.note : ""));
    }
    return lines.join("\n") + "\n";
  }

  return {
    md5: md5,
    md5Create: md5Create,
    digest: digest,
    shaFallback: shaFallback,
    hashBytes: hashBytes,
    canonicalAlgorithm: canonicalAlgorithm,
    algorithmInfo: algorithmInfo,
    algorithmFromLength: algorithmFromLength,
    normalizeDigest: normalizeDigest,
    parseManifest: parseManifest,
    parseManifestLine: parseManifestLine,
    splitCsvLine: splitCsvLine,
    normalizeFileName: normalizeFileName,
    audit: audit,
    toCsv: toCsv,
    toReport: toReport,
    bytesToHex: bytesToHex,
    bytesToBase64: bytesToBase64,
    CHUNK_SIZE: CHUNK_SIZE,
    ALGORITHMS: ALGORITHMS,
    STATUS: STATUS,
    STATUS_LABELS: STATUS_LABELS
  };
});
