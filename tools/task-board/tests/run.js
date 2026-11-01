/* Toolshed Task Board — tests. Run with: node tests/run.js
 * Uses Node's built-in assert and requires ../tool.js via its UMD export.
 */
"use strict";

const assert = require("node:assert");
const tb = require("../tool.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (err) {
    failed++;
    console.error("  FAIL - " + name);
    console.error("         " + (err && err.message));
  }
}

// Fixed reference moment so due-date logic never depends on the wall clock.
// 2026-03-15T12:00:00 local time.
const NOW = new Date(2026, 2, 15, 12, 0, 0).getTime();

console.log("task-board tests");

// --- date helpers ------------------------------------------------------------
test("todayKey formats a local date as YYYY-MM-DD", () => {
  assert.strictEqual(tb.todayKey(NOW), "2026-03-15");
  assert.strictEqual(tb.todayKey(new Date(2026, 0, 3, 8, 0, 0).getTime()), "2026-01-03");
});

test("isValidDateKey accepts real dates and rejects the rest", () => {
  assert.strictEqual(tb.isValidDateKey("2026-03-15"), true);
  assert.strictEqual(tb.isValidDateKey("2024-02-29"), true, "2024 is a leap year");
  assert.strictEqual(tb.isValidDateKey("2026-02-30"), false, "February never has 30 days");
  assert.strictEqual(tb.isValidDateKey("2026-13-01"), false, "month out of range");
  assert.strictEqual(tb.isValidDateKey("2026-3-5"), false, "must be zero padded");
  assert.strictEqual(tb.isValidDateKey("15/03/2026"), false);
  assert.strictEqual(tb.isValidDateKey(""), false);
  assert.strictEqual(tb.isValidDateKey(null), false);
  assert.strictEqual(tb.isValidDateKey(20260315), false);
});

test("daysBetween counts calendar days and is null for bad input", () => {
  assert.strictEqual(tb.daysBetween("2026-03-15", "2026-03-15"), 0);
  assert.strictEqual(tb.daysBetween("2026-03-15", "2026-03-18"), 3);
  assert.strictEqual(tb.daysBetween("2026-03-18", "2026-03-15"), -3);
  // Across a DST boundary in the northern hemisphere.
  assert.strictEqual(tb.daysBetween("2026-03-07", "2026-03-09"), 2);
  assert.strictEqual(tb.daysBetween("nope", "2026-03-18"), null);
});

// --- tags --------------------------------------------------------------------
test("parseTags splits, normalises, dedupes and caps", () => {
  assert.deepStrictEqual(tb.parseTags("Work, home , URGENT"), ["work", "home", "urgent"]);
  assert.deepStrictEqual(tb.parseTags("a,a,a"), ["a"]);
  assert.deepStrictEqual(tb.parseTags("two words"), ["two-words"]);
  assert.deepStrictEqual(tb.parseTags(""), []);
  assert.deepStrictEqual(tb.parseTags(null), []);
  assert.strictEqual(tb.parseTags(new Array(50).fill("x").join(",")).length, 1);
});

test("normalizeTag strips punctuation and caps length", () => {
  assert.strictEqual(tb.normalizeTag("  Hello!! World  "), "hello-world");
  assert.strictEqual(tb.normalizeTag("a".repeat(80)).length, 32);
  assert.strictEqual(tb.normalizeTag(42), "");
});

// --- validation --------------------------------------------------------------
test("validateTaskInput requires a non-empty title", () => {
  assert.strictEqual(tb.validateTaskInput({ title: "" }).ok, false);
  assert.strictEqual(tb.validateTaskInput({ title: "   " }).ok, false);
  assert.strictEqual(tb.validateTaskInput({}).ok, false);
  assert.strictEqual(tb.validateTaskInput(null).ok, false);
});

test("validateTaskInput rejects bad priority and due date with messages", () => {
  const badPriority = tb.validateTaskInput({ title: "x", priority: "urgent" });
  assert.strictEqual(badPriority.ok, false);
  assert.match(badPriority.errors.join(" "), /Priority must be one of/);

  const badDue = tb.validateTaskInput({ title: "x", due: "2026-02-30" });
  assert.strictEqual(badDue.ok, false);
  assert.match(badDue.errors.join(" "), /real date/);
});

test("validateTaskInput defaults priority to normal and trims the title", () => {
  const ok = tb.validateTaskInput({ title: "  Buy milk  " });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.title, "Buy milk");
  assert.strictEqual(ok.value.priority, "normal");
  assert.strictEqual(ok.value.due, null);
  assert.deepStrictEqual(ok.value.tags, []);
});

test("validateTaskInput clamps an over-long title", () => {
  const ok = tb.validateTaskInput({ title: "x".repeat(500) });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.title.length, tb.MAX_TITLE);
});

