/* Toolshed - Archive Inspector
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.archiveInspector and in Node via require() for tests.
 *
 * Everything here operates on an ArrayBuffer/Uint8Array and returns plain
 * objects, so it is equally usable from a Web Worker and from a Node test.
 *
 * The DEFLATE decoder is a port of Mark Adler's public-domain "puff"
 * reference implementation, which keeps the tool free of any dependency
 * while still decompressing real archives.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.archiveInspector = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // -----------------------------------------------------------------------
  // Small byte helpers
  // -----------------------------------------------------------------------

  function u8(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError("expected an ArrayBuffer or Uint8Array");
  }

  function readU16(d, o) {
    return d[o] | (d[o + 1] << 8);
  }
  function readU32(d, o) {
    return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  }
  function concat(parts, total) {
    var out = new Uint8Array(total);
    var at = 0;
    for (var i = 0; i < parts.length; i++) {
      out.set(parts[i], at);
      at += parts[i].length;
    }
    return out;
  }

  // -----------------------------------------------------------------------
  // CRC-32 (IEEE), used by ZIP and GZIP and by checksum verification
  // -----------------------------------------------------------------------

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(data, seed) {
    var c = (seed === undefined ? 0 : seed) ^ 0xffffffff;
    for (var i = 0; i < data.length; i++) {
      c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // -----------------------------------------------------------------------
  // DEFLATE / INFLATE (raw, no zlib or gzip wrapper)
  //
  // Port of puff.c by Mark Adler (zlib licence, public domain reference).
  // -----------------------------------------------------------------------

  var LENS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DISTS = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLCIDX = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function InflateState(data) {
    this.data = data;
    this.pos = 0;
    this.bitbuf = 0;
    this.bitcnt = 0;
    this.out = new Uint8Array(1024);
    this.outLen = 0;
  }

  InflateState.prototype.need = function (n) {
    while (this.bitcnt < n) {
      if (this.pos >= this.data.length) return false;
      this.bitbuf |= this.data[this.pos++] << this.bitcnt;
      this.bitcnt += 8;
    }
    return true;
  };

  InflateState.prototype.bits = function (n) {
    if (n === 0) return 0;
    if (!this.need(n)) throw new Error("unexpected end of DEFLATE stream");
    var val = this.bitbuf & ((1 << n) - 1);
    this.bitbuf >>>= n;
    this.bitcnt -= n;
    return val;
  };

  function Huffman() {
    this.count = new Array(16);
    this.symbol = new Array(288);
  }

  function buildHuffman(h, lengths, n) {
    var len, symbol, left, offs;
    for (len = 0; len < 16; len++) h.count[len] = 0;
    for (symbol = 0; symbol < n; symbol++) h.count[lengths[symbol]]++;
    if (h.count[0] === n) return 0; // complete set with no codes
    left = 1;
    for (len = 1; len <= 15; len++) {
      left <<= 1;
      left -= h.count[len];
      if (left < 0) return left; // over-subscribed
    }
    offs = new Array(16);
    offs[1] = 0;
    for (len = 1; len < 15; len++) offs[len + 1] = offs[len] + h.count[len];
    for (symbol = 0; symbol < n; symbol++) {
      if (lengths[symbol] !== 0) h.symbol[offs[lengths[symbol]]++] = symbol;
    }
    return left; // 0 means complete
  }

  function decodeSym(s, h) {
    var len, code, first, count, index;
    code = first = index = 0;
    for (len = 1; len <= 15; len++) {
      code |= s.bits(1);
      count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("invalid Huffman code in DEFLATE stream");
  }

  function ensureOut(s, extra) {
    if (s.outLen + extra <= s.out.length) return;
    var cap = s.out.length;
    while (cap < s.outLen + extra) cap *= 2;
    var next = new Uint8Array(cap);
    next.set(s.out.subarray(0, s.outLen));
    s.out = next;
  }

  function inflateCodes(s, lencode, distcode) {
    for (;;) {
      var symbol = decodeSym(s, lencode);
      if (symbol < 256) {
        ensureOut(s, 1);
        s.out[s.outLen++] = symbol;
      } else if (symbol === 256) {
        return;
      } else {
        var idx = symbol - 257;
        if (idx >= LENS.length) throw new Error("invalid length code in DEFLATE stream");
        var len = LENS[idx] + s.bits(LEXT[idx]);
        var dcode = decodeSym(s, distcode);
        if (dcode >= DISTS.length) throw new Error("invalid distance code in DEFLATE stream");
        var dist = DISTS[dcode] + s.bits(DEXT[dcode]);
        if (dist > s.outLen) throw new Error("distance too far back in DEFLATE stream");
        ensureOut(s, len);
        for (var i = 0; i < len; i++) {
          s.out[s.outLen] = s.out[s.outLen - dist];
          s.outLen++;
        }
      }
    }
  }

  var FIXED_LEN = (function () {
    var l = new Array(288);
    var i;
    for (i = 0; i < 144; i++) l[i] = 8;
    for (; i < 256; i++) l[i] = 9;
    for (; i < 280; i++) l[i] = 7;
    for (; i < 288; i++) l[i] = 8;
    return l;
  })();
  var FIXED_DIST = new Array(30).fill(5);

  function inflateRaw(data) {
    var s = new InflateState(u8(data));
    var last, type;
    var lencode = new Huffman();
    var distcode = new Huffman();

    do {
      last = s.bits(1);
      type = s.bits(2);
      if (type === 0) {
        // stored (uncompressed) block
        s.bitbuf = 0;
        s.bitcnt = 0;
        if (s.pos + 4 > s.data.length) throw new Error("truncated stored block");
        var len = readU16(s.data, s.pos);
        var nlen = readU16(s.data, s.pos + 2);
        s.pos += 4;
        if ((len ^ 0xffff) !== nlen) throw new Error("stored block length mismatch");
        if (s.pos + len > s.data.length) throw new Error("truncated stored block data");
        ensureOut(s, len);
        s.out.set(s.data.subarray(s.pos, s.pos + len), s.outLen);
        s.outLen += len;
        s.pos += len;
      } else if (type === 1) {
        buildHuffman(lencode, FIXED_LEN, 288);
        buildHuffman(distcode, FIXED_DIST, 30);
        inflateCodes(s, lencode, distcode);
      } else if (type === 2) {
        var hlit = s.bits(5) + 257;
        var hdist = s.bits(5) + 1;
        var hclen = s.bits(4) + 4;
        if (hlit > 286 || hdist > 30) throw new Error("invalid dynamic block header");
        var lengths = new Array(320);
        var i;
        for (i = 0; i < 19; i++) lengths[i] = 0;
        for (i = 0; i < hclen; i++) lengths[CLCIDX[i]] = s.bits(3);
        var lencode2 = new Huffman();
        buildHuffman(lencode2, lengths, 19);
        var n = 0;
        while (n < hlit + hdist) {
          var sym = decodeSym(s, lencode2);
          if (sym < 16) {
            lengths[n++] = sym;
          } else {
            var rep, value = 0;
            if (sym === 16) {
              if (n === 0) throw new Error("no previous length to repeat");
              value = lengths[n - 1];
              rep = 3 + s.bits(2);
            } else if (sym === 17) {
              rep = 3 + s.bits(3);
            } else {
              rep = 11 + s.bits(7);
            }
            if (n + rep > hlit + hdist) throw new Error("too many code lengths");
            while (rep--) lengths[n++] = value;
          }
        }
        if (lengths[256] === 0) throw new Error("missing end-of-block code");
        var llens = lengths.slice(0, hlit);
        var dlens = lengths.slice(hlit, hlit + hdist);
        buildHuffman(lencode, llens, hlit);
        buildHuffman(distcode, dlens, hdist);
        inflateCodes(s, lencode, distcode);
      } else {
        throw new Error("invalid DEFLATE block type");
      }
    } while (!last);

    return s.out.subarray(0, s.outLen);
  }

  // -----------------------------------------------------------------------
  // Text decoding
  // -----------------------------------------------------------------------

  var textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;

  function decodeText(data, limit) {
    var slice = data;
    var truncated = false;
    if (limit && data.length > limit) {
      slice = data.subarray(0, limit);
      truncated = true;
    }
    var text;
    if (textDecoder) {
      text = textDecoder.decode(slice);
    } else {
      // Minimal UTF-8 fallback for very old environments.
      var chars = [];
      for (var i = 0; i < slice.length; i++) chars.push(String.fromCharCode(slice[i]));
      text = chars.join("");
    }
    return { text: text, truncated: truncated };
  }

  function looksBinary(data, sampleLen) {
    var n = Math.min(data.length, sampleLen || 8192);
    if (n === 0) return false;
    var nul = 0;
    for (var i = 0; i < n; i++) if (data[i] === 0) nul++;
    return nul / n > 0.02;
  }

  // -----------------------------------------------------------------------
  // ZIP
  // -----------------------------------------------------------------------

  function findEOCD(d) {
    var min = Math.max(0, d.length - 65557);
    for (var i = d.length - 22; i >= min; i--) {
      if (d[i] === 0x50 && d[i + 1] === 0x4b && d[i + 2] === 0x05 && d[i + 3] === 0x06) return i;
    }
    return -1;
  }

  function zip64Extra(d, extraStart, extraLen, need) {
    // Returns {size, compressed, offset} for whichever fields are 0xFFFFFFFF.
    var end = extraStart + extraLen;
    var o = extraStart;
    var result = {};
    while (o + 4 <= end) {
      var id = readU16(d, o);
      var sz = readU16(d, o + 2);
      if (id === 0x0001) {
        var p = o + 4;
        if (need.size && p + 8 <= o + 4 + sz) {
          result.size = Number(readU32(d, p) | (readU32(d, p + 4) * 0x100000000));
          p += 8;
        }
        if (need.compressed && p + 8 <= o + 4 + sz) {
          result.compressed = Number(readU32(d, p) | (readU32(d, p + 4) * 0x100000000));
          p += 8;
        }
        if (need.offset && p + 8 <= o + 4 + sz) {
          result.offset = Number(readU32(d, p) | (readU32(d, p + 4) * 0x100000000));
          p += 8;
        }
        return result;
      }
      o += 4 + sz;
    }
    return result;
  }

  function dosDateTime(date, time) {
    var year = 1980 + ((date >> 9) & 0x7f);
    var month = (date >> 5) & 0x0f;
    var day = date & 0x1f;
    var hour = (time >> 11) & 0x1f;
    var min = (time >> 5) & 0x3f;
    var sec = (time & 0x1f) * 2;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    var dt = new Date(Date.UTC(year, month - 1, day, hour, min, sec));
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  function parseZip(d) {
    var eocd = findEOCD(d);
    if (eocd < 0) return { error: "no ZIP end-of-directory record found (the file may be truncated or not a ZIP)" };

    var total = readU16(d, eocd + 10);
    var cdSize = readU32(d, eocd + 12);
    var cdOffset = readU32(d, eocd + 16);
    var zip64 = false;

    // ZIP64 end-of-central-directory locator sits 20 bytes before the EOCD.
    if (eocd >= 20 && d[eocd - 20] === 0x50 && d[eocd - 19] === 0x4b && d[eocd - 18] === 0x06 && d[eocd - 17] === 0x07) {
      var e64 = Number(readU32(d, eocd - 12) | (readU32(d, eocd - 8) * 0x100000000));
      if (e64 + 56 <= d.length && readU32(d, e64) === 0x06064b50) {
        zip64 = true;
        total = Number(readU32(d, e64 + 32) | (readU32(d, e64 + 36) * 0x100000000));
        cdSize = Number(readU32(d, e64 + 40) | (readU32(d, e64 + 44) * 0x100000000));
        cdOffset = Number(readU32(d, e64 + 48) | (readU32(d, e64 + 52) * 0x100000000));
      }
    }

    var entries = [];
    var pos = cdOffset;
    var end = cdOffset + cdSize;
    if (end > d.length) end = d.length;

    while (pos + 46 <= end) {
      if (readU32(d, pos) !== 0x02014b50) break;
      var flags = readU16(d, pos + 8);
      var method = readU16(d, pos + 10);
      var modTime = readU16(d, pos + 12);
      var modDate = readU16(d, pos + 14);
      var crc = readU32(d, pos + 16);
      var compSize = readU32(d, pos + 20);
      var uncompSize = readU32(d, pos + 24);
      var nameLen = readU16(d, pos + 28);
      var extraLen = readU16(d, pos + 30);
      var commentLen = readU16(d, pos + 32);
      var externalAttrs = readU32(d, pos + 38);
      var localOffset = readU32(d, pos + 42);
      var nameBytes = d.subarray(pos + 46, pos + 46 + nameLen);

      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        var z = zip64Extra(d, pos + 46 + nameLen, extraLen, {
          size: uncompSize === 0xffffffff,
          compressed: compSize === 0xffffffff,
          offset: localOffset === 0xffffffff,
        });
        if (z.size !== undefined) uncompSize = z.size;
        if (z.compressed !== undefined) compSize = z.compressed;
        if (z.offset !== undefined) localOffset = z.offset;
      }

      var name = decodeText(nameBytes).text;
      entries.push({
        name: name,
        path: name,
        size: uncompSize,
        compressedSize: compSize,
        method: method,
        crc32: crc,
        mtime: dosDateTime(modDate, modTime),
        encrypted: (flags & 0x1) !== 0,
        utf8: (flags & 0x800) !== 0,
        localOffset: localOffset,
        externalAttrs: externalAttrs,
      });
      pos += 46 + nameLen + extraLen + commentLen;
    }

    if (entries.length === 0 && total > 0) {
      return { error: "the ZIP central directory could not be read (unsupported or corrupted archive)" };
    }

    return { entries: entries, zip64: zip64, comment: decodeText(d.subarray(eocd + 22, eocd + 22 + readU16(d, eocd + 20))).text };
  }

  function readZipEntryData(d, entry) {
    var o = entry.localOffset;
    if (o + 30 > d.length || readU32(d, o) !== 0x04034b50) {
      throw new Error("the local file header for this entry is missing or corrupted");
    }
    var nameLen = readU16(d, o + 26);
    var extraLen = readU16(d, o + 28);
    var start = o + 30 + nameLen + extraLen;
    if (entry.encrypted) throw new Error("this entry is encrypted and cannot be read");
    if (start + entry.compressedSize > d.length) throw new Error("entry data runs past the end of the file");
    var raw = d.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRaw(raw);
    throw new Error("unsupported compression method " + entry.method);
  }

  // -----------------------------------------------------------------------
  // GZIP
  // -----------------------------------------------------------------------

  function parseGzip(d) {
    if (d.length < 18) return { error: "the GZIP stream is too short" };
    var flg = d[3];
    var mtime = readU32(d, 4);
    var pos = 10;
    if (flg & 0x04) {
      if (pos + 2 > d.length) return { error: "truncated GZIP extra field" };
      var xlen = readU16(d, pos);
      pos += 2 + xlen;
    }
    var name = null;
    if (flg & 0x08) {
      var end = pos;
      while (end < d.length && d[end] !== 0) end++;
      name = decodeText(d.subarray(pos, end)).text;
      pos = end + 1;
    }
    if (flg & 0x10) {
      var end2 = pos;
      while (end2 < d.length && d[end2] !== 0) end2++;
      pos = end2 + 1;
    }
    if (flg & 0x02) pos += 2;
    if (pos >= d.length) return { error: "truncated GZIP header" };

    var compressed = d.subarray(pos, d.length - 8);
    var out;
    try {
      out = inflateRaw(compressed);
    } catch (err) {
      return { error: "could not decompress the GZIP stream: " + err.message };
    }
    var trailerCrc = readU32(d, d.length - 8);
    var isize = readU32(d, d.length - 4);
    var crcOk = crc32(out) === trailerCrc;
    var inner = name || "data";
    return {
      entries: [
        {
          name: inner,
          path: inner,
          size: out.length,
          compressedSize: compressed.length,
          method: 8,
          methodLabel: "deflate",
          crc32: trailerCrc,
          crcOk: crcOk,
          mtime: mtime ? new Date(mtime * 1000).toISOString() : null,
          isize: isize,
          data: out,
        },
      ],
    };
  }

  // -----------------------------------------------------------------------
  // TAR (ustar / GNU / PAX)
  // -----------------------------------------------------------------------

  function tarString(d, start, len) {
    var end = start;
    var stop = start + len;
    while (end < stop && d[end] !== 0) end++;
    return decodeText(d.subarray(start, end)).text;
  }

  function tarNumber(d, start, len) {
    // Base-256 encoding has the high bit of the first byte set.
    if (d[start] & 0x80) {
      var value = 0;
      for (var i = start; i < start + len; i++) value = value * 256 + d[i];
      value -= Math.pow(2, 8 * len);
      return value;
    }
    var text = tarString(d, start, len).trim();
    if (text === "") return 0;
    var n = parseInt(text, 8);
    return isNaN(n) ? 0 : n;
  }

  function parseTar(d) {
    var entries = [];
    var pos = 0;
    var pendingLongName = null;
    var paxPath = null;
    var zeroBlocks = 0;

    while (pos + 512 <= d.length) {
      var block = d.subarray(pos, pos + 512);
      var allZero = true;
      for (var i = 0; i < 512; i++) {
        if (block[i] !== 0) {
          allZero = false;
          break;
        }
      }
      if (allZero) {
        zeroBlocks++;
        pos += 512;
        if (zeroBlocks >= 2) break;
        continue;
      }
      zeroBlocks = 0;

      var typeflag = String.fromCharCode(d[pos + 156]);
      var size = tarNumber(d, pos + 124, 12);
      var name = tarString(d, pos, 100);
      var prefix = tarString(d, pos + 345, 155);
      var linkname = tarString(d, pos + 157, 100);
      var mtime = tarNumber(d, pos + 136, 12);
      var mode = tarNumber(d, pos + 100, 8);
      var dataStart = pos + 512;

      if (typeflag === "L") {
        pendingLongName = decodeText(d.subarray(dataStart, dataStart + size)).text.replace(/\0+$/, "");
        pos = dataStart + Math.ceil(size / 512) * 512;
        continue;
      }
      if (typeflag === "x" || typeflag === "g") {
        var paxText = decodeText(d.subarray(dataStart, dataStart + size)).text;
        var lines = paxText.split("\n");
        for (var li = 0; li < lines.length; li++) {
          var m = /^(\d+) ([^=]+)=(.*)$/.exec(lines[li]);
          if (m && m[2] === "path") paxPath = m[3];
        }
        pos = dataStart + Math.ceil(size / 512) * 512;
        continue;
      }

      var fullName = pendingLongName || (prefix ? prefix + "/" + name : name);
      if (paxPath) fullName = paxPath;
      pendingLongName = null;
      paxPath = null;

      entries.push({
        name: fullName,
        path: fullName,
        size: size,
        compressedSize: size,
        method: 0,
        methodLabel: "stored",
        crc32: null,
        mtime: mtime ? new Date(mtime * 1000).toISOString() : null,
        typeflag: typeflag,
        linkname: linkname,
        mode: mode,
        dataOffset: dataStart,
      });

      pos = dataStart + Math.ceil(size / 512) * 512;
    }

    if (entries.length === 0) return { error: "no TAR entries found (the file may be truncated or not a TAR)" };
    return { entries: entries };
  }

  // -----------------------------------------------------------------------
  // Format detection
  // -----------------------------------------------------------------------

  function detectFormat(d) {
    if (d.length >= 4 && d[0] === 0x50 && d[1] === 0x4b) {
      if (d[2] === 0x03 || d[2] === 0x05 || d[2] === 0x07) return "zip";
    }
    if (d.length >= 2 && d[0] === 0x1f && d[1] === 0x8b) return "gzip";
    if (d.length >= 262) {
      var magic = decodeText(d.subarray(257, 262)).text;
      if (magic === "ustar") return "tar";
    }
    // A tar can also start with a valid checksum but no ustar magic.
    if (d.length >= 512 && tarChecksumValid(d, 0)) return "tar";
    if (d.length >= 3 && d[0] === 0x42 && d[1] === 0x5a && d[2] === 0x68) return "bzip2";
    if (d.length >= 6 && d[0] === 0xfd && d[1] === 0x37 && d[2] === 0x7a && d[3] === 0x58 && d[4] === 0x5a && d[5] === 0x00) return "xz";
    if (d.length >= 6 && d[0] === 0x37 && d[1] === 0x7a && d[2] === 0xbc && d[3] === 0xaf && d[4] === 0x27 && d[5] === 0x1c) return "7z";
    if (d.length >= 7 && d[0] === 0x52 && d[1] === 0x61 && d[2] === 0x72 && d[3] === 0x21 && d[4] === 0x1a && d[5] === 0x07) return "rar";
    return null;
  }

  function tarChecksumValid(d, pos) {
    if (pos + 512 > d.length) return false;
    var stored = tarNumber(d, pos + 148, 8);
    if (stored === 0) return false;
    var sum = 0;
    for (var i = 0; i < 512; i++) {
      sum += i >= 148 && i < 156 ? 32 : d[pos + i];
    }
    return sum === stored;
  }

  var FORMAT_LABELS = {
    zip: "ZIP archive",
    gzip: "GZIP stream",
    tar: "TAR archive",
    bzip2: "bzip2 archive",
    xz: "XZ archive",
    "7z": "7-Zip archive",
    rar: "RAR archive",
  };

  var UNSUPPORTED = {
    bzip2: "bzip2 compression is not supported in the browser; this tool only reads ZIP, GZIP and TAR.",
    xz: "XZ compression is not supported in the browser; this tool only reads ZIP, GZIP and TAR.",
    "7z": "7-Zip archives are not supported; this tool only reads ZIP, GZIP and TAR.",
    rar: "RAR archives are not supported; this tool only reads ZIP, GZIP and TAR.",
  };

  // -----------------------------------------------------------------------
  // Classification helpers
  // -----------------------------------------------------------------------

  var EXECUTABLE_EXT = {
    exe: 1, dll: 1, scr: 1, com: 1, pif: 1, msi: 1, bat: 1, cmd: 1, ps1: 1, ps1xml: 1,
    vbs: 1, vbe: 1, js: 1, jse: 1, wsf: 1, wsh: 1, hta: 1, lnk: 1, jar: 1, app: 1, sh: 1,
    bash: 1, zsh: 1, command: 1, action: 1, dmg: 1, pkg: 1, deb: 1, rpm: 1, apk: 1, elf: 1,
  };

  var ARCHIVE_EXT = { zip: 1, gz: 1, tgz: 1, tar: 1, "7z": 1, rar: 1, bz2: 1, xz: 1, war: 1, jar: 1, apk: 1, whl: 1 };

  var IMAGE_MIME = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  };

  var TEXT_EXT = {
    txt: 1, md: 1, markdown: 1, json: 1, jsonl: 1, ndjson: 1, csv: 1, tsv: 1, xml: 1, html: 1,
    htm: 1, css: 1, scss: 1, less: 1, js: 1, mjs: 1, cjs: 1, ts: 1, tsx: 1, jsx: 1, py: 1,
    rb: 1, go: 1, rs: 1, java: 1, c: 1, h: 1, cpp: 1, hpp: 1, cs: 1, php: 1, sh: 1, yml: 1,
    yaml: 1, toml: 1, ini: 1, cfg: 1, conf: 1, log: 1, sql: 1, svg: 1, env: 1, gitignore: 1,
    dockerfile: 1, makefile: 1, gradle: 1, properties: 1, lock: 1, tex: 1, r: 1, lua: 1,
  };

  function extensionOf(name) {
    var base = name;
    var slash = name.lastIndexOf("/");
    if (slash >= 0) base = name.slice(slash + 1);
    var dot = base.lastIndexOf(".");
    if (dot <= 0) return "";
    return base.slice(dot + 1).toLowerCase();
  }

  function baseName(name) {
    var slash = name.lastIndexOf("/");
    return slash >= 0 ? name.slice(slash + 1) : name;
  }

  function dirName(name) {
    var slash = name.lastIndexOf("/");
    return slash > 0 ? name.slice(0, slash) : "";
  }

  function isDirEntry(entry) {
    if (entry.typeflag === "5") return true;
    if (/\/$/.test(entry.path)) return true;
    // A ZIP folder made on Windows can have no trailing slash but DOS dir attrs.
    if (entry.externalAttrs && (entry.externalAttrs & 0x10) && entry.size === 0) return true;
    return false;
  }

  // -----------------------------------------------------------------------
  // Analysis
  // -----------------------------------------------------------------------

  function normalisePath(path) {
    return path.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function analyse(data, options) {
    options = options || {};
    var d = u8(data);
    var filename = options.filename || "";
    if (d.length === 0) return { ok: false, error: "the file is empty" };

    var format = detectFormat(d);
    if (!format) {
      return {
        ok: false,
        error: "This does not look like a ZIP, GZIP or TAR archive.",
        detected: null,
      };
    }
    if (UNSUPPORTED[format]) {
      return { ok: false, format: format, formatLabel: FORMAT_LABELS[format], error: UNSUPPORTED[format], detected: format };
    }

    var parsed;
    try {
      if (format === "zip") parsed = parseZip(d);
      else if (format === "gzip") parsed = parseGzip(d);
      else parsed = parseTar(d);
    } catch (err) {
      return { ok: false, format: format, formatLabel: FORMAT_LABELS[format], error: "could not read the archive: " + err.message };
    }
    if (parsed.error) {
      return { ok: false, format: format, formatLabel: FORMAT_LABELS[format], error: parsed.error };
    }

    var entries = parsed.entries.map(function (entry, index) {
      var isDir = isDirEntry(entry);
      var methodLabel = entry.methodLabel || (entry.method === 8 ? "deflate" : entry.method === 0 ? "stored" : "method " + entry.method);
      var path = normalisePath(entry.path);
      var depth = path === "" ? 0 : path.split("/").length - (isDir ? 1 : 0);
      return {
        index: index,
        path: path || entry.path,
        rawPath: entry.path,
        name: baseName(path),
        dir: dirName(path),
        isDir: isDir,
        size: entry.size,
        compressedSize: entry.compressedSize,
        method: entry.method,
        methodLabel: methodLabel,
        crc32: entry.crc32,
        crcOk: entry.crcOk,
        mtime: entry.mtime,
        encrypted: !!entry.encrypted,
        typeflag: entry.typeflag,
        linkname: entry.linkname,
        ext: extensionOf(path),
        depth: depth,
        ratio: entry.compressedSize > 0 ? entry.size / entry.compressedSize : null,
        localOffset: entry.localOffset,
      };
    });

    // De-duplicate: some archives list the same path twice.
    var seen = Object.create(null);
    entries.forEach(function (entry) {
      var key = entry.path.toLowerCase();
      if (seen[key] === undefined) seen[key] = 1;
      else seen[key]++;
    });
    var duplicates = Object.keys(seen).filter(function (k) {
      return seen[k] > 1;
    });

    var files = entries.filter(function (e) {
      return !e.isDir;
    });
    var folders = entries.filter(function (e) {
      return e.isDir;
    });

    var totalUncompressed = 0;
    var totalCompressed = 0;
    files.forEach(function (e) {
      totalUncompressed += e.size;
      totalCompressed += e.compressedSize;
    });

    var typeBreakdown = Object.create(null);
    files.forEach(function (e) {
      var key = e.ext || "(no extension)";
      if (!typeBreakdown[key]) typeBreakdown[key] = { ext: key, count: 0, bytes: 0 };
      typeBreakdown[key].count++;
      typeBreakdown[key].bytes += e.size;
    });

    var largest = null;
    var deepest = null;
    files.forEach(function (e) {
      if (!largest || e.size > largest.size) largest = e;
      if (!deepest || e.depth > deepest.depth) deepest = e;
    });

    var findings = [];
    function finding(severity, code, message, path) {
      findings.push({ severity: severity, code: code, message: message, path: path || null });
    }

    if (files.length === 0) {
      finding("info", "empty", "The archive contains no files (only folders or nothing at all).");
    }

    duplicates.slice(0, 20).forEach(function (path) {
      finding("warning", "duplicate", "Duplicate entry: \"" + path + "\" appears more than once, which some extractors overwrite silently.", path);
    });

    entries.forEach(function (entry) {
      var p = entry.rawPath;
      if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p)) {
        finding("high", "absolute-path", "Absolute path \"" + p + "\" — extracting this can write outside the destination folder.", p);
      } else if (/(^|\/)\.\.(\/|$)/.test(p.replace(/\\/g, "/"))) {
        finding("high", "traversal", "Path traversal in \"" + p + "\" — a naive extractor could overwrite files outside the destination folder.", p);
      }
    });

    files.forEach(function (entry) {
      if (entry.encrypted) {
        finding("info", "encrypted", "\"" + entry.path + "\" is encrypted and cannot be read or previewed here.", entry.path);
      }
      if (ARCHIVE_EXT[entry.ext]) {
        finding("info", "nested-archive", "\"" + entry.path + "\" is itself an archive — a common way to smuggle content past a scan.", entry.path);
      }
      if (EXECUTABLE_EXT[entry.ext]) {
        finding("warning", "executable", "\"" + entry.path + "\" is an executable or script type (.{0}) that runs when opened.".replace("{0}", entry.ext), entry.path);
      }
      if (entry.ext === "" && !entry.isDir && entry.size > 0) {
        finding("info", "no-extension", "\"" + entry.path + "\" has no file extension.", entry.path);
      }
      if (entry.ratio !== null && entry.size > 1024 * 1024 && entry.ratio > 100) {
        finding("warning", "zip-bomb", "\"" + entry.path + "\" expands " + Math.round(entry.ratio) + "x (a possible decompression bomb).", entry.path);
      }
      if (/[\u0000-\u001f]/.test(entry.rawPath)) {
        finding("high", "control-chars", "The name of \"" + entry.path.replace(/[\u0000-\u001f]/g, "?") + "\" contains control characters, which can hide the real filename.", entry.path);
      }
    });

    var macJunk = entries.filter(function (e) {
      return /^__MACOSX\//i.test(e.path) || /(^|\/)\.DS_Store$/i.test(e.path) || /(^|\/)\._[^/]+$/.test(e.path);
    });
    if (macJunk.length > 0) {
      finding("info", "mac-junk", macJunk.length + " macOS metadata entr" + (macJunk.length === 1 ? "y" : "ies") + " (__MACOSX, .DS_Store, ._*) add clutter.");
    }

    if (totalUncompressed > 1024 * 1024 * 1024) {
      finding("warning", "huge", "The archive expands to over 1 GB (" + formatBytes(totalUncompressed) + ").");
    }
    if (deepest && deepest.depth >= 8) {
      finding("info", "deep", "The deepest entry is " + deepest.depth + " levels down, which can defeat extractors with path limits.");
    }
    if (format === "zip" && parsed.zip64) {
      finding("info", "zip64", "This is a ZIP64 archive (used for files over 4 GB or more than 65535 entries).");
    }
    if (format === "gzip") {
      finding("info", "gzip-single", "GZIP holds exactly one file. The original name and mtime are read from the header when present.");
    }
    if (format === "tar") {
      finding("info", "tar-none", "TAR has no compression of its own; a .tar.gz is a GZIP wrapping a TAR.");
    }

    var severityRank = { high: 0, warning: 1, info: 2 };
    findings.sort(function (a, b) {
      var ra = severityRank[a.severity] - severityRank[b.severity];
      if (ra !== 0) return ra;
      return a.message.localeCompare(b.message);
    });

    return {
      ok: true,
      format: format,
      formatLabel: FORMAT_LABELS[format],
      filename: filename,
      totalBytes: d.length,
      comment: parsed.comment || null,
      zip64: !!parsed.zip64,
      entries: entries,
      files: files,
      folders: folders,
      duplicates: duplicates,
      typeBreakdown: Object.keys(typeBreakdown)
        .map(function (k) {
          return typeBreakdown[k];
        })
        .sort(function (a, b) {
          return b.bytes - a.bytes || b.count - a.count;
        }),
      stats: {
        entryCount: entries.length,
        fileCount: files.length,
        folderCount: folders.length,
        totalUncompressed: totalUncompressed,
        totalCompressed: totalCompressed,
        overhead: d.length - totalCompressed,
        compressionRatio: totalCompressed > 0 ? totalUncompressed / totalCompressed : null,
        savingPercent: totalUncompressed > 0 ? (1 - totalCompressed / totalUncompressed) * 100 : null,
        largest: largest ? { path: largest.path, size: largest.size } : null,
        deepest: deepest ? { path: deepest.path, depth: deepest.depth } : null,
        duplicateCount: duplicates.length,
      },
      findings: findings,
    };
  }

  // -----------------------------------------------------------------------
  // Extraction and preview
  // -----------------------------------------------------------------------

  var DEFAULT_PREVIEW_LIMIT = 512 * 1024;

  function extract(data, analysis, index) {
    var d = u8(data);
    var entry = analysis.entries[index];
    if (!entry) throw new Error("no such entry");
    if (entry.isDir) return { kind: "dir" };

    if (analysis.format === "gzip") {
      // The GZIP payload was already decompressed during analysis; re-read it.
      var g = parseGzip(d);
      if (g.error) throw new Error(g.error);
      return { kind: "data", bytes: g.entries[0].data, entry: entry };
    }

    if (analysis.format === "tar") {
      var e = null;
      var parsedTar = parseTar(d);
      if (parsedTar.error) throw new Error(parsedTar.error);
      // Match by index within the parsed order.
      e = parsedTar.entries[index];
      if (!e) throw new Error("entry not found in TAR");
      var start = e.dataOffset;
      var end = Math.min(start + e.size, d.length);
      return { kind: "data", bytes: d.subarray(start, end), entry: entry };
    }

    var raw = readZipEntryData(d, {
      localOffset: entry.localOffset,
      compressedSize: entry.compressedSize,
      encrypted: entry.encrypted,
      method: entry.method,
    });
    var expectedCrc = entry.crc32;
    var crcOk = expectedCrc == null ? null : crc32(raw) === expectedCrc;
    return { kind: "data", bytes: raw, entry: entry, crcOk: crcOk };
  }

  function preview(data, analysis, index, limit) {
    limit = limit || DEFAULT_PREVIEW_LIMIT;
    var entry = analysis.entries[index];
    if (!entry) return { kind: "error", error: "no such entry" };
    if (entry.isDir) return { kind: "dir" };

    var extracted;
    try {
      extracted = extract(data, analysis, index);
    } catch (err) {
      return { kind: "error", error: err.message, entry: entry };
    }
    var bytes = extracted.bytes;
    var mime = IMAGE_MIME[entry.ext];
    if (mime && bytes.length > 0) {
      return {
        kind: "image",
        mime: mime,
        bytes: bytes.length > limit ? bytes.subarray(0, limit) : bytes,
        totalSize: bytes.length,
        truncated: bytes.length > limit,
        entry: entry,
      };
    }

    var isTextExt = !!TEXT_EXT[entry.ext];
    var binary = looksBinary(bytes);
    if (isTextExt || !binary) {
      var decoded = decodeText(bytes, limit);
      return {
        kind: "text",
        text: decoded.text,
        truncated: decoded.truncated,
        totalSize: bytes.length,
        entry: entry,
      };
    }
    return { kind: "binary", totalSize: bytes.length, entry: entry };
  }

  // -----------------------------------------------------------------------
  // Formatting helpers (shared by UI and tests)
  // -----------------------------------------------------------------------

  function formatBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    if (n < 1000) return n + " B";
    var units = ["KB", "MB", "GB", "TB"];
    var value = n / 1000;
    var i = 0;
    while (value >= 1000 && i < units.length - 1) {
      value /= 1000;
      i++;
    }
    return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + " " + units[i];
  }

  function formatRatio(ratio) {
    if (ratio === null || ratio === undefined || isNaN(ratio)) return "—";
    if (ratio >= 100) return Math.round(ratio) + "×";
    return ratio.toFixed(ratio < 10 ? 2 : 1) + "×";
  }

  function formatPercent(p) {
    if (p === null || p === undefined || isNaN(p)) return "—";
    return (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
  }

  function formatDate(iso) {
    if (!iso) return "—";
    return iso.slice(0, 19).replace("T", " ") + " UTC";
  }

  function describeEntry(entry) {
    if (entry.isDir) return "folder";
    var kind = entry.ext ? entry.ext.toUpperCase() + " file" : "file";
    return kind + " · " + formatBytes(entry.size);
  }

  return {
    // detection / parsing
    detectFormat: detectFormat,
    analyse: analyse,
    extract: extract,
    preview: preview,
    // low-level pieces, exported so tests can hit them directly
    inflateRaw: inflateRaw,
    crc32: crc32,
    parseZip: parseZip,
    parseGzip: parseGzip,
    parseTar: parseTar,
    // helpers
    extensionOf: extensionOf,
    baseName: baseName,
    dirName: dirName,
    formatBytes: formatBytes,
    formatRatio: formatRatio,
    formatPercent: formatPercent,
    formatDate: formatDate,
    describeEntry: describeEntry,
    FORMAT_LABELS: FORMAT_LABELS,
    DEFAULT_PREVIEW_LIMIT: DEFAULT_PREVIEW_LIMIT,
  };
});
