# Color Converter

Convert colors between HEX, RGB and HSL, right in your browser, with a live preview.

## What it does

- **Convert** between HEX, RGB and HSL in any direction
- **Preview** — a live swatch shows the color as you type
- **Edit** — type any supported format; see all three representations update instantly
- **Copy** — click any converted value to copy it
- **Quick swatches** — tap a preset color to try the tool instantly
- **Reset** — return to the default color

## Supported input formats

- `#rgb` and `#rrggbb` (hash optional)
- `rgb(r, g, b)` — values are clamped to 0-255
- `hsl(h, s%, l%)` — hue in degrees, saturation and lightness as percentages
- A few common named colors (red, blue, green, black, white, etc.)

## How it works

As you type, the tool validates the color and shows the matching HEX, RGB and HSL
representations side by side, plus a preview swatch. Invalid input produces a clear
error instead of silently guessing.

## Privacy

Everything runs locally in your browser. No input is ever sent anywhere, and
nothing is stored.

## Limitations

- Uses the sRGB gamut; no CMYK, LAB or color-profile conversion yet.
- Named colors are limited to a common subset.
- Alpha channels are accepted and ignored (output has no alpha).
