(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.textDiff = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function tokenize(text) {
    var norm = String(text == null ? "" : text).replace(/\r\n/g, "\n");
    if (norm === "") return [];
    return norm.split("\n");
  }

  function lcs(a, b) {
    var la = a.length;
    var lb = b.length;
    if (la * lb > 100000000) {
      return lcsGreedy(a, b);
    }
    var table = [];
    var i, j;
    for (i = 0; i <= la; i++) {
      table.push(new Array(lb + 1).fill(0));
    }
    for (i = la - 1; i >= 0; i--) {
      for (j = lb - 1; j >= 0; j--) {
        if (a[i] === b[j]) {
          table[i][j] = table[i + 1][j + 1] + 1;
        } else {
          table[i][j] = table[i + 1][j] > table[i][j + 1] ? table[i + 1][j] : table[i][j + 1];
        }
      }
    }
    var eqA = [];
    var eqB = [];
    i = 0;
    j = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) {
        eqA.push(i);
        eqB.push(j);
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }
    return { equalIdxA: eqA, equalIdxB: eqB };
  }

  function lcsGreedy(a, b) {
    var idxB = Object.create(null);
    var i;
    for (i = 0; i < b.length; i++) {
      (idxB[b[i]] = idxB[b[i]] || []).push(i);
    }
    var eqA = [];
    var eqB = [];
    var cursor = 0;
    for (i = 0; i < a.length; i++) {
      var slots = idxB[a[i]];
      if (slots) {
        for (var k = 0; k < slots.length; k++) {
          if (slots[k] >= cursor) {
            eqA.push(i);
            eqB.push(slots[k]);
            cursor = slots[k] + 1;
            break;
          }
        }
      }
    }
    return { equalIdxA: eqA, equalIdxB: eqB };
  }

  function diffLines(aText, bText) {
    var a = tokenize(aText);
    var b = tokenize(bText);
    var l = lcs(a, b);
    var eqA = l.equalIdxA;
    var eqB = l.equalIdxB;

    var blocks = [];
    var ia = 0;
    var ib = 0;
    var ei = 0;
    while (ia < a.length || ib < b.length) {
      if (ei < eqA.length && ia === eqA[ei] && ib === eqB[ei]) {
        var startA = ia;
        var startB = ib;
        while (ei < eqA.length && ia === eqA[ei] && ib === eqB[ei]) {
          ia++;
          ib++;
          ei++;
        }
        blocks.push({
          type: "equal",
          aStart: startA, aEnd: ia,
          bStart: startB, bEnd: ib,
          lines: a.slice(startA, ia)
        });
      } else if (ia < a.length && (ei >= eqA.length || ia < eqA[ei])) {
        var dStart = ia;
        while (ia < a.length && (ei >= eqA.length || ia < eqA[ei])) ia++;
        blocks.push({
          type: "delete",
          aStart: dStart, aEnd: ia,
          bStart: ib, bEnd: ib,
          lines: a.slice(dStart, ia)
        });
      } else {
        var iStart = ib;
        while (ib < b.length && (ei >= eqB.length || ib < eqB[ei])) ib++;
        blocks.push({
          type: "insert",
          aStart: ia, aEnd: ia,
          bStart: iStart, bEnd: ib,
          lines: b.slice(iStart, ib)
        });
      }
    }
    return { blocks: blocks, aLines: a, bLines: b };
  }

  function countStats(aText, bText) {
    var out = diffLines(aText, bText);
    var added = 0;
    var removed = 0;
    out.blocks.forEach(function (blk) {
      if (blk.type === "insert") added += blk.lines.length;
      if (blk.type === "delete") removed += blk.lines.length;
    });
    return { added: added, removed: removed };
  }

  return {
    tokenize: tokenize,
    lcs: lcs,
    diffLines: diffLines,
    countStats: countStats
  };
});