test("createTask throws a validation error for a missing title", () => {
  assert.throws(() => tb.createTask({ title: "" }), (err) => {
    assert.ok(Array.isArray(err.validation));
    return true;
  });
});

// --- createTask --------------------------------------------------------------
test("createTask fills defaults and honours explicit id/now", () => {
  const t = tb.createTask({ title: "Ship it", priority: "high", due: "2026-03-20" },
    { id: "fixed-1", now: NOW });
  assert.strictEqual(t.id, "fixed-1");
  assert.strictEqual(t.title, "Ship it");
  assert.strictEqual(t.priority, "high");
  assert.strictEqual(t.due, "2026-03-20");
  assert.strictEqual(t.done, false);
  assert.strictEqual(t.completedAt, null);
  assert.strictEqual(t.createdAt, NOW);
  assert.strictEqual(t.updatedAt, NOW);
});

test("createTask generates distinct ids", () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(tb.createTask({ title: "t" + i }).id);
  assert.strictEqual(ids.size, 200);
});

// --- due status --------------------------------------------------------------
test("dueStatus buckets overdue/today/soon/later/none", () => {
  const mk = (due) => ({ due, done: false });
  assert.strictEqual(tb.dueStatus(mk(null), NOW), "none");
  assert.strictEqual(tb.dueStatus(mk("2026-03-14"), NOW), "overdue");
  assert.strictEqual(tb.dueStatus(mk("2026-03-15"), NOW), "today");
  assert.strictEqual(tb.dueStatus(mk("2026-03-16"), NOW), "soon");
  assert.strictEqual(tb.dueStatus(mk("2026-03-18"), NOW), "soon");
  assert.strictEqual(tb.dueStatus(mk("2026-03-19"), NOW), "later");
});

test("dueLabel produces readable relative labels", () => {
  assert.strictEqual(tb.dueLabel({ due: "2026-03-15" }, NOW), "Due today");
  assert.strictEqual(tb.dueLabel({ due: "2026-03-16" }, NOW), "Due tomorrow");
  assert.strictEqual(tb.dueLabel({ due: "2026-03-13" }, NOW), "Overdue by 2 days");
  assert.strictEqual(tb.dueLabel({ due: "2026-03-14" }, NOW), "Overdue by 1 day");
  assert.strictEqual(tb.dueLabel({ due: "2026-03-20" }, NOW), "Due in 5 days");
  assert.strictEqual(tb.dueLabel({ due: null }, NOW), "");
});

// --- stats -------------------------------------------------------------------
test("taskStats counts done/active/overdue and completion rate", () => {
  const tasks = [
    { done: true, priority: "high", due: null },
    { done: false, priority: "low", due: "2026-03-10" },
    { done: false, priority: "normal", due: "2026-03-15" },
    { done: false, priority: "normal", due: "2026-04-01" },
  ];
  const s = tb.taskStats(tasks, NOW);
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.done, 1);
  assert.strictEqual(s.active, 3);
  assert.strictEqual(s.overdue, 1);
  assert.strictEqual(s.dueToday, 1);
  assert.strictEqual(s.byPriority.high, 1);
  assert.strictEqual(s.completionRate, 0.25);
});

test("taskStats on an empty list does not divide by zero", () => {
  const s = tb.taskStats([], NOW);
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.completionRate, 0);
});

// --- filtering ---------------------------------------------------------------
const sample = [
  { id: "1", title: "Write report", notes: "quarterly", tags: ["work"], done: false, priority: "high", due: "2026-03-10", order: 0, createdAt: 1, updatedAt: 1 },
  { id: "2", title: "Buy milk", notes: "", tags: ["home"], done: true, priority: "normal", due: null, order: 1, createdAt: 2, updatedAt: 2 },
  { id: "3", title: "Call dentist", notes: "", tags: ["health", "home"], done: false, priority: "low", due: "2026-03-15", order: 2, createdAt: 3, updatedAt: 3 },
];

test("filterTasks by status", () => {
  assert.strictEqual(tb.filterTasks(sample, { status: "all" }, NOW).length, 3);
  assert.strictEqual(tb.filterTasks(sample, { status: "active" }, NOW).length, 2);
  assert.strictEqual(tb.filterTasks(sample, { status: "done" }, NOW).length, 1);
  assert.strictEqual(tb.filterTasks(sample, { status: "overdue" }, NOW).length, 1);
  assert.strictEqual(tb.filterTasks(sample, { status: "today" }, NOW).length, 1);
});

