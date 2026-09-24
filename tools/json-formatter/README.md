# JSON Formatter

Format, validate and inspect JSON directly in your browser.

## What it does

- **Format** — pretty-print JSON with readable indentation
- **Minify** — compress JSON to its most compact form
- **Validate** — get clear, position-aware error messages for bad input
- **Copy** — copy the formatted result to your clipboard
- **Clear** — wipe input and output in one click

## How it works

Paste messy JSON into the left pane. The tool validates it live as you type.
Click **Tidy it up** to pretty-print, or **Minify** to compress. If the input is
invalid, you get a message naming the line, column, and problem.

## Privacy

Everything runs locally in your browser. No input is ever sent anywhere, and
nothing is stored.

## Limitations

- Output is always compact or 2-space indented JSON; no custom indentation yet.
- Very large inputs (several MB) are handled by the browser's native `JSON.parse`,
  which may set practical limits per browser.