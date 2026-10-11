# Unicode & Text Inspector

Find out what is really inside a string. Paste or open text and the tool walks
it character by character — showing each code point, its Unicode category,
block and script, its UTF-8 bytes and JavaScript escape — then runs a security
pass for the characters that are invisible or that pretend to be something
they are not: zero-width and bidi controls, homoglyphs, hidden tag characters
and normalization traps. It can also convert between the escape formats people
paste between, and clean up copy-pasted text.

## Why

Text that looks identical is often not identical. A domain, username, API key
or source file can contain characters that render like ordinary letters but
compare unequal, or invisible characters that silently break a comparison, a
search or a parser:

- `а` (Cyrillic a, U+0430) and `a` (Latin a, U+0061) look the same.
- `\u200b` (zero-width space) is invisible and breaks word matching.
- `\u202e` (right-to-left override) reverses how following text is displayed —
  the trick behind spoofed filenames and the "Trojan Source" source-code attack.
- `café` typed as `cafe` + combining acute (`\u0301`) is a different byte
  sequence from the precomposed `é` (`\u00e9`), so the two compare unequal.

When something "should work" but does not — a login, a signature check, a
find-and-replace, a CSV import — the cause is often one invisible code point.
This tool makes those characters visible and explains what they are.

## What it does

- **Character table.** Every code point in the input with its index, code point,
  glyph, name, Unicode category, block, script, UTF-8 bytes, HTML entity, CSS
  escape and JavaScript escape. Characters that are invisible or confusable are
  flagged with a risk level.
- **Counts.** Characters (code points), UTF-16 code units, UTF-8 bytes, and
  grapheme clusters (what a reader perceives as one character, e.g. an emoji
  family is one cluster but many code points). Also lines, words, non-ASCII
  count and average bytes per character.
- **Security scan.** Grouped findings for:
  - zero-width characters (U+200B, U+200C, U+200D);
  - bidirectional controls (U+200E/200F, U+202A–U+202E, U+2066–U+2069) — the
    display-spoofing class;
  - byte order marks (U+FEFF);
  - hidden tag characters (U+E0020–U+E007F), which encode invisible ASCII;
  - variation selectors and other invisible formatting characters;
  - homoglyphs — Cyrillic and Greek letters that look Latin;
  - mixed scripts inside one word (the classic identifier-spoofing pattern);
  - curly quotes, unusual space characters, replacement characters and lone
    surrogates;
  - text that is not in Unicode Normalization Form C.
- **Normalization.** Compare the input with its NFC/NFD/NFKC/NFKD form, see
  whether it changes, and normalize in place.
- **Escape conversion.** Decode or encode JavaScript (`\uXXXX`, `\u{...}`),
  HTML entities (hex, decimal and common named), URL percent-encoding, CSS
  escapes, JSON strings and a `U+XXXX` list. Decoding is bounded so nested or
  malformed input cannot loop forever.
- **Sanitizing.** Remove invisible characters, replace unusual spaces with a
  normal space, straighten curly quotes and dashes, and normalize — applied
  locally to the text you paste.
- **Export.** Copy the character table as CSV or the full report as JSON.

## How to use

1. Paste text into the input, click **Open file** to read a `.txt`, `.md`,
   `.csv`, `.json` or similar file, or click **Load sample** to try a text that
   mixes a homoglyph, a zero-width space and a bidi override.
2. Analysis runs as you type (debounced) or on **Analyze** / Ctrl/⌘ + Enter.
3. Read the summary cards and the security findings. In the **Characters** tab,
   filter by name, code point or risk, and hover a row to see the full details.
4. Use the **Escapes** tab to decode or encode, and the **Transform** tab to
   sanitize. **Apply result to input** feeds a transform back into the editor.

## Privacy

Everything runs in your browser from the text you paste or open. The tool makes
no network requests, uploads nothing, and writes nothing to storage — no
`localStorage`, no cookies, no analytics. Files are read with the browser's
`FileReader` and never leave the page. Close the tab and the text is gone.

## Limitations

- The block table is a compact, hand-maintained set of the ranges a reviewer
  meets in practice; a code point outside those ranges is reported as "No Block"
  rather than guessed.
- Unicode categories are derived from JavaScript's `\p{...}` property escapes
  (accurate) with a small hand-written fallback for very old engines. Mark
  categories are reported as `Mn` (nonspacing) rather than distinguishing every
  spacing/enclosing mark.
- Homoglyph detection covers the Cyrillic and Greek letters that look Latin and
  a set of look-alike Latin letters; it is not the full Unicode confusables
  table.
- Normalization uses the platform's `String.prototype.normalize`, so results
  match the browser's Unicode version.
- Grapheme clustering uses `Intl.Segmenter` where available and a documented
  approximation otherwise; the two can differ for unusual sequences.
- The detailed character table is capped (see below) on very large inputs.

## Performance

Analysis runs on the main thread over the whole input, but the per-character
detail table is capped at **20,000 characters**; beyond that the tool still
reports counts, runs the full security scan and exports, and tells you the table
was truncated. The character table is rendered in pages, and analysis is
debounced while typing, so a large paste does not freeze the tab.

## Browser requirements

Any current Chrome, Edge, Firefox or Safari. Uses `TextEncoder`/`TextDecoder`,
`String.prototype.normalize` and `Intl.Segmenter` when present, with fallbacks
for the first two and a documented approximation for segmentation. Reading a
file uses the standard `FileReader` API; copying uses the standard Clipboard API.

## Technical notes

- `tool.js` follows the Toolshed UMD pattern: it loads as
  `window.Toolshed.unicodeTextInspector` in the browser and via `require()` in
  Node for tests. It has no dependencies and uses no `eval` or dynamic code
  execution.
- Core exports: `analyze`, `analyzeChar`, `toCodePoints`, `splitGraphemes`,
  `countGraphemes`, `normalize`, `codePointName`, `categoryOf`, `blockOf`,
  `scriptOf`, `describe`, `detectIssues`, `decodeEscapes`, `encodeEscapes`,
  `removeInvisible`, `replaceOddSpaces`, `replaceSmartQuotes`, `sanitize`,
  `exportCSV`, `exportJSON`, plus `MAX_DETAIL_CHARS`, `HAS_SEGMENTER`, `BLOCKS`
  and `SCRIPT_RANGES`.
- `analyze(text, options)` returns `{ text, codePoints, length, utf16Length,
  byteLength, graphemeCount, bytesPerChar, chars, detailTruncated, issues, risk,
  scriptCounts, blockCounts, categoryCounts, hasSegmenter, summary }`.
- All user text is rendered with DOM text nodes and `textContent` — never as
  HTML — so a string containing `<script>` is displayed as text. Escape decoding
  never evaluates the decoded string.
- Tests live in `tests/run.js` and run under `npm run test:tools`. They cover
  code-point counting and UTF-8 encoding, grapheme clustering, category/block/
  script classification, every issue class (zero-width, bidi, BOM, tag, homoglyph,
  mixed-script, smart quotes, odd spaces, replacement, lone surrogate,
  normalization), escape decode/encode round-trips in every format, sanitizing,
  CSV/JSON export, and adversarial input (long input, lone surrogates, malformed
  escapes, control characters).
