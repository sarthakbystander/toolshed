/* Toolshed — Certificate Inspector
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.certificateInspector and in Node via require() for tests.
 *
 * The module decodes PEM or DER input, parses the ASN.1 DER structures behind
 * an X.509 certificate or a PKCS#10 certificate signing request, and turns them
 * into a readable report: subject and issuer names, validity window, public key,
 * signature algorithm, extensions (subjectAltName, key usage, extended key
 * usage, basic constraints, key identifiers, CRL/OCSP endpoints, policies and
 * more), plus a security review that flags expired or not-yet-valid
 * certificates, weak signature or key algorithms, and missing modern
 * extensions.
 *
 * Everything runs in memory. The module never touches the network, never uses
 * eval or dynamic code execution, and never writes to storage. Hashing uses the
 * Web Crypto API when available (with a Node fallback); the module is otherwise
 * synchronous, deterministic and side-effect free.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.certificateInspector = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Object identifiers
  // ---------------------------------------------------------------------

  var OID_NAMES = {
    "1.2.840.113549.1.1.1": "rsaEncryption (RSA)",
    "1.2.840.113549.1.1.2": "md2WithRSAEncryption",
    "1.2.840.113549.1.1.4": "md5WithRSAEncryption",
    "1.2.840.113549.1.1.5": "sha1WithRSAEncryption",
    "1.2.840.113549.1.1.10": "rsassaPss",
    "1.2.840.113549.1.1.11": "sha256WithRSAEncryption",
    "1.2.840.113549.1.1.12": "sha384WithRSAEncryption",
    "1.2.840.113549.1.1.13": "sha512WithRSAEncryption",
    "1.2.840.113549.1.1.14": "sha224WithRSAEncryption",
    "1.2.840.10045.2.1": "id-ecPublicKey (EC)",
    "1.2.840.10045.4.1": "ecdsa-with-SHA1",
    "1.2.840.10045.4.3.1": "ecdsa-with-SHA224",
    "1.2.840.10045.4.3.2": "ecdsa-with-SHA256",
    "1.2.840.10045.4.3.3": "ecdsa-with-SHA384",
    "1.2.840.10045.4.3.4": "ecdsa-with-SHA512",
    "1.3.101.112": "Ed25519",
    "1.3.101.113": "Ed448",
    "2.16.840.1.101.3.4.3.2": "dsa-with-sha256",
    "1.2.840.10040.4.1": "id-dsa",
    "1.2.840.10040.4.3": "dsa-with-sha1"
  };

  var CURVE_NAMES = {
    "1.2.840.10045.3.1.1": "prime192v1 (P-192)",
    "1.3.132.0.33": "secp224r1 (P-224)",
    "1.2.840.10045.3.1.7": "prime256v1 (P-256)",
    "1.3.132.0.34": "secp384r1 (P-384)",
    "1.3.132.0.35": "secp521r1 (P-521)",
    "1.3.132.0.10": "secp256k1"
  };

  var EXTENSION_NAMES = {
    "2.5.29.14": "Subject Key Identifier",
    "2.5.29.15": "Key Usage",
    "2.5.29.16": "Private Key Usage Period",
    "2.5.29.17": "Subject Alternative Name",
    "2.5.29.18": "Issuer Alternative Name",
    "2.5.29.19": "Basic Constraints",
    "2.5.29.30": "Name Constraints",
    "2.5.29.31": "CRL Distribution Points",
    "2.5.29.32": "Certificate Policies",
    "2.5.29.33": "Policy Mappings",
    "2.5.29.35": "Authority Key Identifier",
    "2.5.29.36": "Policy Constraints",
    "2.5.29.37": "Extended Key Usage",
    "2.5.29.46": "Freshest CRL",
    "2.5.29.54": "Inhibit Any Policy",
    "1.3.6.1.5.5.7.1.1": "Authority Information Access",
    "1.3.6.1.5.5.7.1.11": "Subject Information Access",
    "1.3.6.1.5.5.7.1.24": "TLS Feature",
    "1.3.6.1.4.1.11129.2.4.2": "Signed Certificate Timestamp List",
    "2.16.840.1.113730.1.1": "Netscape Certificate Type",
    "2.16.840.1.113730.1.13": "Netscape Comment"
  };

  // Certificate policy OIDs worth naming (CA/Browser Forum and friends).
  var POLICY_NAMES = {
    "2.23.140.1.1": "Extended Validation (EV)",
    "2.23.140.1.2.1": "Domain Validated (DV)",
    "2.23.140.1.2.2": "Organization Validated (OV)",
    "2.23.140.1.2.3": "Individual Validated (IV)",
    "2.23.140.1.2.4": "EV Code Signing",
    "2.23.140.1.3": "EV Code Signing (legacy)"
  };

  var KEY_USAGE_BITS = [
    "digitalSignature", "nonRepudiation", "keyEncipherment", "dataEncipherment",
    "keyAgreement", "keyCertSign", "cRLSign", "encipherOnly", "decipherOnly"
  ];

  var EKU_NAMES = {
    "1.3.6.1.5.5.7.3.1": "serverAuth (TLS server)",
    "1.3.6.1.5.5.7.3.2": "clientAuth (TLS client)",
    "1.3.6.1.5.5.7.3.3": "codeSigning",
    "1.3.6.1.5.5.7.3.4": "emailProtection",
    "1.3.6.1.5.5.7.3.5": "ipsecEndSystem",
    "1.3.6.1.5.5.7.3.6": "ipsecTunnel",
    "1.3.6.1.5.5.7.3.7": "ipsecUser",
    "1.3.6.1.5.5.7.3.8": "timeStamping",
    "1.3.6.1.5.5.7.3.9": "OCSPSigning",
    "1.3.6.1.5.5.7.3.13": "wireless",
    "1.3.6.1.5.5.7.3.17": "ipsecIKE",
    "1.3.6.1.4.1.311.10.3.4": "encryptedFileSystem (Microsoft)",
    "1.3.6.1.4.1.311.20.2.2": "smartcardLogon (Microsoft)",
    "1.3.6.1.4.1.11129.2.4.4": "certificateTransparency",
    "2.5.29.37.0": "anyExtendedKeyUsage"
  };

  var ATTRIBUTE_NAMES = {
    "2.5.4.3": "CN", "2.5.4.4": "SN", "2.5.4.5": "serialNumber",
    "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST", "2.5.4.9": "street",
    "2.5.4.10": "O", "2.5.4.11": "OU", "2.5.4.12": "title",
    "2.5.4.13": "description", "2.5.4.15": "businessCategory",
    "2.5.4.17": "postalCode", "2.5.4.41": "name", "2.5.4.42": "GN",
    "2.5.4.43": "initials", "2.5.4.44": "generationQualifier",
    "2.5.4.46": "dnQualifier", "2.5.4.65": "pseudonym", "2.5.4.97": "organizationIdentifier",
    "1.2.840.113549.1.9.1": "E",
    "0.9.2342.19200300.100.1.25": "DC",
    "0.9.2342.19200300.100.1.1": "UID"
  };

  var GENERAL_NAME_KINDS = {
    0: "otherName", 1: "rfc822Name", 2: "dNSName", 3: "x400Address",
    4: "directoryName", 5: "ediPartyName", 6: "uniformResourceIdentifier",
    7: "iPAddress", 8: "registeredID"
  };

  // ---------------------------------------------------------------------
  // Byte helpers
  // ---------------------------------------------------------------------

  function bytesFromBase64(b64) {
    var clean = String(b64).replace(/[\s\r\n]+/g, "");
    if (clean === "") return null;
    if (!/^[A-Za-z0-9+/=_-]+$/.test(clean)) return null;
    var normalized = clean.replace(/-/g, "+").replace(/_/g, "/");
    if (normalized.length % 4 === 1) return null;
    while (normalized.length % 4 !== 0) normalized += "=";
    try {
      if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
        return new Uint8Array(Buffer.from(normalized, "base64"));
      }
      var bin = atob(normalized);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) {
      return null;
    }
  }

  function bytesToHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    }
    return out;
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
      return Buffer.from(bytes).toString("base64");
    }
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function utf8ToBytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(str, "utf8"));
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function hexToBytes(hex) {
    var clean = String(hex).replace(/[\s:]/g, "");
    if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return null;
    var out = new Uint8Array(clean.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  function colonHex(bytes) {
    var out = [];
    for (var i = 0; i < bytes.length; i++) {
      out.push((bytes[i] < 16 ? "0" : "") + bytes[i].toString(16).toUpperCase());
    }
    return out.join(":");
  }

  // ---------------------------------------------------------------------
  // PEM / DER container detection
  // ---------------------------------------------------------------------

  var PEM_LABEL_RE = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;

  function decodePemBlocks(text) {
    var blocks = [];
    var re = new RegExp(PEM_LABEL_RE.source, "g");
    var m;
    while ((m = re.exec(text)) !== null) {
      var body = m[2].replace(/[\s\r\n]+/g, "");
      if (body === "") continue;
      var der = bytesFromBase64(body);
      if (der) blocks.push({ label: m[1].trim(), der: der, pem: m[0] });
    }
    return blocks;
  }

  function looksLikePem(text) {
    return /-----BEGIN [A-Z0-9 ]+-----/.test(text);
  }

  function labelKind(label) {
    if (/NEW CERTIFICATE REQUEST/.test(label)) return "csr";
    if (/CERTIFICATE REQUEST/.test(label)) return "csr";
    if (/CERTIFICATE$/.test(label)) return "certificate";
    if (/PUBLIC KEY/.test(label)) return "public-key";
    if (/PRIVATE KEY/.test(label)) return "private-key";
    return "unknown";
  }

  // Splits a user-supplied string into decode-able DER blobs, each tagged with
  // the PEM label it came from (or "der"/"base64"/"hex" for raw input).
  function decodeInput(input) {
    var raw = typeof input === "string" ? input : "";
    if (raw.trim() === "") return { ok: false, error: "No input provided." };

    if (looksLikePem(raw)) {
      var blocks = decodePemBlocks(raw);
      if (blocks.length === 0) {
        return { ok: false, error: "A PEM header was found but the base64 body could not be decoded — check that it is intact." };
      }
      var privateKey = blocks.filter(function (b) { return labelKind(b.label) === "private-key"; });
      if (privateKey.length && privateKey.length === blocks.length) {
        return {
          ok: false,
          error: "This looks like a private key. For your safety the inspector refuses to read private keys — paste a certificate or a certificate signing request instead.",
          kind: "private-key"
        };
      }
      var usable = blocks.filter(function (b) { return labelKind(b.label) !== "private-key"; });
      return {
        ok: true,
        blocks: usable.map(function (b) {
          return { der: b.der, label: b.label, source: "pem", kind: labelKind(b.label) };
        }),
        skippedPrivateKeys: blocks.length - usable.length
      };
    }

    var trimmed = raw.trim();
    // Raw DER as hex.
    var hex = /^[0-9a-fA-F\s:]+$/.test(trimmed) ? trimmed.replace(/[\s:]/g, "") : "";
    if (hex && hex.length % 2 === 0 && /^30/.test(hex)) {
      var derHex = hexToBytes(hex);
      if (derHex) return { ok: true, blocks: [{ der: derHex, label: "DER", source: "hex", kind: "unknown" }] };
    }
    // Raw DER as base64.
    var b64 = bytesFromBase64(trimmed);
    if (b64 && b64.length > 0 && b64[0] === 0x30) {
      return { ok: true, blocks: [{ der: b64, label: "DER", source: "base64", kind: "unknown" }] };
    }
    return { ok: false, error: "Unrecognised input — paste a PEM block, or raw DER as base64 or hex." };
  }
  // ---------------------------------------------------------------------
  // ASN.1 DER reader
  // ---------------------------------------------------------------------

  var CLASS_UNIVERSAL = 0;
  var CLASS_APPLICATION = 1;
  var CLASS_CONTEXT = 2;
  var CLASS_PRIVATE = 3;

  var TAG_BOOLEAN = 1, TAG_INTEGER = 2, TAG_BIT_STRING = 3, TAG_OCTET_STRING = 4,
      TAG_NULL = 5, TAG_OID = 6, TAG_SEQUENCE = 16, TAG_SET = 17,
      TAG_UTF8_STRING = 12, TAG_PRINTABLE_STRING = 19, TAG_IA5_STRING = 22,
      TAG_UTC_TIME = 23, TAG_GENERALIZED_TIME = 24;

  function DerError(message) {
    this.name = "DerError";
    this.message = message;
  }
  DerError.prototype = Object.create(Error.prototype);

  function derReader(bytes, base) {
    var pos = 0;
    var origin = base || 0;

    function atEnd() { return pos >= bytes.length; }
    function offset() { return origin + pos; }

    function readByte() {
      if (pos >= bytes.length) throw new DerError("Unexpected end of data while reading ASN.1");
      return bytes[pos++];
    }

    function readLength() {
      var first = readByte();
      if (first < 0x80) return first;
      var count = first & 0x7f;
      if (count === 0) throw new DerError("Indefinite-length encodings are not allowed in DER");
      if (count > 4) throw new DerError("ASN.1 length field is too large");
      var len = 0;
      for (var i = 0; i < count; i++) len = (len * 256) + readByte();
      return len;
    }

    function readNode() {
      var startOffset = pos;
      var tagByte = readByte();
      var cls = (tagByte >> 6) & 0x03;
      var constructed = (tagByte & 0x20) !== 0;
      var tagNumber = tagByte & 0x1f;
      if (tagNumber === 0x1f) {
        tagNumber = 0;
        var b;
        do {
          b = readByte();
          tagNumber = (tagNumber * 128) + (b & 0x7f);
          if (tagNumber > 0x7fffffff) throw new DerError("ASN.1 tag number is too large");
        } while (b & 0x80);
      }
      var length = readLength();
      if (pos + length > bytes.length) throw new DerError("ASN.1 element declares a length past the end of the data");
      var valueStart = pos;
      pos += length;
      return {
        cls: cls,
        constructed: constructed,
        tagNumber: tagNumber,
        length: length,
        start: origin + startOffset,
        headerLength: (origin + valueStart) - (origin + startOffset),
        value: bytes.subarray(valueStart, pos),
        full: bytes.subarray(startOffset, pos),
        children: function () { return readChildren(this); }
      };
    }

    function readChildren(node) {
      if (!node.constructed) throw new DerError("Expected a constructed ASN.1 value");
      var sub = derReader(node.value, node.start + node.headerLength);
      var out = [];
      while (!sub.atEnd()) out.push(sub.readNode());
      return out;
    }

    return { atEnd: atEnd, offset: offset, readNode: readNode, readChildren: readChildren };
  }

  function parseDer(bytes) {
    return derReader(bytes, 0).readNode();
  }

  // ---------------------------------------------------------------------
  // ASN.1 value decoding
  // ---------------------------------------------------------------------

  function isUniversal(node, tagNumber) {
    return node.cls === CLASS_UNIVERSAL && node.tagNumber === tagNumber;
  }

  function isContext(node, tagNumber) {
    return node.cls === CLASS_CONTEXT && node.tagNumber === tagNumber;
  }

  function requireUniversal(node, tagNumber, what) {
    if (!isUniversal(node, tagNumber)) {
      throw new DerError("Expected " + what + " (universal tag " + tagNumber + ") but found tag " +
        node.tagNumber + " in class " + node.cls);
    }
    return node;
  }

  function decodeOid(bytes) {
    if (bytes.length === 0) return "";
    var parts = [];
    var value = 0;
    for (var i = 0; i < bytes.length; i++) {
      value = (value * 128) + (bytes[i] & 0x7f);
      if ((bytes[i] & 0x80) === 0) {
        if (parts.length === 0) {
          parts.push(Math.floor(value / 40), value % 40);
        } else {
          parts.push(value);
        }
        value = 0;
      }
    }
    return parts.join(".");
  }

  function decodeIntegerBig(bytes) {
    // Decimal string for arbitrary-size non-negative integers.
    if (bytes.length === 0) return "0";
    if (bytes[0] & 0x80) return "negative:" + bytesToHex(bytes);
    var digits = [0];
    for (var i = 0; i < bytes.length; i++) {
      var carry = bytes[i];
      for (var d = 0; d < digits.length; d++) {
        var v = digits[d] * 256 + carry;
        digits[d] = v % 10;
        carry = Math.floor(v / 10);
      }
      while (carry > 0) { digits.push(carry % 10); carry = Math.floor(carry / 10); }
    }
    var out = "";
    for (var k = digits.length - 1; k >= 0; k--) out += digits[k];
    return out.replace(/^0+(?=\d)/, "");
  }

  function decodeIntegerSmall(bytes) {
    if (bytes.length === 0) return 0;
    var value = 0;
    for (var i = 0; i < bytes.length; i++) value = value * 256 + bytes[i];
    return value;
  }

  function bitLengthOfBytes(bytes) {
    var i = 0;
    while (i < bytes.length && bytes[i] === 0) i++;
    if (i >= bytes.length) return 0;
    var bits = (bytes.length - i - 1) * 8;
    var b = bytes[i];
    while (b > 0) { bits++; b >>= 1; }
    return bits;
  }

  function decodeStringValue(node) {
    switch (node.tagNumber) {
      case TAG_UTF8_STRING:
      case TAG_IA5_STRING:
      case 26: // VisibleString
      case 27: // GeneralString
        return utf8Decode(node.value);
      case TAG_PRINTABLE_STRING:
      case 18: // NumericString
      case 20: // TeletexString
        return latin1(node.value);
      case 30: // BMPString (UTF-16BE)
        return bmpString(node.value);
      case 28: // UniversalString (UTF-32BE)
        return universalString(node.value);
      default:
        return latin1(node.value);
    }
  }

  function utf8Decode(bytes) {
    try {
      if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (e) { /* fall through to the manual decoder */ }
    var out = "";
    var i = 0;
    while (i < bytes.length) {
      var c = bytes[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c >= 0xc0 && c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
      else if (c >= 0xe0 && c < 0xf0) out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
      else {
        var cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return out;
  }

  function latin1(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function bmpString(bytes) {
    var out = "";
    for (var i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }

  function universalString(bytes) {
    var out = "";
    for (var i = 0; i + 3 < bytes.length; i += 4) {
      var cp = ((bytes[i] << 24) >>> 0) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
      out += cp > 0xffff ? String.fromCodePoint(cp) : String.fromCharCode(cp);
    }
    return out;
  }

  function decodeTime(node) {
    var text = latin1(node.value).trim();
    var year, rest;
    if (node.tagNumber === TAG_UTC_TIME) {
      year = parseInt(text.substr(0, 2), 10);
      year = year >= 50 ? 1900 + year : 2000 + year;
      rest = text.substr(2);
    } else {
      year = parseInt(text.substr(0, 4), 10);
      rest = text.substr(4);
    }
    var month = parseInt(rest.substr(0, 2), 10);
    var day = parseInt(rest.substr(2, 2), 10);
    var hour = parseInt(rest.substr(4, 2), 10) || 0;
    var minute = parseInt(rest.substr(6, 2), 10) || 0;
    var second = parseInt(rest.substr(8, 2), 10) || 0;
    var tz = rest.substr(10);
    var offsetMinutes = 0;
    var m = /^([+-])(\d{2})(\d{2})?/.exec(tz);
    if (m) {
      offsetMinutes = parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0);
      if (m[1] === "-") offsetMinutes = -offsetMinutes;
    }
    var epoch = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60000;
    var valid = !isNaN(epoch) && month >= 1 && month <= 12 && day >= 1 && day <= 31;
    return {
      raw: text,
      epoch: epoch,
      iso: valid ? new Date(epoch).toISOString() : null,
      valid: valid
    };
  }

  function bitStringBytes(node) {
    // BIT STRING value = [unused-bit-count][content bytes]
    if (!isUniversal(node, TAG_BIT_STRING)) throw new DerError("Expected a BIT STRING");
    var unused = node.value.length ? node.value[0] : 0;
    if (unused > 7) throw new DerError("Invalid number of unused bits in a BIT STRING");
    return { unused: unused, bytes: node.value.subarray(1) };
  }
  // ---------------------------------------------------------------------
  // X.509 structures
  // ---------------------------------------------------------------------

  function parseName(node) {
    var seq = requireUniversal(node, TAG_SEQUENCE, "a Name");
    var rdns = seq.children();
    var attributes = [];
    var groups = [];
    for (var i = 0; i < rdns.length; i++) {
      var set = rdns[i];
      var values = set.children();
      var group = [];
      for (var j = 0; j < values.length; j++) {
        var atv = values[j];
        var parts = atv.children();
        if (parts.length < 2) continue;
        var oidNode = parts[0];
        if (!isUniversal(oidNode, TAG_OID)) continue;
        var oid = decodeOid(oidNode.value);
        var attr = {
          oid: oid,
          name: ATTRIBUTE_NAMES[oid] || oid,
          value: decodeStringValue(parts[1])
        };
        attributes.push(attr);
        group.push(attr);
      }
      groups.push(group);
    }
    var formatted = groups
      .filter(function (g) { return g.length > 0; })
      .map(function (g) { return g.map(function (a) { return a.name + "=" + a.value; }).join("+"); })
      .join(", ");
    return { attributes: attributes, groups: groups, formatted: formatted };
  }

  function nameValue(name, short) {
    for (var i = 0; i < name.attributes.length; i++) {
      if (name.attributes[i].name === short) return name.attributes[i].value;
    }
    return null;
  }

  function parseAlgorithmIdentifier(node) {
    var seq = requireUniversal(node, TAG_SEQUENCE, "an AlgorithmIdentifier");
    var parts = seq.children();
    if (parts.length === 0) throw new DerError("An AlgorithmIdentifier must contain an OID");
    var oid = decodeOid(requireUniversal(parts[0], TAG_OID, "an algorithm OID").value);
    var params = parts.length > 1 ? parts[1] : null;
    var curve = null;
    if (params && isUniversal(params, TAG_OID)) curve = decodeOid(params.value);
    return {
      oid: oid,
      name: OID_NAMES[oid] || oid,
      curve: curve,
      curveName: curve ? (CURVE_NAMES[curve] || curve) : null,
      parameters: params ? describeAlgorithmParams(oid, params) : null,
      raw: seq.value
    };
  }

  function describeAlgorithmParams(oid, node) {
    if (isUniversal(node, TAG_NULL)) return "NULL";
    if (isUniversal(node, TAG_OID)) return "OID " + decodeOid(node.value);
    if (isUniversal(node, TAG_SEQUENCE)) {
      var parts = node.children();
      var bits = parts.map(function (p) { return describeAlgorithmParams(oid, p); });
      return "{" + bits.join(", ") + "}";
    }
    if (isUniversal(node, TAG_INTEGER)) return decodeIntegerBig(node.value);
    return bytesToHex(node.value);
  }

  // signatureAlgorithm helpers --------------------------------------------------

  function signatureFamily(oid) {
    if (/^1\.2\.840\.113549\.1\.1\.(2|4|5|11|12|13|14)$/.test(oid)) return "RSA";
    if (oid === "1.2.840.113549.1.1.10") return "RSA-PSS";
    if (/^1\.2\.840\.10045\.4\./.test(oid)) return "ECDSA";
    if (oid === "1.3.101.112" || oid === "1.3.101.113") return "EdDSA";
    if (/^2\.16\.840\.1\.101\.3\.4\.3\./.test(oid)) return "DSA";
    if (oid === "1.2.840.10040.4.3") return "DSA";
    return "unknown";
  }

  function signatureHash(oid) {
    var table = {
      "1.2.840.113549.1.1.2": "MD2", "1.2.840.113549.1.1.4": "MD5",
      "1.2.840.113549.1.1.5": "SHA-1", "1.2.840.113549.1.1.11": "SHA-256",
      "1.2.840.113549.1.1.12": "SHA-384", "1.2.840.113549.1.1.13": "SHA-512",
      "1.2.840.113549.1.1.14": "SHA-224",
      "1.2.840.10045.4.1": "SHA-1", "1.2.840.10045.4.3.1": "SHA-224",
      "1.2.840.10045.4.3.2": "SHA-256", "1.2.840.10045.4.3.3": "SHA-384",
      "1.2.840.10045.4.3.4": "SHA-512",
      "1.2.840.10040.4.3": "SHA-1", "2.16.840.1.101.3.4.3.2": "SHA-256"
    };
    return table[oid] || null;
  }

  function parsePublicKeyInfo(node) {
    var seq = requireUniversal(node, TAG_SEQUENCE, "a SubjectPublicKeyInfo");
    var parts = seq.children();
    if (parts.length < 2) throw new DerError("A SubjectPublicKeyInfo must have an algorithm and a key");
    var algorithm = parseAlgorithmIdentifier(parts[0]);
    var bits = bitStringBytes(parts[1]);
    var info = {
      algorithm: algorithm,
      keyType: keyTypeLabel(algorithm.oid),
      keySize: null,
      keySizeLabel: null,
      curve: algorithm.curveName,
      rsa: null,
      raw: bits.bytes,
      rawHex: bytesToHex(bits.bytes),
      spki: node.full
    };
    if (algorithm.oid === "1.2.840.113549.1.1.1") {
      try {
        var rsaSeq = parseDer(bits.bytes);
        var rsaParts = rsaSeq.children();
        var modulus = rsaParts[0].value;
        var exponent = rsaParts[1].value;
        info.rsa = { modulus: decodeIntegerBig(modulus), exponent: decodeIntegerBig(exponent) };
        info.keySize = bitLengthOfBytes(modulus);
        info.keySizeLabel = info.keySize + "-bit RSA";
      } catch (e) {
        info.keySize = bits.bytes.length * 8;
        info.keySizeLabel = "RSA (unparsed)";
      }
    } else if (algorithm.oid === "1.2.840.10045.2.1") {
      info.keySize = curveBits(algorithm.curve);
      info.keySizeLabel = (info.curve || "EC") + (info.keySize ? " (" + info.keySize + "-bit)" : "");
    } else if (algorithm.oid === "1.3.101.112") {
      info.keySize = 256; info.keySizeLabel = "Ed25519";
    } else if (algorithm.oid === "1.3.101.113") {
      info.keySize = 456; info.keySizeLabel = "Ed448";
    } else if (algorithm.oid === "1.2.840.10040.4.1") {
      info.keySizeLabel = "DSA";
    }
    return info;
  }

  function keyTypeLabel(oid) {
    if (oid === "1.2.840.113549.1.1.1") return "RSA";
    if (oid === "1.2.840.10045.2.1") return "EC";
    if (oid === "1.3.101.112") return "Ed25519";
    if (oid === "1.3.101.113") return "Ed448";
    if (oid === "1.2.840.10040.4.1") return "DSA";
    return "unknown";
  }

  function curveBits(oid) {
    var table = {
      "1.2.840.10045.3.1.1": 192, "1.3.132.0.33": 224,
      "1.2.840.10045.3.1.7": 256, "1.3.132.0.34": 384,
      "1.3.132.0.35": 521, "1.3.132.0.10": 256
    };
    return table[oid] || null;
  }

  // ---------------------------------------------------------------------
  // Extensions
  // ---------------------------------------------------------------------

  function parseExtensions(node) {
    // node is the SEQUENCE OF Extension inside a [3] EXPLICIT tag wrapper.
    var seq = requireUniversal(node, TAG_SEQUENCE, "an Extensions sequence");
    var list = seq.children();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      out.push(parseExtension(list[i]));
    }
    return out;
  }

  function parseExtension(node) {
    var parts = requireUniversal(node, TAG_SEQUENCE, "an Extension").children();
    if (parts.length < 2) throw new DerError("An Extension needs an OID and a value");
    var oid = decodeOid(requireUniversal(parts[0], TAG_OID, "an extension OID").value);
    var critical = false;
    var valueIndex = 1;
    if (isUniversal(parts[1], TAG_BOOLEAN)) {
      critical = parts[1].value.length > 0 && parts[1].value[0] !== 0;
      valueIndex = 2;
    }
    var extnValue = parts[valueIndex];
    var valueBytes = isUniversal(extnValue, TAG_OCTET_STRING) ? extnValue.value : new Uint8Array(0);
    var ext = {
      oid: oid,
      name: EXTENSION_NAMES[oid] || "Extension",
      critical: critical,
      valueHex: bytesToHex(valueBytes),
      decoded: null
    };
    try {
      ext.decoded = decodeExtensionValue(oid, valueBytes);
    } catch (e) {
      ext.decoded = { type: "unknown", summary: "Could not decode this extension (" + e.message + ")", details: [] };
    }
    return ext;
  }

  function decodeExtensionValue(oid, bytes) {
    switch (oid) {
      case "2.5.29.17":
      case "2.5.29.18":
        return decodeGeneralNamesExtension(bytes);
      case "2.5.29.15":
        return decodeKeyUsage(bytes);
      case "2.5.29.37":
        return decodeExtendedKeyUsage(bytes);
      case "2.5.29.19":
        return decodeBasicConstraints(bytes);
      case "2.5.29.14":
        return decodeKeyIdentifier(bytes, "Subject key identifier");
      case "2.5.29.35":
        return decodeAuthorityKeyIdentifier(bytes);
      case "2.5.29.31":
      case "2.5.29.46":
        return decodeDistributionPoints(bytes);
      case "1.3.6.1.5.5.7.1.1":
      case "1.3.6.1.5.5.7.1.11":
        return decodeAia(bytes, oid);
      case "2.5.29.32":
        return decodeCertificatePolicies(bytes);
      case "1.3.6.1.5.5.7.1.24":
        return decodeTlsFeature(bytes);
      case "2.5.29.30":
        return decodeNameConstraints(bytes);
      default:
        return { type: "raw", summary: "Not decoded — raw bytes shown below.", details: [] };
    }
  }

  function decodeGeneralName(node) {
    var kind = GENERAL_NAME_KINDS[node.tagNumber] || ("tag " + node.tagNumber);
    if (isContext(node, 2)) return { kind: "DNS", type: "dNSName", value: latin1(node.value) };
    if (isContext(node, 1)) return { kind: "Email", type: "rfc822Name", value: latin1(node.value) };
    if (isContext(node, 6)) return { kind: "URI", type: "uniformResourceIdentifier", value: latin1(node.value) };
    if (isContext(node, 7)) {
      var b = node.value;
      if (b.length === 4) return { kind: "IP", type: "iPAddress", value: b[0] + "." + b[1] + "." + b[2] + "." + b[3] };
      if (b.length === 16) {
        var groups = [];
        for (var i = 0; i < 16; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
        return { kind: "IP", type: "iPAddress", value: groups.join(":") };
      }
      return { kind: "IP", type: "iPAddress", value: bytesToHex(b) };
    }
    if (isContext(node, 8)) return { kind: "OID", type: "registeredID", value: decodeOid(node.value) };
    if (isContext(node, 0)) return { kind: "otherName", type: "otherName", value: bytesToHex(node.value) };
    if (isContext(node, 4)) {
      try {
        return { kind: "DirName", type: "directoryName", value: parseName(node.children()[0]).formatted };
      } catch (e) {
        return { kind: "DirName", type: "directoryName", value: bytesToHex(node.value) };
      }
    }
    return { kind: kind, type: kind, value: bytesToHex(node.value) };
  }

  function decodeGeneralNamesExtension(bytes) {
    var seq = parseDer(bytes);
    var names = seq.children().map(decodeGeneralName);
    var summary = names.map(function (n) { return n.value; }).join(", ");
    return { type: "generalNames", names: names, summary: summary, details: [] };
  }

  function decodeKeyUsage(bytes) {
    var bits = bitStringBytes(parseDer(bytes));
    var usages = [];
    for (var i = 0; i < KEY_USAGE_BITS.length; i++) {
      var byteIndex = Math.floor(i / 8);
      if (byteIndex < bits.bytes.length && (bits.bytes[byteIndex] & (0x80 >> (i % 8)))) usages.push(KEY_USAGE_BITS[i]);
    }
    return { type: "keyUsage", usages: usages, summary: usages.join(", ") || "none", details: [] };
  }

  function decodeExtendedKeyUsage(bytes) {
    var seq = parseDer(bytes);
    var usages = seq.children().map(function (n) {
      var oid = decodeOid(n.value);
      return { oid: oid, name: EKU_NAMES[oid] || oid };
    });
    return { type: "extendedKeyUsage", usages: usages, summary: usages.map(function (u) { return u.name; }).join(", "), details: [] };
  }

  function decodeBasicConstraints(bytes) {
    var seq = parseDer(bytes);
    var parts = seq.children();
    var ca = false;
    var pathLen = null;
    for (var i = 0; i < parts.length; i++) {
      if (isUniversal(parts[i], TAG_BOOLEAN)) ca = parts[i].value.length > 0 && parts[i].value[0] !== 0;
      else if (isUniversal(parts[i], TAG_INTEGER)) pathLen = decodeIntegerSmall(parts[i].value);
    }
    var summary = ca ? "CA: TRUE" : "CA: FALSE";
    if (pathLen !== null) summary += ", path length " + pathLen;
    return { type: "basicConstraints", ca: ca, pathLen: pathLen, summary: summary, details: [] };
  }

  function decodeKeyIdentifier(bytes, label) {
    var octets = parseDer(bytes);
    var hex = isUniversal(octets, TAG_OCTET_STRING) ? bytesToHex(octets.value) : bytesToHex(octets.value);
    return { type: "keyIdentifier", hex: hex, colon: colonHex(hexToBytes(hex) || new Uint8Array(0)), summary: colonHex(hexToBytes(hex) || new Uint8Array(0)), details: [] };
  }

  function decodeAuthorityKeyIdentifier(bytes) {
    var seq = parseDer(bytes);
    var parts = seq.children();
    var keyId = null, issuer = null, serial = null;
    for (var i = 0; i < parts.length; i++) {
      if (isContext(parts[i], 0)) keyId = bytesToHex(parts[i].value);
      else if (isContext(parts[i], 1)) {
        try { issuer = parseName(parts[i].children()[0]).formatted; } catch (e) { issuer = null; }
      } else if (isContext(parts[i], 2)) serial = decodeIntegerBig(parts[i].value);
    }
    return {
      type: "authorityKeyIdentifier",
      keyIdentifier: keyId,
      keyIdentifierColon: keyId ? colonHex(hexToBytes(keyId)) : null,
      issuer: issuer,
      serial: serial,
      summary: keyId ? colonHex(hexToBytes(keyId)) : (issuer || "present"),
      details: []
    };
  }

  function decodeDistributionPoints(bytes) {
    var seq = parseDer(bytes);
    var uris = [];
    function walk(node) {
      if (isContext(node, 6)) { uris.push(latin1(node.value)); return; }
      if (node.constructed) {
        try { node.children().forEach(walk); } catch (e) { /* ignore */ }
      }
    }
    seq.children().forEach(walk);
    return { type: "distributionPoints", uris: uris, summary: uris.join(", ") || "present (no URI found)", details: [] };
  }

  function decodeAia(bytes, oid) {
    var seq = parseDer(bytes);
    var entries = seq.children().map(function (ad) {
      var parts = ad.children();
      var method = decodeOid(parts[0].value);
      var location = parts.length > 1 ? decodeGeneralName(parts[1]) : { value: "" };
      var label = method === "1.3.6.1.5.5.7.48.1" ? "OCSP" :
                  method === "1.3.6.1.5.5.7.48.2" ? "CA Issuers" : method;
      return { method: method, label: label, value: location.value };
    });
    var summary = entries.map(function (e) { return e.label + " → " + e.value; }).join("; ");
    return { type: oid === "1.3.6.1.5.5.7.1.11" ? "sia" : "aia", entries: entries, summary: summary, details: [] };
  }

  function decodeCertificatePolicies(bytes) {
    var seq = parseDer(bytes);
    var policies = seq.children().map(function (pi) {
      var parts = pi.children();
      var oid = decodeOid(parts[0].value);
      var cps = null;
      if (parts.length > 1 && parts[1].constructed) {
        try {
          parts[1].children().forEach(function (qualifier) {
            var q = qualifier.children();
            var qOid = decodeOid(q[0].value);
            if (qOid === "1.3.6.1.5.5.7.2.1" && q[1] && q[1].constructed) {
              var ia5 = q[1].children()[0];
              if (ia5) cps = latin1(ia5.value);
            }
          });
        } catch (e) { /* ignore qualifier parse errors */ }
      }
      return { oid: oid, name: POLICY_NAMES[oid] || null, cps: cps };
    });
    var summary = policies.map(function (p) { return p.name ? p.name + " (" + p.oid + ")" : p.oid; }).join(", ");
    return { type: "certificatePolicies", policies: policies, summary: summary, details: [] };
  }

  function decodeTlsFeature(bytes) {
    var seq = parseDer(bytes);
    var features = seq.children().map(function (n) { return decodeIntegerSmall(n.value); });
    var names = features.map(function (f) {
      return f === 5 ? "status_request (OCSP must-staple)" : f === 17 ? "status_request_v2" : "feature " + f;
    });
    return { type: "tlsFeature", features: features, summary: names.join(", "), details: [] };
  }

  function decodeNameConstraints(bytes) {
    var seq = parseDer(bytes);
    var parts = seq.children();
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var label = isContext(parts[i], 0) ? "Permitted" : isContext(parts[i], 1) ? "Excluded" : "Constraint";
      var names = [];
      try {
        parts[i].children().forEach(function (subtree) {
          subtree.children().forEach(function (g) {
            if (g.constructed) g.children().forEach(function (n) { names.push(decodeGeneralName(n).value); });
            else names.push(decodeGeneralName(g).value);
          });
        });
      } catch (e) { /* ignore */ }
      out.push(label + ": " + (names.join(", ") || "present"));
    }
    return { type: "nameConstraints", summary: out.join("; "), details: [] };
  }
  // ---------------------------------------------------------------------
  // Certificate
  // ---------------------------------------------------------------------

  function parseCertificate(der) {
    var root = parseDer(der);
    requireUniversal(root, TAG_SEQUENCE, "a Certificate");
    var parts = root.children();
    if (parts.length < 3) throw new DerError("A Certificate must contain a tbsCertificate, signatureAlgorithm and signature");
    var tbs = parts[0];
    requireUniversal(tbs, TAG_SEQUENCE, "a TBSCertificate");
    var signatureAlgorithm = parseAlgorithmIdentifier(parts[1]);
    var signatureBits = bitStringBytes(parts[2]);

    var cert = {
      kind: "certificate",
      der: der,
      size: der.length,
      version: 1,
      serialNumber: null,
      serialHex: null,
      signatureAlgorithm: signatureAlgorithm,
      signatureFamily: signatureFamily(signatureAlgorithm.oid),
      signatureHash: signatureHash(signatureAlgorithm.oid),
      signatureHex: bytesToHex(signatureBits.bytes),
      signatureBytes: signatureBits.bytes,
      signatureLength: signatureBits.bytes.length,
      issuer: null,
      validity: { notBefore: null, notAfter: null },
      subject: null,
      publicKey: null,
      extensions: [],
      tbs: tbs,
      tbsBytes: tbs.full,
      fingerprintInput: der,
      warnings: []
    };

    var fields = tbs.children();
    var idx = 0;

    if (isContext(fields[0], 0)) {
      var versionInt = fields[0].children()[0];
      cert.version = decodeIntegerSmall(versionInt.value) + 1;
      idx++;
    }

    cert.serialNumber = decodeIntegerBig(requireUniversal(fields[idx], TAG_INTEGER, "a serial number").value);
    cert.serialHex = bytesToHex(fields[idx].value);
    idx++;

    cert.signatureAlgorithmInner = parseAlgorithmIdentifier(fields[idx]);
    idx++;

    cert.issuer = parseName(fields[idx]);
    idx++;

    var validity = requireUniversal(fields[idx], TAG_SEQUENCE, "a Validity").children();
    cert.validity.notBefore = decodeTime(validity[0]);
    cert.validity.notAfter = decodeTime(validity[1]);
    idx++;

    cert.subject = parseName(fields[idx]);
    idx++;

    cert.publicKey = parsePublicKeyInfo(fields[idx]);
    idx++;

    // Optional issuerUniqueID / subjectUniqueID [1] [2], then extensions [3].
    while (idx < fields.length) {
      if (isContext(fields[idx], 1)) cert.issuerUniqueId = bytesToHex(fields[idx].value);
      else if (isContext(fields[idx], 2)) cert.subjectUniqueId = bytesToHex(fields[idx].value);
      else if (isContext(fields[idx], 3)) {
        var extSeq = fields[idx].children();
        if (extSeq.length) cert.extensions = parseExtensions(extSeq[0]);
      }
      idx++;
    }

    annotateCertificate(cert);
    return cert;
  }

  function annotateCertificate(cert) {
    cert.isCA = false;
    cert.pathLen = null;
    cert.keyUsage = null;
    cert.extendedKeyUsage = null;
    cert.subjectAltNames = [];
    cert.basicConstraints = null;
    cert.subjectKeyIdentifier = null;
    cert.authorityKeyIdentifier = null;

    for (var i = 0; i < cert.extensions.length; i++) {
      var ext = cert.extensions[i];
      var d = ext.decoded;
      if (!d) continue;
      if (d.type === "basicConstraints") { cert.isCA = d.ca; cert.pathLen = d.pathLen; cert.basicConstraints = d; }
      else if (d.type === "keyUsage") cert.keyUsage = d;
      else if (d.type === "extendedKeyUsage") cert.extendedKeyUsage = d;
      else if (d.type === "generalNames" && ext.oid === "2.5.29.17") cert.subjectAltNames = d.names;
      else if (d.type === "keyIdentifier" && ext.oid === "2.5.29.14") cert.subjectKeyIdentifier = d;
      else if (d.type === "authorityKeyIdentifier") cert.authorityKeyIdentifier = d;
    }
  }

  // ---------------------------------------------------------------------
  // Certificate signing request (PKCS#10)
  // ---------------------------------------------------------------------

  function parseCsr(der) {
    var root = parseDer(der);
    requireUniversal(root, TAG_SEQUENCE, "a CertificationRequest");
    var parts = root.children();
    if (parts.length < 3) throw new DerError("A CertificationRequest must contain certificationRequestInfo, signatureAlgorithm and signature");
    var info = requireUniversal(parts[0], TAG_SEQUENCE, "a CertificationRequestInfo");
    var signatureAlgorithm = parseAlgorithmIdentifier(parts[1]);
    var signatureBits = bitStringBytes(parts[2]);

    var csr = {
      kind: "csr",
      der: der,
      size: der.length,
      version: 0,
      subject: null,
      publicKey: null,
      attributes: [],
      extensionRequest: [],
      signatureAlgorithm: signatureAlgorithm,
      signatureFamily: signatureFamily(signatureAlgorithm.oid),
      signatureHash: signatureHash(signatureAlgorithm.oid),
      signatureHex: bytesToHex(signatureBits.bytes),
      signatureBytes: signatureBits.bytes,
      tbsBytes: info.full,
      warnings: []
    };

    var fields = info.children();
    csr.version = decodeIntegerSmall(requireUniversal(fields[0], TAG_INTEGER, "a version").value);
    csr.subject = parseName(fields[1]);
    csr.publicKey = parsePublicKeyInfo(fields[2]);

    if (fields[3] && fields[3].constructed) {
      fields[3].children().forEach(function (attr) {
        var a = attr.children();
        var oid = decodeOid(a[0].value);
        var values = a[1] ? a[1].children() : [];
        var entry = { oid: oid, name: ATTRIBUTE_NAMES[oid] || oid, values: [] };
        if (oid === "1.2.840.113549.1.9.14") {
          // extensionRequest — the value of each AttributeValue is an
          // Extensions SEQUENCE OF Extension; parse it directly.
          values.forEach(function (v) {
            if (!v.constructed) return;
            try { csr.extensionRequest = parseExtensions(v); } catch (e) { /* ignore */ }
          });
          entry.values.push("extensionRequest (" + csr.extensionRequest.length + " extension" + (csr.extensionRequest.length === 1 ? "" : "s") + ")");
        } else {
          values.forEach(function (v) { entry.values.push(decodeStringValue(v)); });
        }
        csr.attributes.push(entry);
      });
    }

    annotateCsr(csr);
    return csr;
  }

  function annotateCsr(csr) {
    csr.subjectAltNames = [];
    for (var i = 0; i < csr.extensionRequest.length; i++) {
      var ext = csr.extensionRequest[i];
      if (ext.oid === "2.5.29.17" && ext.decoded && ext.decoded.names) csr.subjectAltNames = ext.decoded.names;
    }
  }

  // ---------------------------------------------------------------------
  // Security analysis
  // ---------------------------------------------------------------------

  function relativeDays(epoch, now) {
    return Math.round((epoch - now) / 86400000);
  }

  function analyzeCertificate(cert, now) {
    now = typeof now === "number" ? now : Date.now();
    var findings = [];
    function add(severity, title, detail) { findings.push({ severity: severity, title: title, detail: detail }); }

    var nb = cert.validity.notBefore;
    var na = cert.validity.notAfter;

    if (!nb.valid || !na.valid) {
      add("error", "Unreadable validity dates", "The validity window could not be parsed; expiry cannot be checked.");
    } else {
      if (now < nb.epoch) {
        add("error", "Not yet valid", "This certificate becomes valid on " + nb.iso + " (" + Math.abs(relativeDays(nb.epoch, now)) + " day(s) from now).");
      }
      if (now > na.epoch) {
        add("error", "Expired", "This certificate expired on " + na.iso + " (" + Math.abs(relativeDays(na.epoch, now)) + " day(s) ago).");
      } else if (now <= na.epoch && relativeDays(na.epoch, now) <= 30) {
        add("warning", "Expires soon", "Only " + relativeDays(na.epoch, now) + " day(s) of validity remain (expires " + na.iso + ").");
      }
      if (nb.valid && na.valid && na.epoch <= nb.epoch) {
        add("error", "Inverted validity window", "notAfter is not later than notBefore.");
      }
      var spanDays = relativeDays(na.epoch, nb.epoch);
      if (spanDays > 398) {
        add("info", "Long validity period", "The validity window is " + spanDays + " days; browsers cap publicly-trusted TLS certificates at 398 days.");
      }
    }

    // Signature algorithm strength.
    var hash = cert.signatureHash;
    if (hash === "MD2" || hash === "MD5") {
      add("error", "Broken signature hash (" + hash + ")", "The certificate is signed with " + hash + ", which is cryptographically broken and no longer trusted.");
    } else if (hash === "SHA-1") {
      add("error", "Weak signature hash (SHA-1)", "SHA-1 collisions are practical; modern browsers and CAs reject SHA-1 certificates.");
    } else if (!hash && cert.signatureFamily !== "EdDSA") {
      add("info", "Unrecognised signature algorithm", "The signature algorithm OID " + cert.signatureAlgorithm.oid + " is not in the known list; its strength cannot be assessed.");
    }

    // Public key strength.
    var pk = cert.publicKey;
    if (pk) {
      if (pk.keyType === "RSA" && pk.keySize) {
        if (pk.keySize < 1024) add("error", "RSA key too small", "A " + pk.keySize + "-bit RSA key is considered broken; use at least 2048 bits.");
        else if (pk.keySize < 2048) add("error", "Weak RSA key", "A " + pk.keySize + "-bit RSA key is deprecated; use at least 2048 bits.");
        else if (pk.keySize < 3072) add("info", "RSA key size", pk.keySize + "-bit RSA is acceptable today; 3072-bit or larger is preferred for long-lived keys.");
      } else if (pk.keyType === "EC" && pk.keySize) {
        if (pk.keySize < 224) add("error", "EC key too small", "A " + pk.keySize + "-bit curve is too weak; use P-256 or larger.");
        else if (pk.keySize < 256) add("warning", "Small EC key", "A " + pk.keySize + "-bit curve is below the recommended P-256 minimum.");
      } else if (pk.keyType === "DSA") {
        add("warning", "DSA public key", "DSA keys are legacy and increasingly unsupported by clients.");
      } else if (pk.keyType === "unknown") {
        add("info", "Unknown public key type", "The key algorithm " + (pk.algorithm ? pk.algorithm.oid : "?") + " is not recognised.");
      }
    }

    // Basic constraints / CA sanity.
    if (cert.isCA) {
      if (!cert.keyUsage || cert.keyUsage.usages.indexOf("keyCertSign") === -1) {
        add("warning", "CA without keyCertSign", "This certificate is a CA but its Key Usage does not include keyCertSign.");
      }
    } else {
      if (cert.keyUsage && cert.keyUsage.usages.indexOf("keyCertSign") !== -1) {
        add("warning", "End-entity with keyCertSign", "This is not a CA certificate, yet its Key Usage permits signing certificates.");
      }
    }

    // SAN presence for TLS leaf certificates.
    var eku = cert.extendedKeyUsage;
    var isServerCert = eku && eku.usages.some(function (u) { return u.oid === "1.3.6.1.5.5.7.3.1"; });
    if (!cert.isCA && (isServerCert || !eku)) {
      if (!cert.subjectAltNames.length) {
        add("warning", "No Subject Alternative Name", "Modern browsers ignore the Common Name and require the hostname in a subjectAltName extension.");
      }
    }

    // Hostname/CN mismatch note.
    var cn = nameValue(cert.subject, "CN");
    if (cn && cert.subjectAltNames.length) {
      var dnsNames = cert.subjectAltNames.filter(function (n) { return n.type === "dNSName"; }).map(function (n) { return n.value; });
      if (dnsNames.length && dnsNames.indexOf(cn) === -1) {
        add("info", "CN not in SAN list", "The Common Name (\"" + cn + "\") is not among the subjectAltName DNS entries; clients match against the SAN list only.");
      }
    }

    // Self-signed check.
    if (cert.subject.formatted === cert.issuer.formatted) {
      add("info", "Self-signed", "The subject and issuer are identical. This certificate is not issued by a public CA.");
    }

    // Missing key identifiers.
    if (!cert.subjectKeyIdentifier) add("info", "No Subject Key Identifier", "The subjectKeyIdentifier extension is missing, which can complicate chain building.");
    if (!cert.authorityKeyIdentifier) add("info", "No Authority Key Identifier", "The authorityKeyIdentifier extension is missing, which can complicate chain building.");

    // Revocation information.
    var hasOcsp = cert.extensions.some(function (e) { return e.decoded && e.decoded.type === "aia" && e.decoded.entries.some(function (x) { return x.label === "OCSP"; }); });
    var hasCrl = cert.extensions.some(function (e) { return e.decoded && e.decoded.type === "distributionPoints" && e.decoded.uris.length; });
    if (!cert.isCA && !hasOcsp && !hasCrl) {
      add("info", "No revocation endpoints", "Neither an OCSP responder nor a CRL distribution point is listed, so revocation cannot be checked automatically.");
    }

    return { findings: findings, summary: summarizeFindings(findings) };
  }

  function analyzeCsr(csr, now) {
    now = typeof now === "number" ? now : Date.now();
    var findings = [];
    function add(severity, title, detail) { findings.push({ severity: severity, title: title, detail: detail }); }

    var hash = csr.signatureHash;
    if (hash === "MD5" || hash === "MD2") add("error", "Broken signature hash (" + hash + ")", "The request is signed with " + hash + ".");
    else if (hash === "SHA-1") add("warning", "Weak signature hash (SHA-1)", "The request is signed with SHA-1; SHA-256 or better is recommended.");

    var pk = csr.publicKey;
    if (pk) {
      if (pk.keyType === "RSA" && pk.keySize && pk.keySize < 2048) {
        add(pk.keySize < 1024 ? "error" : "warning", "Small RSA key", "The request contains a " + pk.keySize + "-bit RSA key; 2048 bits or more is expected.");
      } else if (pk.keyType === "EC" && pk.keySize && pk.keySize < 256) {
        add("warning", "Small EC key", "The request uses a " + pk.keySize + "-bit curve; P-256 or larger is recommended.");
      }
    }

    if (!csr.subjectAltNames.length) {
      add("info", "No SAN requested", "The request does not ask for a subjectAltName extension. For a TLS certificate you normally want the hostnames included here.");
    }
    if (!csr.subject.formatted) {
      add("warning", "Empty subject", "The request has an empty subject distinguished name.");
    }
    var cn = nameValue(csr.subject, "CN");
    if (!cn && !csr.subjectAltNames.length) {
      add("warning", "No Common Name and no SAN", "The request identifies no hostname at all.");
    }

    return { findings: findings, summary: summarizeFindings(findings) };
  }

  function summarizeFindings(findings) {
    var counts = { error: 0, warning: 0, info: 0 };
    for (var i = 0; i < findings.length; i++) counts[findings[i].severity]++;
    return counts;
  }

  // ---------------------------------------------------------------------
  // Fingerprints & hashing
  // ---------------------------------------------------------------------

  function getSubtle() {
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto.subtle;
    if (typeof crypto !== "undefined" && crypto.subtle) return crypto.subtle;
    if (typeof module === "object" && module.exports) {
      try {
        var nodeCrypto = require("crypto");
        if (nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle) return nodeCrypto.webcrypto.subtle;
      } catch (e) { /* no webcrypto */ }
    }
    return null;
  }

  function hashBytes(bytes, algorithm) {
    var subtle = getSubtle();
    if (subtle) {
      return subtle.digest(algorithm, bytes).then(function (buf) {
        return new Uint8Array(buf);
      });
    }
    if (typeof module === "object" && module.exports) {
      try {
        var nodeCrypto = require("crypto");
        var name = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" }[algorithm];
        if (name) {
          return Promise.resolve(new Uint8Array(nodeCrypto.createHash(name).update(Buffer.from(bytes)).digest()));
        }
      } catch (e) { /* fall through */ }
    }
    return Promise.resolve(null);
  }

  function computeFingerprints(der) {
    var algorithms = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"];
    return Promise.all(algorithms.map(function (alg) {
      return hashBytes(der, alg).then(function (digest) {
        return {
          algorithm: alg,
          hex: digest ? bytesToHex(digest) : null,
          colon: digest ? colonHex(digest) : null,
          base64: digest ? bytesToBase64(digest) : null
        };
      });
    })).then(function (list) {
      var out = {};
      list.forEach(function (f) { out[f.algorithm] = f; });
      return out;
    });
  }

  function computeKeyIdentifier(publicKeyBytes) {
    // RFC 5280 method (1): SHA-1 of the BIT STRING contents of subjectPublicKey.
    return hashBytes(publicKeyBytes, "SHA-1").then(function (digest) {
      return digest ? colonHex(digest) : null;
    });
  }

  // ---------------------------------------------------------------------
  // Signature verification
  // ---------------------------------------------------------------------

  var VERIFIABLE_HASHES = ["SHA-1", "SHA-224", "SHA-256", "SHA-384", "SHA-512"];

  // Map an X.509 signature algorithm OID onto the Web Crypto import parameters
  // for the issuer's key plus the digest to use, or null when the combination
  // cannot be checked with Web Crypto (DSA, Ed25519 on older engines, RSASSA-PSS).
  function verifyParams(sigOid, keyAlgorithm) {
    var hash = signatureHash(sigOid);
    var family = signatureFamily(sigOid);
    if (VERIFIABLE_HASHES.indexOf(hash) === -1) return null;
    if (keyAlgorithm === "RSA" && family === "RSA") {
      return { verifyParams: { name: "RSASSA-PKCS1-v1_5" }, hash: hash };
    }
    if (keyAlgorithm === "EC" && family === "ECDSA") {
      return { verifyParams: { name: "ECDSA", hash: hash }, hash: hash };
    }
    return null;
  }

  function unsupportedReason(child, issuer) {
    var hash = child.signatureHash;
    var family = child.signatureFamily;
    var keyType = issuer && issuer.publicKey ? issuer.publicKey.keyType : "unknown";
    if (family === "RSA" || family === "ECDSA") {
      if (keyType !== family) {
        return "The signature algorithm is " + (family === "RSA" ? "RSA" : "ECDSA") +
          " but the issuer's key is " + keyType + ", so this pair cannot match.";
      }
    }
    if (family === "RSA-PSS") return "RSASSA-PSS signatures are not supported by the browser's Web Crypto API.";
    if (family === "EdDSA") return "Ed25519/Ed448 signatures are not supported by this browser's Web Crypto API.";
    if (family === "DSA") return "DSA signatures are not supported by the browser's Web Crypto API.";
    if (!hash) return "The signature algorithm is unknown, so it cannot be checked.";
    return hash + " signatures are not supported by the browser's Web Crypto API.";
  }

  function importIssuerKey(child, issuer) {
    var subtle = getSubtle();
    if (!subtle || !issuer || !issuer.publicKey) return Promise.resolve(null);
    var keyType = issuer.publicKey.keyType;
    var sigOid = child.signatureAlgorithm ? child.signatureAlgorithm.oid : null;
    if (!sigOid) return Promise.resolve(null);
    var params = verifyParams(sigOid, keyType);
    if (!params) return Promise.resolve(null);

    var importParams;
    if (keyType === "EC") {
      importParams = { name: "ECDSA", namedCurve: curveWebCryptoName(issuer.publicKey.algorithm.curve) };
      if (!importParams.namedCurve) return Promise.resolve(null);
    } else {
      importParams = { name: "RSASSA-PKCS1-v1_5", hash: params.hash };
    }
    return subtle.importKey("spki", issuer.publicKey.spki, importParams, false, ["verify"])
      .then(function (key) { return { key: key, verifyParams: params.verifyParams, hash: params.hash }; })
      .catch(function () { return null; });
  }

  function curveWebCryptoName(oid) {
    var table = {
      "1.2.840.10045.3.1.1": "P-192", "1.3.132.0.33": "P-224",
      "1.2.840.10045.3.1.7": "P-256", "1.3.132.0.34": "P-384",
      "1.3.132.0.35": "P-521", "1.3.132.0.10": "K-256"
    };
    return table[oid] || null;
  }

  // Verify the signature over `child` using the public key of `issuer`.
  // Returns a promise resolving to a small status object — never throws.
  function verifySignature(child, issuer) {
    if (!child || child.kind !== "certificate" && child.kind !== "csr") {
      return Promise.resolve({ status: "unsupported", reason: "Only certificates and requests can be verified." });
    }
    if (!issuer || !issuer.publicKey) {
      return Promise.resolve({ status: "unsupported", reason: "No issuer key was supplied." });
    }
    var sigOid = child.signatureAlgorithm && child.signatureAlgorithm.oid;
    var expected = verifyParams(sigOid, issuer.publicKey.keyType);
    if (!expected) {
      return Promise.resolve({
        status: "unsupported",
        reason: unsupportedReason(child, issuer)
      });
    }
    return importIssuerKey(child, issuer).then(function (imported) {
      if (!imported) {
        return { status: "unsupported", reason: "The issuer's public key could not be imported for verification." };
      }
      var sig = child.signatureBytes;
      // ECDSA signatures are DER-encoded (r, s) pairs; Web Crypto wants the raw
      // fixed-width concatenation, so convert when needed.
      if (issuer.publicKey.keyType === "EC") {
        try {
          sig = ecdsaDerToRaw(child.signatureBytes, curveByteLength(issuer.publicKey.algorithm.curve));
        } catch (e) {
          return { status: "invalid", reason: "The ECDSA signature is not a well-formed DER (r, s) pair." };
        }
      }
      return getSubtle().verify(imported.verifyParams, imported.key, sig, child.tbsBytes)
        .then(function (ok) { return { status: ok ? "valid" : "invalid", hash: expected.hash }; })
        .catch(function () { return { status: "invalid", reason: "The signature did not verify against the issuer key." }; });
    });
  }

  function curveByteLength(oid) {
    var bits = curveBits(oid);
    return bits ? Math.ceil(bits / 8) : null;
  }

  // Convert a DER SEQUENCE { INTEGER r, INTEGER s } into the fixed-length
  // big-endian r||s form Web Crypto expects for ECDSA.
  function ecdsaDerToRaw(der, byteLength) {
    if (!byteLength) throw new DerError("Unknown curve size");
    var seq = parseDer(der);
    requireUniversal(seq, TAG_SEQUENCE, "an ECDSA signature");
    var parts = seq.children();
    if (parts.length !== 2) throw new DerError("An ECDSA signature needs exactly two integers");
    function fixed(intBytes) {
      var bytes = intBytes;
      var i = 0;
      while (i < bytes.length - 1 && bytes[i] === 0) i++;
      bytes = bytes.subarray(i);
      if (bytes.length > byteLength) throw new DerError("ECDSA integer is larger than the curve size");
      var out = new Uint8Array(byteLength);
      out.set(bytes, byteLength - bytes.length);
      return out;
    }
    var r = fixed(parts[0].value);
    var s = fixed(parts[1].value);
    var raw = new Uint8Array(byteLength * 2);
    raw.set(r, 0);
    raw.set(s, byteLength);
    return raw;
  }

  // ---------------------------------------------------------------------
  // Chain building
  // ---------------------------------------------------------------------

  function keyIdentifierOf(cert) {
    if (cert.subjectKeyIdentifier && cert.subjectKeyIdentifier.hex) return cert.subjectKeyIdentifier.hex;
    if (cert.computedKeyIdentifier) return cert.computedKeyIdentifier.replace(/:/g, "").toLowerCase();
    return null;
  }

  function authorityIdentifierOf(cert) {
    if (cert.authorityKeyIdentifier && cert.authorityKeyIdentifier.keyIdentifier) {
      return cert.authorityKeyIdentifier.keyIdentifier;
    }
    return null;
  }

  function isSelfIssued(cert) {
    return !!(cert.subject && cert.issuer && cert.subject.formatted === cert.issuer.formatted);
  }

  // Order a bag of certificates into a leaf → … → root chain and report
  // anything that could not be linked. Signatures are not verified here.
  function buildChain(certificates) {
    var certs = (certificates || []).filter(function (c) { return c && c.kind === "certificate"; });
    if (certs.length === 0) {
      return { ok: false, error: "No certificates to build a chain from.", chain: [], links: [], unused: [] };
    }

    var byKeyId = {};
    certs.forEach(function (c) {
      var kid = keyIdentifierOf(c);
      if (kid) byKeyId[kid] = c;
    });

    function findIssuer(child) {
      var aki = authorityIdentifierOf(child);
      if (aki && byKeyId[aki] && byKeyId[aki] !== child) return byKeyId[aki];
      // Fall back to matching subject name, preferring a different certificate.
      for (var i = 0; i < certs.length; i++) {
        var c = certs[i];
        if (c === child) continue;
        if (c.subject.formatted === child.issuer.formatted) return c;
      }
      return null;
    }

    function isRoot(c) { return isSelfIssued(c); }

    // Prefer a non-self-issued certificate with no issuer present as the leaf.
    var leaf = null;
    for (var i = 0; i < certs.length && !leaf; i++) {
      if (!isRoot(certs[i]) && !findIssuer(certs[i])) leaf = certs[i];
    }
    if (!leaf) {
      for (var j = 0; j < certs.length && !leaf; j++) {
        if (!isRoot(certs[j])) leaf = certs[j];
      }
    }
    if (!leaf) leaf = certs[0];

    var chain = [];
    var links = [];
    var used = [];
    var current = leaf;
    var guard = 0;
    while (current && guard++ <= certs.length + 1) {
      chain.push(current);
      used.push(current);
      if (isRoot(current)) {
        links.push({ from: current, to: current, reason: "self-signed root", selfSigned: true });
        break;
      }
      var issuer = findIssuer(current);
      if (!issuer) {
        links.push({ from: current, to: null, reason: "issuer not found in the supplied set" });
        break;
      }
      links.push({ from: current, to: issuer, reason: authorityIdentifierOf(current) ? "matched by key identifier" : "matched by subject name" });
      current = issuer;
    }

    var unused = certs.filter(function (c) { return used.indexOf(c) === -1; });
    var complete = chain.length > 0 && isRoot(chain[chain.length - 1]);

    return { ok: true, chain: chain, links: links, unused: unused, complete: complete };
  }

  // Verify each issuer → subject link in a chain, in order.
  function verifyChain(chain) {
    var pairs = [];
    for (var i = 0; i < chain.length - 1; i++) pairs.push([chain[i], chain[i + 1]]);
    return Promise.all(pairs.map(function (pair) {
      return verifySignature(pair[0], pair[1]).then(function (res) {
        return { child: pair[0], issuer: pair[1], result: res };
      });
    })).then(function (results) {
      var selfSigned = null;
      if (chain.length && isSelfIssued(chain[chain.length - 1])) {
        selfSigned = chain[chain.length - 1];
      }
      if (selfSigned) {
        return verifySignature(selfSigned, selfSigned).then(function (res) {
          return { links: results, selfSignature: { certificate: selfSigned, result: res } };
        });
      }
      return { links: results, selfSignature: null };
    });
  }

  // ---------------------------------------------------------------------
  // One-shot parsing entry point
  // ---------------------------------------------------------------------

  function parseBlock(block) {
    var node;
    try {
      node = parseDer(block.der);
    } catch (e) {
      return { ok: false, error: "This block is not valid DER (" + e.message + ")." };
    }
    if (!node.constructed || node.cls !== CLASS_UNIVERSAL || node.tagNumber !== TAG_SEQUENCE) {
      return { ok: false, error: "The top-level ASN.1 value is not a SEQUENCE, so it is not a certificate or a request." };
    }
    var firstChild = null;
    try { firstChild = node.children()[0]; } catch (e) { firstChild = null; }

    var asCert = null;
    var asCsr = null;
    var certError = null;
    var csrError = null;

    try { asCert = parseCertificate(block.der); } catch (e) { certError = e.message; }
    try { asCsr = parseCsr(block.der); } catch (e) { csrError = e.message; }

    // Disambiguate: a certificate has three top-level elements and the first is
    // a SEQUENCE; a CSR likewise, so prefer the parse that succeeds. If both
    // "succeed", pick by structure — certificates have a validity SEQUENCE with
    // two times, requests have a third element that is a context [0] attributes.
    var chosen = null;
    if (asCert && asCsr) {
      var third = null;
      try { third = node.children()[2]; } catch (e) { third = null; }
      if (third && isContext(third, 0)) chosen = asCsr;
      else chosen = asCert;
    } else if (asCert) {
      chosen = asCert;
    } else if (asCsr) {
      chosen = asCsr;
    } else {
      return {
        ok: false,
        error: "Could not parse this block as a certificate or a request. " +
          "Certificate error: " + certError + ". Request error: " + csrError + "."
      };
    }

    if (block.kind === "certificate" && chosen.kind === "csr") { /* keep chosen */ }
    return { ok: true, value: chosen };
  }

  function inspect(input, options) {
    options = options || {};
    var now = typeof options.now === "number" ? options.now : Date.now();
    var decoded = decodeInput(input);
    if (!decoded.ok) {
      return Promise.resolve({ ok: false, error: decoded.error, kind: decoded.kind || null });
    }

    var parsed = [];
    var errors = [];
    decoded.blocks.forEach(function (block, i) {
      var res = parseBlock(block);
      if (!res.ok) {
        errors.push({ index: i, label: block.label, error: res.error });
        return;
      }
      var value = res.value;
      value.sourceLabel = block.label;
      value.source = block.source;
      if (value.kind === "certificate") {
        value.analysis = analyzeCertificate(value, now);
      } else {
        value.analysis = analyzeCsr(value, now);
      }
      parsed.push(value);
    });

    if (parsed.length === 0) {
      return Promise.resolve({
        ok: false,
        error: errors.length ? errors[0].error : "Nothing could be parsed from the input.",
        errors: errors
      });
    }

    return Promise.all(parsed.map(function (value) {
      return computeFingerprints(value.der).then(function (fps) {
        value.fingerprints = fps;
        if (value.kind === "certificate" && value.publicKey) {
          return computeKeyIdentifier(value.publicKey.raw).then(function (kid) {
            value.computedKeyIdentifier = kid;
            return value;
          });
        }
        return value;
      });
    })).then(function (items) {
      return { ok: true, items: items, errors: errors, skippedPrivateKeys: decoded.skippedPrivateKeys || 0 };
    });
  }

  // ---------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------

  function certificateToJson(cert) {
    return {
      kind: cert.kind,
      version: cert.version,
      serialNumber: cert.serialNumber,
      serialHex: cert.serialHex,
      subject: cert.subject.formatted,
      issuer: cert.issuer.formatted,
      validity: {
        notBefore: cert.validity.notBefore ? cert.validity.notBefore.iso : null,
        notAfter: cert.validity.notAfter ? cert.validity.notAfter.iso : null
      },
      signatureAlgorithm: cert.signatureAlgorithm.name,
      signatureAlgorithmOid: cert.signatureAlgorithm.oid,
      signatureHash: cert.signatureHash,
      signatureBytes: cert.signatureLength,
      publicKey: cert.publicKey ? {
        type: cert.publicKey.keyType,
        size: cert.publicKey.keySize,
        curve: cert.publicKey.curve
      } : null,
      isCA: cert.isCA,
      pathLen: cert.pathLen,
      keyUsage: cert.keyUsage ? cert.keyUsage.usages : null,
      extendedKeyUsage: cert.extendedKeyUsage ? cert.extendedKeyUsage.usages.map(function (u) { return u.name; }) : null,
      subjectAltNames: cert.subjectAltNames.map(function (n) { return { type: n.type, value: n.value }; }),
      fingerprints: cert.fingerprints,
      extensions: cert.extensions.map(function (e) {
        return { oid: e.oid, name: e.name, critical: e.critical, summary: e.decoded ? e.decoded.summary : null };
      })
    };
  }

  function csrToJson(csr) {
    return {
      kind: csr.kind,
      version: csr.version,
      subject: csr.subject.formatted,
      signatureAlgorithm: csr.signatureAlgorithm.name,
      signatureAlgorithmOid: csr.signatureAlgorithm.oid,
      signatureHash: csr.signatureHash,
      publicKey: csr.publicKey ? {
        type: csr.publicKey.keyType,
        size: csr.publicKey.keySize,
        curve: csr.publicKey.curve
      } : null,
      attributes: csr.attributes.map(function (a) { return { oid: a.oid, name: a.name, values: a.values }; }),
      requestedExtensions: csr.extensionRequest.map(function (e) {
        return { oid: e.oid, name: e.name, critical: e.critical, summary: e.decoded ? e.decoded.summary : null };
      }),
      subjectAltNames: csr.subjectAltNames.map(function (n) { return { type: n.type, value: n.value }; })
    };
  }

  function toJsonReport(result) {
    return {
      items: result.items.map(function (item) {
        var base = item.kind === "certificate" ? certificateToJson(item) : csrToJson(item);
        base.analysis = item.analysis.findings.map(function (f) { return { severity: f.severity, title: f.title, detail: f.detail }; });
        return base;
      })
    };
  }

  function formatDn(name) {
    return name.formatted;
  }

  function formatDate(epoch) {
    if (typeof epoch !== "number" || isNaN(epoch)) return "—";
    var d = new Date(epoch);
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
      " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + " UTC";
  }

  function validityState(item, now) {
    now = typeof now === "number" ? now : Date.now();
    if (!item.validity || !item.validity.notBefore || !item.validity.notAfter) return "n/a";
    if (!item.validity.notBefore.valid || !item.validity.notAfter.valid) return "unknown";
    if (now < item.validity.notBefore.epoch) return "not-yet-valid";
    if (now > item.validity.notAfter.epoch) return "expired";
    if (relativeDays(item.validity.notAfter.epoch, now) <= 30) return "expiring";
    return "valid";
  }

  return {
    // decoding
    decodeInput: decodeInput,
    decodePemBlocks: decodePemBlocks,
    // asn1 primitives
    parseDer: parseDer,
    decodeOid: decodeOid,
    decodeIntegerBig: decodeIntegerBig,
    decodeIntegerSmall: decodeIntegerSmall,
    bitLengthOfBytes: bitLengthOfBytes,
    decodeTime: decodeTime,
    // structures
    parseCertificate: parseCertificate,
    parseCsr: parseCsr,
    parseName: parseName,
    nameValue: nameValue,
    parsePublicKeyInfo: parsePublicKeyInfo,
    parseExtensions: parseExtensions,
    parseBlock: parseBlock,
    // analysis
    inspect: inspect,
    analyzeCertificate: analyzeCertificate,
    analyzeCsr: analyzeCsr,
    validityState: validityState,
    relativeDays: relativeDays,
    // fingerprints
    computeFingerprints: computeFingerprints,
    computeKeyIdentifier: computeKeyIdentifier,
    hashBytes: hashBytes,
    // chain & verification
    buildChain: buildChain,
    verifySignature: verifySignature,
    verifyChain: verifyChain,
    ecdsaDerToRaw: ecdsaDerToRaw,
    // formatting / export
    certificateToJson: certificateToJson,
    csrToJson: csrToJson,
    toJsonReport: toJsonReport,
    formatDate: formatDate,
    formatDn: formatDn,
    bytesToHex: bytesToHex,
    colonHex: colonHex,
    bytesToBase64: bytesToBase64,
    bytesFromBase64: bytesFromBase64,
    utf8ToBytes: utf8ToBytes,
    bytesEqual: bytesEqual,
    // constants
    OID_NAMES: OID_NAMES,
    EXTENSION_NAMES: EXTENSION_NAMES,
    EKU_NAMES: EKU_NAMES,
    KEY_USAGE_BITS: KEY_USAGE_BITS,
    GENERAL_NAME_KINDS: GENERAL_NAME_KINDS,
    DerError: DerError
  };
});
