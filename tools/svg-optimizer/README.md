# SVG Optimizer

Shrink and clean up SVG files right in the browser. Optimize path data,
drop editor metadata and comments, flatten useless groups, and review the
result for accessibility, contrast and safety problems — with a live
before/after preview. No uploads, no accounts, no build step.

## What it does

- **Load an SVG** — drag-and-drop a file, browse for one, paste from the
  clipboard, or type markup directly into the source pane.
- **Optimize** — a set of independent, well-understood rewrites that keep the
  rendered image identical:
  - remove comments, `<metadata>` blocks and the XML declaration/DOCTYPE
  - remove editor/export data (Inkscape, Sodipodi, Sketch, Adobe, Figma…)
    and namespace declarations that nothing in the document uses
  - remove containers (`<g>`, `<defs>`, `<symbol>`…) that end up empty
  - collapse a plain `<g>` that wraps a single element
  - remove attributes set to their own default (`x="0"`, `rx="0"`…)
  - trim formatting whitespace between elements only
  - round numeric attributes to a chosen precision
  - normalize and round path `d` data, including compact arc-flag syntax
  - minify colors to the shortest equivalent hex form
  - sort attributes for stable, diffable output
  - optionally shorten `id`s and rewrite every reference (`url(#…)`,
    `href="#…"`, `xlink:href`, and ids referenced inside `<style>`)
  - optionally remove `width`/`height` — only when a `viewBox` is present, so
    the image scales to its container
- **Presets** — Minimal, Safe and Strong one-click starting points.
- **Before/after preview** — both renderings side by side on a checkerboard.
- **Review** — an audit of `<title>`/`<desc>` presence, `role="img"`, `viewBox`,
  dimensions, live `<text>`, embedded `data:`/scriptable URIs, event-handler
  attributes and `<script>` elements, plus a low-contrast color-pair check
  against the WCAG AA 3:1 minimum for graphical objects.
- **Size report** — byte and element counts before and after, the percentage
  saved, and a per-optimization breakdown of what changed.
- **Export** — copy the optimized markup, download it as `.svg`, or download a
  Markdown report of the run.

## Why someone would use it

Handing a 40 KB vector-editor export to the web is wasteful: most of it is
editor bookkeeping, unrounded coordinates and comments that change nothing
about the picture. This tool strips that weight in one pass and, unlike a
plain minifier, shows you exactly what it removed and flags the accessibility
and safety problems the export left behind.

## How to use it

1. Drop an `.svg` file onto the drop zone, click **Open file**, or paste/type
   markup into the source box. Use **Load sample** to see it work on a typical
   editor export.
2. Pick a preset or toggle individual optimizations. The output, review and
   report update as you change options.
3. Check the before/after previews and the review notes.
4. **Copy SVG** or **Download .svg** for the optimized file, or **Download
   report** for the Markdown summary.

## Supported inputs

- Well-formed XML with an `<svg>` root element, including namespaced SVG
  (`xmlns:xlink`, `sodipodi`, `inkscape`, …), `<style>` blocks, `<defs>`,
  gradients, masks, filters and `<text>`.
- CDATA sections, comments, processing instructions and a DOCTYPE are parsed
  and handled.
- The input must be well-formed XML: HTML-style unclosed tags are rejected with
  a line/column error rather than guessed at.

## Limitations

- The parser is intentionally strict XML, not a full HTML5/SVG parser. Malformed
  markup fails with a location instead of being auto-corrected.
- Optimizations are structural and conservative; they do not do advanced
  geometry work such as converting shapes to paths or merging paths.
- `shortenIds` is off by default because some downstream consumers key off
  specific ids.
- Removing `width`/`height` is opt-in and only happens when a `viewBox` exists.
- The contrast check compares the set of flat, fully opaque colors used in the
  document. It cannot know the background an icon will sit on, so it reports
  low-contrast pairs rather than judging any single color.
- Files over 5 MB are refused so the browser stays responsive.

## Privacy

Everything runs locally in your browser. The SVG is parsed, optimized and
audited in memory; nothing is uploaded, no network requests are made, and
nothing is stored. `privacy.dataUploaded` is `false` and `privacy.storage` is
`none`. Downloads use local `Blob` URLs. Previews render the markup through an
object URL in an `<img>`, which does not execute scripts inside the SVG.

## Browser requirements

A modern browser with `FileReader`, `Blob`/`URL.createObjectURL`, and the
Clipboard API (used only for the optional Paste/Copy buttons, with a manual
fallback). Works offline.

## Technical notes

The core logic lives in `tool.js`, a dependency-free UMD module that exposes
`window.Toolshed.svgOptimizer` in the browser and `module.exports` in Node for
the test suite. It contains:

- a small, strict XML/SVG parser that builds a lightweight node tree;
- the optimization passes, which walk and rewrite that tree;
- serializers for compact and pretty output;
- the color/contrast math and the audit.

The page shell (`index.html`) wires the UI to the core and is the only place
that touches the DOM. All user-provided content is treated as untrusted: the
UI builds DOM nodes with `textContent` rather than `innerHTML`, and the core
never uses `eval` or any dynamic code execution. Run the tests with
`node tools/svg-optimizer/tests/run.js`.
