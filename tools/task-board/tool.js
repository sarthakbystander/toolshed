/* Toolshed — Task Board (todo app with persistence)
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.taskBoard and in Node via require() for tests.
 *
 * This module is pure: it creates, validates, filters, sorts and serialises
 * task objects and never touches the DOM, the network or storage. The page
 * (app.js) owns localStorage and the UI; that split is what makes the whole
 * data model testable under plain Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.taskBoard = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCHEMA_VERSION = 2;
  var MAX_TITLE = 200;
  var MAX_NOTES = 4000;
  var MAX_TAGS = 20;
  var MAX_TAG_LEN = 32;
  var MAX_TASKS = 5000;

  var PRIORITIES = ["low", "normal", "high"];
  var STATUS_FILTERS = ["all", "active", "done", "overdue", "today", "upcoming"];
  var SORT_MODES = ["manual", "due", "priority", "created", "title"];

  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /** Two-digit zero-padded string. */
  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /** Local calendar date key ('YYYY-MM-DD') for an epoch-millisecond time. */
  function todayKey(now) {
    var d = new Date(typeof now === "number" && isFinite(now) ? now : Date.now());
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  /** True only for a syntactically valid 'YYYY-MM-DD' string on a real date. */
  function isValidDateKey(value) {
    if (typeof value !== "string") return false;
    var m = DATE_RE.exec(value);
    if (!m) return false;
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    // Reject impossible days (2026-02-30) by round-tripping through Date.
    var dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }

  /** Days from one date key to another (b - a), or null if either is invalid. */
  function daysBetween(a, b) {
    if (!isValidDateKey(a) || !isValidDateKey(b)) return null;
    var am = DATE_RE.exec(a);
    var bm = DATE_RE.exec(b);
    var at = Date.UTC(Number(am[1]), Number(am[2]) - 1, Number(am[3]));
    var bt = Date.UTC(Number(bm[1]), Number(bm[2]) - 1, Number(bm[3]));
    return Math.round((bt - at) / 86400000);
  }

  function clampString(value, max) {
    var s = typeof value === "string" ? value : value == null ? "" : String(value);
    if (s.length > max) s = s.slice(0, max);
    return s;
  }

  /** Normalise a tag: lowercase, trimmed, spaces collapsed to dashes. */
  function normalizeTag(value) {
    if (typeof value !== "string") return "";
    return value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}_-]/gu, "")
      .slice(0, MAX_TAG_LEN);
  }

  /**
   * Turn a comma/space separated tag string into a clean, unique, ordered list.
   * @param {string} value
   * @returns {string[]}
   */
  function parseTags(value) {
    if (typeof value !== "string" || value.trim() === "") return [];
    var parts = value.split(/[,\n]+/);
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < parts.length && out.length < MAX_TAGS; i++) {
      var tag = normalizeTag(parts[i]);
      if (!tag || seen[tag]) continue;
      seen[tag] = true;
      out.push(tag);
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Ids
  // ---------------------------------------------------------------------

  var idCounter = 0;

  /**
   * Stable-ish unique id. Uses crypto.randomUUID when available (browser and
   * modern Node), otherwise a monotonic counter plus random suffix. Ids are
   * opaque strings; the only contract is that two live tasks differ.
   */
  function makeId() {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch (e) {
      /* fall through to the deterministic path */
    }
    idCounter += 1;
    return "t" + Date.now().toString(36) + "-" + idCounter.toString(36) + "-" +
      Math.floor(Math.random() * 0x1000000).toString(36);
  }

  // ---------------------------------------------------------------------
  // Task construction and validation
  // ---------------------------------------------------------------------

  /**
   * Validate raw task input (from the form or an imported file).
   * @param {object} input
   * @returns {{ok: true, value: object}|{ok: false, errors: string[]}}
   */
  function validateTaskInput(input) {
    var errors = [];
    var src = isPlainObject(input) ? input : {};
    var title = clampString(src.title, MAX_TITLE).trim();
    if (!title) errors.push("A task needs a title.");

    var priority = src.priority;
    if (priority !== undefined && priority !== null && priority !== "") {
      if (PRIORITIES.indexOf(priority) === -1) {
        errors.push('Priority must be one of: ' + PRIORITIES.join(", ") + ".");
      }
    }

    var due = src.due;
    if (due !== undefined && due !== null && due !== "") {
      if (!isValidDateKey(due)) errors.push("Due date must be a real date in YYYY-MM-DD form.");
    }

    if (errors.length) return { ok: false, errors: errors };
    return {
      ok: true,
      value: {
        title: title,
        notes: clampString(src.notes, MAX_NOTES),
        priority: PRIORITIES.indexOf(priority) === -1 ? "normal" : priority,
        due: due ? due : null,
        tags: Array.isArray(src.tags) ? src.tags : parseTags(src.tags)
      }
    };
  }

  /**
   * Build a complete task from validated or raw input.
   * @param {object} input
   * @param {{id?: string, now?: number, order?: number}} [opts]
   * @returns {object} task
   */
  function createTask(input, opts) {
    var o = opts || {};
    var src = isPlainObject(input) ? input : {};
    var check = validateTaskInput(src);
    if (!check.ok) {
      var err = new Error(check.errors.join(" "));
      err.validation = check.errors;
      throw err;
    }
    var v = check.value;
    var now = typeof o.now === "number" && isFinite(o.now) ? o.now : Date.now();
    return {
      id: typeof o.id === "string" && o.id ? o.id : makeId(),
      title: v.title,
      notes: v.notes,
      done: src.done === true,
      priority: v.priority,
      due: v.due,
      tags: v.tags.slice(0, MAX_TAGS),
      createdAt: now,
      updatedAt: now,
      completedAt: src.done === true ? now : null,
      order: typeof o.order === "number" && isFinite(o.order) ? o.order : now
    };
  }

  /**
   * Coerce one raw record (from storage) into a valid task, or null if it
   * cannot be salvaged. Never throws — imported files are untrusted.
   */
  function coerceTask(raw, index, now) {
    if (!isPlainObject(raw)) return null;
    var title = clampString(raw.title != null ? raw.title : raw.text, MAX_TITLE).trim();
    if (!title) return null;
    var created = Number(raw.createdAt);
    if (!isFinite(created) || created <= 0) created = now;
    var updated = Number(raw.updatedAt);
    if (!isFinite(updated) || updated <= 0) updated = created;
    var done = raw.done === true;
    var completedAt = Number(raw.completedAt);
    if (!done || !isFinite(completedAt) || completedAt <= 0) completedAt = done ? updated : null;

    var priority = PRIORITIES.indexOf(raw.priority) === -1 ? "normal" : raw.priority;
    var due = isValidDateKey(raw.due) ? raw.due : null;
    var tags = Array.isArray(raw.tags) ? parseTags(raw.tags.join(",")) : parseTags(raw.tags);
    var order = Number(raw.order);

    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : "t" + index + "-" + created.toString(36),
      title: title,
      notes: clampString(raw.notes, MAX_NOTES),
      done: done,
      priority: priority,
      due: due,
      tags: tags,
      createdAt: created,
      updatedAt: updated,
      completedAt: completedAt,
      order: isFinite(order) ? order : created
    };
  }

  // ---------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------

  /**
   * Bucket a task's due date relative to a moment in time.
   * @returns {"none"|"overdue"|"today"|"soon"|"later"}
   */
  function dueStatus(task, now) {
    if (!isPlainObject(task) || !isValidDateKey(task.due)) return "none";
    var diff = daysBetween(todayKey(now), task.due);
    if (diff === null) return "none";
    if (diff < 0) return "overdue";
    if (diff === 0) return "today";
    if (diff <= 3) return "soon";
    return "later";
  }

  /** Human label for a due date, e.g. "Overdue by 2 days", "Today", "in 5 days". */
  function dueLabel(task, now) {
    if (!isPlainObject(task) || !isValidDateKey(task.due)) return "";
    var diff = daysBetween(todayKey(now), task.due);
    if (diff === null) return "";
    if (diff < 0) {
      var n = -diff;
      return "Overdue by " + n + (n === 1 ? " day" : " days");
    }
    if (diff === 0) return "Due today";
    if (diff === 1) return "Due tomorrow";
    return "Due in " + diff + " days";
  }

  /**
   * Summary counts for a task list.
   * @returns {{total, active, done, overdue, dueToday, completionRate, byPriority}}
   */
  function taskStats(tasks, now) {
    var list = Array.isArray(tasks) ? tasks : [];
    var stats = {
      total: list.length,
      active: 0,
      done: 0,
      overdue: 0,
      dueToday: 0,
      completionRate: 0,
      byPriority: { low: 0, normal: 0, high: 0 }
    };
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!isPlainObject(t)) continue;
      if (t.done) stats.done += 1;
      else {
        stats.active += 1;
        var s = dueStatus(t, now);
        if (s === "overdue") stats.overdue += 1;
        else if (s === "today") stats.dueToday += 1;
      }
      if (stats.byPriority[t.priority] !== undefined) stats.byPriority[t.priority] += 1;
    }
    stats.completionRate = stats.total ? stats.done / stats.total : 0;
    return stats;
  }

  // ---------------------------------------------------------------------
  // Filtering and sorting
  // ---------------------------------------------------------------------

  /**
   * Filter tasks by free text, status, priority and tag.
   * @param {object[]} tasks
   * @param {{text?: string, status?: string, priority?: string, tag?: string}} query
   * @param {number} [now]
   */
  function filterTasks(tasks, query, now) {
    var list = Array.isArray(tasks) ? tasks : [];
    var q = query || {};
    var text = typeof q.text === "string" ? q.text.trim().toLowerCase() : "";
    var status = STATUS_FILTERS.indexOf(q.status) === -1 ? "all" : q.status;
    var priority = PRIORITIES.indexOf(q.priority) === -1 ? null : q.priority;
    var tag = typeof q.tag === "string" && q.tag ? q.tag.toLowerCase() : null;

    return list.filter(function (t) {
      if (!isPlainObject(t)) return false;
      if (status === "active" && t.done) return false;
      if (status === "done" && !t.done) return false;
      if (priority && t.priority !== priority) return false;
      if (tag && !(Array.isArray(t.tags) && t.tags.indexOf(tag) !== -1)) return false;
      if (status === "overdue" || status === "today" || status === "upcoming") {
        if (t.done) return false;
        var s = dueStatus(t, now);
        if (status === "overdue" && s !== "overdue") return false;
        if (status === "today" && s !== "today") return false;
        if (status === "upcoming" && s !== "soon" && s !== "later") return false;
      }
      if (text) {
        var hay = (t.title + " " + (t.notes || "") + " " + (t.tags || []).join(" ")).toLowerCase();
        if (hay.indexOf(text) === -1) return false;
      }
      return true;
    });
  }

  var PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

  /**
   * Return a new, sorted array. Never mutates the input.
   * @param {object[]} tasks
   * @param {string} mode one of SORT_MODES
   * @param {number} [now]
   */
  function sortTasks(tasks, mode, now) {
    var list = Array.isArray(tasks) ? tasks.slice() : [];
    var m = SORT_MODES.indexOf(mode) === -1 ? "manual" : mode;
    if (m === "manual") {
      list.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    } else if (m === "due") {
      list.sort(function (a, b) {
        var ad = isValidDateKey(a.due) ? a.due : null;
        var bd = isValidDateKey(b.due) ? b.due : null;
        if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : (a.order || 0) - (b.order || 0);
        if (ad) return -1;
        if (bd) return 1;
        return (a.order || 0) - (b.order || 0);
      });
    } else if (m === "priority") {
      list.sort(function (a, b) {
        var d = (PRIORITY_RANK[a.priority] || 1) - (PRIORITY_RANK[b.priority] || 1);
        return d !== 0 ? d : (a.order || 0) - (b.order || 0);
      });
    } else if (m === "created") {
      list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    } else if (m === "title") {
      list.sort(function (a, b) {
        return String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" });
      });
    }
    return list;
  }

  // ---------------------------------------------------------------------
  // Immutable list operations
  // ---------------------------------------------------------------------

  function findIndex(tasks, id) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i] && tasks[i].id === id) return i;
    }
    return -1;
  }

  /** Toggle done state, keeping completedAt consistent. Returns a new array. */
  function toggleDone(tasks, id, now) {
    var at = typeof now === "number" && isFinite(now) ? now : Date.now();
    return tasks.map(function (t) {
      if (t.id !== id) return t;
      var done = !t.done;
      return Object.assign({}, t, {
        done: done,
        completedAt: done ? at : null,
        updatedAt: at
      });
    });
  }

  /** Apply validated edits to a task. Returns a new array. */
  function updateTask(tasks, id, patch, now) {
    var at = typeof now === "number" && isFinite(now) ? now : Date.now();
    var merged = null;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === id) {
        merged = Object.assign({}, tasks[i], patch);
        break;
      }
    }
    if (!merged) return tasks.slice();
    var check = validateTaskInput(merged);
    if (!check.ok) {
      var err = new Error(check.errors.join(" "));
      err.validation = check.errors;
      throw err;
    }
    return tasks.map(function (t) {
      if (t.id !== id) return t;
      var next = Object.assign({}, t, {
        title: check.value.title,
        notes: check.value.notes,
        priority: check.value.priority,
        due: check.value.due,
        tags: check.value.tags,
        done: merged.done === true,
        updatedAt: at
      });
      if (next.done && !t.done) next.completedAt = at;
      if (!next.done) next.completedAt = null;
      return next;
    });
  }

  function removeTask(tasks, id) {
    return tasks.filter(function (t) { return t.id !== id; });
  }

  function addTask(tasks, task) {
    return (Array.isArray(tasks) ? tasks : []).concat([task]);
  }

  /** Move the task with `id` so it sits at `toIndex` in the ordered list. */
  function moveTask(tasks, id, toIndex) {
    var list = Array.isArray(tasks) ? tasks.slice() : [];
    var from = findIndex(list, id);
    if (from === -1) return list;
    var to = Math.max(0, Math.min(list.length - 1, Math.floor(toIndex)));
    if (from === to) return list;
    var moved = list.splice(from, 1)[0];
    list.splice(to, 0, moved);
    // Rewrite order values so "manual" sort reflects the new arrangement.
    return list.map(function (t, i) {
      return t.order === i ? t : Object.assign({}, t, { order: i });
    });
  }

  /** Reassign sequential order values to match the array position. */
  function reindex(tasks) {
    return (Array.isArray(tasks) ? tasks : []).map(function (t, i) {
      return t.order === i ? t : Object.assign({}, t, { order: i });
    });
  }

  /**
   * Mark every task done (or not). Returns a new array.
   * A task already in the target state is left alone except for completedAt,
   * which is repaired so "done" and "completedAt" never drift apart.
   */
  function setAllDone(tasks, done, now) {
    var at = typeof now === "number" && isFinite(now) ? now : Date.now();
    return (Array.isArray(tasks) ? tasks : []).map(function (t) {
      var completedAt = done ? (t.completedAt || at) : null;
      if (t.done === done && t.completedAt === completedAt) return t;
      return Object.assign({}, t, {
        done: done,
        completedAt: completedAt,
        updatedAt: t.done === done ? t.updatedAt : at
      });
    });
  }

  /** Remove all completed tasks. */
  function clearCompleted(tasks) {
    return (Array.isArray(tasks) ? tasks : []).filter(function (t) { return !t.done; });
  }

  // ---------------------------------------------------------------------
  // Serialisation (the persistence format)
  // ---------------------------------------------------------------------

  /**
   * Serialise tasks to the versioned on-disk document.
   * @returns {string}
   */
  function serialize(tasks, now) {
    var list = Array.isArray(tasks) ? tasks : [];
    var doc = {
      app: "toolshed/task-board",
      version: SCHEMA_VERSION,
      savedAt: typeof now === "number" && isFinite(now) ? now : Date.now(),
      tasks: list.slice(0, MAX_TASKS)
    };
    return JSON.stringify(doc);
  }

  /**
   * Parse a stored/imported document back into tasks, defensively.
   * Handles the legacy v1 shape ({tasks:[{text, done}]}) and any plain array.
   * @returns {{ok:true, tasks:object[], warnings:string[], version:number}
   *          |{ok:false, error:string}}
   */
  function deserialize(text, now) {
    if (typeof text !== "string" || text.trim() === "") {
      return { ok: false, error: "There is nothing saved yet." };
    }
    var raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: "Saved data is not valid JSON and could not be read." };
    }

    var at = typeof now === "number" && isFinite(now) ? now : Date.now();
    var warnings = [];
    var version = SCHEMA_VERSION;
    var source = null;

    if (Array.isArray(raw)) {
      source = raw;
      warnings.push("Loaded a bare task array; it has been upgraded to the current format.");
    } else if (isPlainObject(raw)) {
      if (Array.isArray(raw.tasks)) source = raw.tasks;
      else return { ok: false, error: "Saved data has no task list." };
      var v = Number(raw.version);
      version = isFinite(v) && v > 0 ? v : 1;
      if (version > SCHEMA_VERSION) {
        warnings.push(
          "Saved data was written by a newer version (" + version + "). " +
          "Unknown fields were ignored."
        );
      } else if (version < SCHEMA_VERSION) {
        warnings.push("Upgraded saved data from format v" + version + " to v" + SCHEMA_VERSION + ".");
      }
    } else {
      return { ok: false, error: "Saved data is not in a recognised shape." };
    }

    if (source.length > MAX_TASKS) {
      warnings.push("Only the first " + MAX_TASKS + " tasks were kept.");
      source = source.slice(0, MAX_TASKS);
    }

    var tasks = [];
    var skipped = 0;
    for (var i = 0; i < source.length; i++) {
      var task = coerceTask(source[i], i, at);
      if (task) tasks.push(task);
      else skipped += 1;
    }
    if (skipped) warnings.push(skipped + (skipped === 1 ? " entry was" : " entries were") + " skipped as unreadable.");

    return { ok: true, tasks: reindex(tasks), warnings: warnings, version: version };
  }

  /** The complete set of tags in use, sorted, for filter chips and suggestions. */
  function allTags(tasks) {
    var seen = Object.create(null);
    var out = [];
    var list = Array.isArray(tasks) ? tasks : [];
    for (var i = 0; i < list.length; i++) {
      var tags = list[i] && list[i].tags;
      if (!Array.isArray(tags)) continue;
      for (var j = 0; j < tags.length; j++) {
        if (!seen[tags[j]]) {
          seen[tags[j]] = true;
          out.push(tags[j]);
        }
      }
    }
    return out.sort();
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_TITLE: MAX_TITLE,
    MAX_NOTES: MAX_NOTES,
    MAX_TAGS: MAX_TAGS,
    MAX_TASKS: MAX_TASKS,
    PRIORITIES: PRIORITIES,
    STATUS_FILTERS: STATUS_FILTERS,
    SORT_MODES: SORT_MODES,

    todayKey: todayKey,
    isValidDateKey: isValidDateKey,
    daysBetween: daysBetween,
    normalizeTag: normalizeTag,
    parseTags: parseTags,
    makeId: makeId,

    validateTaskInput: validateTaskInput,
    createTask: createTask,
    coerceTask: coerceTask,

    dueStatus: dueStatus,
    dueLabel: dueLabel,
    taskStats: taskStats,

    filterTasks: filterTasks,
    sortTasks: sortTasks,

    findIndex: findIndex,
    addTask: addTask,
    toggleDone: toggleDone,
    updateTask: updateTask,
    removeTask: removeTask,
    moveTask: moveTask,
    reindex: reindex,
    setAllDone: setAllDone,
    clearCompleted: clearCompleted,

    serialize: serialize,
    deserialize: deserialize,
    allTags: allTags
  };
});
