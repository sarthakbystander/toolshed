"use strict";

/**
 * Cron Expression Lab — test suite.
 *
 * Run directly (node tools/cron-expression-lab/tests/run.js) or through the
 * repository runner (npm run test:tools). The library is required exactly as
 * the browser loads it, so these tests exercise the same code path the page
 * uses. Occurrence tests pass an explicit start instant so results never
 * depend on when or where the suite runs.
 */

const assert = require("node:assert");
const lib = require("../tool.js");

let passed = 0;
let failed = 0;

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Field expansion
// ---------------------------------------------------------------------------

test("wildcard expands to the full field range", () => {
  const r = lib.expandField("*", lib.FIELD_DEFS.minute);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.values.size, 60);
  assert.strictEqual(r.restricted, false);
});

test("single value, list and range expand correctly", () => {
  assert.deepStrictEqual(Array.from(lib.expandField("5", lib.FIELD_DEFS.minute).values), [5]);
  assert.deepStrictEqual(Array.from(lib.expandField("1,3,5", lib.FIELD_DEFS.hour).values), [1, 3, 5]);
  assert.deepStrictEqual(Array.from(lib.expandField("9-11", lib.FIELD_DEFS.hour).values), [9, 10, 11]);
});

test("steps expand from a start or from the minimum", () => {
  assert.deepStrictEqual(
    Array.from(lib.expandField("*/15", lib.FIELD_DEFS.minute).values),
    [0, 15, 30, 45]
  );
  assert.deepStrictEqual(
    Array.from(lib.expandField("0/20", lib.FIELD_DEFS.minute).values),
    [0, 20, 40]
  );
  assert.deepStrictEqual(
    Array.from(lib.expandField("2-10/2", lib.FIELD_DEFS.minute).values),
    [2, 4, 6, 8, 10]
  );
});

test("month and weekday names are accepted, case-insensitively", () => {
  assert.deepStrictEqual(Array.from(lib.expandField("jan", lib.FIELD_DEFS.month).values), [1]);
  assert.deepStrictEqual(Array.from(lib.expandField("JAN-MAR", lib.FIELD_DEFS.month).values), [1, 2, 3]);
  assert.deepStrictEqual(Array.from(lib.expandField("mon-fri", lib.FIELD_DEFS.dow).values), [1, 2, 3, 4, 5]);
});

test("day-of-week 7 folds onto Sunday (0)", () => {
  assert.deepStrictEqual(Array.from(lib.expandField("7", lib.FIELD_DEFS.dow).values), [0]);
  assert.deepStrictEqual(Array.from(lib.expandField("0,7", lib.FIELD_DEFS.dow).values), [0]);
});

test("question mark is a synonym for wildcard", () => {
  assert.deepStrictEqual(
    Array.from(lib.expandField("?", lib.FIELD_DEFS.dom).values),
    Array.from(lib.expandField("*", lib.FIELD_DEFS.dom).values)
  );
});

test("invalid fields are rejected with a reason", () => {
  assert.strictEqual(lib.expandField("60", lib.FIELD_DEFS.minute).ok, false);
  assert.strictEqual(lib.expandField("", lib.FIELD_DEFS.minute).ok, false);
  assert.strictEqual(lib.expandField("5-1", lib.FIELD_DEFS.minute).ok, false);
  assert.strictEqual(lib.expandField("*/0", lib.FIELD_DEFS.minute).ok, false);
  assert.strictEqual(lib.expandField("a", lib.FIELD_DEFS.minute).ok, false);
  assert.strictEqual(lib.expandField("1,,2", lib.FIELD_DEFS.minute).ok, false);
  assert.strictEqual(lib.expandField("1-2-3", lib.FIELD_DEFS.minute).ok, false);
  assert.strictEqual(lib.expandField("1.5", lib.FIELD_DEFS.minute).ok, false);
});

// ---------------------------------------------------------------------------
// Expression parsing
// ---------------------------------------------------------------------------

