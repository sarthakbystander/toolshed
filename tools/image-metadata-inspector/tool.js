/* Toolshed — Image Metadata Inspector
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.imageMetadataInspector and in Node via require() for tests.
 *
 * Everything works on an in-memory Uint8Array of the file's bytes. The module
 * never touches the network, never uses eval/dynamic code execution, never
 * writes to storage, and never decodes pixels — it reads container structure
 * and metadata segments only, so it is safe on untrusted files.
 *
 * Supported containers: JPEG (EXIF, XMP, IPTC/Photoshop, ICC, comments),
 * PNG (text chunks, EXIF, XMP), WebP (EXIF, XMP, ICC, VP8X) and GIF.
 *
 * All parsing is defensive: a malformed offset, out-of-range length or
 * truncated segment produces a warning and is skipped, never an exception.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.imageMetadataInspector = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "1.0.0";

  // ---------------------------------------------------------------------
  // Byte helpers
  // ---------------------------------------------------------------------

  function toBytes(input) {
    if (input == null) return null;
    if (input instanceof Uint8Array) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (typeof ArrayBuffer !== "undefined" && input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    if (Array.isArray(input)) return Uint8Array.from(input);
    return null;
  }

  function ascii(bytes, start, length) {
    var out = "";
    var end = Math.min(bytes.length, start + length);
    for (var i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function hasPrefix(bytes, offset, str) {
    if (offset + str.length > bytes.length) return false;
    for (var i = 0; i < str.length; i++) {
      if (bytes[offset + i] !== str.charCodeAt(i)) return false;
    }
    return true;
  }

  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

  // Decode a byte run as UTF-8, falling back to Latin-1 for invalid sequences.
  function decodeText(bytes) {
    if (typeof TextDecoder === "function") {
      try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); }
      catch (e) { /* fall through */ }
    }
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function trimNull(s) {
    var i = s.indexOf("\u0000");
    return (i === -1 ? s : s.slice(0, i)).replace(/\s+$/, "");
  }

  // ---------------------------------------------------------------------
  // EXIF tag tables
  // ---------------------------------------------------------------------

  var IFD0_TAGS = {
    0x0100: { name: "ImageWidth" },
    0x0101: { name: "ImageHeight" },
    0x0102: { name: "BitsPerSample" },
    0x0103: { name: "Compression" },
    0x0106: { name: "PhotometricInterpretation" },
    0x010E: { name: "ImageDescription" },
    0x010F: { name: "Make" },
    0x0110: { name: "Model" },
    0x0112: { name: "Orientation" },
    0x0115: { name: "SamplesPerPixel" },
    0x011A: { name: "XResolution" },
    0x011B: { name: "YResolution" },
    0x011C: { name: "PlanarConfiguration" },
    0x0128: { name: "ResolutionUnit" },
    0x0131: { name: "Software" },
    0x0132: { name: "DateTime" },
    0x013B: { name: "Artist" },
    0x013E: { name: "WhitePoint" },
    0x013F: { name: "PrimaryChromaticities" },
    0x0201: { name: "JPEGInterchangeFormat", pointer: true },
    0x0202: { name: "JPEGInterchangeFormatLength" },
    0x0211: { name: "YCbCrCoefficients" },
    0x0213: { name: "YCbCrPositioning" },
    0x0214: { name: "ReferenceBlackWhite" },
    0x8298: { name: "Copyright" },
    0x8769: { name: "ExifIFDPointer", pointer: true },
    0x8825: { name: "GPSInfoIFDPointer", pointer: true },
    0x9C9B: { name: "XPTitle" },
    0x9C9C: { name: "XPComment" },
    0x9C9D: { name: "XPAuthor" },
    0x9C9E: { name: "XPKeywords" },
    0x9C9F: { name: "XPSubject" }
  };

  var EXIF_TAGS = {
    0x829A: { name: "ExposureTime", kind: "exposure" },
    0x829D: { name: "FNumber", kind: "aperture" },
    0x8822: { name: "ExposureProgram", kind: "enum", map: {
      0: "Not defined", 1: "Manual", 2: "Normal program", 3: "Aperture priority",
      4: "Shutter priority", 5: "Creative program", 6: "Action program",
      7: "Portrait mode", 8: "Landscape mode" } },
    0x8827: { name: "ISOSpeedRatings" },
    0x8830: { name: "SensitivityType" },
    0x9000: { name: "ExifVersion" },
    0x9003: { name: "DateTimeOriginal" },
    0x9004: { name: "DateTimeDigitized" },
    0x9010: { name: "OffsetTime" },
    0x9011: { name: "OffsetTimeOriginal" },
    0x9201: { name: "ShutterSpeedValue", kind: "rational" },
    0x9202: { name: "ApertureValue", kind: "rational" },
    0x9204: { name: "ExposureBiasValue", kind: "signed" },
    0x9205: { name: "MaxApertureValue", kind: "rational" },
    0x9207: { name: "MeteringMode", kind: "enum", map: {
      0: "Unknown", 1: "Average", 2: "Center-weighted average", 3: "Spot",
      4: "Multi-spot", 5: "Pattern", 6: "Partial", 255: "Other" } },
    0x9208: { name: "LightSource" },
    0x9209: { name: "Flash", kind: "enum", map: {
      0x00: "No flash", 0x01: "Fired", 0x05: "Fired, return light not detected",
      0x07: "Fired, return light detected", 0x09: "Fired, compulsory",
      0x0D: "Fired, compulsory, no return", 0x0F: "Fired, compulsory, return detected",
      0x10: "Did not fire, compulsory", 0x18: "Did not fire, auto",
      0x19: "Fired, auto", 0x1D: "Fired, auto, no return", 0x1F: "Fired, auto, return detected",
      0x20: "No flash function", 0x41: "Fired, red-eye reduction",
      0x45: "Fired, red-eye reduction, no return",
      0x47: "Fired, red-eye reduction, return detected",
      0x49: "Fired, compulsory, red-eye reduction",
      0x4D: "Fired, compulsory, red-eye reduction, no return",
      0x4F: "Fired, compulsory, red-eye reduction, return detected",
      0x59: "Fired, auto, red-eye reduction", 0x5D: "Fired, auto, red-eye reduction, no return",
      0x5F: "Fired, auto, red-eye reduction, return detected" } },
    0x920A: { name: "FocalLength", kind: "focal" },
    0x927C: { name: "MakerNote", binary: true },
    0x9286: { name: "UserComment", kind: "usercomment" },
    0x9290: { name: "SubSecTime" },
    0x9291: { name: "SubSecTimeOriginal" },
    0x9292: { name: "SubSecTimeDigitized" },
    0xA000: { name: "FlashpixVersion" },
    0xA001: { name: "ColorSpace", kind: "enum", map: { 1: "sRGB", 2: "Adobe RGB", 0xFFFF: "Uncalibrated" } },
    0xA002: { name: "PixelXDimension" },
    0xA003: { name: "PixelYDimension" },
    0xA005: { name: "InteroperabilityIFDPointer", pointer: true },
    0xA20E: { name: "FocalPlaneXResolution" },
    0xA20F: { name: "FocalPlaneYResolution" },
    0xA210: { name: "FocalPlaneResolutionUnit" },
    0xA402: { name: "ExposureMode", kind: "enum", map: { 0: "Auto", 1: "Manual", 2: "Auto bracket" } },
    0xA403: { name: "WhiteBalance", kind: "enum", map: { 0: "Auto", 1: "Manual" } },
    0xA404: { name: "DigitalZoomRatio", kind: "rational" },
    0xA405: { name: "FocalLengthIn35mmFilm" },
    0xA406: { name: "SceneCaptureType", kind: "enum", map: {
      0: "Standard", 1: "Landscape", 2: "Portrait", 3: "Night scene" } },
    0xA407: { name: "GainControl" },
    0xA408: { name: "Contrast" },
    0xA409: { name: "Saturation" },
    0xA40A: { name: "Sharpness" },
    0xA40C: { name: "SubjectDistanceRange" },
    0xA420: { name: "ImageUniqueID" },
    0xA430: { name: "CameraOwnerName" },
    0xA431: { name: "BodySerialNumber" },
    0xA432: { name: "LensSpecification", kind: "rational" },
    0xA433: { name: "LensMake" },
    0xA434: { name: "LensModel" },
    0xA435: { name: "LensSerialNumber" }
  };

  var GPS_TAGS = {
    0x0000: { name: "GPSVersionID" },
    0x0001: { name: "GPSLatitudeRef" },
    0x0002: { name: "GPSLatitude", kind: "dms" },
    0x0003: { name: "GPSLongitudeRef" },
    0x0004: { name: "GPSLongitude", kind: "dms" },
    0x0005: { name: "GPSAltitudeRef" },
    0x0006: { name: "GPSAltitude", kind: "meters" },
    0x0007: { name: "GPSTimeStamp", kind: "dms" },
    0x0008: { name: "GPSSatellites" },
    0x0009: { name: "GPSStatus" },
    0x000A: { name: "GPSMeasureMode" },
    0x000B: { name: "GPSDOP" },
    0x000C: { name: "GPSSpeedRef" },
    0x000D: { name: "GPSSpeed" },
    0x000E: { name: "GPSTrackRef" },
    0x000F: { name: "GPSTrack" },
    0x0010: { name: "GPSImgDirectionRef" },
    0x0011: { name: "GPSImgDirection" },
    0x0012: { name: "GPSMapDatum" },
    0x0013: { name: "GPSDestLatitudeRef" },
    0x001D: { name: "GPSDateStamp" },
    0x001F: { name: "GPSProcessingMethod" },
    0x0020: { name: "GPSAreaInformation" }
  };

  var INTEROP_TAGS = {
    0x0001: { name: "InteroperabilityIndex" },
    0x0002: { name: "InteroperabilityVersion" },
    0x1000: { name: "RelatedImageFileFormat" },
    0x1001: { name: "RelatedImageWidth" },
    0x1002: { name: "RelatedImageLength" }
  };

  var TYPE_NAMES = {
    1: "BYTE", 2: "ASCII", 3: "SHORT", 4: "LONG", 5: "RATIONAL",
    6: "SBYTE", 7: "UNDEFINED", 8: "SSHORT", 9: "SLONG", 10: "SRATIONAL",
    11: "FLOAT", 12: "DOUBLE"
  };

  var TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  var POINTER_TAGS = { 0x8769: "exif", 0x8825: "gps", 0xA005: "interop" };

  // ---------------------------------------------------------------------
  // EXIF parsing
  // ---------------------------------------------------------------------

  function parseExif(input) {
    var bytes = toBytes(input);
    var result = {
      present: true,
      byteOrder: null,
      ifd0: [],
      exif: [],
      gps: [],
      interop: [],
      ifd1: [],
      thumbnail: null,
      warnings: []
    };
    if (!bytes || bytes.length < 8) {
      result.warnings.push("EXIF block is too short to contain a TIFF header.");
      return result;
    }

    var little;
    if (bytes[0] === 0x49 && bytes[1] === 0x49) { little = true; result.byteOrder = "little-endian (Intel)"; }
    else if (bytes[0] === 0x4D && bytes[1] === 0x4D) { little = false; result.byteOrder = "big-endian (Motorola)"; }
    else {
      result.warnings.push("EXIF block has no valid TIFF byte-order marker.");
      return result;
    }

    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    function get16(o) { return dv.getUint16(o, little); }
    function get32(o) { return dv.getUint32(o, little); }

    if (get16(2) !== 0x002A) {
      result.warnings.push("EXIF block has an unexpected TIFF magic number.");
      return result;
    }

    var visited = {};
    var depth = 0;

    function parseIfd(offset, tags, group) {
      var entries = [];
      if (depth > 6) return { entries: entries, next: 0 };
      depth++;
      if (offset == null || offset <= 0 || offset + 2 > bytes.length) {
        depth--;
        return { entries: entries, next: 0 };
      }
      if (visited[offset]) { depth--; return { entries: entries, next: 0 }; }
      visited[offset] = true;

      var count = get16(offset);
      if (count > 512 || offset + 2 + count * 12 > bytes.length) {
        result.warnings.push("An EXIF IFD at offset " + offset + " has an invalid entry count.");
        depth--;
        return { entries: entries, next: 0 };
      }

      for (var i = 0; i < count; i++) {
        var eo = offset + 2 + i * 12;
        var tag = get16(eo);
        var type = get16(eo + 2);
        var n = get32(eo + 4);
        var spec = tags[tag] || null;
        var entry = {
          tag: tag,
          group: group,
          name: spec ? spec.name : "Tag 0x" + tag.toString(16).toUpperCase(),
          known: !!spec,
          kind: spec && spec.kind ? spec.kind : null,
          binary: !!(spec && spec.binary),
          pointer: !!(spec && spec.pointer),
          enumMap: spec && spec.map ? spec.map : null,
          type: type,
          typeName: TYPE_NAMES[type] || ("type " + type),
          count: n,
          value: null,
          display: "",
          numeric: null
        };

        var pointerGroup = POINTER_TAGS[tag];
        if (pointerGroup) {
          entry.value = get32(eo + 8);
          entry.display = String(entry.value);
        } else if (entry.binary) {
          var bsize = (TYPE_SIZES[type] || 0) * n;
          entry.display = bsize + " bytes (not decoded)";
        } else {
          decodeEntry(dv, little, eo, type, n, entry);
        }

        entries.push(entry);
      }

      var next = 0;
      var nextOffset = offset + 2 + count * 12;
      if (nextOffset + 4 <= bytes.length) next = get32(nextOffset);
      depth--;
      return { entries: entries, next: next };
    }

    var ifd0 = parseIfd(get32(4), IFD0_TAGS, "IFD0");
    result.ifd0 = ifd0.entries;

    var pointers = { exif: 0, gps: 0, interop: 0 };
    ifd0.entries.forEach(function (e) {
      if (POINTER_TAGS[e.tag]) pointers[POINTER_TAGS[e.tag]] = e.value || 0;
    });

    if (pointers.exif) result.exif = parseIfd(pointers.exif, EXIF_TAGS, "Exif").entries;
    if (pointers.gps) result.gps = parseIfd(pointers.gps, GPS_TAGS, "GPS").entries;
    if (pointers.interop) result.interop = parseIfd(pointers.interop, INTEROP_TAGS, "Interop").entries;
    if (ifd0.next) result.ifd1 = parseIfd(ifd0.next, IFD0_TAGS, "IFD1").entries;

    var thumbOffset = null, thumbLength = null;
    result.ifd1.forEach(function (e) {
      if (e.tag === 0x0201) thumbOffset = e.value;
      if (e.tag === 0x0202) thumbLength = e.value;
    });
    if (thumbOffset && thumbLength && thumbOffset + thumbLength <= bytes.length && thumbLength > 0) {
      result.thumbnail = { offset: thumbOffset, length: thumbLength };
    }

    return result;
  }

  function decodeEntry(dv, little, entryOffset, type, count, entry) {
    var size = TYPE_SIZES[type];
    if (!size || count < 0) { entry.display = "(unknown type)"; return; }
    var total = size * count;
    var dataOffset;
    if (total <= 4) dataOffset = entryOffset + 8;
    else dataOffset = dv.getUint32(entryOffset + 8, little);
    if (dataOffset + total > dv.byteLength) {
      entry.display = "(value out of range)";
      return;
    }

    function get16(o) { return dv.getUint16(o, little); }
    function get32(o) { return dv.getUint32(o, little); }
    var i;

    switch (type) {
      case 2: {
        var s = "";
        for (i = 0; i < count; i++) s += String.fromCharCode(dv.getUint8(dataOffset + i));
        entry.value = trimNull(s);
        break;
      }
      case 1:
      case 7: {
        if (count === 1) entry.value = dv.getUint8(dataOffset);
        else {
          var arr = new Uint8Array(count);
          for (i = 0; i < count; i++) arr[i] = dv.getUint8(dataOffset + i);
          entry.value = arr;
        }
        break;
      }
      case 3: {
        var shorts = [];
        for (i = 0; i < count; i++) shorts.push(get16(dataOffset + i * 2));
        entry.value = count === 1 ? shorts[0] : shorts;
        break;
      }
      case 4: {
        var longs = [];
        for (i = 0; i < count; i++) longs.push(get32(dataOffset + i * 4));
        entry.value = count === 1 ? longs[0] : longs;
        break;
      }
      case 5:
      case 10: {
        var rats = [];
        for (i = 0; i < count; i++) {
          var num = type === 10 ? dv.getInt32(dataOffset + i * 8, little) : get32(dataOffset + i * 8);
          var den = type === 10 ? dv.getInt32(dataOffset + i * 8 + 4, little) : get32(dataOffset + i * 8 + 4);
          rats.push({ num: num, den: den });
        }
        entry.value = count === 1 ? rats[0] : rats;
        break;
      }
      case 6: entry.value = dv.getInt8(dataOffset); break;
      case 8: entry.value = dv.getInt16(dataOffset, little); break;
      case 9: entry.value = dv.getInt32(dataOffset, little); break;
      case 11: entry.value = dv.getFloat32(dataOffset, little); break;
      case 12: entry.value = dv.getFloat64(dataOffset, little); break;
      default: entry.value = null;
    }

    entry.numeric = numericValue(entry.value);
    entry.display = formatEntry(entry);
  }

  function rationalToNumber(r) {
    if (!r || typeof r !== "object") return null;
    if (!r.den) return null;
    return r.num / r.den;
  }

  function numericValue(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      var n = Number(value);
      return isFinite(n) && value.trim() !== "" ? n : null;
    }
    if (Array.isArray(value)) return value.length === 1 ? numericValue(value[0]) : null;
    if (value && typeof value === "object" && "num" in value) return rationalToNumber(value);
    return null;
  }

  function decodeUtf16le(bytes) {
    var out = "";
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      var code = bytes[i] | (bytes[i + 1] << 8);
      if (code === 0) break;
      out += String.fromCharCode(code);
    }
    return out;
  }

  function isXpTag(tag) {
    return tag === 0x9C9B || tag === 0x9C9C || tag === 0x9C9D || tag === 0x9C9E || tag === 0x9C9F;
  }

  function decodeUserComment(bytes) {
    var prefix = ascii(bytes, 0, Math.min(8, bytes.length));
    var body = bytes.subarray(Math.min(8, bytes.length));
    if (/^ASCII/.test(prefix)) return decodeText(body).replace(/\u0000+$/, "");
    if (/^UNICODE/.test(prefix)) return decodeUtf16le(body.subarray(0, body.length & ~1));
    return decodeText(body).replace(/[\u0000\s]+$/, "");
  }

  function formatEntry(entry) {
    var v = entry.value;
    if (v === null || v === undefined) return "";

    if (v instanceof Uint8Array) {
      if (isXpTag(entry.tag)) return decodeUtf16le(v);
      if (entry.tag === 0x9286) return decodeUserComment(v);
      return v.length + " bytes";
    }

    switch (entry.kind) {
      case "exposure": return formatExposure(rationalToNumber(v));
      case "aperture": return "f/" + formatNumber(rationalToNumber(v), 1);
      case "focal": return formatNumber(rationalToNumber(v), 1) + " mm";
      case "meters": return formatNumber(rationalToNumber(v), 2) + " m";
      case "rational": return formatNumber(rationalToNumber(v), 2);
      case "signed": return formatNumber(rationalToNumber(v), 2);
      case "dms": return formatDmsArray(v);
      case "enum": {
        var key = Array.isArray(v) ? v[0] : v;
        return entry.enumMap && entry.enumMap[key] !== undefined ? entry.enumMap[key] : String(key);
      }
      default: break;
    }

    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === "object" && v[0] && "num" in v[0]) {
        return v.map(function (r) { return formatNumber(rationalToNumber(r), 3); }).join(", ");
      }
      return v.join(", ");
    }
    if (v && typeof v === "object" && "num" in v) return formatNumber(rationalToNumber(v), 3);
    if (typeof v === "number") {
      if (entry.tag === 0x0112) return describeOrientation(v);
      return String(v);
    }
    return String(v);
  }

  function formatExposure(seconds) {
    if (seconds === null || !isFinite(seconds)) return "";
    if (seconds === 0) return "0 s";
    if (seconds < 1) return "1/" + Math.round(1 / seconds) + " s";
    return formatNumber(seconds, 2) + " s";
  }

  function formatNumber(n, decimals) {
    if (n === null || n === undefined || !isFinite(n)) return "";
    return String(Number(n.toFixed(decimals)));
  }

  function formatDmsArray(v) {
    if (!Array.isArray(v) || v.length !== 3) {
      var single = rationalToNumber(v);
      return single === null ? "" : formatNumber(single, 6);
    }
    var d = rationalToNumber(v[0]) || 0;
    var m = rationalToNumber(v[1]) || 0;
    var s = rationalToNumber(v[2]) || 0;
    return formatNumber(d, 0) + "\u00B0 " + formatNumber(m, 0) + "' " + formatNumber(s, 2) + "\"";
  }

  function dmsToDecimal(v) {
    if (!Array.isArray(v) || v.length !== 3) return rationalToNumber(v);
    var d = rationalToNumber(v[0]) || 0;
    var m = rationalToNumber(v[1]) || 0;
    var s = rationalToNumber(v[2]) || 0;
    return d + m / 60 + s / 3600;
  }

  function describeOrientation(n) {
    var map = {
      1: "1 \u2014 normal", 2: "2 \u2014 mirrored horizontally",
      3: "3 \u2014 rotated 180\u00B0", 4: "4 \u2014 mirrored vertically",
      5: "5 \u2014 mirrored then rotated 90\u00B0 CW", 6: "6 \u2014 rotated 90\u00B0 CW",
      7: "7 \u2014 mirrored then rotated 90\u00B0 CCW", 8: "8 \u2014 rotated 90\u00B0 CCW"
    };
    return map[n] || String(n);
  }

  // ---------------------------------------------------------------------
  // XMP (best-effort XML scan)
  // ---------------------------------------------------------------------

  function localName(name) {
    var i = name.indexOf(":");
    return i === -1 ? name : name.slice(i + 1);
  }

  function parseXmlTree(xml) {
    var i = 0, len = xml.length;
    var root = null;
    var stack = [];

    function parseAttrs(s) {
      var attrs = {};
      var re = /([\w:.\-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      var m;
      while ((m = re.exec(s))) attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
      return attrs;
    }

    while (i < len) {
      var lt = xml.indexOf("<", i);
      if (lt === -1) break;
      if (lt > i && stack.length) stack[stack.length - 1].text += xml.slice(i, lt);
      if (xml.startsWith("<!--", lt)) {
        var endC = xml.indexOf("-->", lt);
        i = endC === -1 ? len : endC + 3;
        continue;
      }
      if (xml.startsWith("<![CDATA[", lt)) {
        var endD = xml.indexOf("]]>", lt);
        if (endD !== -1 && stack.length) stack[stack.length - 1].text += xml.slice(lt + 9, endD);
        i = endD === -1 ? len : endD + 3;
        continue;
      }
      if (xml.startsWith("<?", lt)) {
        var endP = xml.indexOf("?>", lt);
        i = endP === -1 ? len : endP + 2;
        continue;
      }
      if (xml.startsWith("<!", lt)) {
        var endB = xml.indexOf(">", lt);
        i = endB === -1 ? len : endB + 1;
        continue;
      }
      var gt = xml.indexOf(">", lt);
      if (gt === -1) break;
      var inner = xml.slice(lt + 1, gt);

      if (inner.charAt(0) === "/") {
        var closeName = inner.slice(1).trim();
        for (var s = stack.length - 1; s >= 0; s--) {
          if (stack[s].name === closeName) { stack.length = s; break; }
        }
        i = gt + 1;
        continue;
      }

      var selfClose = inner.charAt(inner.length - 1) === "/";
      if (selfClose) inner = inner.slice(0, -1);
      var sp = inner.search(/\s/);
      var name = sp === -1 ? inner : inner.slice(0, sp);
      var attrStr = sp === -1 ? "" : inner.slice(sp);
      var node = { name: name, attrs: parseAttrs(attrStr), children: [], text: "" };

      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (!root) root = node;

      if (!selfClose) stack.push(node);
      i = gt + 1;
    }

    return root;
  }

  function parseXmp(xml) {
    if (typeof xml !== "string" || xml.indexOf("<") === -1) return null;
    var root = parseXmlTree(xml);
    if (!root) return null;

    var properties = {};
    var namespaces = {};
    (function collectNs(node) {
      Object.keys(node.attrs).forEach(function (k) {
        if (k === "xmlns") namespaces[""] = node.attrs[k];
        else if (k.indexOf("xmlns:") === 0) namespaces[k.slice(6)] = node.attrs[k];
      });
      node.children.forEach(collectNs);
    })(root);

    function nodeText(node) { return node.text ? node.text.trim() : ""; }

    function collect(node) {
      var local = localName(node.name);

      // Simple attributes on this element are properties too. Many packets put
      // plain values (dc:format, xmp:CreatorTool) and structured children on
      // the same rdf:Description, so attributes must be read before recursing.
      Object.keys(node.attrs).forEach(function (k) {
        if (k === "xmlns" || k.indexOf("xmlns:") === 0) return;
        var ln = localName(k);
        if (ln === "about" || ln === "ID" || ln === "resource") return;
        properties[ln] = node.attrs[k];
      });

      if (!node.children.length) {
        var text = nodeText(node);
        if (text) { properties[local] = text; return; }
        if (local in properties) return;
        var resource = node.attrs["rdf:resource"] || node.attrs.resource;
        if (resource) properties[local] = resource;
        return;
      }

      if (node.children.length === 1) {
        var only = node.children[0];
        var onlyLocal = localName(only.name);
        if (onlyLocal === "Bag" || onlyLocal === "Seq" || onlyLocal === "Alt") {
          properties[local] = only.children.map(function (li) {
            return nodeText(li) || li.attrs["rdf:resource"] || li.attrs.resource || "";
          });
          return;
        }
      }

      node.children.forEach(collect);
    }

    var descriptions = [];
    (function findDescriptions(node) {
      if (localName(node.name) === "Description") descriptions.push(node);
      node.children.forEach(findDescriptions);
    })(root);

    if (descriptions.length) descriptions.forEach(collect);
    else collect(root);

    return { properties: properties, namespaces: namespaces };
  }

  // ---------------------------------------------------------------------
  // IPTC IIM (best-effort)
  // ---------------------------------------------------------------------

  var IPTC_RECORD_NAMES = { 1: "Envelope", 2: "Application", 3: "NewsPhoto", 7: "PreObjectData", 8: "ObjectData" };
  var IPTC_DATASET_NAMES = {
    1: { 0: "ModelVersion", 5: "Destination", 20: "FileFormat", 22: "FileVersion", 30: "ServiceIdentifier", 40: "EnvelopeNumber", 70: "DateSent", 90: "CharacterSet" },
    2: {
      0: "RecordVersion", 3: "ObjectTypeReference", 4: "ObjectAttributeReference", 5: "ObjectName",
      10: "Urgency", 15: "Category", 20: "SupplementalCategories", 22: "FixtureIdentifier",
      25: "Keywords", 26: "ContentLocationCode", 27: "ContentLocationName", 30: "ReleaseDate",
      35: "ReleaseTime", 40: "SpecialInstructions", 55: "DateCreated", 60: "TimeCreated",
      62: "DigitalCreationDate", 63: "DigitalCreationTime", 80: "By-line", 85: "By-lineTitle",
      90: "City", 92: "Sub-location", 95: "Province-State", 100: "Country-PrimaryLocationCode",
      101: "Country-PrimaryLocationName", 103: "OriginalTransmissionReference", 105: "Headline",
      110: "Credit", 115: "Source", 116: "CopyrightNotice", 118: "Contact", 120: "Caption-Abstract",
      122: "Writer-Editor"
    },
    7: { 10: "SizeMode", 20: "MaxSubfileSize", 90: "ObjectSizeAnnounced" },
    8: { 10: "Subfile", 90: "ObjectDataSize" }
  };

  function findPhotoshopIptc(input) {
    // Walk a Photoshop Image Resource Block (IRB) and return the payload of
    // the 0x0404 resource, which holds the IPTC IIM stream.
    var bytes = toBytes(input);
    if (!bytes || bytes.length < 12) return null;
    var p = 0, guard = 0;
    while (p + 12 <= bytes.length && guard++ < 10000) {
      if (!hasPrefix(bytes, p, "8BIM")) { p += 1; continue; }
      var id = u16be(bytes, p + 4);
      var nameLen = bytes[p + 6];
      var nameField = 1 + nameLen;
      var sizeOffset = p + 6 + nameField + (nameField % 2);
      if (sizeOffset + 4 > bytes.length) break;
      var size = u32be(bytes, sizeOffset);
      var dataStart = sizeOffset + 4;
      if (dataStart + size > bytes.length) break;
      if (id === 0x0404) return bytes.subarray(dataStart, dataStart + size);
      p = dataStart + size + (size % 2);
    }
    return null;
  }

  function parseIptc(input) {
    var bytes = toBytes(input);
    if (!bytes || bytes.length < 5) return null;
    var records = [];
    var byRecord = {};
    var i = 0;
    var guard = 0;

    while (i + 5 <= bytes.length && guard++ < 100000) {
      if (bytes[i] !== 0x1C) break;
      var record = bytes[i + 1];
      var dataset = bytes[i + 2];
      var len = u16be(bytes, i + 3);
      if (len & 0x8000) break;
      var start = i + 5;
      if (start + len > bytes.length) break;
      var value = decodeText(bytes.subarray(start, start + len));

      if (!byRecord[record]) {
        byRecord[record] = { record: record, name: IPTC_RECORD_NAMES[record] || ("Record " + record), datasets: [] };
        records.push(byRecord[record]);
      }
      var names = IPTC_DATASET_NAMES[record] || {};
      byRecord[record].datasets.push({
        dataset: dataset,
        name: names[dataset] || ("Dataset " + record + ":" + dataset),
        value: value
      });
      i = start + len;
    }

    if (!records.length) return null;
    return { present: true, records: records };
  }

  // ---------------------------------------------------------------------
  // ICC profile (presence + size only)
  // ---------------------------------------------------------------------

  function parseIcc(input) {
    var bytes = toBytes(input);
    if (!bytes || bytes.length < 132) return null;
    var size = u32be(bytes, 0);
    if (size > bytes.length || !hasPrefix(bytes, 36, "acsp")) return null;
    return { present: true, size: size };
  }

  // ---------------------------------------------------------------------
  // Container parsers
  // ---------------------------------------------------------------------

  var FORMATS = {
    jpeg: { label: "JPEG", mime: "image/jpeg" },
    png: { label: "PNG", mime: "image/png" },
    webp: { label: "WebP", mime: "image/webp" },
    gif: { label: "GIF", mime: "image/gif" }
  };

  function detectFormat(bytes) {
    if (!bytes || bytes.length < 4) return "unknown";
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return "jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "png";
    if (hasPrefix(bytes, 0, "RIFF") && hasPrefix(bytes, 8, "WEBP")) return "webp";
    if (hasPrefix(bytes, 0, "GIF87a") || hasPrefix(bytes, 0, "GIF89a")) return "gif";
    return "unknown";
  }

  var JPEG_MARKER_NAMES = {
    0xC0: "SOF0", 0xC1: "SOF1", 0xC2: "SOF2", 0xC3: "SOF3", 0xC4: "DHT",
    0xC5: "SOF5", 0xC6: "SOF6", 0xC7: "SOF7", 0xC8: "JPG", 0xC9: "SOF9",
    0xCA: "SOF10", 0xCB: "SOF11", 0xCC: "DAC", 0xCD: "SOF13", 0xCE: "SOF14",
    0xCF: "SOF15", 0xDA: "SOS", 0xDB: "DQT", 0xDC: "DNL", 0xDD: "DRI",
    0xDE: "DHP", 0xDF: "EXP", 0xE0: "APP0", 0xE1: "APP1", 0xE2: "APP2",
    0xE3: "APP3", 0xE4: "APP4", 0xE5: "APP5", 0xE6: "APP6", 0xE7: "APP7",
    0xE8: "APP8", 0xE9: "APP9", 0xEA: "APP10", 0xEB: "APP11", 0xEC: "APP12",
    0xED: "APP13", 0xEE: "APP14", 0xEF: "APP15", 0xFE: "COM"
  };

  function markerLabel(marker) {
    return JPEG_MARKER_NAMES[marker] || ("0x" + marker.toString(16).toUpperCase());
  }

  function walkJpeg(bytes, onSegment) {
    var p = 2;
    var warnings = [];
    var guard = 0;
    while (p + 1 < bytes.length && guard++ < 100000) {
      if (bytes[p] !== 0xFF) {
        warnings.push("Unexpected byte where a JPEG marker was expected at offset " + p + ".");
        break;
      }
      var marker = bytes[p + 1];
      if (marker === 0xFF) { p++; continue; }
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { p += 2; continue; }
      if (marker === 0xD9) break;
      if (marker === 0xDA) { onSegment(marker, p, p + 2, true); break; }
      if (p + 4 > bytes.length) { warnings.push("Truncated JPEG segment header at offset " + p + "."); break; }
      var length = u16be(bytes, p + 2);
      if (length < 2) { warnings.push("JPEG segment at offset " + p + " has an invalid length."); break; }
      var end = p + 2 + length;
      if (end > bytes.length) {
        warnings.push("JPEG segment at offset " + p + " extends past the end of the file.");
        break;
      }
      onSegment(marker, p, end, false);
      p = end;
    }
    return warnings;
  }

  function parseJpeg(bytes) {
    var out = {
      format: "jpeg", warnings: [],
      exif: null, xmp: null, iptc: null, icc: null, comment: null,
      segments: [], dimensions: null
    };
    var xmpChunks = [];
    var extendedXmp = [];

    out.warnings = walkJpeg(bytes, function (marker, start, end, isSos) {
      var payloadStart = start + 4;
      var payloadLength = end - payloadStart;
      var label = markerLabel(marker);
      var note = "";

      if (!isSos && payloadLength >= 0) {
        if (marker === 0xE1) {
          if (hasPrefix(bytes, payloadStart, "Exif\u0000\u0000")) {
            var tiff = bytes.subarray(payloadStart + 6, end);
            var parsed = parseExif(tiff);
            if (!out.exif) out.exif = parsed;
            else out.warnings.push("A second EXIF segment was ignored.");
            note = "EXIF";
          } else if (hasPrefix(bytes, payloadStart, "http://ns.adobe.com/xap/1.0/\u0000")) {
            xmpChunks.push(decodeText(bytes.subarray(payloadStart + 29, end)));
            note = "XMP";
          } else if (hasPrefix(bytes, payloadStart, "http://ns.adobe.com/xmp/extension/\u0000")) {
            extendedXmp.push({ offset: 32, raw: bytes.subarray(payloadStart + 35, end) });
            note = "XMP extension";
          } else {
            note = "unknown APP1 payload";
          }
        } else if (marker === 0xE0) {
          note = hasPrefix(bytes, payloadStart, "JFIF\u0000") ? "JFIF"
            : hasPrefix(bytes, payloadStart, "AVI1") ? "AVI" : "unknown APP0 payload";
        } else if (marker === 0xE2) {
          // APP2 ICC payloads are prefixed with "ICC_PROFILE\0" + chunk index
          // + chunk count; the profile itself starts after that 14-byte header.
          var iccPayload = bytes.subarray(payloadStart, end);
          if (hasPrefix(iccPayload, 0, "ICC_PROFILE\u0000") && iccPayload.length > 14) {
            iccPayload = iccPayload.subarray(14);
          }
          var icc = parseIcc(iccPayload);
          if (icc) { out.icc = icc; note = "ICC profile"; }
          else note = "unknown APP2 payload";
        } else if (marker === 0xED) {
          if (hasPrefix(bytes, payloadStart, "Photoshop 3.0\u0000")) {
            var iptcStream = findPhotoshopIptc(bytes.subarray(payloadStart + 14, end));
            var iptc = iptcStream ? parseIptc(iptcStream) : null;
            if (iptc) { out.iptc = iptc; note = "IPTC / Photoshop IRB"; }
            else note = "Photoshop IRB (no IPTC found)";
          } else note = "unknown APP13 payload";
        } else if (marker === 0xEE) {
          note = hasPrefix(bytes, payloadStart, "Adobe") ? "Adobe APP14" : "unknown APP14 payload";
        } else if (marker === 0xFE) {
          out.comment = decodeText(bytes.subarray(payloadStart, end));
          note = "comment";
        } else if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          if (payloadLength >= 6 && !out.dimensions) {
            out.dimensions = {
              height: u16be(bytes, payloadStart + 1),
              width: u16be(bytes, payloadStart + 3),
              bitsPerSample: bytes[payloadStart],
              components: bytes[payloadStart + 5],
              encoding: sofEncoding(marker)
            };
          }
          note = "frame header";
        }
      }

      out.segments.push({ marker: marker, label: label, offset: start, length: isSos ? 0 : end - start, note: note });
    });

    var xmpText = xmpChunks.join("");
    if (extendedXmp.length) {
      var ext = "";
      extendedXmp.forEach(function (e) { ext += decodeText(e.raw); });
      xmpText += ext;
    }
    if (xmpText) out.xmp = parseXmp(xmpText);

    return out;
  }

  function sofEncoding(marker) {
    if (marker === 0xC0) return "baseline";
    if (marker === 0xC1) return "extended sequential";
    if (marker === 0xC2) return "progressive";
    if (marker === 0xC3) return "lossless";
    return "other";
  }

  function parsePng(bytes) {
    var out = {
      format: "png", warnings: [],
      exif: null, xmp: null, iptc: null, icc: null, comment: null,
      textChunks: [], dimensions: null, chunks: []
    };
    if (bytes.length < 8 || !hasPrefix(bytes, 0, "\u0089PNG")) {
      out.warnings.push("File does not start with a PNG signature.");
      return out;
    }
    var p = 8;
    var guard = 0;
    while (p + 8 <= bytes.length && guard++ < 100000) {
      var length = u32be(bytes, p);
      var type = ascii(bytes, p + 4, 4);
      var dataStart = p + 8;
      var dataEnd = dataStart + length;
      if (dataEnd + 4 > bytes.length) {
        out.warnings.push("PNG chunk " + type + " is truncated.");
        break;
      }

      out.chunks.push({ type: type, offset: p, length: length + 12 });
      var data = bytes.subarray(dataStart, dataEnd);

      if (type === "IHDR" && length >= 13) {
        out.dimensions = { width: u32be(data, 0), height: u32be(data, 4), bitDepth: data[8], colorType: data[9] };
      } else if (type === "tEXt") {
        var z = data.indexOf(0);
        if (z !== -1) {
          var keyword = ascii(data, 0, z);
          var text = decodeText(data.subarray(z + 1));
          out.textChunks.push({ keyword: keyword, text: text, kind: "tEXt" });
          if (keyword === "Comment") out.comment = text;
        }
      } else if (type === "zTXt") {
        var z2 = data.indexOf(0);
        if (z2 !== -1) {
          out.textChunks.push({ keyword: ascii(data, 0, z2), text: "(compressed \u2014 not expanded)", kind: "zTXt" });
        }
      } else if (type === "iTXt") {
        var parts = parseITxt(data);
        if (parts) out.textChunks.push(parts);
      } else if (type === "eXIf") {
        out.exif = parseExif(data);
      } else if (type === "iCCP") {
        var z3 = data.indexOf(0);
        if (z3 !== -1) out.icc = { present: true, size: length, name: ascii(data, 0, z3) };
      } else if (type === "IEND") {
        break;
      }
      p = dataEnd + 4;
    }

    var xmpText = "";
    out.textChunks.forEach(function (c) {
      if (c.keyword === "XML:com.adobe.xmp" || /xmp/i.test(c.keyword)) xmpText += c.text;
    });
    if (xmpText) out.xmp = parseXmp(xmpText);
    return out;
  }

  function parseITxt(data) {
    var z = data.indexOf(0);
    if (z === -1) return null;
    var keyword = ascii(data, 0, z);
    var rest = data.subarray(z + 1);
    if (rest.length < 2) return null;
    var compressed = rest[0] === 1;
    var method = rest[1];
    var afterMethod = rest.subarray(2);
    var z2 = afterMethod.indexOf(0);
    if (z2 === -1) return null;
    var language = ascii(afterMethod, 0, z2);
    var afterLang = afterMethod.subarray(z2 + 1);
    var z3 = afterLang.indexOf(0);
    if (z3 === -1) return null;
    var translated = decodeText(afterLang.subarray(0, z3));
    var text = compressed ? "(compressed \u2014 not expanded)" : decodeText(afterLang.subarray(z3 + 1));
    return { keyword: keyword, text: text, kind: "iTXt", language: language, translated: translated, compressed: compressed, method: method };
  }

  function parseWebp(bytes) {
    var out = {
      format: "webp", warnings: [],
      exif: null, xmp: null, iptc: null, icc: null, comment: null,
      chunks: [], dimensions: null, features: null
    };
    if (!hasPrefix(bytes, 0, "RIFF") || !hasPrefix(bytes, 8, "WEBP")) {
      out.warnings.push("File does not start with a WebP RIFF header.");
      return out;
    }
    var declared = u32le(bytes, 4) + 8;
    if (declared > bytes.length) out.warnings.push("RIFF size declares more bytes than the file contains.");

    var p = 12;
    var guard = 0;
    while (p + 8 <= bytes.length && guard++ < 100000) {
      var fourcc = ascii(bytes, p, 4);
      var size = u32le(bytes, p + 4);
      var dataStart = p + 8;
      var dataEnd = dataStart + size;
      if (dataEnd > bytes.length) {
        out.warnings.push("WebP chunk " + fourcc + " is truncated.");
        break;
      }
      out.chunks.push({ fourcc: fourcc, offset: p, size: size });

      if (fourcc === "VP8X" && size >= 10) {
        // Canvas size is stored as two 24-bit little-endian values minus one.
        out.dimensions = { width: 1 + u24le(bytes, dataStart + 4), height: 1 + u24le(bytes, dataStart + 7) };
        out.features = decodeWebpFeatures(bytes[dataStart]);
      } else if (fourcc === "VP8 " && size >= 10) {
        if (u24le(bytes, dataStart + 3) === 0x9D012A) {
          out.dimensions = {
            width: u16le(bytes, dataStart + 6) & 0x3FFF,
            height: u16le(bytes, dataStart + 8) & 0x3FFF
          };
        }
      } else if (fourcc === "VP8L" && size >= 5) {
        var b0 = bytes[dataStart + 1], b1 = bytes[dataStart + 2], b2 = bytes[dataStart + 3], b3 = bytes[dataStart + 4];
        out.dimensions = {
          width: 1 + (((b1 & 0x3F) << 8) | b0),
          height: 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
        };
      } else if (fourcc === "EXIF") {
        out.exif = parseExif(bytes.subarray(dataStart, dataEnd));
      } else if (fourcc === "ICCP") {
        var icc = parseIcc(bytes.subarray(dataStart, dataEnd));
        out.icc = icc || { present: true, size: size };
      } else if (fourcc === "XMP ") {
        out.xmp = parseXmp(decodeText(bytes.subarray(dataStart, dataEnd)));
      }
      p = dataEnd + (size % 2);
    }
    return out;
  }

  function decodeWebpFeatures(flags) {
    return {
      icc: !!(flags & 0x20),
      alpha: !!(flags & 0x10),
      exif: !!(flags & 0x08),
      xmp: !!(flags & 0x04),
      animation: !!(flags & 0x02)
    };
  }

  function u24le(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }
  function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function parseGif(bytes) {
    var out = {
      format: "gif", warnings: [],
      exif: null, xmp: null, iptc: null, icc: null, comment: null,
      comments: [], dimensions: null, version: null
    };
    if (bytes.length < 13) {
      out.warnings.push("File is too short to be a GIF.");
      return out;
    }
    out.version = ascii(bytes, 0, 6);
    out.dimensions = { width: u16le(bytes, 6), height: u16le(bytes, 8) };

    var p = 13;
    var gctFlag = (bytes[10] & 0x80) !== 0;
    var gctSize = gctFlag ? 3 * (1 << ((bytes[10] & 0x07) + 1)) : 0;
    p += gctSize;

    var guard = 0;
    while (p < bytes.length && guard++ < 100000) {
      var block = bytes[p];
      if (block === 0x21) { // extension
        var label = bytes[p + 1];
        p += 2;
        if (label === 0xFE) {
          var text = "";
          while (p < bytes.length && bytes[p] !== 0) {
            var len = bytes[p];
            if (p + 1 + len > bytes.length) break;
            text += decodeText(bytes.subarray(p + 1, p + 1 + len));
            p += 1 + len;
          }
          out.comments.push(text);
          if (!out.comment) out.comment = text;
          p += 1; // block terminator
        } else if (label === 0xFF) {
          // Application extension: identifier block, then data sub-blocks.
          var appIdSize = bytes[p];
          var appId = ascii(bytes, p + 1, Math.min(11, appIdSize));
          var q = p + 1 + appIdSize;
          var dataBytes = [];
          while (q < bytes.length && bytes[q] !== 0) {
            var sl = bytes[q];
            if (q + 1 + sl > bytes.length) break;
            for (var k = 0; k < sl; k++) dataBytes.push(bytes[q + 1 + k]);
            q += 1 + sl;
          }
          if (/XMP DataXMP/.test(appId)) {
            out.xmp = parseXmp(decodeText(Uint8Array.from(dataBytes)));
          }
          p = q + 1;
        } else {
          // skip sub-blocks
          while (p < bytes.length && bytes[p] !== 0) {
            p += 1 + bytes[p];
          }
          p += 1;
        }
      } else if (block === 0x2C) { // image descriptor — stop; frames are not parsed
        break;
      } else if (block === 0x3B) { // trailer
        break;
      } else {
        out.warnings.push("Unknown GIF block 0x" + block.toString(16) + " at offset " + p + ".");
        break;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Top-level inspection
  // ---------------------------------------------------------------------

  function inspect(input) {
    var bytes = toBytes(input);
    if (!bytes || bytes.length === 0) {
      return { ok: false, error: "The file is empty.", format: "unknown" };
    }
    var format = detectFormat(bytes);
    if (format === "unknown") {
      return {
        ok: false,
        format: "unknown",
        error: "Unrecognised image format. This tool reads JPEG, PNG, WebP and GIF files."
      };
    }

    var parsed;
    if (format === "jpeg") parsed = parseJpeg(bytes);
    else if (format === "png") parsed = parsePng(bytes);
    else if (format === "webp") parsed = parseWebp(bytes);
    else parsed = parseGif(bytes);

    var findings = [];
    var gps = extractGps(parsed.exif);
    var privacy = analysePrivacy(parsed, gps);
    var summary = summarise(parsed, gps);
    if (parsed.dimensions && parsed.dimensions.width) {
      // A plausible sanity check for corrupted headers.
      if (parsed.dimensions.width > 100000 || parsed.dimensions.height > 100000) {
        parsed.warnings.push("Reported dimensions look implausible; the header may be corrupt.");
      }
    }

    var report = {
      ok: true,
      format: format,
      formatLabel: FORMATS[format].label,
      mime: FORMATS[format].mime,
      fileSize: bytes.length,
      byteLength: bytes.length,
      dimensions: parsed.dimensions || null,
      exif: parsed.exif,
      xmp: parsed.xmp,
      iptc: parsed.iptc,
      icc: parsed.icc,
      comment: parsed.comment || null,
      comments: parsed.comments || (parsed.comment ? [parsed.comment] : []),
      segments: parsed.segments || null,
      chunks: parsed.chunks || null,
      textChunks: parsed.textChunks || null,
      features: parsed.features || null,
      version: parsed.version || null,
      gps: gps,
      summary: summary,
      privacy: privacy,
      findings: findings,
      warnings: parsed.warnings || []
    };
    report.findings = buildFindings(report);
    return report;
  }

  function extractGps(exif) {
    if (!exif || !exif.gps || !exif.gps.length) return null;
    var byName = {};
    exif.gps.forEach(function (e) { byName[e.name] = e; });

    var lat = byName.GPSLatitude ? dmsToDecimal(byName.GPSLatitude.value) : null;
    var lon = byName.GPSLongitude ? dmsToDecimal(byName.GPSLongitude.value) : null;
    var latRef = byName.GPSLatitudeRef ? String(byName.GPSLatitudeRef.value) : "";
    var lonRef = byName.GPSLongitudeRef ? String(byName.GPSLongitudeRef.value) : "";

    if (lat !== null && /S/i.test(latRef)) lat = -lat;
    if (lon !== null && /W/i.test(lonRef)) lon = -lon;

    if (lat === null || lon === null) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { latitude: null, longitude: null, invalid: true, refs: { latRef: latRef, lonRef: lonRef } };
    }
    return {
      latitude: lat,
      longitude: lon,
      altitude: byName.GPSAltitude ? numericValue(byName.GPSAltitude.value) : null,
      timestamp: byName.GPSTimeStamp ? formatDmsArray(byName.GPSTimeStamp.value) : null,
      dateStamp: byName.GPSDateStamp ? String(byName.GPSDateStamp.value) : null
    };
  }

  function flattenExif(exif) {
    if (!exif) return [];
    return []
      .concat(exif.ifd0 || [])
      .concat(exif.exif || [])
      .concat(exif.gps || [])
      .concat(exif.interop || [])
      .concat(exif.ifd1 || []);
  }

  var SENSITIVE_NAMES = [
    "GPSLatitude", "GPSLongitude", "GPSAltitude", "GPSLatitudeRef", "GPSLongitudeRef",
    "GPSDateStamp", "GPSTimeStamp", "Make", "Model", "Software", "DateTime",
    "DateTimeOriginal", "DateTimeDigitized", "Artist", "Copyright", "ImageDescription",
    "CameraOwnerName", "BodySerialNumber", "LensSerialNumber", "LensModel", "LensMake",
    "ImageUniqueID", "XPTitle", "XPComment", "XPAuthor", "XPKeywords", "XPSubject",
    "UserComment", "OffsetTime", "OffsetTimeOriginal", "SubSecTimeOriginal"
  ];

  function analysePrivacy(parsed, gps) {
    var items = [];
    var score = 0;

    function add(id, label, detail, weight) {
      items.push({ id: id, label: label, detail: detail });
      score += weight;
    }

    var entries = flattenExif(parsed.exif);
    var names = {};
    entries.forEach(function (e) { names[e.name] = e; });

    if (gps && gps.latitude !== null && gps.longitude !== null) {
      add("gps", "GPS location",
        gps.latitude.toFixed(6) + ", " + gps.longitude.toFixed(6) + " \u2014 exact capture coordinates are embedded.",
        45);
    }

    if (names.Make || names.Model) {
      var cam = [names.Make && names.Make.display, names.Model && names.Model.display]
        .filter(Boolean).join(" ");
      add("camera", "Camera make and model", cam || "Camera identity tags present.", 10);
    }

    if (names.BodySerialNumber) add("serial", "Camera serial number",
      names.BodySerialNumber.display || "present", 15);
    if (names.LensSerialNumber) add("lensserial", "Lens serial number",
      names.LensSerialNumber.display || "present", 10);
    if (names.ImageUniqueID) add("uniqueid", "Image unique ID",
      names.ImageUniqueID.display || "present", 8);

    if (names.Artist || names.Copyright || names.XPAuthor || names.CameraOwnerName) {
      var who = names.Artist || names.Copyright || names.XPAuthor || names.CameraOwnerName;
      add("author", "Author / copyright", who.display || "present", 12);
    }

    if (names.Software) add("software", "Editing software", names.Software.display || "present", 5);

    var dates = ["DateTime", "DateTimeOriginal", "DateTimeDigitized"].filter(function (n) { return names[n]; });
    if (dates.length) {
      add("datetime", "Capture / edit timestamp",
        dates.map(function (n) { return names[n].display; }).join(" \u00B7 "), 10);
    }

    if (names.UserComment && names.UserComment.display) add("usercomment", "User comment",
      names.UserComment.display, 5);

    if (names.XPKeywords) add("keywords", "Keywords", names.XPKeywords.display || "present", 3);

    var xmp = parsed.xmp && parsed.xmp.properties ? parsed.xmp.properties : {};
    var xmpKeys = Object.keys(xmp);
    if (xmpKeys.length) {
      var xmpCreator = xmp["dc:creator"] || xmp.creator;
      if (xmpCreator) add("xmpcreator", "XMP creator",
        Array.isArray(xmpCreator) ? xmpCreator.join(", ") : String(xmpCreator), 12);
      if (xmp["dc:description"] || xmp.description) {
        var d = xmp["dc:description"] || xmp.description;
        add("xmpdesc", "XMP description", Array.isArray(d) ? d.join(" ") : String(d), 4);
      }
      if (xmpKeys.length > 2) {
        add("xmp", "XMP packet", xmpKeys.length + " properties embedded.", 4);
      }
    }

    if (parsed.iptc && parsed.iptc.records) {
      var dsCount = 0;
      parsed.iptc.records.forEach(function (r) { dsCount += r.datasets.length; });
      add("iptc", "IPTC metadata", dsCount + " dataset(s) embedded (caption, credit, keywords).", 6);
    }

    if (parsed.comment) add("comment", "Image comment", parsed.comment.slice(0, 120), 3);

    var level = score === 0 ? "clean" : score >= 40 ? "high" : score >= 15 ? "medium" : "low";
    return {
      score: score,
      level: level,
      items: items,
      count: items.length
    };
  }

  function summarise(parsed, gps) {
    var names = {};
    flattenExif(parsed.exif).forEach(function (e) { if (!(e.name in names)) names[e.name] = e; });
    return {
      camera: [names.Make && names.Make.display, names.Model && names.Model.display]
        .filter(Boolean).join(" ") || null,
      lens: names.LensModel ? names.LensModel.display : null,
      software: names.Software ? names.Software.display : null,
      taken: (names.DateTimeOriginal && names.DateTimeOriginal.display) ||
        (names.DateTime && names.DateTime.display) || null,
      orientation: names.Orientation ? names.Orientation.display : null,
      exposure: names.ExposureTime ? names.ExposureTime.display : null,
      aperture: names.FNumber ? names.FNumber.display : null,
      iso: names.ISOSpeedRatings ? names.ISOSpeedRatings.display : null,
      focalLength: names.FocalLength ? names.FocalLength.display : null,
      gps: gps && gps.latitude !== null
        ? gps.latitude.toFixed(6) + ", " + gps.longitude.toFixed(6) : null
    };
  }

  function buildFindings(report) {
    var findings = [];
    if (report.exif) {
      findings.push({
        id: "exif",
        label: "EXIF",
        present: true,
        count: flattenExif(report.exif).length,
        note: report.exif.byteOrder || ""
      });
      if (report.exif.thumbnail) findings.push({
        id: "thumbnail", label: "Embedded thumbnail", present: true,
        note: report.exif.thumbnail.length + " bytes"
      });
    } else {
      findings.push({ id: "exif", label: "EXIF", present: false });
    }

    var xmpCount = report.xmp && report.xmp.properties ? Object.keys(report.xmp.properties).length : 0;
    findings.push({ id: "xmp", label: "XMP", present: !!xmpCount, count: xmpCount });

    var iptcCount = 0;
    if (report.iptc && report.iptc.records) {
      report.iptc.records.forEach(function (r) { iptcCount += r.datasets.length; });
    }
    findings.push({ id: "iptc", label: "IPTC", present: iptcCount > 0, count: iptcCount });

    findings.push({
      id: "icc", label: "ICC colour profile", present: !!report.icc,
      note: report.icc ? Math.round(report.icc.size / 1024) + " KB" : ""
    });
    findings.push({ id: "comment", label: "Comment", present: !!report.comment });
    findings.push({
      id: "gps", label: "GPS coordinates",
      present: !!(report.gps && report.gps.latitude !== null)
    });
    return findings;
  }

  // ---------------------------------------------------------------------
  // Metadata stripping
  // ---------------------------------------------------------------------
  //
  // Strip rebuilds the container from its non-metadata segments only. It is
  // deliberately conservative: if the structure cannot be rebuilt without
  // risking the image data, it returns an error rather than guessing.

  function stripMetadata(input) {
    var bytes = toBytes(input);
    if (!bytes || bytes.length === 0) return { ok: false, error: "The file is empty." };
    var format = detectFormat(bytes);
    if (format === "jpeg") return stripJpeg(bytes);
    if (format === "png") return stripPng(bytes);
    if (format === "webp") return stripWebp(bytes);
    if (format === "gif") return stripGif(bytes);
    return { ok: false, error: "Unrecognised image format. This tool can strip JPEG, PNG, WebP and GIF files." };
  }

  function concatBytes(parts) {
    var total = 0;
    parts.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total);
    var offset = 0;
    parts.forEach(function (p) { out.set(p, offset); offset += p.length; });
    return out;
  }

  function stripJpeg(bytes) {
    var parts = [bytes.subarray(0, 2)]; // SOI
    var removed = [];
    var kept = [];
    var stopped = false;

    walkJpeg(bytes, function (marker, start, end, isSos) {
      if (isSos) {
        // Everything from SOS to the end of file is entropy-coded image data.
        parts.push(bytes.subarray(start));
        kept.push(markerLabel(marker));
        stopped = true;
        return;
      }
      // APP1 (EXIF/XMP), APP2 (ICC), APP13 (IPTC/Photoshop) and COM carry
      // metadata. APP0 (JFIF) and APP14 (Adobe) describe the colour
      // transform and density, so they are kept to preserve decoding.
      var drop = marker === 0xE1 || marker === 0xE2 || marker === 0xED || marker === 0xFE;
      if (drop) removed.push(markerLabel(marker));
      else { parts.push(bytes.subarray(start, end)); kept.push(markerLabel(marker)); }
    });

    if (!stopped) {
      return { ok: false, error: "This JPEG has no scan data to preserve; refusing to rewrite it." };
    }
    return {
      ok: true,
      format: "jpeg",
      bytes: concatBytes(parts),
      removedSegments: removed,
      keptSegments: kept
    };
  }

  function stripPng(bytes) {
    if (!hasPrefix(bytes, 0, "\u0089PNG")) return { ok: false, error: "Not a PNG file." };
    var parts = [bytes.subarray(0, 8)];
    var removed = [];
    var kept = [];
    var p = 8;
    var guard = 0;
    var sawIend = false;

    while (p + 8 <= bytes.length && guard++ < 100000) {
      var length = u32be(bytes, p);
      var type = ascii(bytes, p + 4, 4);
      var chunkEnd = p + 8 + length + 4;
      if (chunkEnd > bytes.length) {
        return { ok: false, error: "PNG chunk " + type + " is truncated; refusing to rewrite the file." };
      }
      var drop = type === "tEXt" || type === "zTXt" || type === "iTXt" ||
        type === "eXIf" || type === "iCCP";
      if (drop) removed.push(type);
      else { parts.push(bytes.subarray(p, chunkEnd)); kept.push(type); }
      p = chunkEnd;
      if (type === "IEND") { sawIend = true; break; }
    }

    if (!sawIend) return { ok: false, error: "PNG is missing its IEND chunk; refusing to rewrite the file." };
    if (p < bytes.length) parts.push(bytes.subarray(p)); // trailing bytes, if any
    return { ok: true, format: "png", bytes: concatBytes(parts), removedSegments: removed, keptSegments: kept };
  }

  function stripWebp(bytes) {
    if (!hasPrefix(bytes, 0, "RIFF") || !hasPrefix(bytes, 8, "WEBP")) {
      return { ok: false, error: "Not a WebP file." };
    }
    var body = [];
    var removed = [];
    var kept = [];
    var p = 12;
    var guard = 0;
    var sawImage = false;

    while (p + 8 <= bytes.length && guard++ < 100000) {
      var fourcc = ascii(bytes, p, 4);
      var size = u32le(bytes, p + 4);
      var dataEnd = p + 8 + size;
      if (dataEnd > bytes.length) {
        return { ok: false, error: "WebP chunk " + fourcc + " is truncated; refusing to rewrite the file." };
      }
      var drop = fourcc === "EXIF" || fourcc === "XMP " || fourcc === "ICCP";
      if (drop) {
        removed.push(fourcc.trim());
      } else {
        body.push(bytes.subarray(p, dataEnd));
        if (size % 2 === 1) body.push(new Uint8Array([0])); // RIFF padding
        kept.push(fourcc);
        if (fourcc === "VP8 " || fourcc === "VP8L") sawImage = true;
      }
      p = dataEnd + (size % 2);
    }

    if (!sawImage) return { ok: false, error: "WebP has no image bitstream; refusing to rewrite the file." };

    // Recompute VP8X feature flags if a VP8X header is present. Copy the
    // chunk first so the caller's input buffer is never mutated.
    for (var i = 0; i < body.length; i++) {
      var part = body[i];
      if (part.length >= 8 && ascii(part, 0, 4) === "VP8X") {
        var vp8x = Uint8Array.from(part);
        vp8x[8] = vp8x[8] & ~(0x20 | 0x08 | 0x04); // clear ICC, EXIF and XMP flags
        body[i] = vp8x;
      }
    }

    var payload = concatBytes(body);
    var header = new Uint8Array(12);
    header[0] = 0x52; header[1] = 0x49; header[2] = 0x46; header[3] = 0x46; // RIFF
    writeU32le(header, 4, payload.length + 4);
    header[8] = 0x57; header[9] = 0x45; header[10] = 0x42; header[11] = 0x50; // WEBP
    return {
      ok: true, format: "webp",
      bytes: concatBytes([header, payload]),
      removedSegments: removed, keptSegments: kept
    };
  }

  function writeU32le(b, o, v) {
    b[o] = v & 0xFF;
    b[o + 1] = (v >>> 8) & 0xFF;
    b[o + 2] = (v >>> 16) & 0xFF;
    b[o + 3] = (v >>> 24) & 0xFF;
  }

  function stripGif(bytes) {
    if (!hasPrefix(bytes, 0, "GIF87a") && !hasPrefix(bytes, 0, "GIF89a")) {
      return { ok: false, error: "Not a GIF file." };
    }
    var gctFlag = (bytes[10] & 0x80) !== 0;
    var gctSize = gctFlag ? 3 * (1 << ((bytes[10] & 0x07) + 1)) : 0;
    var headEnd = 13 + gctSize;
    if (headEnd > bytes.length) return { ok: false, error: "GIF header is truncated." };

    var parts = [bytes.subarray(0, headEnd)];
    var removed = [];
    var p = headEnd;
    var guard = 0;

    while (p < bytes.length && guard++ < 100000) {
      var block = bytes[p];
      if (block === 0x21) {
        var label = bytes[p + 1];
        var start = p;
        p += 2;
        if (label === 0xFE) { // comment
          while (p < bytes.length && bytes[p] !== 0) p += 1 + bytes[p];
          p += 1;
          removed.push("Comment");
        } else if (label === 0xFF) {
          var appSize = bytes[p];
          var appId = ascii(bytes, p + 1, Math.min(11, appSize));
          var next = p + 1 + appSize;
          while (next < bytes.length && bytes[next] !== 0) next += 1 + bytes[next];
          next += 1;
          if (/XMP DataXMP/.test(appId)) { removed.push("XMP"); p = next; }
          else { parts.push(bytes.subarray(start, next)); p = next; }
        } else {
          while (p < bytes.length && bytes[p] !== 0) p += 1 + bytes[p];
          p += 1;
          parts.push(bytes.subarray(start, p));
        }
      } else {
        // Image descriptors, sub-blocks and trailer: copy verbatim to the end.
        parts.push(bytes.subarray(p));
        break;
      }
    }

    return { ok: true, format: "gif", bytes: concatBytes(parts), removedSegments: removed, keptSegments: [] };
  }

  // ---------------------------------------------------------------------
  // Text export
  // ---------------------------------------------------------------------

  function formatBytes(n) {
    if (n === null || n === undefined || !isFinite(n)) return "\u2014";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  function reportToText(report) {
    if (!report || !report.ok) return "No image inspected.";
    var lines = [];
    lines.push("Image Metadata Report");
    lines.push("=====================");
    lines.push("");
    lines.push("Format:     " + report.formatLabel + " (" + report.mime + ")");
    lines.push("File size:  " + formatBytes(report.fileSize));
    if (report.dimensions && report.dimensions.width) {
      lines.push("Dimensions: " + report.dimensions.width + " \u00D7 " + report.dimensions.height + " px");
    }
    if (report.version) lines.push("Version:    " + report.version);
    lines.push("");

    lines.push("Privacy exposure: " + report.privacy.level.toUpperCase() +
      " (score " + report.privacy.score + ")");
    if (report.privacy.items.length) {
      report.privacy.items.forEach(function (it) {
        lines.push("  \u2022 " + it.label + " \u2014 " + it.detail);
      });
    } else {
      lines.push("  No identifying metadata found.");
    }
    lines.push("");

    lines.push("Metadata present:");
    report.findings.forEach(function (f) {
      lines.push("  " + (f.present ? "[x]" : "[ ]") + " " + f.label +
        (f.count ? " (" + f.count + ")" : "") + (f.note ? " \u2014 " + f.note : ""));
    });
    lines.push("");

    if (report.summary.camera || report.summary.taken || report.summary.exposure) {
      lines.push("Capture summary:");
      var s = report.summary;
      if (s.camera) lines.push("  Camera:    " + s.camera);
      if (s.lens) lines.push("  Lens:      " + s.lens);
      if (s.taken) lines.push("  Taken:     " + s.taken);
      if (s.exposure) lines.push("  Exposure:  " + s.exposure);
      if (s.aperture) lines.push("  Aperture:  " + s.aperture);
      if (s.iso) lines.push("  ISO:       " + s.iso);
      if (s.focalLength) lines.push("  Focal:     " + s.focalLength);
      if (s.orientation) lines.push("  Orientation: " + s.orientation);
      if (s.gps) lines.push("  GPS:       " + s.gps);
      lines.push("");
    }

    var groups = [
      ["IFD0 (main image)", report.exif && report.exif.ifd0],
      ["Exif sub-IFD", report.exif && report.exif.exif],
      ["GPS", report.exif && report.exif.gps],
      ["Interoperability", report.exif && report.exif.interop],
      ["IFD1 (thumbnail)", report.exif && report.exif.ifd1]
    ];
    groups.forEach(function (g) {
      if (!g[1] || !g[1].length) return;
      lines.push(g[0] + ":");
      g[1].forEach(function (e) {
        lines.push("  " + e.name + " (" + e.typeName + "): " + e.display);
      });
      lines.push("");
    });

    if (report.xmp && report.xmp.properties) {
      lines.push("XMP:");
      Object.keys(report.xmp.properties).forEach(function (k) {
        var v = report.xmp.properties[k];
        lines.push("  " + k + ": " + (Array.isArray(v) ? v.join(", ") : v));
      });
      lines.push("");
    }

    if (report.iptc && report.iptc.records) {
      lines.push("IPTC:");
      report.iptc.records.forEach(function (r) {
        lines.push("  " + r.name + " (" + r.record + ")");
        r.datasets.forEach(function (d) { lines.push("    " + d.name + ": " + d.value); });
      });
      lines.push("");
    }

    if (report.warnings.length) {
      lines.push("Warnings:");
      report.warnings.forEach(function (w) { lines.push("  ! " + w); });
      lines.push("");
    }

    return lines.join("\n");
  }

  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c];
    });
  }

  // Produce a self-contained, script-free SVG privacy card for the image.
  function privacyCardSvg(report) {
    if (!report || !report.ok) return "";
    var w = 640, h = 360;
    var accent = "#b3402a", ink = "#211d17", ink2 = "#6f6657", rule = "#d8cfbc", surface = "#fbf8f1";
    var levelColor = report.privacy.level === "clean" ? "#2e7d4e" :
      report.privacy.level === "high" ? accent : ink2;

    var lines = [];
    lines.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
      '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Image privacy card">');
    lines.push('<rect width="' + w + '" height="' + h + '" fill="' + surface + '"/>');
    lines.push('<rect x="0" y="0" width="' + w + '" height="6" fill="' + accent + '"/>');
    lines.push('<text x="40" y="64" font-family="Georgia, serif" font-size="30" fill="' + ink + '">Metadata privacy card</text>');
    lines.push('<text x="40" y="96" font-family="monospace" font-size="13" fill="' + ink2 + '">' +
      escapeXml(report.formatLabel + " \u00B7 " + formatBytes(report.fileSize) +
        (report.dimensions ? " \u00B7 " + report.dimensions.width + "x" + report.dimensions.height : "")) + '</text>');

    var items = report.privacy.items.slice(0, 8);
    var y = 140;
    if (!items.length) {
      lines.push('<text x="40" y="' + y + '" font-family="Georgia, serif" font-size="18" fill="#2e7d4e">No identifying metadata found.</text>');
    } else {
      items.forEach(function (it) {
        lines.push('<circle cx="46" cy="' + (y - 5) + '" r="4" fill="' + levelColor + '"/>');
        lines.push('<text x="62" y="' + y + '" font-family="Georgia, serif" font-size="17" fill="' + ink + '">' +
          escapeXml(it.label) + '</text>');
        var detail = it.detail.length > 74 ? it.detail.slice(0, 73) + "\u2026" : it.detail;
        lines.push('<text x="62" y="' + (y + 20) + '" font-family="monospace" font-size="12" fill="' + ink2 + '">' +
          escapeXml(detail) + '</text>');
        y += 44;
      });
    }

    lines.push('<line x1="40" y1="' + (h - 54) + '" x2="' + (w - 40) + '" y2="' + (h - 54) + '" stroke="' + rule + '"/>');
    lines.push('<text x="40" y="' + (h - 28) + '" font-family="monospace" font-size="12" fill="' + ink2 + '">' +
      escapeXml("Exposure: " + report.privacy.level.toUpperCase() + " (score " + report.privacy.score + ") \u00B7 generated locally by Toolshed") +
      '</text>');
    lines.push('</svg>');
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------
  // Synthetic sample file builder (used by the page and the tests)
  // ---------------------------------------------------------------------

  function bytesFrom(values) { return Uint8Array.from(values); }

  function asciiBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
    return out;
  }

  function buildTiffExif() {
    // A small little-endian TIFF block: IFD0 -> Exif sub-IFD and GPS IFD,
    // carrying camera identity, a timestamp, exposure data and coordinates.
    // Offsets are computed explicitly so the sample is a genuine, walkable
    // TIFF that the parser (and any other tool) can read back.
    function u16(v) { return [v & 0xFF, (v >> 8) & 0xFF]; }
    function u32(v) { return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]; }
    function rational(num, den) { return u32(num).concat(u32(den)); }

    var IFD0_OFFSET = 8, IFD0_COUNT = 4;
    var EXIF_OFFSET = IFD0_OFFSET + 2 + IFD0_COUNT * 12 + 4;
    var EXIF_COUNT = 2;
    var GPS_OFFSET = EXIF_OFFSET + 2 + EXIF_COUNT * 12 + 4;
    var GPS_COUNT = 4;
    var DATA_OFFSET = GPS_OFFSET + 2 + GPS_COUNT * 12 + 4;

    var makeStr = "Toolshed\u0000";
    var dateStr = "2024:05:01 12:30:00\u0000";

    var makeOffset = DATA_OFFSET;
    var dateOffset = makeOffset + makeStr.length;
    var fnumOffset = dateOffset + dateStr.length;
    var latOffset = fnumOffset + 8;
    var lonOffset = latOffset + 24;

    var header = [0x49, 0x49, 0x2A, 0x00].concat(u32(IFD0_OFFSET));

    var ifd0 = [].concat(u16(IFD0_COUNT));
    ifd0 = ifd0.concat(u16(0x010F)).concat(u16(2)).concat(u32(makeStr.length)).concat(u32(makeOffset));
    ifd0 = ifd0.concat(u16(0x0112)).concat(u16(3)).concat(u32(1)).concat(u16(1)).concat(u16(0));
    ifd0 = ifd0.concat(u16(0x8769)).concat(u16(4)).concat(u32(1)).concat(u32(EXIF_OFFSET));
    ifd0 = ifd0.concat(u16(0x8825)).concat(u16(4)).concat(u32(1)).concat(u32(GPS_OFFSET));
    ifd0 = ifd0.concat(u32(0));

    var exifIfd = [].concat(u16(EXIF_COUNT));
    exifIfd = exifIfd.concat(u16(0x9003)).concat(u16(2)).concat(u32(dateStr.length)).concat(u32(dateOffset));
    exifIfd = exifIfd.concat(u16(0x829D)).concat(u16(5)).concat(u32(1)).concat(u32(fnumOffset));
    exifIfd = exifIfd.concat(u32(0));

    // GPS: 51°30'0" N, 0°7'30" W (London). ASCII refs of 2 bytes fit inline.
    var gpsIfd = [].concat(u16(GPS_COUNT));
    gpsIfd = gpsIfd.concat(u16(0x0001)).concat(u16(2)).concat(u32(2)).concat([0x4E, 0x00, 0x00, 0x00]);
    gpsIfd = gpsIfd.concat(u16(0x0002)).concat(u16(5)).concat(u32(3)).concat(u32(latOffset));
    gpsIfd = gpsIfd.concat(u16(0x0003)).concat(u16(2)).concat(u32(2)).concat([0x57, 0x00, 0x00, 0x00]);
    gpsIfd = gpsIfd.concat(u16(0x0004)).concat(u16(5)).concat(u32(3)).concat(u32(lonOffset));
    gpsIfd = gpsIfd.concat(u32(0));

    var data = [];
    data = data.concat(Array.from(asciiBytes(makeStr)));
    data = data.concat(Array.from(asciiBytes(dateStr)));
    data = data.concat(rational(40, 10));                       // FNumber = f/4
    data = data.concat(rational(51, 1)).concat(rational(30, 1)).concat(rational(0, 1));
    data = data.concat(rational(0, 1)).concat(rational(7, 1)).concat(rational(30, 1));

    var all = header.concat(ifd0).concat(exifIfd).concat(gpsIfd).concat(data);
    return bytesFrom(all);
  }

  function buildSampleJpeg() {
    // A structurally valid, minimal JPEG: SOI, APP0 (JFIF), APP1 (EXIF),
    // APP1 (XMP), COM, SOF0, SOS, and a tiny (non-decodable) scan payload.
    var parts = [];
    parts.push(bytesFrom([0xFF, 0xD8]));

    var jfif = asciiBytes("JFIF\u0000");
    var app0 = [0xFF, 0xE0, 0x00, 0x10];
    app0 = app0.concat(Array.from(jfif)).concat([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
    parts.push(bytesFrom(app0));

    var tiff = buildTiffExif();
    var app1Len = 2 + 6 + tiff.length;
    var app1 = [0xFF, 0xE1, (app1Len >> 8) & 0xFF, app1Len & 0xFF];
    app1 = app1.concat(Array.from(asciiBytes("Exif\u0000\u0000"))).concat(Array.from(tiff));
    parts.push(bytesFrom(app1));

    var xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:xmp="http://ns.adobe.com/xap/1.0/">' +
      '<dc:creator><rdf:Seq><rdf:li>Ada Lovelace</rdf:li></rdf:Seq></dc:creator>' +
      '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Sample</rdf:li></rdf:Alt></dc:title>' +
      '<xmp:CreatorTool>Toolshed</xmp:CreatorTool>' +
      '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    var xmpBytes = asciiBytes("http://ns.adobe.com/xap/1.0/\u0000" + xmp);
    var xmpLen = 2 + xmpBytes.length;
    parts.push(bytesFrom([0xFF, 0xE1, (xmpLen >> 8) & 0xFF, xmpLen & 0xFF].concat(Array.from(xmpBytes))));

    var comment = asciiBytes("Generated by Toolshed sample builder");
    var comLen = 2 + comment.length;
    parts.push(bytesFrom([0xFF, 0xFE, (comLen >> 8) & 0xFF, comLen & 0xFF].concat(Array.from(comment))));

    // ICC profile (APP2): 132-byte header with the 'acsp' signature at byte 36
    // and the total size (132) stored big-endian in the first four bytes.
    var icc = new Uint8Array(132);
    icc[3] = 132; icc[36] = 0x61; icc[37] = 0x63; icc[38] = 0x73; icc[39] = 0x70;
    var iccPayload = Array.from(asciiBytes("ICC_PROFILE\u0000")).concat([1, 1]).concat(Array.from(icc));
    var iccLen = 2 + iccPayload.length;
    parts.push(bytesFrom([0xFF, 0xE2, (iccLen >> 8) & 0xFF, iccLen & 0xFF].concat(Array.from(iccPayload))));

    // Photoshop IRB (APP13) carrying an IPTC IIM stream in resource 0x0404.
    var iptcStream = [];
    function iptcDataset(record, dataset, text) {
      var v = Array.from(asciiBytes(text));
      return [0x1C, record, dataset, (v.length >> 8) & 0xFF, v.length & 0xFF].concat(v);
    }
    iptcStream = iptcStream.concat(iptcDataset(2, 105, "Toolshed"));      // Headline
    iptcStream = iptcStream.concat(iptcDataset(2, 80, "Ada Lovelace"));   // By-line
    iptcStream = iptcStream.concat(iptcDataset(2, 116, "(c) Toolshed"));  // Copyright
    var irb = Array.from(asciiBytes("8BIM")).concat([0x04, 0x04, 0x00, 0x00])
      .concat(u32beBytes(iptcStream.length)).concat(iptcStream);
    var psPayload = Array.from(asciiBytes("Photoshop 3.0\u0000")).concat(irb);
    var psLen = 2 + psPayload.length;
    parts.push(bytesFrom([0xFF, 0xED, (psLen >> 8) & 0xFF, psLen & 0xFF].concat(Array.from(psPayload))));

    // SOF0: 8-bit, 8x8, 3 components
    var sof = [0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x08, 0x00, 0x08, 0x03,
      0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
    parts.push(bytesFrom(sof));

    var sos = [0xFF, 0xDA, 0x00, 0x0C, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00];
    parts.push(bytesFrom(sos));

    parts.push(bytesFrom([0x00, 0x11, 0x22, 0x33, 0xFF, 0xD9])); // scan + EOI
    return concatBytes(parts);
  }

  function buildSamplePng() {
    var parts = [];
    parts.push(bytesFrom([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

    function chunk(type, data) {
      var len = data.length;
      var head = [0, 0, 0, 0];
      head[0] = (len >>> 24) & 0xFF; head[1] = (len >>> 16) & 0xFF;
      head[2] = (len >>> 8) & 0xFF; head[3] = len & 0xFF;
      var typeBytes = asciiBytes(type);
      // CRC is required by the spec but not needed for metadata inspection;
      // a placeholder keeps the sample compact.
      return bytesFrom(head.concat(Array.from(typeBytes)).concat(Array.from(data)).concat([0, 0, 0, 0]));
    }

    var ihdr = [0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0]; // 16x16 RGBA
    parts.push(chunk("IHDR", ihdr));

    var text = Array.from(asciiBytes("Comment")).concat([0]).concat(Array.from(asciiBytes("Hello from Toolshed")));
    parts.push(chunk("tEXt", text));

    var software = Array.from(asciiBytes("Software")).concat([0]).concat(Array.from(asciiBytes("Toolshed Sample")));
    parts.push(chunk("tEXt", software));

    var xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:creator><rdf:Seq><rdf:li>Grace Hopper</rdf:li></rdf:Seq></dc:creator>' +
      '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    // iTXt layout: keyword, NUL, compression flag, compression method,
    // language tag, NUL, translated keyword, NUL, text. Empty tags here.
    var itxt = Array.from(asciiBytes("XML:com.adobe.xmp")).concat([0, 0, 0, 0, 0])
      .concat(Array.from(asciiBytes(xmp)));
    parts.push(chunk("iTXt", itxt));

    parts.push(chunk("IEND", []));
    return concatBytes(parts);
  }

  function buildSampleWebp() {
    var parts = [];
    parts.push(asciiBytes("RIFF"));
    var body = [];
    // VP8X with ICC + EXIF + XMP flags set, 16x16 canvas.
    var vp8x = [0x2C, 0, 0, 0, 0x0F, 0x00, 0x00, 0x0F, 0x00, 0x00];
    body.push(asciiBytes("VP8X"));
    body.push(u32leBytes(10));
    body.push(bytesFrom(vp8x));
    // Minimal ICC profile (132 bytes) so ICC handling is exercised. The
    // profile size in the first four bytes is big-endian, as the ICC spec
    // requires; only the RIFF chunk size around it is little-endian.
    var icc = new Uint8Array(132);
    icc[3] = 132; icc[36] = 0x61; icc[37] = 0x63; icc[38] = 0x73; icc[39] = 0x70; // 'acsp'
    body.push(asciiBytes("ICCP"));
    body.push(u32leBytes(icc.length));
    body.push(icc);
    // EXIF chunk
    var tiff = buildTiffExif();
    body.push(asciiBytes("EXIF"));
    body.push(u32leBytes(tiff.length));
    body.push(tiff);
    if (tiff.length % 2 === 1) body.push(bytesFrom([0]));
    // XMP chunk
    var xmp = asciiBytes('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>Alan Turing</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>');
    body.push(asciiBytes("XMP "));
    body.push(u32leBytes(xmp.length));
    body.push(xmp);
    if (xmp.length % 2 === 1) body.push(bytesFrom([0]));
    // Minimal VP8 image chunk (header only, not a real bitstream).
    var vp8 = [0x30, 0x01, 0x00, 0x9D, 0x01, 0x2A, 0x10, 0x00, 0x10, 0x00];
    body.push(asciiBytes("VP8 "));
    body.push(u32leBytes(vp8.length));
    body.push(bytesFrom(vp8));

    var payload = concatBytes(body);
    parts.push(u32leBytes(payload.length + 4));
    parts.push(asciiBytes("WEBP"));
    parts.push(payload);
    return concatBytes(parts);
  }

  function u32leBytes(v) {
    return bytesFrom([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
  }

  function u32beBytes(v) {
    return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
  }

  function buildSampleGif() {
    var parts = [];
    parts.push(asciiBytes("GIF89a"));
    parts.push(bytesFrom([0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00])); // 16x16, no GCT
    var comment = asciiBytes("Toolshed GIF sample");
    parts.push(bytesFrom([0x21, 0xFE, comment.length].concat(Array.from(comment)).concat([0x00])));

    // Application extension carrying an XMP packet, split into sub-blocks.
    var xmp = asciiBytes("XMP DataXMP" +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:creator><rdf:Seq><rdf:li>Katherine Johnson</rdf:li></rdf:Seq></dc:creator>' +
      '</rdf:Description></rdf:RDF></x:xmpmeta>');
    parts.push(bytesFrom([0x21, 0xFF, 11]));
    parts.push(xmp.subarray(0, 11));
    for (var i = 11; i < xmp.length; i += 255) {
      var block = xmp.subarray(i, Math.min(i + 255, xmp.length));
      parts.push(bytesFrom([block.length]));
      parts.push(block);
    }
    parts.push(bytesFrom([0x00])); // sub-block terminator
    parts.push(bytesFrom([0x3B])); // trailer
    return concatBytes(parts);
  }

  function sampleBytes(kind) {
    if (kind === "png") return buildSamplePng();
    if (kind === "webp") return buildSampleWebp();
    if (kind === "gif") return buildSampleGif();
    return buildSampleJpeg();
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  return {
    VERSION: VERSION,
    inspect: inspect,
    stripMetadata: stripMetadata,
    parseExif: parseExif,
    parseXmp: parseXmp,
    parseIptc: parseIptc,
    parseIcc: parseIcc,
    parseXmlTree: parseXmlTree,
    detectFormat: detectFormat,
    reportToText: reportToText,
    privacyCardSvg: privacyCardSvg,
    formatBytes: formatBytes,
    sampleBytes: sampleBytes,
    // exported for focused unit tests
    _internal: {
      toBytes: toBytes,
      decodeText: decodeText,
      dmsToDecimal: dmsToDecimal,
      rationalToNumber: rationalToNumber,
      numericValue: numericValue,
      trimNull: trimNull,
      hasPrefix: hasPrefix,
      localName: localName,
      formatExposure: formatExposure,
      formatDmsArray: formatDmsArray,
      describeOrientation: describeOrientation,
      buildSampleJpeg: buildSampleJpeg,
      buildSamplePng: buildSamplePng,
      buildSampleWebp: buildSampleWebp,
      buildSampleGif: buildSampleGif,
      buildTiffExif: buildTiffExif
    }
  };
});
