(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.uuidGenerator = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var HEX = "0123456789abcdef";

  var cryptoObj = null;
  if (typeof self !== "undefined" && self.crypto && typeof self.crypto.getRandomValues === "function") {
    cryptoObj = self.crypto;
  } else if (typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    cryptoObj = globalThis.crypto;
  }

  function randomBytes(n) {
    if (cryptoObj) {
      var out = new Uint8Array(n);
      cryptoObj.getRandomValues(out);
      return out;
    }
    var fallback = new Uint8Array(n);
    for (var i = 0; i < n; i++) fallback[i] = Math.floor(Math.random() * 256);
    return fallback;
  }

  /** Generate one RFC 4122 v4 UUID string. */
  function uuidv4() {
    var b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = "";
    for (var i = 0; i < 16; i++) {
      if (i === 4 || i === 6 || i === 8 || i === 10) h += "-";
      h += HEX[b[i] >> 4] + HEX[b[i] & 0x0f];
    }
    return h;
  }

  /** Generate n UUIDs. Returns an array. */
  function generate(count) {
    var n = typeof count === "number" ? count : Number(count);
    if (isNaN(n)) n = 1;
    n = Math.floor(n);
    if (n < 1) n = 1;
    if (n > 1000) n = 1000;
    var out = [];
    for (var i = 0; i < n; i++) out.push(uuidv4());
    return out;
  }

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function isValid(uuid) {
    return typeof uuid === "string" && UUID_RE.test(uuid);
  }

  return {
    uuidv4: uuidv4,
    generate: generate,
    isValid: isValid
  };
});