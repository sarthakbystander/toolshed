# Design Token Studio

Parse, normalize, inspect and convert design tokens without leaving the
browser. Paste DTCG JSON, flat JSON, CSS custom properties, SCSS variables or
Less variables; the studio resolves every alias, flags broken and circular
references, checks WCAG contrast, and exports the set to eight target formats.

Design tokens are the single source of truth for a product's colors, spacing,
radii, type scale and more — but they are usually spread across a DTCG file, a
`tokens.css`, a Sass partial and a Tailwind config that quietly drift apart.
This tool gives you one place to see what the tokens actually resolve to and to
move them between formats safely.

## What it does

- **Reads four input formats** — DTCG JSON (`$value` / `$type` / `$description`
  with nested groups), flat or nested plain JSON, CSS custom properties
  (`--name: value` inside a `:root` block or bare), SCSS variables (`$name`) and
  Less variables (`@name`). The format is auto-detected, and can be forced.
- **Normalizes values** — colors are parsed from `#rgb`, `#rgba`, `#rrggbb`,
  `#rrggbbaa`, `rgb()` / `rgba()` and `hsl()` / `hsla()` in both comma and
  space syntax, and shown as a swatch with their canonical hex. Dimensions,
  unitless numbers, and other values are classified too.
- **Resolves aliases** — `{color.brand}` (DTCG) and `var(--color-brand)` (CSS)
  references resolve transitively to a literal value, so
  `color-accent → color-brand → #b3402a` collapses cleanly.
- **Finds problems** — broken references (pointing at a name that does not
  exist), circular references, and duplicate token names are reported as
  issues instead of throwing. The raw value is preserved so you can still
  export and fix it.
- **Checks contrast** — pick any two color tokens (or white/black) and get the
  WCAG 2.1 contrast ratio with AA / AAA / AA-Large verdicts. Translucent
  foregrounds are composited over the background before measuring.
- **Exports eight formats** — plain JSON, DTCG, CSS custom properties, SCSS,
  Less, Tailwind `theme.extend`, a Swift/UIKit enum, and Android
  `res/values` XML. Aliases are re-expressed as `var(--…)`, `$…` or `@…`
  references where the target language supports them.
- **Filters and groups** — search by name, group, value or type, filter by
  inferred kind, and browse the set grouped by name prefix.

## How to use it

1. Paste tokens into the **Token source** box, or click **Load sample** to see a
   small DTCG set immediately. The format is auto-detected; override it with the
   **Input format** select if needed.
2. The **Analysis** pane updates as you type and summarizes token counts plus
   any reference issues.
3. Browse the **Tokens** pane to inspect each value, its swatch, its aliases and
   how many other tokens use it.
4. Use the **Contrast checker** to test a text/background pair.
5. Pick a format in **Export**, tweak the JSON key style or nesting, then
   **Copy** or **Download** the result.

## Supported input

### DTCG JSON

```json
{
  "color": {
    "$type": "color",
    "brand": { "$value": "#b3402a", "$description": "Primary brand" },
    "surface": { "$value": "#fbf8f1" }
  },
  "space": { "$type": "dimension", "md": { "$value": "8px" } }
}
```

Nested groups become dash-separated names (`color-brand`, `space-md`).
`$type` and `$description` are inherited by descendants and carried through to
the DTCG export.

### Flat JSON

```json
{
  "color-brand": "#b3402a",
  "color-brand-strong": "{color.brand}",
  "space-md": "8px"
}
```

An array of `{ "name", "value" }` objects is also accepted.

### CSS / SCSS / Less

```css
:root {
  --color-brand: #b3402a;
  --color-brand-strong: var(--color-brand);
  --space-md: 8px;
}
```

The same declaration parser handles `$name: value;` (SCSS) and `@name: value;`
(Less), including comments (`//` and `/* */`), quoted strings and nested
`{ }` blocks (the block path becomes the group).

## Reference resolution

A reference is either a DTCG brace reference (`{color.brand}`) or a CSS custom
property (`var(--color-brand)`). Names are compared after stripping a leading
`--`, `$` or `@` and turning dots into dashes, so `{color.brand}` and
`var(--color-brand)` address the same token.

Resolution is transitive and cycle-safe. A reference that points at a missing
name is reported as a broken reference; a reference chain that loops is
reported as circular. In both cases the affected token keeps its raw value in
the export.

## Limitations

- Only literal colors, dimensions, unitless numbers and plain strings are
  classified. Composite DTCG types (`typography`, `shadow`, `border`,
  `gradient`, `transition`) are treated as opaque strings and exported verbatim
  — the studio does not decompose them.
- Color parsing covers hex, `rgb()`/`rgba()` and `hsl()`/`hsla()`. Named CSS
  colors, `lab()`/`lch()`/`oklch()`, `color-mix()` and relative color syntax are
  not resolved and fall through as `other` values.
- The Tailwind and JSON nested exports namespace by the first dash segment, so
  `color-brand` becomes `color.brand`. When a leaf and a group share a name
  (both `color-brand` and `color-brand-strong`), the leaf value is kept under a
  `_value` key rather than being dropped.
- Export ordering is deterministic (groups and names sorted), which may differ
  from the order tokens appeared in the source.
- Duplicate names are kept once; later definitions are ignored and reported.

## Privacy

Everything runs locally in your browser. Tokens are parsed, resolved and
serialized in memory; nothing is uploaded, and nothing is written to
`localStorage`, `sessionStorage` or `indexedDB`. There are no network requests
of any kind. The Clipboard API is used only when you click a **Copy** button,
and the File/Blob API only when you click **Download**.

## Browser requirements

A modern evergreen browser with `Blob`, `URL.createObjectURL` and the Clipboard
API. The tool works offline and needs no build step.

## Implementation notes

The parsing, resolution, color and serialization engine is a dependency-free
UMD module (`window.Toolshed.designTokenStudio` in the browser,
`require("../tool.js")` in Node) so the same code powers the page and the test
suite in `tests/run.js`. The UI builds every result with DOM nodes and
`textContent` — no `innerHTML` and no `eval` — so arbitrary token values are
rendered safely.
