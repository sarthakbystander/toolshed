# Regex Tester

Test JavaScript regular expressions against your own text, with every match
highlighted, capture groups listed, and live match stats — entirely in your
browser.

## What it does

- **Live testing** — type a pattern (and optional flags) and watch matches
  highlight as you edit, debounced after the first run
- **Highlighted matches** — the renderer splits your text into match and
  non-match segments and builds the view from DOM text nodes (no
  `innerHTML`, so arbitrary input is rendered safely
- **Capture groups** — each match entry lists `(1)`, `(2)`, … capture values,
  plus named groups when present
- **Match stats** — total match count and matched character count
- **Copy matches** — copies each matched substring, one per line, to the clipboard
- **Load sample / Clear** — one-click sample text and reset

## How it works

Paste (or type) your regular expression into the **Pattern** field, choose flags
(default `g`), and put the text to search into the **Subject text** pane. Click
**Test** (or press Ctrl/Cmd+Enter). Matches appear in the **Results** pane:
the original text with matched ranges highlighted, plus a collapsible list of every
match with its position and captures.

The core logic ships as a dependency-free UMD module
`window.Toolshed.regexTester` in the browser and `require(".../tool.js")` in Node,
so the same engine powers the UI and the test suite.

## Supported flags

`g` global · `i` ignore case · `m` multiline · `s` dotAll · `u` unicode ·
`v` unicodeSets · `y` sticky — matching JavaScript's `RegExp` flags.

. The pattern
must be delimiter-free just like the argument to `new RegExp()`, so
`/\d+/g` typed as `\d+` with flags `g`.

## Limitations

- Matching follows JavaScript's `RegExp` semantics exactly, including quirks
  around zero-width matches and `lastIndex`
- Non-global patterns are matched globally for highlighting, though anchors
  (`^`, `$`) still apply to the whole subject — so a plain `abc` highlights
  every occurrence, while `^abc` only matches at the start
- A safety ceiling of 5,000 matches avoids freezing the page on pathological
  patterns; the UI says when results are truncated
- Very large subjects rely on the browser's native regex engine, so practical
  limits vary per browser

## Privacy

Everything runs locally in your browser. Your pattern and text are never sent
anywhere, and nothing is persisted — not even in `localStorage`. The only
browser API used is the Clipboard API, and only when you explicitly click
**Copy matches**.

## Browser requirements

Modern evergreen browser. The `u` and `v` flags require up-to-date V8/
SpiderMonkey/JavaScriptCore engine support.