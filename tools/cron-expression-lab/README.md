# Cron Expression Lab

Explain, build and schedule cron expressions entirely in your browser. Type an
expression and get a plain-language description, a per-field breakdown of what
it matches, and the next run times in any time zone — with daylight-saving
transitions handled correctly.

## Why use it

Cron syntax is compact and unforgiving. A one-character slip can turn "every
Monday at 09:00" into "every minute of every day", and the classic
day-of-month/day-of-week rule surprises even experienced engineers. This tool
turns a cryptic expression into something you can read, sanity-check the field
by field, and confirm against real calendar dates before it goes anywhere near
production. It is the kind of check you want before committing a schedule to a
CI config, a Kubernetes `CronJob`, a systemd timer or a backup script.

## What it does

- **Plain-language description** — e.g. `0 9 * * 1-5` reads as "At 09:00, on
  Monday, Tuesday, Wednesday, Thursday and Friday."
- **Field breakdown** — each field's raw input and the compact set of values it
  matches (ranges are collapsed, e.g. `0–59`).
- **Next run times** — the next five firings, shown as real timestamps in the
  selected zone and as a relative "in 13 min" hint.
- **Layout detection** — recognises 5-field (standard), 6-field with seconds,
  6-field with a year, and 7-field expressions, or lets you pick the layout
  explicitly. Macros such as `@daily` are expanded.
- **Time-zone aware** — pick any IANA zone; next-run calculations use real
  wall-clock values, so `0 0 * * *` stays at local midnight across a
  daylight-saving change.
- **Field-by-field builder** — assemble an expression from inputs for each
  field and copy it out, or send it straight back into the explainer.
- **Day-matching modes** — the standard "day OR weekday" rule, the Quartz-style
  "day AND weekday" rule, or ignore one of the two fields.
- **Reference card** — field ranges, macro list, and the gotchas that trip
  people up.

## How to use it

1. Type or paste an expression into the **Expression** field (or press a preset
   or macro chip). The description, field breakdown and next run times update as
   you type.
2. Choose the **field layout** if the expression is ambiguous — a six-field
   expression is read as seconds-first unless its last field looks like a year.
3. Pick a **time zone** to see next runs in that zone.
4. Use **Day matching** to switch between the standard OR rule and Quartz AND
   rule when both day-of-month and day-of-week are restricted.
5. To build instead of explain, fill in the inputs under **Build an
   expression**, then **Copy expression** or **Explain this**.

Keyboard: Ctrl/Cmd+Enter re-runs the explanation.

## Supported syntax

Fields are separated by whitespace and may use:

| Form | Meaning | Example |
| --- | --- | --- |
| `*` | every value in the field's range | `*` |
| `?` | synonym for `*` (day fields) | `?` |
| `5` | one value | `5` |
| `1-5` | inclusive range | `9-17` |
| `*/10` | every 10th value across the whole range | `*/15` |
| `a/step` | every `step` starting at `a` | `0/20` |
| `a-b/step` | every `step` within `a`–`b` | `9-17/2` |
| `1,3,5` | a union of the above | `MON,WED,FRI` |

Three-letter names are accepted for months (`JAN`–`DEC`) and weekdays
(`SUN`–`SAT`), case-insensitively. In the day-of-week field both `0` and `7`
mean Sunday.

Macros: `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`,
`@hourly`. `@reboot` is recognised but has no fixed schedule — the tool says so
instead of inventing next-run times.

## Limitations

- Standard cron has no concept of sub-minute scheduling; seconds only appear in
  six- or seven-field expressions.
- Next runs are capped at 50 results and a 20-year horizon. A self-contradictory
  schedule such as `0 0 31 2 *` (31 February) reports no occurrences rather than
  looping forever.
- Time zones rely on the browser's `Intl.DateTimeFormat` for wall-clock
  conversion, which every current evergreen browser supports. Zones the
  browser cannot load are reported as unknown rather than silently treated as
  UTC.
- Some cron dialects extend the syntax in incompatible ways (e.g. Quartz uses
  `?`, `L`, `W` and `#`). Only the forms listed above are understood; anything
  else is reported as an error rather than guessed at.

## Privacy

Everything runs locally in your browser. Expressions and time zones are never
sent anywhere, and nothing is persisted — not even in `localStorage`. The only
browser API used beyond the DOM is the Clipboard API, and only when you
explicitly click a copy button.

## Browser requirements

A modern evergreen browser with `Intl` support. No build step, no dependencies,
and no network requests — the page works offline.

## Implementation

The parsing, time-zone and occurrence logic lives in `tool.js` as a
dependency-free UMD module. It is exposed as `window.Toolshed.cronExpressionLab`
in the browser and can be `require`d in Node, so the test suite exercises the
same engine the page uses. The UI is plain DOM built with `textContent` and
`createElement` — no `innerHTML`, so nothing typed by the user is ever
interpreted as markup.

## Tests

`tests/run.js` covers field expansion (values, ranges, steps, names, `7`→`0`),
parsing and layout detection, the day OR/AND rules, time-zone resolution,
occurrence calculation (including leap day, an impossible schedule, a
year-scoped schedule, seconds, and DST spring-forward/fall-back cases), the
builder, and invalid input. Occurrence tests pass explicit start instants so
they do not depend on when or where the suite runs.