test("filterTasks by priority and tag", () => {
  assert.strictEqual(tb.filterTasks(sample, { priority: "high" }, NOW).length, 1);
  assert.strictEqual(tb.filterTasks(sample, { tag: "home" }, NOW).length, 2);
  assert.strictEqual(tb.filterTasks(sample, { tag: "home", status: "active" }, NOW).length, 1);
});

test("filterTasks text search is case-insensitive across title, notes and tags", () => {
  assert.strictEqual(tb.filterTasks(sample, { text: "REPORT" }, NOW).length, 1);
  assert.strictEqual(tb.filterTasks(sample, { text: "quarterly" }, NOW).length, 1);
  assert.strictEqual(tb.filterTasks(sample, { text: "health" }, NOW).length, 1);
  assert.strictEqual(tb.filterTasks(sample, { text: "zzz" }, NOW).length, 0);
});

test("filterTasks treats an unknown status as 'all' and ignores bad input", () => {
  assert.strictEqual(tb.filterTasks(sample, { status: "bogus" }, NOW).length, 3);
  assert.strictEqual(tb.filterTasks(null, {}, NOW).length, 0);
});

// --- sorting -----------------------------------------------------------------
test("sortTasks by due puts dated tasks first and undated last", () => {
  const out = tb.sortTasks(sample, "due", NOW).map((t) => t.id);
  assert.deepStrictEqual(out, ["1", "3", "2"]);
});

test("sortTasks by priority ranks high, normal, low", () => {
  const out = tb.sortTasks(sample, "priority", NOW).map((t) => t.id);
  assert.deepStrictEqual(out, ["1", "2", "3"]);
});

test("sortTasks by title is alphabetical, case-insensitive", () => {
  const out = tb.sortTasks(sample, "title", NOW).map((t) => t.title);
  assert.deepStrictEqual(out, ["Buy milk", "Call dentist", "Write report"]);
});

test("sortTasks never mutates the input array", () => {
  const before = sample.map((t) => t.id);
  tb.sortTasks(sample, "title", NOW);
  assert.deepStrictEqual(sample.map((t) => t.id), before);
});

// --- immutable operations ----------------------------------------------------
test("toggleDone flips state and maintains completedAt", () => {
  const after = tb.toggleDone(sample, "1", NOW);
  assert.strictEqual(after[0].done, true);
  assert.strictEqual(after[0].completedAt, NOW);
  const back = tb.toggleDone(after, "1", NOW + 1000);
  assert.strictEqual(back[0].done, false);
  assert.strictEqual(back[0].completedAt, null);
  assert.strictEqual(sample[0].done, false, "original untouched");
});

test("toggleDone on an unknown id returns an equivalent list", () => {
  const after = tb.toggleDone(sample, "nope", NOW);
  assert.deepStrictEqual(after.map((t) => t.id), sample.map((t) => t.id));
});

test("updateTask applies edits and validates them", () => {
  const after = tb.updateTask(sample, "2", { title: "Buy oat milk", priority: "high" }, NOW);
  assert.strictEqual(after[1].title, "Buy oat milk");
  assert.strictEqual(after[1].priority, "high");
  assert.strictEqual(after[1].updatedAt, NOW);
  assert.throws(() => tb.updateTask(sample, "2", { title: "" }, NOW), (err) => {
    assert.ok(Array.isArray(err.validation));
    return true;
  });
});

test("updateTask un-completing clears completedAt", () => {
  const after = tb.updateTask(sample, "2", { done: false }, NOW);
  assert.strictEqual(after[1].done, false);
  assert.strictEqual(after[1].completedAt, null);
});

test("removeTask drops only the named task", () => {
  const after = tb.removeTask(sample, "2");
  assert.deepStrictEqual(after.map((t) => t.id), ["1", "3"]);
  assert.strictEqual(sample.length, 3);
});

test("clearCompleted and setAllDone", () => {
  assert.deepStrictEqual(tb.clearCompleted(sample).map((t) => t.id), ["1", "3"]);
  const all = tb.setAllDone(sample, true, NOW);
  assert.ok(all.every((t) => t.done && t.completedAt === NOW));
  const none = tb.setAllDone(all, false, NOW);
  assert.ok(none.every((t) => !t.done && t.completedAt === null));
});

test("moveTask reorders and rewrites order values", () => {
  const list = tb.reindex(sample);
  const moved = tb.moveTask(list, "3", 0);
  assert.deepStrictEqual(moved.map((t) => t.id), ["3", "1", "2"]);
  assert.deepStrictEqual(moved.map((t) => t.order), [0, 1, 2]);
  // Out-of-range targets clamp rather than throw.
  assert.deepStrictEqual(tb.moveTask(list, "1", 99).map((t) => t.id), ["2", "3", "1"]);
  assert.deepStrictEqual(tb.moveTask(list, "missing", 0).map((t) => t.id), ["1", "2", "3"]);
});

