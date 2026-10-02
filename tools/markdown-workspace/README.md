# Markdown Workspace

Write, preview and sanity-check Markdown in one place, entirely in your browser.

## What it does

- **Live preview** — a safely-rendered HTML preview that updates as you type.
- **Outline** — an indented list of every heading (ATX and setext); click one to jump to it in the preview.
- **Statistics** — words, characters, lines, reading time, heading levels, links, images, tables, task-list progress, fenced code blocks and the languages used.
- **Health check** — flags common Markdown problems: heading-level jumps, more than one H1, unclosed fenced code blocks, repeated headings, images without alt text, unused link reference definitions and trailing whitespace.
- **Cleanup** — optional normalization passes (trim trailing spaces, collapse blank lines, space after `#`, unify list bullets, blank lines around headings, ensure a final newline) that you can apply to the source or copy out.
- **File handling** — open a local `.md`/`.txt` file (or drag one onto the editor) and save the source back out as `document.md`.
- **Copy** — copy the raw source, the cleaned source, or the rendered HTML.

## Why use it

It is a private scratchpad for Markdown: drafts, README files, changelog entries,
issue descriptions, documentation snippets. You get the feedback a good editor
gives you — rendered output, structure, stats, and warnings about mistakes —
without signing in to anything or shipping your text to a service.

## How to use it

1. Type or paste Markdown into the left pane, or press **Load sample** to see a
   worked example.
2. Use the tabs on the right to switch between **Preview**, **Outline**,
   **Stats** and **Health**. The Health tab shows a count badge when it finds
   something.
3. To tidy the source, open **Cleanup & normalization**, tick the passes you
   want, then **Clean up source** (rewrites the editor) or **Copy cleaned
   source** (leaves the editor alone).
4. **Open file** loads a local file; **Save .md** downloads the current source.

## Supported syntax

A conservative, self-contained Markdown subset:

- ATX headings (`#`…`######`) and setext headings (`===`, `---`)
- Bold, italic, bold-italic, strikethrough, and backslash escapes
- Inline code and fenced code blocks (backtick or tilde fences, optional language)
- Links (inline, reference, and bare `http(s)`/`mailto` autolinks), images, and titles
- Ordered, unordered and nested lists, including task list items (`- [x]`)
- Blockquotes, horizontal rules, and GitHub-style tables with column alignment
- Hard line breaks (two trailing spaces)

Raw HTML in the source is **not** executed or rendered as markup — it is shown as
literal, escaped text. This is deliberate: the preview is safe by construction.

## Privacy

Everything runs locally in your browser. Nothing is uploaded, there are no
network requests, no accounts, no analytics, and nothing is written to storage.
The page uses no external scripts. The only I/O is the file you choose to open
and the file you choose to download, both handled by browser APIs on your device.

## Limitations

- The renderer implements a deliberately small, CommonMark-flavoured subset, not
  the full specification. Footnotes, definition lists, math, MDX/JSX and
  raw-HTML passthrough are not supported (raw HTML is escaped on purpose).
- Reference-style links are recognised by the renderer for the subset it
  supports; the health check reports definitions that appear unused.
- Very large documents (over 2 MB) are rejected to keep the tab responsive.
- Downloading uses a generated Blob URL rather than the File System Access API,
  so it works in every browser without a permission prompt.

## Tests

`tools/markdown-workspace/tests/run.js` is a plain Node script (no dependencies)
that exercises the rendering, outline, analysis, cleanup and security behaviour,
including malformed input, empty input, unclosed fences, scheme smuggling and
attribute-escaping cases. Run it from the repository root with:

```bash
npm run test:tools
```
