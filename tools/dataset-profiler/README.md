# Dataset Profiler

Paste, drop, or upload a dataset and get an instant statistical profile of
every column — inferred types, missing values, distributions, outliers,
duplicate rows, and correlations. Everything runs in your browser; no data
ever leaves your machine.

## What it does

- **Reads CSV, TSV, and JSON** — auto-detects the delimiter (comma, semicolon,
  tab, pipe) from the header line, honors quoted fields, escaped quotes,
  embedded newlines, CRLF endings, and a leading UTF-8 BOM. JSON input accepts
  an array of objects, an array of arrays, an array of primitives, or a
  single-key object wrapping an array.
- **Infers column types** — `integer`, `number`, `boolean`, `date`, `text`, or
  `empty`, based on the actual values rather than the header name.
- **Summarizes each column** — non-null count, missing count and ratio,
  distinct values, most frequent values, and min/max string lengths for text.
- **Computes numeric statistics** — min, max, mean, sample standard deviation,
  Q1, median, Q3, IQR, and the number of outliers using the 1.5 × IQR rule,
  plus an equal-width histogram.
- **Finds correlations** — a Pearson correlation matrix across the numeric
  columns (up to the first 20 numeric columns).
- **Dataset-level metrics** — row/column/cell counts, overall missing ratio,
  and the number of fully duplicated rows.
- **Exports** — copy a Markdown report or download the full profile as JSON.
- **Handles large files without freezing** — profiling a 100,000-row × 6-column
  CSV takes well under a second on a typical machine, and internal caps keep
  pathological inputs from exhausting memory.

## How to use it

1. Paste data into the text box, or drag a `.csv`, `.tsv`, or `.json` file onto
   the drop area (or click it to choose a file).
2. Optionally adjust the format, whether the first row is a header, the
   histogram bin count, and whether blank / `null` / `N/A` / `NaN` count as
   missing.
3. Click **Profile data** (or press Ctrl/Cmd+Enter).

The results show a summary strip, a column overview table, a detail card per
column (with a histogram for numeric columns or a frequency list for
categorical ones), and a correlation matrix when two or more numeric columns
are present.

The **Load sample** button fills the form with a small mixed-type employee
dataset so you can see the output immediately.

## Supported input

- **Delimited text** — the delimiter is guessed from the first line unless you
  pick one explicitly. Rows shorter than the header are padded with empty
  cells; longer rows are trimmed to the header width.
- **JSON** — parsed strictly with `JSON.parse`; malformed JSON produces a
  readable error instead of a crash. Nested objects and arrays inside a row
  are treated as single (text) cell values rather than being flattened.

## Type inference rules

A column's type is decided from its non-missing values:

- **integer / number** — every value parses as a finite number; `integer`
  additionally requires all values to be whole numbers.
- **boolean** — every value is `true`/`false` (case-insensitive).
- **date** — every value matches an ISO-style `YYYY-MM-DD` date, optionally
  with a time and timezone.
- **empty** — every value is missing.
- **text** — anything else, including columns with mixed types.

## Limitations

- Percentiles use linear interpolation (the "type 7" method used by NumPy and R).
- Correlations are Pearson only; they capture linear relationships and should
  not be read as causation. Columns with no variance report `n/a`.
- Distinct-value tracking is capped at 50,000 values per column, and the
  duplicate detection at 200,000 rows; the UI marks capped values with a `+`.
- Inputs larger than 500,000 rows are profiled but flagged as truncated.
- Nested JSON values are not flattened — deeply nested data will appear as a
  `text` column containing object literals.

## Privacy

Everything runs locally in your browser. Files are read with the File API and
decoded in memory; nothing is uploaded, and nothing is written to
`localStorage`, `sessionStorage`, or `indexedDB`. There are no network requests
of any kind. The Clipboard API is used only when you click **Copy Markdown
report**, and the File/Blob API only when you click **Download JSON**.

## Browser requirements

A modern evergreen browser. The tool uses standard `FileReader`, `Blob`,
`URL.createObjectURL`, `Set`/`Map`, and `Intl`-free number formatting; no
Web Worker is required because profiling is fast enough to run synchronously.

## Implementation notes

The parsing and statistics engine is a dependency-free UMD module
(`window.Toolshed.datasetProfiler` in the browser, `require("../tool.js")` in
Node) so the same code powers the page and the test suite in `tests/run.js`.
The UI builds every result with DOM nodes and `textContent` — no `innerHTML`
and no `eval` — so arbitrary cell contents are rendered safely.