// --- persistence round trip --------------------------------------------------
test("serialize/deserialize round-trips tasks losslessly", () => {
  const tasks = tb.reindex(sample.map((t) => tb.createTask(t, { id: t.id, now: t.createdAt })));
  const text = tb.serialize(tasks, NOW);
  const back = tb.deserialize(text, NOW);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.tasks.length, tasks.length);
  assert.deepStrictEqual(back.tasks.map((t) => t.title), tasks.map((t) => t.title));
  assert.deepStrictEqual(back.tasks.map((t) => t.tags), tasks.map((t) => t.tags));
  assert.strictEqual(back.tasks[1].done, true);
});

test("serialize writes a versioned document", () => {
  const doc = JSON.parse(tb.serialize([], NOW));
  assert.strictEqual(doc.version, tb.SCHEMA_VERSION);
  assert.strictEqual(doc.app, "toolshed/task-board");
  assert.deepStrictEqual(doc.tasks, []);
});

test("deserialize rejects empty, non-JSON and wrong-shaped input", () => {
  assert.strictEqual(tb.deserialize("", NOW).ok, false);
  assert.strictEqual(tb.deserialize("   ", NOW).ok, false);
  assert.strictEqual(tb.deserialize("{not json", NOW).ok, false);
  assert.strictEqual(tb.deserialize("42", NOW).ok, false);
  assert.strictEqual(tb.deserialize('{"nope":true}', NOW).ok, false);
  assert.strictEqual(tb.deserialize(null, NOW).ok, false);
});

test("deserialize upgrades a legacy v1 document", () => {
  const legacy = JSON.stringify({ version: 1, tasks: [{ text: "Old task", done: true }] });
  const back = tb.deserialize(legacy, NOW);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.tasks[0].title, "Old task");
  assert.strictEqual(back.tasks[0].done, true);
  assert.match(back.warnings.join(" "), /Upgraded saved data/);
});

test("deserialize accepts a bare array with a warning", () => {
  const back = tb.deserialize(JSON.stringify([{ title: "Loose" }]), NOW);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.tasks[0].title, "Loose");
  assert.match(back.warnings.join(" "), /bare task array/);
});

test("deserialize skips unreadable entries instead of throwing", () => {
  const doc = JSON.stringify({ version: 2, tasks: [null, 7, { title: "" }, { title: "Good" }] });
  const back = tb.deserialize(doc, NOW);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.tasks.length, 1);
  assert.strictEqual(back.tasks[0].title, "Good");
  assert.match(back.warnings.join(" "), /skipped/);
});

test("deserialize neutralises hostile field values", () => {
  const doc = JSON.stringify({
    version: 2,
    tasks: [{
      title: "  <img src=x onerror=alert(1)>  ",
      priority: "'; DROP TABLE--",
      due: "../../etc/passwd",
      tags: ["<script>", "<script>", "ok"],
      notes: "x".repeat(99999),
      done: "yes"
    }]
  });
  const back = tb.deserialize(doc, NOW);
  const t = back.tasks[0];
  assert.strictEqual(t.priority, "normal", "bad priority falls back");
  assert.strictEqual(t.due, null, "bad due date is dropped");
  assert.strictEqual(t.done, false, "only a literal boolean true counts as done");
  assert.ok(t.notes.length <= tb.MAX_NOTES);
  assert.strictEqual(t.tags.filter((x) => x === "script").length, 1, "tags are normalised and deduped");
  // The angle brackets survive as inert text; the UI renders them via textContent.
  assert.match(t.title, /<img/);
});

test("deserialize warns about a newer on-disk version", () => {
  const doc = JSON.stringify({ version: 99, tasks: [{ title: "Future" }] });
  const back = tb.deserialize(doc, NOW);
  assert.strictEqual(back.ok, true);
  assert.match(back.warnings.join(" "), /newer version/);
});

test("deserialize caps an oversized task list", () => {
  const many = [];
  for (let i = 0; i < tb.MAX_TASKS + 50; i++) many.push({ title: "t" + i });
  const back = tb.deserialize(JSON.stringify({ version: 2, tasks: many }), NOW);
  assert.strictEqual(back.tasks.length, tb.MAX_TASKS);
  assert.match(back.warnings.join(" "), /first/);
});

// --- tags in use -------------------------------------------------------------
test("allTags returns a sorted, unique union", () => {
  assert.deepStrictEqual(tb.allTags(sample), ["health", "home", "work"]);
  assert.deepStrictEqual(tb.allTags([]), []);
  assert.deepStrictEqual(tb.allTags(null), []);
});

// --- summary -----------------------------------------------------------------
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
