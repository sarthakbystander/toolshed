# Text Case Lab

Convert identifiers and prose between the common casing conventions entirely in
your browser. Paste a snippet and see every conversion at once, find out what
style the input is already in, and run a set of text-cleanup transforms — all
without sending a character anywhere.

## Why use it

Case conversion comes up constantly and is surprisingly easy to get wrong by
hand: renaming a `user_profile_id` column into the `userProfileId` your API
expects, turning a page title into a slug, switching a constant into kebab-case
for a CSS class, or cleaning up a paragraph that arrived with curly quotes,
double spaces and stray blank lines. Most online converters either upload your
text or stop at a single target case. This one shows every style side by side,
so you can see and pick the right one — and it handles the tricky parts
(acronyms, digits, mixed separators) predictably.

## What it does

- **Detects the current style** — recognises `camelCase`, `PascalCase`,
  `snake_case`, `CONSTANT_CASE`, `kebab-case`, `Train-Case`, `dot.case`,
  `path/case`, and the prose styles lower / UPPER / Title / Sentence case, or
  reports "Mixed / unknown" rather than guessing.
- **Converts to every style at once** — lower, UPPER, Title, Sentence,
  camelCase, PascalCase, snake_case, CONSTANT_CASE, kebab-case, Train-Case,
  dot.case, path/case and Ada_Case, each with its own copy button.
- **Cleanup transforms** — trim each line, collapse spaces and tabs, join into
  a single line, remove blank lines, strip accents and diacritics, normalise
  curly punctuation to ASCII, deduplicate lines, sort lines A–Z and reverse
  line order.
- **Document statistics** — characters, characters without spaces, words,
  unique words, sentences and lines.
- **Exports** — copy a Markdown report or download the full analysis as JSON.

## How to use it

1. Type or paste text into the **Your text** box on the left. The results
   update as you type.
2. Read the **detected** badge in the results header to confirm the input
   style, and the statistics strip beneath the input for counts.
3. Find the conversion or transform you want on the right and press its
   **Copy** button — a short confirmation appears at the bottom of the input
   pane.
4. Use **Load sample** to see every conversion applied to a mixed snippet, and
   **Clear** to start over.

Keyboard: Ctrl/Cmd+Enter re-runs the analysis. Every result button is reachable
by Tab and has an accessible label.

## How the conversions work

The word-splitting step is the heart of the tool. An input is split into words
by:

- separators — spaces, underscores, hyphens, dots, slashes and any other
  non-letter, non-digit character;
- camel and Pascal boundaries — a lower-case letter or digit followed by an
  upper-case letter (`userProfile` → `user`, `Profile`);
- acronym boundaries — a run of capitals followed by a capital and a lower-case
  letter (`HTTPServer` → `HTTP`, `Server`);
- letter/digit boundaries (`utf8String` → `utf`, `8`, `String`).

Apostrophes between letters are dropped so a contraction stays one word
(`don't` → `dont`), rather than shattering into fragments.

Word-list conversions (camelCase through Ada_Case) then re-join those words
with the separator and capitalisation the target style calls for. They
deliberately discard the original punctuation, because that is what an
identifier conversion should do.

The four prose conversions — lower, UPPER, Title and Sentence case — behave
differently: they operate on the original string and preserve its punctuation
and spacing. Title case capitalises the first letter of every word; sentence
case lower-cases the whole string, then capitalises the first letter and the
start of each new sentence (after `.`, `!`, `?` or a newline).

## Supported input

Plain text. There is no file upload — paste or type the text directly. Unicode
letters and digits are handled (the splitter uses Unicode property escapes), so
accented text and non-Latin scripts are not mangled. Very large inputs are
processed synchronously; the transforms are linear, but a multi-megabyte paste
is still a multi-megabyte paste, so keep inputs to the size a human is actually
reading or converting.

## Limitations

- Detection is a heuristic. Deliberately ambiguous inputs — `HELLO_world`,
  `user Profile`, `!!!` — are reported as "Mixed / unknown" instead of a
  confident wrong answer.
- A single all-lower-case token is reported as "lowercase", not "camelCase",
  because there is no way to tell them apart.
- Sentence-case detection is intentionally strict: a string is only called
  sentence case when the first word is capitalised and every later word is
  lower-case.
- The cleanup transforms are independent of the case conversions. They run on
  the original text, not on the output of a conversion, so the results stay
  composable and predictable.

## Privacy

Everything runs locally in your browser. Your text, the conversions and the
statistics never leave the tab, and nothing is persisted — not even in
`localStorage`. The only browser APIs used beyond the DOM are the Clipboard API
(when you click a copy button) and `URL.createObjectURL` (when you download the
JSON). No network requests are made, and `privacy.dataUploaded` is `false`.

## Browser requirements

A modern evergreen browser with support for Unicode property escapes in regular
expressions (`\p{…}`) and `String.prototype.normalize`, both of which are
present in every current browser. No build step, no dependencies, and the page
works offline.

## Implementation

The splitting, detection, conversion, transform and reporting logic lives in
`tool.js` as a dependency-free UMD module. It is exposed as
`window.Toolshed.textCaseLab` in the browser and can be `require`d in Node, so
the test suite exercises the same engine the page uses. The UI is plain DOM
built with `textContent` and `createElement` — no `innerHTML` — so nothing
typed by the user is ever interpreted as markup.

## Tests

`tests/run.js` covers word splitting (camel/Pascal and acronym boundaries,
separators, digits, apostrophes, empty input), every word-list conversion
(including round-trips and unknown case ids), the prose conversions, detection
for each recognised style plus empty and ambiguous inputs, every cleanup
transform, the statistics, and the JSON/Markdown reports (including pipe
escaping). Run it directly with `node tools/text-case-lab/tests/run.js` or
through the repository runner with `npm run test:tools`.
