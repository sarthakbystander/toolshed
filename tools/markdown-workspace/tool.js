/* Toolshed — Markdown Workspace
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.markdownWorkspace and in Node via require() for tests.
 *
 * Everything is computed from the user's input in memory. The module never
 * touches the network, never uses eval/dynamic code execution, and never
 * writes to storage.
 *
 * The renderer is intentionally a conservative, self-contained Markdown
 * subset (CommonMark-flavoured for the constructs it supports). It builds a
 * data structure of nodes and serialises it to HTML with every piece of
 * user text escaped, so the produced string is safe to assign to innerHTML
 * without an extra sanitisation pass. Raw HTML in the source is rendered as
 * literal text, never executed.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.markdownWorkspace = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MAX_SOURCE = 2 * 1024 * 1024; // 2 MB — keep the tab responsive.

  // ---------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/`/g, "&#96;");
  }

  function repeat(ch, n) {
    return new Array(n + 1).join(ch);
  }

  function trimBlankLines(lines) {
    var out = lines.slice();
    while (out.length && out[0].trim() === "") out.shift();
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    return out;
  }

  // ---------------------------------------------------------------------
  // Inline rendering
  // ---------------------------------------------------------------------

  // Autolink a bare URL. Deliberately conservative: only http/https/mailto
  // schemes, so javascript:, data: and vbscript: are never turned into links.
  function autolink(text) {
    return text.replace(/\b(https?:\/\/[^\s<]+|mailto:[^\s<]+)/g, function (url) {
      var trailing = "";
      var clean = url;
      while (clean.length && /[.,;:!?)\]}]$/.test(clean)) {
        trailing = clean.charAt(clean.length - 1) + trailing;
        clean = clean.slice(0, -1);
      }
      if (!clean) return url;
      return (
        '<a href="' + escapeAttr(clean) + '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(clean) +
        "</a>" + escapeHtml(trailing)
      );
    });
  }

  function sanitizeUrl(href) {
    var value = String(href == null ? "" : href).trim();
    // Strip control characters that browsers ignore but that can be used to
    // smuggle a scheme past a naive check (e.g. "java\tscript:").
    value = value.replace(/[\u0000-\u001f\u007f]/g, "");
    if (/^(https?:|mailto:|tel:|#)/i.test(value)) return value;
    if (/^\//.test(value) || /^\.\.?\//.test(value)) return value;
    return "#";
  }

  function renderLink(dest, label, title) {
    var href = sanitizeUrl(dest);
    var html = '<a href="' + escapeAttr(href) + '"';
    if (/^https?:/i.test(href)) html += ' target="_blank" rel="noopener noreferrer"';
    if (title != null && title !== "") html += ' title="' + escapeAttr(title) + '"';
    html += ">" + renderInline(label) + "</a>";
    return html;
  }

  function renderImage(dest, alt, title) {
    var src = sanitizeUrl(dest);
    // Images only ever load http(s), protocol-relative or local/relative
    // sources; anything else (javascript:, data:, ...) is neutralised to "#".
    if (/^\/\//.test(src)) src = "https:" + src;
    var html = '<img src="' + escapeAttr(src) + '" alt="' + escapeAttr(alt || "") + '" loading="lazy"';
    if (title != null && title !== "") html += ' title="' + escapeAttr(title) + '"';
    html += ">";
    return html;
  }

  function isWhitespace(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  // Parse a link/image destination, including the optional <...> form.
  function parseDestination(src, start) {
    var i = start;
    if (src.charAt(i) === "<") {
      i++;
      var buf = "";
      while (i < src.length && src.charAt(i) !== ">") {
        buf += src.charAt(i);
        i++;
      }
      if (src.charAt(i) !== ">") return null;
      return { dest: buf, end: i + 1 };
    }
    var depth = 0;
    var out = "";
    while (i < src.length) {
      var ch = src.charAt(i);
      if (isWhitespace(ch) && depth === 0) break;
      if (ch === "(") depth++;
      if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
      out += ch;
      i++;
    }
    return { dest: out, end: i };
  }

  function renderInline(text) {
    var src = String(text == null ? "" : text);
    var out = "";
    var i = 0;

    while (i < src.length) {
      var ch = src.charAt(i);

      // Backslash escape.
      if (ch === "\\" && i + 1 < src.length && /[\\`*_{}\[\]()#+\-.!<>~|]/.test(src.charAt(i + 1))) {
        out += escapeHtml(src.charAt(i + 1));
        i += 2;
        continue;
      }

      // Code span.
      if (ch === "`") {
        var run = 1;
        while (src.charAt(i + run) === "`") run++;
        var fence = repeat("`", run);
        var closeAt = src.indexOf(fence, i + run);
        if (closeAt !== -1) {
          var code = src.slice(i + run, closeAt).replace(/\n/g, " ");
          if (code.length >= 2 && code.charAt(0) === " " && code.charAt(code.length - 1) === " " && code.trim() !== "") {
            code = code.slice(1, -1);
          }
          out += "<code>" + escapeHtml(code) + "</code>";
          i = closeAt + run;
          continue;
        }
        out += escapeHtml(fence);
        i += run;
        continue;
      }

      // Image.
      if (ch === "!" && src.charAt(i + 1) === "[") {
        var img = matchLabel(src, i + 1);
        if (img && src.charAt(img.end) === "(") {
          var imgDest = parseDestination(src, img.end + 1);
          if (imgDest && src.charAt(imgDest.end) === ")") {
            out += renderImage(imgDest.dest, img.text, null);
            i = imgDest.end + 1;
            continue;
          }
          var imgTitle = imgDest ? parseOptionalTitle(src, imgDest.end + 1) : null;
          if (imgDest && imgTitle && src.charAt(imgTitle.end) === ")") {
            out += renderImage(imgDest.dest, img.text, imgTitle.title);
            i = imgTitle.end + 1;
            continue;
          }
        }
      }

      // Link.
      if (ch === "[") {
        var link = matchLabel(src, i);
        if (link) {
          if (src.charAt(link.end) === "(") {
            var dest = parseDestination(src, link.end + 1);
            if (dest && src.charAt(dest.end) === ")") {
              out += renderLink(dest.dest, link.text, null);
              i = dest.end + 1;
              continue;
            }
            var titled = parseOptionalTitle(src, dest ? dest.end + 1 : link.end + 1);
            if (dest && titled && src.charAt(titled.end) === ")") {
              out += renderLink(dest.dest, link.text, titled.title);
              i = titled.end + 1;
              continue;
            }
          }
          // Reference-style link: [text][id]
          if (src.charAt(link.end) === "[") {
            var ref = matchLabel(src, link.end);
            if (ref) {
              out += renderLink("#", link.text, null);
              i = ref.end + 1;
              continue;
            }
          }
        }
      }

      // Strong and emphasis. CommonMark-ish: ** wins over *, __ over _.
      if (ch === "*" || ch === "_") {
        var doubled = ch + ch;
        if (src.substr(i, 2) === doubled) {
          var strongEnd = findClosing(src, doubled, i + 2);
          if (strongEnd !== -1) {
            out += "<strong>" + renderInline(src.slice(i + 2, strongEnd)) + "</strong>";
            i = strongEnd + 2;
            continue;
          }
        }
        var emEnd = findClosing(src, ch, i + 1);
        if (emEnd !== -1 && emEnd > i + 1) {
          out += "<em>" + renderInline(src.slice(i + 1, emEnd)) + "</em>";
          i = emEnd + 1;
          continue;
        }
      }

      // Strikethrough.
      if (src.substr(i, 2) === "~~") {
        var strikeEnd = findClosing(src, "~~", i + 2);
        if (strikeEnd !== -1) {
          out += "<del>" + renderInline(src.slice(i + 2, strikeEnd)) + "</del>";
          i = strikeEnd + 2;
          continue;
        }
      }

      // Hard line break.
      if (ch === "\n") {
        out += "<br>";
        i++;
        continue;
      }

      // Autolink bare URLs. Consume the URL in one go so it is not also
      // processed character-by-character.
      if ((ch === "h" || ch === "m") && /^(https?:\/\/|mailto:)/.test(src.slice(i))) {
        var match = /^(https?:\/\/[^\s<]+|mailto:[^\s<]+)/.exec(src.slice(i));
        if (match) {
          var raw = match[1];
          var tail = "";
          while (raw.length && /[.,;:!?)\]}]$/.test(raw)) {
            tail = raw.charAt(raw.length - 1) + tail;
            raw = raw.slice(0, -1);
          }
          out +=
            '<a href="' + escapeAttr(raw) + '" target="_blank" rel="noopener noreferrer">' +
            escapeHtml(raw) + "</a>" + escapeHtml(tail);
          i += match[0].length;
          continue;
        }
      }

      // Plain text.
      if (ch === "&") {
        out += "&amp;";
        i++;
        continue;
      }
      if (ch === "<") {
        out += "&lt;";
        i++;
        continue;
      }
      if (ch === ">") {
        out += "&gt;";
        i++;
        continue;
      }
      out += ch;
      i++;
    }

    return out;
  }

  // Matching brackets are precomputed lazily with a single stack pass for the
  // current string. A naive rescan from every "[" makes input like "[[[[…"
  // quadratic, so the pairs are resolved once and looked up in O(1).
  var bracketSource = null;
  var bracketPairs = null;

  function ensureBracketMap(src) {
    if (bracketSource === src) return;
    bracketSource = src;
    bracketPairs = new Map();
    var stack = [];
    for (var k = 0; k < src.length; k++) {
      var c = src.charAt(k);
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === "[") stack.push(k);
      else if (c === "]") {
        if (stack.length) bracketPairs.set(stack.pop(), k);
      }
    }
  }

  function releaseBracketMap() {
    bracketSource = null;
    bracketPairs = null;
  }

  // Match "[text]" starting at the "[" position; returns {text,end} or null.
  function matchLabel(src, start) {
    if (src.charAt(start) !== "[") return null;
    ensureBracketMap(src);
    var close = bracketPairs.get(start);
    if (close === undefined) return null;
    return { text: src.slice(start + 1, close), end: close + 1 };
  }

  // Parse ` "title"` / ` 'title'` / ` (title)` after a destination.
  function parseOptionalTitle(src, start) {
    var i = start;
    while (i < src.length && isWhitespace(src.charAt(i))) i++;
    if (i >= src.length) return null;
    var open = src.charAt(i);
    var close = open === "(" ? ")" : open;
    if (open !== '"' && open !== "'" && open !== "(") return null;
    var end = src.indexOf(close, i + 1);
    if (end === -1) return null;
    return { title: src.slice(i + 1, end), end: end + 1 };
  }

  function findClosing(src, marker, from) {
    var idx = src.indexOf(marker, from);
    while (idx !== -1) {
      // A closing run must not be preceded by an escaped character.
      var escapes = 0;
      var j = idx - 1;
      while (j >= 0 && src.charAt(j) === "\\") {
        escapes++;
        j--;
      }
      if (escapes % 2 === 0) return idx;
      idx = src.indexOf(marker, idx + 1);
    }
    return -1;
  }

  // ---------------------------------------------------------------------
  // Block parsing
  // ---------------------------------------------------------------------

  var LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
  var HEADING_RE = /^(#{1,6})(\s+)(.*?)(\s*#*\s*)$/;
  var FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^`]*)$/;
  var HR_RE = /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
  var QUOTE_RE = /^ {0,3}>\s?(.*)$/;
  var TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function isBlockStart(line) {
    if (line.trim() === "") return true;
    if (FENCE_RE.test(line)) return true;
    if (HEADING_RE.test(line)) return true;
    if (HR_RE.test(line)) return true;
    if (QUOTE_RE.test(line)) return true;
    if (LIST_RE.test(line)) return true;
    if (/^ {0,3}\[[^\]]+\]:\s+\S/.test(line)) return true; // link reference def
    return false;
  }

  function parseBlocks(lines) {
    var blocks = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (line.trim() === "") {
        i++;
        continue;
      }

      // Fenced code.
      var fence = FENCE_RE.exec(line);
      if (fence) {
        var marker = fence[2];
        var info = fence[3].trim();
        var buf = [];
        i++;
        while (i < lines.length) {
          var closeMatch = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
          if (closeMatch && closeMatch[1].charAt(0) === marker.charAt(0) && closeMatch[1].length >= marker.length) {
            i++;
            break;
          }
          buf.push(lines[i]);
          i++;
        }
        blocks.push({ type: "code", language: info.split(/\s+/)[0] || "", text: buf.join("\n") });
        continue;
      }

      // ATX heading.
      var heading = HEADING_RE.exec(line);
      if (heading) {
        var level = heading[1].length;
        blocks.push({ type: "heading", level: level, text: heading[3].trim() });
        i++;
        continue;
      }

      // Thematic break.
      if (HR_RE.test(line)) {
        blocks.push({ type: "hr" });
        i++;
        continue;
      }

      // Blockquote (contiguous lines, with lazy continuation).
      if (QUOTE_RE.test(line)) {
        var quote = [];
        while (i < lines.length && lines[i].trim() !== "") {
          var qm = QUOTE_RE.exec(lines[i]);
          if (qm) quote.push(qm[1]);
          else if (quote.length) quote.push(lines[i]);
          else break;
          i++;
        }
        blocks.push({ type: "quote", children: parseBlocks(quote) });
        continue;
      }

      // Table (header row followed by a separator row).
      if (line.indexOf("|") !== -1 && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].indexOf("-") !== -1) {
        var table = parseTable(lines, i);
        blocks.push(table.block);
        i = table.next;
        continue;
      }

      // List.
      if (LIST_RE.test(line)) {
        var list = parseList(lines, i);
        blocks.push(list.block);
        i = list.next;
        continue;
      }

      // Paragraph.
      var para = [];
      while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
        para.push(lines[i].trim());
        i++;
      }
      if (para.length) {
        blocks.push({ type: "paragraph", text: para.join("\n") });
      } else {
        // Defensive: never loop forever.
        para.push(lines[i].trim());
        i++;
        blocks.push({ type: "paragraph", text: para.join("\n") });
      }
    }

    return blocks;
  }

  function splitRow(row) {
    var trimmed = row.trim();
    if (trimmed.charAt(0) === "|") trimmed = trimmed.slice(1);
    if (trimmed.charAt(trimmed.length - 1) === "|") trimmed = trimmed.slice(0, -1);
    return trimmed.split("|").map(function (cell) {
      return cell.trim();
    });
  }

  function parseTable(lines, start) {
    var header = splitRow(lines[start]);
    var separators = splitRow(lines[start + 1]);
    var columns = Math.max(header.length, separators.length);
    var aligns = [];
    for (var c = 0; c < columns; c++) {
      var sep = separators[c] || "";
      var left = sep.charAt(0) === ":";
      var right = sep.charAt(sep.length - 1) === ":";
      aligns.push(left && right ? "center" : right ? "right" : left ? "left" : null);
    }

    var rows = [];
    var i = start + 2;
    while (i < lines.length && lines[i].trim() !== "" && lines[i].indexOf("|") !== -1) {
      rows.push(splitRow(lines[i]));
      i++;
    }
    return {
      block: { type: "table", header: header, aligns: aligns, rows: rows },
      next: i,
    };
  }

  function parseList(lines, start) {
    var first = LIST_RE.exec(lines[start]);
    var ordered = /\d/.test(first[2]);
    var baseIndent = first[1].length;
    var items = [];
    var i = start;
    var loose = false;

    while (i < lines.length) {
      var m = LIST_RE.exec(lines[i]);
      if (m && m[1].length === baseIndent && /\d/.test(m[2]) === ordered) {
        // Start a new item.
        var itemLines = [m[4]];
        i++;
        while (i < lines.length) {
          var next = lines[i];
          if (next.trim() === "") {
            var look = i + 1;
            while (look < lines.length && lines[look].trim() === "") look++;
            if (look >= lines.length) break;
            var lookLine = lines[look];
            var lookItem = LIST_RE.exec(lookLine);
            // A blank line before a sibling item makes the whole list loose.
            if (lookItem && lookItem[1].length === baseIndent && /\d/.test(lookItem[2]) === ordered) {
              loose = true;
              i = look;
              break;
            }
            // Otherwise the item continues only if the content is indented.
            if (lookLine.search(/\S/) > baseIndent) {
              loose = true;
              itemLines.push("");
              i++;
              continue;
            }
            break;
          }
          var nm = LIST_RE.exec(next);
          if (nm && nm[1].length === baseIndent) break;
          if (next.search(/\S/) <= baseIndent) break;
          itemLines.push(next.replace(/^\s{1,4}/, ""));
          i++;
        }
        items.push(parseBlocks(trimBlankLines(itemLines)));
        continue;
      }
      break;
    }

    return {
      block: { type: "list", ordered: ordered, start: ordered ? parseInt(first[2], 10) : 1, items: items, loose: loose },
      next: i,
    };
  }

  // ---------------------------------------------------------------------
  // HTML serialisation
  // ---------------------------------------------------------------------

  function renderBlocks(blocks) {
    var html = "";
    for (var i = 0; i < blocks.length; i++) {
      html += renderBlock(blocks[i]);
    }
    return html;
  }

  function renderBlock(block) {
    switch (block.type) {
      case "heading":
        return (
          "<h" + block.level + ' id="' + headingId(block.text) + '">' +
          renderInline(block.text) +
          "</h" + block.level + ">"
        );
      case "paragraph":
        return "<p>" + renderInline(block.text) + "</p>";
      case "code":
        var cls = block.language ? ' class="language-' + escapeAttr(block.language) + '"' : "";
        return "<pre><code" + cls + ">" + escapeHtml(block.text) + "</code></pre>";
      case "hr":
        return "<hr>";
      case "quote":
        return "<blockquote>" + renderBlocks(block.children) + "</blockquote>";
      case "list":
        var tag = block.ordered ? "ol" : "ul";
        var attrs = block.ordered && block.start !== 1 ? ' start="' + block.start + '"' : "";
        var inner = "";
        for (var j = 0; j < block.items.length; j++) {
          inner += "<li>" + renderListItem(block.items[j], block.loose) + "</li>";
        }
        return "<" + tag + attrs + ">" + inner + "</" + tag + ">";
      case "table":
        return renderTable(block);
      default:
        return "";
    }
  }

  // Tight list items render paragraphs without <p> tags; loose list items
  // keep them, matching CommonMark's tight/loose distinction.
  function renderListItem(children, loose) {
    if (!loose) {
      var out = "";
      for (var k = 0; k < children.length; k++) {
        var child = children[k];
        out += child.type === "paragraph" ? renderInline(child.text) : renderBlock(child);
      }
      return out;
    }
    return renderBlocks(children);
  }

  function renderTable(block) {
    var html = "<table><thead><tr>";
    for (var c = 0; c < block.header.length; c++) {
      html += cellTag("th", block.header[c], block.aligns[c]);
    }
    html += "</tr></thead><tbody>";
    for (var r = 0; r < block.rows.length; r++) {
      html += "<tr>";
      for (var k = 0; k < block.header.length; k++) {
        html += cellTag("td", block.rows[r][k] == null ? "" : block.rows[r][k], block.aligns[k]);
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    return html;
  }

  function cellTag(tag, content, align) {
    var attr = align ? ' style="text-align:' + align + '"' : "";
    return "<" + tag + attr + ">" + renderInline(content) + "</" + tag + ">";
  }

  // ---------------------------------------------------------------------
  // Heading slugs (for the outline and anchor links)
  // ---------------------------------------------------------------------

  function slugify(text) {
    return String(text)
      .toLowerCase()
      .replace(/[`*_~\[\]()!]/g, "")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  // Slug counters are reset per render so repeated headings get stable,
  // distinct ids ("same", "same-1", ...) that match the outline.
  var slugCounts = null;

  function headingId(text) {
    var base = slugify(text) || "section";
    if (!slugCounts) return base;
    if (slugCounts[base] == null) {
      slugCounts[base] = 0;
      return base;
    }
    slugCounts[base]++;
    return base + "-" + slugCounts[base];
  }

  function assignHeadingIds(headings) {
    var counts = {};
    for (var i = 0; i < headings.length; i++) {
      var base = slugify(headings[i].text) || "section";
      if (counts[base] == null) {
        counts[base] = 0;
      } else {
        counts[base]++;
      }
      headings[i].id = counts[base] === 0 ? base : base + "-" + counts[base];
    }
  }

  // ---------------------------------------------------------------------
  // Outline
  // ---------------------------------------------------------------------

  function outline(source) {
    var lines = String(source == null ? "" : source).replace(/\r\n?/g, "\n").split("\n");
    var headings = [];
    var inFence = false;
    var fenceChar = "";

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (!inFence) {
          inFence = true;
          fenceChar = fence[1].charAt(0);
        } else if (fence[1].charAt(0) === fenceChar) {
          inFence = false;
        }
        continue;
      }
      if (inFence) continue;

      var m = HEADING_RE.exec(line);
      if (m) {
        headings.push({
          level: m[1].length,
          text: m[3].replace(/\s+#+\s*$/, "").trim(),
          line: i + 1,
        });
        continue;
      }
      // Setext headings.
      if (i + 1 < lines.length && line.trim() !== "" && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1])) {
        headings.push({
          level: lines[i + 1].trim().charAt(0) === "=" ? 1 : 2,
          text: line.trim(),
          line: i + 1,
        });
        i++;
      }
    }

    assignHeadingIds(headings);
    return headings;
  }

  // ---------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------

  // Resolve "[" ↔ "]" and "(" ↔ ")" pairs with one stack pass each. Several
  // regexes over user Markdown (word counting, link counting) otherwise
  // backtrack catastrophically on long runs of unmatched delimiters.
  function buildPairMaps(text) {
    var n = text.length;
    var bracketClose = new Map();
    var parenClose = new Map();
    var bracketStack = [];
    var parenStack = [];
    for (var i = 0; i < n; i++) {
      var ch = text.charAt(i);
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "[") bracketStack.push(i);
      else if (ch === "]") {
        if (bracketStack.length) bracketClose.set(bracketStack.pop(), i);
      } else if (ch === "(") parenStack.push(i);
      else if (ch === ")") {
        if (parenStack.length) parenClose.set(parenStack.pop(), i);
      }
    }
    return { bracketClose: bracketClose, parenClose: parenClose };
  }

  // Blank out fenced code blocks, line by line.
  function stripFencedCode(text) {
    var lines = text.split("\n");
    var out = [];
    var inFence = false;
    var fenceChar = "";
    for (var i = 0; i < lines.length; i++) {
      var m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
      if (m) {
        if (!inFence) {
          inFence = true;
          fenceChar = m[1].charAt(0);
        } else if (m[1].charAt(0) === fenceChar) {
          inFence = false;
        }
        out.push(" ");
        continue;
      }
      out.push(inFence ? " " : lines[i]);
    }
    return out.join("\n");
  }

  // Replace inline code spans with a space and links/images with their label
  // text, in one linear pass.
  function stripCodeAndLinks(text) {
    var n = text.length;
    var maps = buildPairMaps(text);
    var out = "";
    var i = 0;
    while (i < n) {
      var ch = text.charAt(i);
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        var run = 1;
        while (text.charAt(i + run) === "`") run++;
        var fence = repeat("`", run);
        var closeAt = text.indexOf(fence, i + run);
        if (closeAt !== -1) {
          out += " ";
          i = closeAt + run;
          continue;
        }
        i += run;
        continue;
      }
      var isImage = ch === "!" && text.charAt(i + 1) === "[";
      var labelStart = isImage ? i + 1 : i;
      if (ch === "[" || isImage) {
        var close = maps.bracketClose.get(labelStart);
        if (close !== undefined && text.charAt(close + 1) === "(") {
          var parenEnd = maps.parenClose.get(close + 1);
          if (parenEnd !== undefined) {
            out += text.slice(labelStart + 1, close);
            i = parenEnd + 1;
            continue;
          }
        }
      }
      out += ch;
      i++;
    }
    return out;
  }

  function countWords(text) {
    var stripped = stripCodeAndLinks(stripFencedCode(String(text)));
    stripped = stripped.replace(/[#>*_~\-|]/g, " ");
    var words = stripped.split(/\s+/).filter(function (w) {
      return /[\p{L}\p{N}]/u.test(w);
    });
    return words.length;
  }

  // Count inline links and images with a single linear pass over the pair maps.
  function countLinksAndImages(text) {
    var n = text.length;
    var maps = buildPairMaps(text);
    var links = 0;
    var images = 0;
    for (var i = 0; i < n; i++) {
      var c = text.charAt(i);
      if (c === "\\") {
        i++;
        continue;
      }
      if (c !== "[") continue;
      var close = maps.bracketClose.get(i);
      if (close === undefined || text.charAt(close + 1) !== "(") continue;
      if (maps.parenClose.get(close + 1) === undefined) continue;
      if (i > 0 && text.charAt(i - 1) === "!") images++;
      else links++;
    }
    return { links: links, images: images };
  }

  function analyze(source) {
    var text = String(source == null ? "" : source);
    var normalized = text.replace(/\r\n?/g, "\n");
    var lines = normalized.split("\n");

    var headings = outline(text);
    var words = countWords(text);
    var characters = text.length;
    var charactersNoSpaces = text.replace(/\s/g, "").length;
    var readingMinutes = words / 220;

    // Fenced code blocks: language tally and lines.
    var codeLines = 0;
    var languages = {};
    var inFence = false;
    var fenceChar = "";
    for (var i = 0; i < lines.length; i++) {
      var fence = FENCE_RE.exec(lines[i]);
      if (fence && /^ {0,3}(`{3,}|~{3,})/.test(lines[i])) {
        if (!inFence) {
          inFence = true;
          fenceChar = fence[2].charAt(0);
          var lang = fence[3].trim().split(/\s+/)[0];
          if (lang) languages[lang] = (languages[lang] || 0) + 1;
        } else if (fence[2].charAt(0) === fenceChar) {
          inFence = false;
        }
        continue;
      }
      if (inFence) codeLines++;
    }

    var linkCounts = countLinksAndImages(normalized);
    var links = linkCounts.links;
    var images = linkCounts.images;

    var wordLineCount = lines.filter(function (l) {
      return l.trim() !== "";
    }).length;

    return {
      words: words,
      characters: characters,
      charactersNoSpaces: charactersNoSpaces,
      lines: lines.length,
      nonEmptyLines: wordLineCount,
      readingMinutes: readingMinutes,
      readingTime: formatDuration(readingMinutes),
      headings: headings.length,
      headingLevels: levelTally(headings),
      codeBlocks: Object.keys(languages).reduce(function (sum, key) {
        return sum + languages[key];
      }, 0),
      codeLines: codeLines,
      languages: languages,
      links: links,
      images: images,
      longestLine: lines.reduce(function (max, l) {
        return Math.max(max, l.length);
      }, 0),
      tables: (function () {
        var count = 0;
        for (var t = 0; t < lines.length - 1; t++) {
          if (lines[t].indexOf("|") !== -1 && TABLE_SEP_RE.test(lines[t + 1]) && lines[t + 1].indexOf("-") !== -1) count++;
        }
        return count;
      })(),
      taskItems: (normalized.match(/^[ \t]*[-*+][ \t]+\[[ xX]\]/gm) || []).length,
      checkedTasks: (normalized.match(/^[ \t]*[-*+][ \t]+\[[xX]\]/gm) || []).length,
    };
  }

  function levelTally(headings) {
    var tally = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (var i = 0; i < headings.length; i++) {
      tally[headings[i].level] = (tally[headings[i].level] || 0) + 1;
    }
    return tally;
  }

  function formatDuration(minutes) {
    if (minutes < 1) return "< 1 min";
    var rounded = Math.round(minutes);
    if (rounded < 60) return rounded + " min";
    var hours = Math.floor(rounded / 60);
    var mins = rounded % 60;
    return hours + "h" + (mins ? " " + mins + "m" : "");
  }

  // ---------------------------------------------------------------------
  // Document health checks
  // ---------------------------------------------------------------------

  function checkDocument(source) {
    var text = String(source == null ? "" : source);
    var normalized = text.replace(/\r\n?/g, "\n");
    var lines = normalized.split("\n");
    var headings = outline(text);
    var issues = [];

    if (text.trim() === "") {
      return { issues: issues, levelCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 } };
    }

    // Heading-level jumps (e.g. h1 -> h3).
    var previousLevel = 0;
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      if (previousLevel && h.level > previousLevel + 1) {
        issues.push({
          severity: "warning",
          code: "heading-jump",
          message: "Heading jumps from H" + previousLevel + " to H" + h.level + ".",
          line: h.line,
        });
      }
      previousLevel = h.level;
    }

    // Multiple H1s.
    var h1s = headings.filter(function (h) {
      return h.level === 1;
    });
    if (h1s.length > 1) {
      issues.push({
        severity: "warning",
        code: "multiple-h1",
        message: h1s.length + " top-level (H1) headings — consider a single title.",
        line: h1s[1].line,
      });
    }

    // Unclosed fenced code block.
    var fenceOpen = false;
    var fenceChar = "";
    for (var f = 0; f < lines.length; f++) {
      var fm = /^ {0,3}(`{3,}|~{3,})/.exec(lines[f]);
      if (!fm) continue;
      if (!fenceOpen) {
        fenceOpen = true;
        fenceChar = fm[1].charAt(0);
      } else if (fm[1].charAt(0) === fenceChar) {
        fenceOpen = false;
      }
    }
    if (fenceOpen) {
      issues.push({
        severity: "warning",
        code: "unclosed-fence",
        message: "A fenced code block is never closed.",
        line: lines.length,
      });
    }

    // Duplicate heading text (the outline disambiguates ids, but a repeated
    // heading is usually an editorial mistake).
    var slugSeen = {};
    for (var s = 0; s < headings.length; s++) {
      var slug = slugify(headings[s].text);
      if (slugSeen[slug]) {
        issues.push({
          severity: "info",
          code: "duplicate-heading",
          message: 'Heading "' + headings[s].text + '" repeats — anchor links will be numbered.',
          line: headings[s].line,
        });
      }
      slugSeen[slug] = true;
    }

    // Image without alt text.
    var imagesNoAlt = normalized.match(/!\[\s*\]\([^)]+\)/g) || [];
    if (imagesNoAlt.length) {
      issues.push({
        severity: "info",
        code: "image-no-alt",
        message: imagesNoAlt.length + " image" + (imagesNoAlt.length === 1 ? "" : "s") + " without alt text.",
        line: 0,
      });
    }

    // Link reference definitions that are never used.
    var defined = {};
    var defRe = /^ {0,3}\[([^\]]+)\]:[ \t]+\S+/gm;
    var def;
    while ((def = defRe.exec(normalized)) !== null) {
      defined[def[1].toLowerCase()] = true;
    }
    var used = {};
    var useMaps = buildPairMaps(normalized);
    for (var pos = 0; pos < normalized.length; pos++) {
      if (normalized.charAt(pos) !== "]") continue;
      if (normalized.charAt(pos + 1) !== "[") continue;
      var labelEnd = useMaps.bracketClose.get(pos + 1);
      if (labelEnd === undefined) continue;
      used[normalized.slice(pos + 2, labelEnd).toLowerCase()] = true;
    }
    var unused = Object.keys(defined).filter(function (key) {
      return !used[key];
    });
    if (unused.length) {
      issues.push({
        severity: "info",
        code: "unused-reference",
        message: unused.length + " unused link reference definition" + (unused.length === 1 ? "" : "s") + ".",
        line: 0,
      });
    }

    // Trailing whitespace on a line (other than a deliberate hard break).
    var trailing = 0;
    for (var t = 0; t < lines.length; t++) {
      if (/[ \t]+$/.test(lines[t]) && !/ {2,}$/.test(lines[t])) trailing++;
    }
    if (trailing) {
      issues.push({
        severity: "info",
        code: "trailing-whitespace",
        message: trailing + " line" + (trailing === 1 ? "" : "s") + " with trailing whitespace.",
        line: 0,
      });
    }

    return { issues: issues, levelCounts: levelTally(headings) };
  }

  // ---------------------------------------------------------------------
  // Normalisation / cleanup
  // ---------------------------------------------------------------------

  function normalize(source, options) {
    var opts = options || {};
    var text = String(source == null ? "" : source).replace(/\r\n?/g, "\n");

    if (opts.trimTrailing) {
      text = text
        .split("\n")
        .map(function (line) {
          return line.replace(/[ \t]+$/, "");
        })
        .join("\n");
    }

    if (opts.collapseBlankLines) {
      text = text.replace(/\n{3,}/g, "\n\n");
    }

    if (opts.headings) {
      text = text.replace(/^(#{1,6})([^#\n]*?)(\s*#+\s*)?$/gm, function (line, hashes, rest) {
        return hashes + " " + rest.trim();
      });
    }

    if (opts.listMarkers) {
      text = text.replace(/^(\s*)([-*+])(\s+)/gm, function (line, indent, marker, space) {
        return indent + "-" + space;
      });
    }

    if (opts.blankLinesAroundHeadings) {
      text = text.replace(/([^\n])\n(#{1,6} )/g, "$1\n\n$2");
      text = text.replace(/(#{1,6} [^\n]+)\n([^\n#])/g, "$1\n\n$2");
      text = text.replace(/\n{3,}/g, "\n\n");
    }

    if (opts.ensureFinalNewline) {
      text = text.replace(/\n+$/, "") + "\n";
    }

    return text;
  }

  // ---------------------------------------------------------------------
  // Document assembly
  // ---------------------------------------------------------------------

  function renderDocument(source) {
    var text = String(source == null ? "" : source);
    var normalized = text.replace(/\r\n?/g, "\n");
    var lines = normalized.split("\n");

    slugCounts = {};
    var blocks = parseBlocks(lines);
    var html = renderBlocks(blocks);

    slugCounts = null;
    releaseBracketMap();
    return html;
  }

  function process(source) {
    var text = String(source == null ? "" : source);
    if (text.length > MAX_SOURCE) {
      return {
        ok: false,
        error: "Document is too large to preview (" + formatBytes(text.length) + "). The limit is " + formatBytes(MAX_SOURCE) + ".",
      };
    }
    return {
      ok: true,
      html: renderDocument(text),
      analysis: analyze(text),
      outline: outline(text),
      health: checkDocument(text),
    };
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function sampleDocument() {
    return [
      "# Markdown Workspace",
      "",
      "A single place to **write**, *preview*, and sanity-check Markdown. Everything runs locally — nothing is uploaded.",
      "",
      "## Features",
      "",
      "- Live preview as you type",
      "- Outline navigation with heading anchors",
      "- Word count, reading time and link stats",
      "- A document health check for common mistakes",
      "",
      "## Quick reference",
      "",
      "| Syntax | Result |",
      "| --- | --- |",
      "| `**bold**` | **bold** |",
      "| `*italic*` | *italic* |",
      "| `` `code` `` | `code` |",
      "| `[link](https://example.com)` | [link](https://example.com) |",
      "",
      "> Blockquotes work too, and can contain [links](https://example.com) or `inline code`.",
      "",
      "### A task list",
      "",
      "- [x] Write the document",
      "- [ ] Review the preview",
      "",
      "### Code",
      "",
      "```js",
      "const answer = 6 * 7;",
      "console.log(answer);",
      "```",
      "",
      "#### Text with a line break  ",
      "…continues here after two trailing spaces.",
      "",
      "---",
      "",
      "That's the whole idea. Happy writing!",
    ].join("\n");
  }

  return {
    // rendering
    renderInline: renderInline,
    renderDocument: renderDocument,
    process: process,
    parseBlocks: parseBlocks,
    // outline
    outline: outline,
    slugify: slugify,
    // analysis
    analyze: analyze,
    checkDocument: checkDocument,
    countWords: countWords,
    // cleanup
    normalize: normalize,
    // helpers
    escapeHtml: escapeHtml,
    sanitizeUrl: sanitizeUrl,
    formatBytes: formatBytes,
    sampleDocument: sampleDocument,
    MAX_SOURCE: MAX_SOURCE,
  };
});
