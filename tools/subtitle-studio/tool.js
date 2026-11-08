/* Toolshed — Subtitle Studio
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.subtitleStudio and in Node via require() for tests.
 *
 * The module parses SubRip (.srt) and WebVTT (.vtt) subtitle files into a cue
 * model, and provides the transforms a subtitle editor needs: time shifting,
 * stretching, overlap repair, timing normalization, find-and-replace, tag
 * stripping, line rewrapping, splitting and merging, a QA pass (overlaps,
 * durations, reading speed, line length), and export back to SRT, VTT, plain
 * text or CSV.
 *
 * Everything runs in memory. The module never touches the network, never uses
 * eval or dynamic code execution, and never writes to storage.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.subtitleStudio = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Hard bounds so a pathological file cannot exhaust memory or freeze the
  // tab. Files beyond these are rejected with a clear error rather than
  // silently truncated, because a half-parsed subtitle file is worse than none.
  var MAX_CUES = 20000;
  var MAX_FILE_CHARS = 12 * 1024 * 1024;

  var DEFAULT_QA = {
    minDurationMs: 800,
    maxDurationMs: 10000,
    maxCps: 21,
    maxLineChars: 42,
    maxLines: 2,
    minGapMs: 0
  };

  // ---------------------------------------------------------------------
  // Timecodes
  // ---------------------------------------------------------------------

  // Accepts HH:MM:SS,mmm | HH:MM:SS.mmm | MM:SS.mmm | MM:SS,mmm | MM:SS
  // (hours and milliseconds are both optional).
  var TIMECODE_RE = /^(?:(\d{1,4}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/;

  function parseTimestamp(value) {
    if (typeof value !== "string") return null;
    var s = value.trim();
    if (!s) return null;

    var negative = false;
    if (s.charAt(0) === "-") {
      negative = true;
      s = s.slice(1).trim();
    }

    var m = TIMECODE_RE.exec(s);
    if (!m) return null;

    var hours = m[1] === undefined ? 0 : parseInt(m[1], 10);
    var minutes = parseInt(m[2], 10);
    var seconds = parseInt(m[3], 10);
    if (minutes > 59 || seconds > 59) return null;

    var ms = 0;
    if (m[4] !== undefined) {
      ms = parseInt((m[4] + "000").slice(0, 3), 10);
    }

    var total = ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
    return negative ? -total : total;
  }

  function pad(value, width) {
    var s = String(Math.abs(Math.trunc(value)));
    while (s.length < width) s = "0" + s;
    return s;
  }

  // style: "srt" (comma, always hours), "vtt" (dot, always hours),
  // "compact" (dot, hours omitted when zero — for display only).
  function formatTimestamp(ms, style) {
    var value = Number(ms);
    var useDot = style === "vtt" || style === "compact";
    var sep = useDot ? "." : ",";
    if (!isFinite(value)) return useDot ? "00:00:00.000" : "00:00:00,000";

    var negative = value < 0;
    value = Math.abs(Math.round(value));

    var hours = Math.floor(value / 3600000);
    var minutes = Math.floor((value % 3600000) / 60000);
    var seconds = Math.floor((value % 60000) / 1000);
    var millis = value % 1000;

    var out;
    if (style === "compact" && hours === 0) {
      out = pad(minutes, 2) + ":" + pad(seconds, 2) + sep + pad(millis, 3);
    } else {
      out = pad(hours, 2) + ":" + pad(minutes, 2) + ":" + pad(seconds, 2) + sep + pad(millis, 3);
    }
    return (negative ? "-" : "") + out;
  }

  function formatDuration(ms) {
    var value = Math.abs(Number(ms) || 0);
    if (value < 1000) return Math.round(value) + " ms";
    if (value < 60000) return (value / 1000).toFixed(value % 1000 === 0 ? 0 : 1) + " s";
    var minutes = Math.floor(value / 60000);
    var seconds = Math.round((value % 60000) / 1000);
    return minutes + "m " + seconds + "s";
  }

  // ---------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------

  function normalizeNewlines(text) {
    return String(text == null ? "" : text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  }

  function splitBlocks(text) {
    return normalizeNewlines(text).split(/\n[ \t]*\n/);
  }

  // Trims the blank lines and stray indentation around a cue block while
  // leaving the interior text — including deliberate leading spaces used for
  // dialogue dashes — untouched.
  function trimBlock(block) {
    return String(block).replace(/^\s+/, "").replace(/\s+$/, "");
  }

  var ARROW_RE = /^(.*?)\s*-->\s*(.*?)\s*$/;

  // Splits "00:00:01,000 --> 00:00:04,000 align:middle" into start, end and
  // any trailing cue settings.
  function parseTimecodeLine(line) {
    var m = ARROW_RE.exec(String(line == null ? "" : line).trim());
    if (!m) return null;

    var startToken = m[1].split(/\s+/)[0];
    var rest = m[2].trim();
    var endToken = rest.split(/\s+/)[0];
    var settings = rest.slice(endToken.length).trim();

    var start = parseTimestamp(startToken);
    var end = parseTimestamp(endToken);
    if (start === null || end === null) return null;
    return { start: start, end: end, settings: settings };
  }

  function detectFormat(text) {
    var s = normalizeNewlines(text).trimStart();
    if (/^WEBVTT(?:\s|$)/i.test(s)) return "vtt";
    if (/-->/.test(s)) return "srt";
    return "unknown";
  }

  function isIndexLine(line) {
    return /^\d{1,6}$/.test(String(line).trim());
  }

  function nextCueIdFactory() {
    var n = 0;
    return function () {
      n += 1;
      return "c" + n;
    };
  }

  function parseSRT(text) {
    var blocks = splitBlocks(text);
    var cues = [];
    var errors = [];
    var nextId = nextCueIdFactory();
    var sequence = 0;

    for (var b = 0; b < blocks.length; b++) {
      var block = trimBlock(blocks[b]);
      if (!block) continue;

      var lines = block.split("\n");
      var timeIndex = -1;
      var declaredIndex = null;

      for (var i = 0; i < lines.length; i++) {
        if (ARROW_RE.test(lines[i].trim())) {
          timeIndex = i;
          break;
        }
      }

      if (timeIndex === -1) {
        errors.push({ block: b + 1, message: "no timecode line found; block skipped" });
        continue;
      }
      if (timeIndex > 0 && isIndexLine(lines[0])) {
        declaredIndex = parseInt(lines[0].trim(), 10);
      } else if (timeIndex > 1) {
        errors.push({
          block: b + 1,
          message: "unexpected content before the timecode line; ignored"
        });
      }

      var times = parseTimecodeLine(lines[timeIndex]);
      if (!times) {
        errors.push({ block: b + 1, message: "could not read the timecode line" });
        continue;
      }

      sequence += 1;
      cues.push({
        id: nextId(),
        index: declaredIndex === null ? sequence : declaredIndex,
        start: times.start,
        end: times.end,
        settings: times.settings || "",
        text: lines.slice(timeIndex + 1).join("\n")
      });
    }

    return { format: "srt", cues: cues, errors: errors, header: "", extras: [] };
  }

  function parseVTT(text) {
    var normalized = normalizeNewlines(text);
    var lines = normalized.split("\n");
    var header = "WEBVTT";
    var start = 0;

    if (lines.length && /^WEBVTT/i.test(lines[0].trim())) {
      header = lines[0].trim();
      start = 1;
      // The optional VTT header block runs until the first blank line.
      while (start < lines.length && lines[start].trim() !== "") start += 1;
    }

    var body = lines.slice(start).join("\n");
    var blocks = body.split(/\n[ \t]*\n/);
    var cues = [];
    var errors = [];
    var extras = [];
    var nextId = nextCueIdFactory();
    var sequence = 0;

    for (var b = 0; b < blocks.length; b++) {
      var block = trimBlock(blocks[b]);
      if (!block) continue;

      var blockLines = block.split("\n");
      var keyword = blockLines[0].trim().split(/\s+/)[0].toUpperCase();
      if (keyword === "NOTE" || keyword === "STYLE" || keyword === "REGION") {
        extras.push({ kind: keyword.toLowerCase(), text: block });
        continue;
      }

      var timeIndex = -1;
      for (var i = 0; i < blockLines.length; i++) {
        if (ARROW_RE.test(blockLines[i].trim())) {
          timeIndex = i;
          break;
        }
      }
      if (timeIndex === -1) {
        errors.push({ block: b + 1, message: "no timecode line found; block skipped" });
        continue;
      }

      var times = parseTimecodeLine(blockLines[timeIndex]);
      if (!times) {
        errors.push({ block: b + 1, message: "could not read the timecode line" });
        continue;
      }

      sequence += 1;
      cues.push({
        id: nextId(),
        index: sequence,
        cueId: timeIndex > 0 ? blockLines.slice(0, timeIndex).join("\n") : "",
        start: times.start,
        end: times.end,
        settings: times.settings || "",
        text: blockLines.slice(timeIndex + 1).join("\n")
      });
    }

    return { format: "vtt", cues: cues, errors: errors, header: header, extras: extras };
  }

  function parseSubtitle(text, format) {
    if (typeof text !== "string" || text.trim() === "") {
      return { format: "unknown", cues: [], errors: [{ block: 0, message: "no input" }], header: "", extras: [] };
    }
    if (text.length > MAX_FILE_CHARS) {
      return {
        format: "unknown",
        cues: [],
        errors: [{ block: 0, message: "file is larger than the 12 MB limit" }],
        header: "",
        extras: []
      };
    }

    var chosen = format && format !== "auto" ? format : detectFormat(text);
    var result;
    if (chosen === "vtt") result = parseVTT(text);
    else if (chosen === "srt") result = parseSRT(text);
    else result = parseSRT(text); // best effort for an unrecognized file

    if (result.cues.length > MAX_CUES) {
      return {
        format: chosen,
        cues: result.cues.slice(0, MAX_CUES),
        errors: result.errors.concat([{ block: 0, message: "only the first " + MAX_CUES + " cues were loaded" }]),
        header: result.header,
        extras: result.extras,
        truncated: true
      };
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------

  // Removes the inline markup that subtitle formats allow: HTML-ish tags
  // (<i>, <b>, <font ...>), WebVTT timestamp tags and class spans, and ASS
  // override blocks ({\an8}). The remaining entities are decoded last so a
  // decoded "<" cannot be mistaken for a tag.
  function stripTags(text) {
    return String(text == null ? "" : text)
      .replace(/<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/g, "")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"");
  }

  function cuePlainText(cue) {
    return stripTags(cue.text);
  }

  function countChars(text) {
    return String(text).replace(/\n/g, "").length;
  }

  function countWords(text) {
    var trimmed = String(text).trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }

  function readingSpeed(cue) {
    var seconds = (cue.end - cue.start) / 1000;
    if (!(seconds > 0)) return null;
    var chars = countChars(cuePlainText(cue));
    return { chars: chars, seconds: seconds, cps: chars / seconds };
  }

  // ---------------------------------------------------------------------
  // Cue list transforms
  // ---------------------------------------------------------------------

  function cloneCues(cues) {
    return cues.map(function (c) {
      return {
        id: c.id,
        index: c.index,
        cueId: c.cueId,
        start: c.start,
        end: c.end,
        settings: c.settings,
        text: c.text
      };
    });
  }

  function reindex(cues) {
    return cues.map(function (c, i) {
      var copy = Object.assign({}, c);
      copy.index = i + 1;
      return copy;
    });
  }

  function sortCues(cues) {
    return cloneCues(cues).sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      return a.end - b.end;
    });
  }

  function shiftCues(cues, offsetMs) {
    var delta = Number(offsetMs) || 0;
    return cloneCues(cues).map(function (c) {
      c.start = Math.round(c.start + delta);
      c.end = Math.round(c.end + delta);
      return c;
    });
  }

  // Scales every cue around an anchor. factor 2 doubles the length, 0.5 halves
  // it. The anchor defaults to the first cue's start so the result stays where
  // the file already begins.
  function scaleCues(cues, factor, anchorMs) {
    var f = Number(factor);
    if (!isFinite(f) || f <= 0) f = 1;
    var anchor = isFinite(Number(anchorMs)) ? Number(anchorMs) : (cues.length ? cues[0].start : 0);
    return cloneCues(cues).map(function (c) {
      c.start = Math.round(anchor + (c.start - anchor) * f);
      c.end = Math.round(anchor + (c.end - anchor) * f);
      return c;
    });
  }

  // Repairs timing in one pass: clamps negatives, sorts by start, removes
  // overlaps (unless allowed), enforces a minimum duration and a minimum gap.
  function applyTimingRules(cues, options) {
    var opts = options || {};
    var minGap = isFinite(Number(opts.minGapMs)) ? Number(opts.minGapMs) : 0;
    var minDuration = isFinite(Number(opts.minDurationMs)) ? Number(opts.minDurationMs) : 0;
    var allowOverlap = !!opts.allowOverlap;

    var out = sortCues(cues);
    var changed = 0;
    var previousEnd = null;

    for (var i = 0; i < out.length; i++) {
      var cue = out[i];
      var start = Math.max(0, cue.start);
      var end = Math.max(start, cue.end);

      if (previousEnd !== null && !allowOverlap) {
        var earliest = previousEnd + minGap;
        if (start < earliest) start = earliest;
      }
      if (end < start + minDuration) end = start + minDuration;

      if (start !== cue.start || end !== cue.end) changed += 1;
      cue.start = start;
      cue.end = end;
      previousEnd = end;
    }

    return { cues: out, changed: changed };
  }

  function fixOverlaps(cues, minGapMs) {
    return applyTimingRules(cues, {
      minGapMs: minGapMs || 0,
      minDurationMs: 0,
      allowOverlap: false
    });
  }

  function setCueTime(cues, id, start, end) {
    return cloneCues(cues).map(function (c) {
      if (c.id !== id) return c;
      c.start = Math.round(Number(start));
      c.end = Math.round(Number(end));
      return c;
    });
  }

  function updateCueText(cues, id, text) {
    return cloneCues(cues).map(function (c) {
      if (c.id !== id) return c;
      c.text = String(text == null ? "" : text);
      return c;
    });
  }

  function deleteCue(cues, id) {
    return cloneCues(cues).filter(function (c) {
      return c.id !== id;
    });
  }

  function nudgeCue(cues, id, startDeltaMs, endDeltaMs) {
    return cloneCues(cues).map(function (c) {
      if (c.id !== id) return c;
      c.start = Math.round(c.start + (Number(startDeltaMs) || 0));
      c.end = Math.round(c.end + (Number(endDeltaMs) || 0));
      return c;
    });
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Literal or regular-expression replacement across cue text.
  function replaceInCues(cues, find, replace, options) {
    var opts = options || {};
    var pattern = String(find == null ? "" : find);
    if (pattern === "") return { cues: cloneCues(cues), count: 0 };

    var flags = opts.caseSensitive ? "g" : "gi";
    var source = opts.regex ? pattern : escapeRegExp(pattern);
    if (opts.wholeWord) source = "\\b(?:" + source + ")\\b";

    var re;
    try {
      re = new RegExp(source, flags);
    } catch (err) {
      return { cues: cloneCues(cues), count: 0, error: err.message };
    }

    var replacement = String(replace == null ? "" : replace);
    var count = 0;
    var out = cloneCues(cues).map(function (c) {
      var text = String(c.text);
      // Count with a throwaway copy, then apply the native string replacement so
      // $1..$9, $&, $` and $' expand exactly as they do in String.replace.
      var scan = new RegExp(re.source, re.flags);
      var match;
      while ((match = scan.exec(text)) !== null) {
        count += 1;
        if (match.index === scan.lastIndex) scan.lastIndex += 1;
      }
      c.text = text.replace(re, replacement);
      return c;
    });
    return { cues: out, count: count };
  }

  function greedyWrap(words, limit) {
    var lines = [];
    var current = "";
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      var candidate = current ? current + " " + word : word;
      if (candidate.length <= limit || current === "") {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  // Word wrap with a line cap. A word longer than the limit is placed on its
  // own line. When the text cannot fit in maxLines lines at maxChars, the words
  // are balanced across exactly maxLines lines so the overflow is shared
  // instead of piled onto the last line.
  function wrapText(text, maxChars, maxLines) {
    var limit = Math.max(1, Math.round(Number(maxChars) || 42));
    var lineLimit = Math.max(1, Math.round(Number(maxLines) || 2));
    var words = stripTags(text).split(/\s+/).filter(Boolean);
    if (!words.length) return "";

    var lines = greedyWrap(words, limit);
    if (lines.length <= lineLimit) return lines.join("\n");

    var target = Math.ceil(words.join(" ").length / lineLimit);
    var balanced = greedyWrap(words, Math.max(limit, target));
    if (balanced.length > lineLimit) {
      var head = balanced.slice(0, lineLimit - 1);
      head.push(balanced.slice(lineLimit - 1).join(" "));
      balanced = head;
    }
    return balanced.join("\n");
  }

  function rewrapCues(cues, maxChars, maxLines) {
    var changed = 0;
    var out = cloneCues(cues).map(function (c) {
      var wrapped = wrapText(c.text, maxChars, maxLines);
      if (wrapped !== c.text) changed += 1;
      c.text = wrapped;
      return c;
    });
    return { cues: out, changed: changed };
  }

  function stripTagsInCues(cues) {
    var changed = 0;
    var out = cloneCues(cues).map(function (c) {
      var stripped = stripTags(c.text);
      if (stripped !== c.text) changed += 1;
      c.text = stripped;
      return c;
    });
    return { cues: out, changed: changed };
  }

  function splitCue(cues, id, atMs) {
    var out = [];
    var split = false;
    var nextId = nextCueIdFactory();
    var used = {};
    for (var i = 0; i < cues.length; i++) used[cues[i].id] = true;

    for (var j = 0; j < cues.length; j++) {
      var cue = cues[j];
      if (cue.id !== id || split || !(atMs > cue.start && atMs < cue.end)) {
        out.push(Object.assign({}, cue));
        continue;
      }
      split = true;

      var textLines = String(cue.text).split("\n");
      var firstText;
      var secondText;
      if (textLines.length > 1) {
        firstText = textLines.slice(0, Math.ceil(textLines.length / 2)).join("\n");
        secondText = textLines.slice(Math.ceil(textLines.length / 2)).join("\n");
      } else {
        var words = String(cue.text).trim().split(/\s+/);
        var half = Math.ceil(words.length / 2);
        firstText = words.slice(0, half).join(" ");
        secondText = words.slice(half).join(" ");
      }

      var newId;
      do { newId = nextId(); } while (used[newId]);
      used[newId] = true;

      out.push({
        id: cue.id,
        index: cue.index,
        cueId: cue.cueId,
        start: cue.start,
        end: Math.round(atMs),
        settings: cue.settings,
        text: firstText
      });
      out.push({
        id: newId,
        index: cue.index + 1,
        cueId: "",
        start: Math.round(atMs),
        end: cue.end,
        settings: cue.settings,
        text: secondText
      });
    }

    return { cues: out, split: split };
  }

  function mergeCues(cues, idA, idB) {
    var indexA = -1;
    var indexB = -1;
    for (var i = 0; i < cues.length; i++) {
      if (cues[i].id === idA) indexA = i;
      if (cues[i].id === idB) indexB = i;
    }
    if (indexA === -1 || indexB === -1) return { cues: cloneCues(cues), merged: false };

    var first = Math.min(indexA, indexB);
    var second = Math.max(indexA, indexB);
    var a = cues[first];
    var b = cues[second];

    var merged = {
      id: a.id,
      index: a.index,
      cueId: a.cueId || "",
      start: Math.min(a.start, b.start),
      end: Math.max(a.end, b.end),
      settings: a.settings,
      text: [a.text, b.text].filter(function (t) { return String(t).trim() !== ""; }).join("\n")
    };

    var out = [];
    for (var j = 0; j < cues.length; j++) {
      if (j === first) {
        out.push(merged);
      } else if (j !== second) {
        out.push(Object.assign({}, cues[j]));
      }
    }
    return { cues: out, merged: true };
  }

  // ---------------------------------------------------------------------
  // QA
  // ---------------------------------------------------------------------

  function qaOptions(options) {
    var merged = Object.assign({}, DEFAULT_QA, options || {});
    return {
      minDurationMs: Number(merged.minDurationMs),
      maxDurationMs: Number(merged.maxDurationMs),
      maxCps: Number(merged.maxCps),
      maxLineChars: Number(merged.maxLineChars),
      maxLines: Number(merged.maxLines),
      minGapMs: Number(merged.minGapMs) || 0
    };
  }

  function validate(cues, options) {
    var opts = qaOptions(options);
    var issues = [];

    function add(index, id, severity, type, message) {
      issues.push({ cueIndex: index, cueId: id, severity: severity, type: type, message: message });
    }

    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var position = i + 1;
      var duration = cue.end - cue.start;

      if (cue.start < 0) {
        add(position, cue.id, "error", "negative", "Cue " + position + " starts before 00:00:00.");
      }
      if (duration <= 0) {
        add(position, cue.id, "error", "duration", "Cue " + position + " ends at or before its start time.");
      } else {
        if (duration < opts.minDurationMs) {
          add(position, cue.id, "warning", "short",
            "Cue " + position + " lasts " + formatDuration(duration) + ", under the " + formatDuration(opts.minDurationMs) + " minimum.");
        }
        if (duration > opts.maxDurationMs) {
          add(position, cue.id, "warning", "long",
            "Cue " + position + " lasts " + formatDuration(duration) + ", over the " + formatDuration(opts.maxDurationMs) + " maximum.");
        }
      }

      var plain = cuePlainText(cue);
      if (!plain.trim()) {
        add(position, cue.id, "warning", "empty", "Cue " + position + " has no text.");
      }

      var speed = readingSpeed(cue);
      if (speed && speed.cps > opts.maxCps) {
        add(position, cue.id, "warning", "cps",
          "Cue " + position + " reads at " + speed.cps.toFixed(1) + " characters/second (limit " + opts.maxCps + ").");
      }

      var textLines = String(cue.text).split("\n");
      if (textLines.length > opts.maxLines) {
        add(position, cue.id, "warning", "lines",
          "Cue " + position + " has " + textLines.length + " lines (limit " + opts.maxLines + ").");
      }
      for (var k = 0; k < textLines.length; k++) {
        var visible = stripTags(textLines[k]);
        if (visible.length > opts.maxLineChars) {
          add(position, cue.id, "warning", "line-length",
            "Cue " + position + " line " + (k + 1) + " is " + visible.length + " characters (limit " + opts.maxLineChars + ").");
        }
      }
    }

    for (var j = 0; j < cues.length - 1; j++) {
      var current = cues[j];
      var next = cues[j + 1];
      if (current.end > next.start) {
        add(j + 1, current.id, "error", "overlap",
          "Cue " + (j + 1) + " overlaps cue " + (j + 2) + " by " + formatDuration(current.end - next.start) + ".");
      } else if (opts.minGapMs > 0 && next.start - current.end < opts.minGapMs) {
        add(j + 1, current.id, "warning", "gap",
          "Only " + formatDuration(next.start - current.end) + " between cues " + (j + 1) + " and " + (j + 2) + ".");
      }
      if (next.start < current.start) {
        add(j + 2, next.id, "warning", "order",
          "Cue " + (j + 2) + " starts before cue " + (j + 1) + ".");
      }
    }

    var errors = issues.filter(function (x) { return x.severity === "error"; }).length;
    return {
      issues: issues,
      errors: errors,
      warnings: issues.length - errors,
      clean: issues.length === 0
    };
  }

  // ---------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------

  function stats(cues) {
    if (!cues.length) {
      return { count: 0, words: 0, chars: 0, durationMs: 0, spanMs: 0, avgDurationMs: 0, avgCps: 0, minStart: 0, maxEnd: 0 };
    }
    var words = 0;
    var chars = 0;
    var durationSum = 0;
    var cpsSum = 0;
    var cpsCount = 0;
    var minStart = Infinity;
    var maxEnd = -Infinity;

    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var plain = cuePlainText(cue);
      words += countWords(plain);
      chars += countChars(plain);
      durationSum += cue.end - cue.start;
      var speed = readingSpeed(cue);
      if (speed) { cpsSum += speed.cps; cpsCount += 1; }
      if (cue.start < minStart) minStart = cue.start;
      if (cue.end > maxEnd) maxEnd = cue.end;
    }

    return {
      count: cues.length,
      words: words,
      chars: chars,
      durationMs: durationSum,
      spanMs: maxEnd - minStart,
      avgDurationMs: durationSum / cues.length,
      avgCps: cpsCount ? cpsSum / cpsCount : 0,
      minStart: minStart,
      maxEnd: maxEnd
    };
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------

  function cleanCueText(text) {
    return String(text == null ? "" : text).replace(/\s+$/, "");
  }

  function toSRT(cues) {
    var parts = [];
    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var start = Math.max(0, Math.round(cue.start));
      var end = Math.max(start, Math.round(cue.end));
      parts.push(
        String(i + 1) + "\n" +
        formatTimestamp(start, "srt") + " --> " + formatTimestamp(end, "srt") + "\n" +
        cleanCueText(cue.text)
      );
    }
    return parts.join("\n\n") + (parts.length ? "\n" : "");
  }

  function toVTT(cues, options) {
    var opts = options || {};
    var header = String(opts.header || "WEBVTT").trim() || "WEBVTT";
    // The header, then one entry per cue, joined by a blank line. This yields
    // exactly one blank line after the header and between each pair of cues,
    // which is what a WebVTT parser expects.
    var parts = [header];
    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var start = Math.max(0, Math.round(cue.start));
      var end = Math.max(start, Math.round(cue.end));
      var line = formatTimestamp(start, "vtt") + " --> " + formatTimestamp(end, "vtt");
      if (cue.settings) line += " " + cue.settings;
      var block = "";
      if (opts.includeIds && cue.cueId) block += cue.cueId + "\n";
      block += line + "\n" + cleanCueText(cue.text);
      parts.push(block);
    }
    return parts.join("\n\n") + "\n";
  }

  function toTXT(cues, options) {
    var opts = options || {};
    var lines = [];
    for (var i = 0; i < cues.length; i++) {
      if (opts.withTimecodes) {
        lines.push("[" + formatTimestamp(cues[i].start, "compact") + " --> " + formatTimestamp(cues[i].end, "compact") + "]");
      }
      lines.push(cuePlainText(cues[i]));
      lines.push("");
    }
    return lines.join("\n").replace(/\n+$/, "\n");
  }

  function csvCell(value) {
    var s = String(value == null ? "" : value);
    if (/[",\n]/.test(s)) return "\"" + s.replace(/"/g, "\"\"") + "\"";
    return s;
  }

  function toCSV(cues) {
    var rows = ["index,start,end,duration_ms,chars,cps,text"];
    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var plain = cuePlainText(cue).replace(/\n/g, " ");
      var speed = readingSpeed(cue);
      rows.push([
        i + 1,
        formatTimestamp(Math.max(0, cue.start), "srt"),
        formatTimestamp(Math.max(0, cue.end), "srt"),
        Math.max(0, cue.end - cue.start),
        countChars(plain),
        speed ? speed.cps.toFixed(1) : "",
        csvCell(plain)
      ].join(","));
    }
    return rows.join("\n") + "\n";
  }

  return {
    // timecodes
    parseTimestamp: parseTimestamp,
    formatTimestamp: formatTimestamp,
    formatDuration: formatDuration,
    // parsing
    detectFormat: detectFormat,
    parseTimecodeLine: parseTimecodeLine,
    parseSRT: parseSRT,
    parseVTT: parseVTT,
    parseSubtitle: parseSubtitle,
    // text
    stripTags: stripTags,
    cuePlainText: cuePlainText,
    countChars: countChars,
    countWords: countWords,
    readingSpeed: readingSpeed,
    wrapText: wrapText,
    // transforms
    cloneCues: cloneCues,
    reindex: reindex,
    sortCues: sortCues,
    shiftCues: shiftCues,
    scaleCues: scaleCues,
    applyTimingRules: applyTimingRules,
    fixOverlaps: fixOverlaps,
    setCueTime: setCueTime,
    updateCueText: updateCueText,
    deleteCue: deleteCue,
    nudgeCue: nudgeCue,
    replaceInCues: replaceInCues,
    rewrapCues: rewrapCues,
    stripTagsInCues: stripTagsInCues,
    splitCue: splitCue,
    mergeCues: mergeCues,
    // QA
    validate: validate,
    stats: stats,
    // export
    toSRT: toSRT,
    toVTT: toVTT,
    toTXT: toTXT,
    toCSV: toCSV,
    // constants
    DEFAULT_QA: DEFAULT_QA,
    MAX_CUES: MAX_CUES,
    MAX_FILE_CHARS: MAX_FILE_CHARS
  };
});
