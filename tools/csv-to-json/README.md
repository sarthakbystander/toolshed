# CSV to JSON

Convert CSV into JSON in your browser, with automatic header detection and type inference.

## What it does

- **Convert** CSV text into a JSON array of objects (or a flat array for a single column)
- **Header detection** — the first row is treated as headers when it looks like labels
- **Type inference** — numeric cells become numbers, `true`/`false`/`null` become booleans/null
- **Delimiter selection** — auto-detect, or force comma, semicolon, tab or pipe
- **Quote handling** — quoted fields, escaped quotes (`""`) and embedded commas/newlines
- **Load sample** — one click to try the bundled sample CSV
- **Copy** — copy the generated JSON

## How it works

The tool parses the CSV faithfully (RFC 4180-style quoting, BOM stripping, CRLF
support), detects the delimiter from the header line, optionally infers scalar
types from each cell, then maps rows to objects using the header row. Fields
missing from a row become empty strings.

## Privacy

Everything runs locally in your browser. Your CSV never leaves your tab.

## Limitations

- Loses leading zeros in numeric cells that look like numbers (use "Infer
  types" unchecked to keep them as strings).
- No streaming: very large files are handled in memory.
- Comments, variable-length rows and multi-header hierarchies are not supported.