test("five-field expression parses with implicit seconds and year", () => {
  const p = lib.parseCron("0 9 * * 1-5");
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.layout, "standard");
  assert.strictEqual(p.hasSeconds, false);
  assert.strictEqual(p.hasYear, false);
  assert.deepStrictEqual(Array.from(p.fields.second.values), [0]);
});

test("six fields ending in a four-digit value are read as a year", () => {
  const p = lib.parseCron("0 0 1 * * 2027");
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.layout, "with-year");
  assert.deepStrictEqual(Array.from(p.fields.year.values), [2027]);
});

test("six fields otherwise default to seconds", () => {
  const p = lib.parseCron("*/30 * * * * *");
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.layout, "with-seconds");
  assert.deepStrictEqual(Array.from(p.fields.second.values), [0, 30]);
});

test("seven fields parse as seconds + year", () => {
  const p = lib.parseCron("0 0 12 1 1 * 2030", { layout: "full" });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.hasSeconds, true);
  assert.strictEqual(p.hasYear, true);
});

test("macros expand to their standard equivalent", () => {
  const daily = lib.parseCron("@daily");
  assert.strictEqual(daily.ok, true);
  assert.strictEqual(daily.canonical, "0 0 * * *");
  assert.strictEqual(daily.macro, "@daily");
  const weekly = lib.parseCron("@weekly");
  assert.strictEqual(weekly.canonical, "0 0 * * 0");
});

test("@reboot is reported as unschedulable rather than faked", () => {
  const p = lib.parseCron("@reboot");
  assert.strictEqual(p.ok, false);
  assert.match(p.error, /boot/i);
});

