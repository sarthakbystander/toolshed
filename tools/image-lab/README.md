# Image Lab

Adjust brightness, contrast, saturation, blur and sharpen on your
images, right in the browser. No uploads, no accounts — every pixel is
processed on your device.

## What it does

- **Open an image** — pick a file or drag-and-drop one onto the canvas. JPG, PNG, WebP and GIF (first frame) are all supported via the browser's image decoder
- **Live adjustments** — brightness, contrast, saturation, blur and sharpen sliders, applied as you move them
- **Preset filters** — one-click grayscale and sepia toning, baked into the working image
- **Before / after** — toggle to view the untouched original at the same size and zoom, then toggle back to the edited frame
- **Zoom to fit** — scale the preview down to the pane, or show it at 1:1
- **Export** — download the result as PNG (lossless) or flattened JPEG, rendered at full resolution
- **Reset** — return every slider to neutral (does not undo grayscale/sepia)

## How it works

The image is decoded to raw RGBA pixels on a hidden canvas. Pixel
operations (brightness, contrast, saturation, blur, sharpen, grayscale,
sepia) run in `tool.js` — a dependency-free UMD module that exports pure
functions over `Uint8ClampedArray` RGBA buffers, row-major. The three
adjustment stages are:

1. **Brightness / contrast / saturation** — a combined luminance-aware pass.
   Contrast uses the classic `(259*(c+255))/(255*(259-c))` factor so that mid-gray
   stays put; saturation interpolates each channel toward the perceived luminance.
2. **Blur** — a box blur (radius 0–20 px from the UI, clamped to 50 in the
   core) implemented as two separable passes, horizontal then vertical,
   averaging RGB and A over a sliding window. Both passes are O(width × height)
   regardless of radius. It never leaks pixels across the edges — borders
   clamp to the image.
3. **Sharpen** — an unsharp-style pass that subtracts a scaled Laplacian toward
   each pixel's neighbors. The UI maps its 0–100 slider to an amount of 0–1.
   Border pixels clamp to the edge, so no dark rim appears.

For large images the live preview runs on a downscaled copy (capped at
1600 px on the longest side and 2.5 megapixels) so slider edits stay
responsive; the pane reports both the source and preview dimensions.
Exports always re-run the adjustments at full resolution.

Export uses the browser's canvas to encode PNG/JPEG. Nothing is sent
over the network — downloads use a local `Blob` URL, and the image never
leaves the tab.



## Privacy

Everything runs locally in your browser. No input image is ever uploaded, no
network requests occur, and nothing is stored. `privacy.dataUploaded` is `false`.

## Limitations

- Very large images are downscaled for the live preview, so the pane shows an
  approximation while you tune the sliders. The exported file is always
  rendered from the full-resolution source.
- The blur radius is capped at 20 px in the UI and 50 px in the core. Preview
  and export are computed at their own resolutions, so one radius value covers
  more of the source image than of the downscaled preview.
- GIFs decode to their first frame only, and animated formats are not
  supported - you get a static result.
- HEIC/RAW formats depend on browser codec support and may not decode in all cases.
- JPEG export flattens transparency; use PNG to keep alpha.

## Browser requirements

A modern browser with Canvas 2D and `URL.createObjectURL` support. Works offline.
