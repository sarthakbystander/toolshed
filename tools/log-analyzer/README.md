# Log Analyzer

Turn a raw log file into an answer. Paste or open a server, application or
structured log and the tool parses it line by line, counts severities, groups
near-identical messages, surfaces the top errors and exception types, draws a
throughput timeline, and gives you a virtualized view you can search with plain
text or a regular expression.

## Why

The first thing anyone does with a log is grep it, and the second thing is
wonder what they missed. A crash loop and a slow leak look the same in a tail;
`ERROR` lines hide behind thousands of `INFO` heartbeats; the same
`NullPointerException` fires from five places under five different messages. This
tool does the triage pass automatically: it tells you the error rate, when the
volume spiked, which messages repeat, and which sources are noisy — all before
you type a single search term.

It is built for the moment when a log lands in front of you and you have no
access to a log platform: an attachment in a support ticket, a file from a
container, a paste from a colleague, or a dump you cannot upload anywhere.

## What it does

- **Parses mixed formats** in one file. Each line is recognized independently,
  so a log that mixes plain text, JSON and logfmt lines still analyzes cleanly.
- **Severity counts** across `fatal`, `error`, `warning`, `notice`, `info`,
  `debug` and `trace`, with a bar chart, an error rate, and a count of lines that
  could not be parsed.
- **Message templates.** Lines are normalized — numbers, UUIDs, IP addresses,
  timestamps, quoted strings, hex blobs and long tokens become placeholders —
  so `processed 12 records` and `processed 480 records` group into one template
  with a combined count.
- **Top errors and exception types.** Error and fatal templates are ranked, and
  Java-style, `XxxError`/`XxxException`-style and quoted exception names are
  extracted and counted.
- **Sources.** Logger, module and syslog program names are ranked by volume, so
  a single noisy service stands out.
- **Throughput timeline.** Timestamped lines are bucketed into a histogram with
  the peak rate, the span, and the first and last timestamps in UTC.
- **Searchable, virtualized log view.** Filter by substring or regular
  expression (with a case-sensitivity toggle), by severity, by source, or by
  time window, then scroll a view that only renders the visible rows — so a
  large file stays responsive and matches are highlighted inline.
- **Export.** Copy the currently filtered lines as CSV or JSON Lines.

## Supported formats

The parser tries structured formats first, then falls back to a plain-text
heuristic.

| Format | Example |
| --- | --- |
| ISO 8601 | `2024-05-01T10:00:00Z ERROR api.handler: request failed` |
| ISO 8601, space/offset | `2024-05-01 10:00:00,250 WARN db.pool: pool near capacity` |
| Syslog | `May  1 10:00:04 host sshd[123]: Accepted password` |
| Apache/NGINX access | `10.0.0.7 - - [01/May/2024:10:00:00 +0000] "GET / HTTP/1.1" 200` |
| JSON / NDJSON | `{"time":"2024-05-01T10:00:03Z","level":"error","logger":"api","message":"boom"}` |
| logfmt | `level=info msg="cache warmed" service=cache duration=120ms` |

### Timestamps

Recognized forms include ISO 8601 with `T` or a space, optional milliseconds
(`.` or `,`) and an optional `Z` or `±HH:MM` offset; slash- or dash-separated
dates; Apache common-log `[dd/Mon/yyyy:HH:MM:SS ±HHMM]`; a bare `HH:MM:SS`; and
syslog's `Mon dd HH:MM:SS`, which carries no year. Year-less timestamps are
anchored to the year of the first fully-dated line in the file, so a log that
mixes both still produces a sane time range. Every timestamp is normalized to
UTC; the tool does not know the original zone, so a local-time log will be
displayed as if it were UTC.

### Levels and sources

Levels are recognized as a token or a bracketed token (`ERROR`, `[warn]`,
`level=error`, JSON `level`/`severity`/`lvl`, and numeric syslog severities such
as `level: 50` → `fatal`). Sources are recognized as a dotted module name
(`api.handler`), a bracketed name (`[worker-1]`) or a logfmt/JSON logger field.