test("wrong field counts and blank input are rejected", () => {
  assert.strictEqual(lib.parseCron("").ok, false);
  assert.strictEqual(lib.parseCron("   ").ok, false);
  assert.strictEqual(lib.parseCron("1 2 3").ok, false);
  assert.strictEqual(lib.parseCron("1 2 3 4 5 6 7 8").ok, false);
  assert.strictEqual(lib.parseCron("bad").ok, false);
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function parts(y, mo, d, h, mi, s) {
  return {
    year: y, month: mo, day: d, hour: h, minute: mi, second: s,
    weekday: new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  };
}

test("matchesParts honours every field", () => {
  const p = lib.parseCron("0 9 * * 1-5");
  assert.strictEqual(lib.matchesParts(p, parts(2026, 3, 9, 9, 0, 0)), true);  // Monday
  assert.strictEqual(lib.matchesParts(p, parts(2026, 3, 8, 9, 0, 0)), false); // Sunday
  assert.strictEqual(lib.matchesParts(p, parts(2026, 3, 9, 10, 0, 0)), false);
});

test("day-of-month and day-of-week combine with OR by default", () => {
  const p = lib.parseCron("0 0 15 * 1"); // 15th OR Monday
  assert.strictEqual(lib.dayMatches(p, 15, 3, "or"), true); // 15th (a Wednesday)
  assert.strictEqual(lib.dayMatches(p, 10, 1, "or"), true); // a Monday that is not the 15th
  assert.strictEqual(lib.dayMatches(p, 10, 3, "or"), false);
});

test("AND mode requires both day-of-month and weekday", () => {
  const p = lib.parseCron("0 0 15 * 1");
  assert.strictEqual(lib.dayMatches(p, 15, 1, "and"), true);
  assert.strictEqual(lib.dayMatches(p, 15, 3, "and"), false);
  assert.strictEqual(lib.dayMatches(p, 10, 1, "and"), false);
});

test("dom and dow modes narrow the match to a single field", () => {
  const p = lib.parseCron("0 0 15 * 1");
  assert.strictEqual(lib.dayMatches(p, 15, 3, "dom"), true);
  assert.strictEqual(lib.dayMatches(p, 10, 1, "dom"), false);
  assert.strictEqual(lib.dayMatches(p, 10, 1, "dow"), true);
  assert.strictEqual(lib.dayMatches(p, 15, 3, "dow"), false);
});

// ---------------------------------------------------------------------------
// Time-zone handling
// ---------------------------------------------------------------------------

test("getTimeZoneParts resolves real wall-clock values", () => {
  const d = new Date("2026-03-07T15:30:00Z");
  const ny = lib.getTimeZoneParts(d, "America/New_York");
  assert.strictEqual(ny.hour, 10);
  assert.strictEqual(ny.minute, 30);
  const utc = lib.getTimeZoneParts(d, "UTC");
  assert.strictEqual(utc.hour, 15);
});

test("unknown time zones are rejected", () => {
  assert.strictEqual(lib.isValidTimeZone("America/New_York"), true);
  assert.strictEqual(lib.isValidTimeZone("Mars/Olympus"), false);
  assert.strictEqual(lib.isValidTimeZone(""), false);
});

test("time-zone list contains UTC and is sorted", () => {
  const zones = lib.listTimeZones();
  assert.ok(zones.includes("UTC"));
  assert.deepStrictEqual(zones, zones.slice().sort());
});

// ---------------------------------------------------------------------------
// Next occurrences
// ---------------------------------------------------------------------------

test("next occurrences of a five-minute schedule", () => {
  const p = lib.parseCron("*/15 * * * *");
  const r = lib.nextOccurrences(p, { tz: "UTC", start: "2026-03-07T10:02:30Z", count: 3 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(
    r.occurrences.map((o) => o.date.toISOString()),
    ["2026-03-07T10:15:00.000Z", "2026-03-07T10:30:00.000Z", "2026-03-07T10:45:00.000Z"]
  );
});

test("start is exclusive", () => {
  const p = lib.parseCron("0 0 * * *");
  const r = lib.nextOccurrences(p, { tz: "UTC", start: "2026-03-07T00:00:00Z", count: 1 });
  assert.strictEqual(r.occurrences[0].date.toISOString(), "2026-03-08T00:00:00.000Z");
});

test("weekday schedule skips weekends", () => {
  const p = lib.parseCron("0 9 * * 1-5");
  const r = lib.nextOccurrences(p, { tz: "UTC", start: "2026-03-06T12:00:00Z", count: 2 });
  // Fri 6th is past; Sat 7th and Sun 8th are skipped; Mon 9th and Tue 10th fire.
  assert.deepStrictEqual(
    r.occurrences.map((o) => o.date.toISOString()),
    ["2026-03-09T09:00:00.000Z", "2026-03-10T09:00:00.000Z"]
  );
});

test("a leap-day schedule finds the next 29 February", () => {
  const p = lib.parseCron("0 0 29 2 *");
  const r = lib.nextOccurrences(p, { tz: "UTC", start: "2026-01-01T00:00:00Z", count: 1 });
  assert.strictEqual(r.occurrences[0].date.toISOString(), "2028-02-29T00:00:00.000Z");
});

test("an impossible schedule returns no occurrences without hanging", () => {
  const p = lib.parseCron("0 0 31 2 *"); // 31 February never exists
  const r = lib.nextOccurrences(p, { tz: "UTC", start: "2026-01-01T00:00:00Z", count: 3 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.occurrences.length, 0);
});

test("a year-scoped schedule stops after that year", () => {
  const p = lib.parseCron("0 0 1 1 * 2027", { layout: "with-year" });
  const r = lib.nextOccurrences(p, { tz: "UTC", start: "2026-06-01T00:00:00Z", count: 5 });
  assert.strictEqual(r.occurrences.length, 1);
  assert.strictEqual(r.occurrences[0].date.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("seconds schedules fire at the right instants", () => {
  const p = lib.parseCron("*/30 * * * * *");
  const r = lib.nextOccurrences(p, { tz: "UTC", start: "2026-03-07T10:00:00Z", count: 3 });
  assert.deepStrictEqual(
    r.occurrences.map((o) => o.date.toISOString()),
    ["2026-03-07T10:00:30.000Z", "2026-03-07T10:01:00.000Z", "2026-03-07T10:01:30.000Z"]
  );
});

test("daily schedule across a spring-forward day stays on the wall clock", () => {
  // New York springs forward at 02:00 on 2026-03-08 (EST -> EDT).
  const p = lib.parseCron("0 0 * * *");
  const r = lib.nextOccurrences(p, { tz: "America/New_York", start: "2026-03-07T12:00:00Z", count: 2 });
  assert.strictEqual(r.occurrences[0].date.toISOString(), "2026-03-08T05:00:00.000Z"); // 00:00 EST
  assert.strictEqual(r.occurrences[1].date.toISOString(), "2026-03-09T04:00:00.000Z"); // 00:00 EDT
});

test("a wall time inside the spring-forward gap is skipped", () => {
  // 02:30 on 2026-03-08 does not exist in New York; the next day is used.
  const p = lib.parseCron("30 2 * * *");
  const r = lib.nextOccurrences(p, { tz: "America/New_York", start: "2026-03-07T12:00:00Z", count: 1 });
  assert.strictEqual(r.occurrences[0].date.toISOString(), "2026-03-09T06:30:00.000Z"); // 02:30 EDT
});

test("a wall time that occurs twice in autumn resolves to a valid instant", () => {
  // New York falls back at 02:00 on 2026-11-01 (EDT -> EST).
  const p = lib.parseCron("30 1 * * *");
  const r = lib.nextOccurrences(p, { tz: "America/New_York", start: "2026-10-31T12:00:00Z", count: 1 });
  const iso = r.occurrences[0].date.toISOString();
  const shown = lib.getTimeZoneParts(r.occurrences[0].date, "America/New_York");
  assert.strictEqual(shown.hour, 1);
  assert.strictEqual(shown.minute, 30);
  assert.ok(iso === "2026-11-01T05:30:00.000Z" || iso === "2026-11-01T06:30:00.000Z");
});

test("nextOccurrences refuses an unparsed expression and a bad zone", () => {
  assert.strictEqual(lib.nextOccurrences(null, {}).ok, false);
  const p = lib.parseCron("0 0 * * *");
  assert.strictEqual(lib.nextOccurrences(p, { tz: "Nowhere/Land" }).ok, false);
});

test("count is clamped to a sane maximum", () => {
  const p = lib.parseCron("* * * * *");
  const r = lib.nextOccurrences(p, { tz: "UTC", start: "2026-03-07T00:00:00Z", count: 500 });
  assert.strictEqual(r.occurrences.length, 50);
});

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

test("descriptions are plain, capitalized sentences", () => {
  const cases = [
    ["0 9 * * 1-5", /weekday|Monday/i],
    ["*/15 * * * *", /every 15 minutes/i],
    ["0 0 1 * *", /day 1/i],
    ["0 0 1 1 *", /January/i]
  ];
  for (const [expr, re] of cases) {
    const text = lib.describeCron(lib.parseCron(expr));
    assert.ok(text.length > 0, expr + " should be described");
    assert.strictEqual(text[0], text[0].toUpperCase());
    assert.match(text, re);
  }
});

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

test("builder joins fields and applies defaults", () => {
  const built = lib.buildCron({
    layout: "standard",
    fields: { minute: "0", hour: "9", dom: "*", month: "*", dow: "1-5" }
  });
  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.expression, "0 9 * * 1-5");
  const defaults = lib.buildCron({ layout: "with-seconds", fields: {} });
  assert.strictEqual(defaults.expression, "0 * * * * *");
});

test("builder rejects invalid field values", () => {
  const bad = lib.buildCron({ layout: "standard", fields: { minute: "99" } });
  assert.strictEqual(bad.ok, false);
  const badLayout = lib.buildCron({ layout: "nope" });
  assert.strictEqual(badLayout.ok, false);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

console.log("cron-expression-lab tests");
for (const { name, fn } of tests) {
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
console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