## How to use

1. Paste log lines into the input box, click **Open file** to read a
   `.log`, `.txt`, `.jsonl` or `.json` file, or click **Load sample** to try a
   realistic mixed-format log.
2. Click **Analyze** (or press Ctrl/⌘ + Enter). Analysis runs automatically when
   you load a file or the sample.
3. Read the summary cards, then switch between the **Overview**, **Messages**,
   **Errors**, **Sources**, **Timeline** and **Log** tabs.
4. In the **Log** tab, narrow the view with the search box, the severity chips,
   the source dropdown and the regular-expression toggle, then copy the filtered
   set as CSV or JSONL.

## Privacy

Everything runs in your browser from the text you paste or open. The tool makes
no network requests, uploads nothing, and writes nothing to storage — no
`localStorage`, no cookies, no analytics. Files are read with the browser's
`FileReader` and never leave the page. Close the tab and the log is gone.

## Limitations

- The tool is a triage aid, not a full-text search engine. It does not index
  every token or understand language-specific log schemas.
- Timestamps are shown in UTC. A log written in a local zone is not converted.
- Year-less (syslog) timestamps are inferred from the first fully-dated line in
  the same file; a file with no dated line falls back to a fixed reference year
  (2000). Relative ordering is preserved either way, but the absolute year of
  such a file is a guess.
- Message normalization is deliberately aggressive so similar lines group. A
  template is a summary, not an exact-match key — use the Log tab for exact
  matching.
- Exception extraction recognizes common naming conventions
  (`FooException`, `FooError`, quoted class names); it is not a language parser.
- Very large files are capped (see below) rather than streamed, because analysis
  is in-memory.

## Performance

The whole file is split and parsed on the main thread, then capped at
**200,000 lines** so the tab stays usable; the status bar reports when a cap was
applied. The Log tab is virtualized, rendering only the rows in view (plus a
small buffer), so scrolling and filtering stay smooth regardless of result
count. Search is debounced and highlighting is computed once per filter change,
not on every scroll frame.

## Browser requirements

Any current Chrome, Edge, Firefox or Safari. Opening a file uses the standard
`FileReader` API and the toolbar buttons use the standard Clipboard API, so no
experimental or permission-gated APIs are required.

## Technical notes

- `tool.js` follows the Toolshed UMD pattern: it loads as
  `window.Toolshed.logAnalyzer` in the browser and via `require()` in Node for
  tests. It has no dependencies and uses no `eval` or dynamic code execution.
- Core exports: `parseLine`, `parseTimestamp`, `analyze`, `summarize`,
  `buildBuckets`, `filterEntries`, `highlightRanges`, `normalizeMessage`,
  `extractExceptionTypes`, `compileRegex`, `splitLines`, `exportCSV`,
  `exportJSONL`, `formatDuration`, `formatEpoch`, plus `SEVERITY_RANK`,
  `MAX_LINES` and `MAX_REGEX_LENGTH`.
- `analyze(text, options)` returns `{ entries, totalLines, processedLines,
  truncated, options }`; each entry carries `n`, `format`, `level`, `severity`,
  `source`, `message`, `template`, `timestamp` and a `malformed` flag.
- `summarize(entries, options)` returns level counts, an error rate, ranked
  message groups, top errors, exception types, sources, a time range and
  histogram buckets.
- Search patterns are bounded in length and compiled in a `try`/`catch`; an
  invalid or over-long pattern degrades to "no matches" instead of throwing.
- Log content is rendered with DOM text nodes and `textContent` only — never as
  HTML — so a line containing `<script>` or `{{ }}` is displayed as text.
- Tests live in `tests/run.js` and run under `npm run test:tools`. They cover
  every timestamp form, plain/JSON/logfmt parsing, message normalization,
  exception extraction, grouping, bucketing, all filters, regex safety,
  highlighting, CSV/JSONL export, empty and malformed input, and adversarial
  input (very long lines, control characters, quote and brace floods).
