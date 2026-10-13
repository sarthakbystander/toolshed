# Image Metadata Inspector

See everything a photo reveals about you — and strip it out — without the file
ever leaving your browser. Drop in a JPEG, PNG, WebP or GIF and get a
plain-language privacy report, a full breakdown of every embedded metadata
block, and a one-click way to download a clean copy.

## Why use it

Photos routinely carry far more than pixels: the camera's make and model, a
serial number, the exact time and place they were taken, and an editing history.
That metadata is invisible in most viewers, and it travels with the file when you
post it, email it or hand over a device. This tool makes that hidden data visible
and lets you remove it — locally, with no upload and no account.

## What it does

- **Privacy exposure report** — a weighted score (clean / low / medium / high)
  that flags GPS coordinates, camera serial numbers, identity tags and other
  identifying fields, each explained in plain language.
- **Full metadata breakdown**, grouped into tabs:
  - **EXIF** — IFD0, the Exif sub-IFD, GPS, interoperability and thumbnail
    blocks, with every tag shown by name, type and value.
  - **XMP** — the parsed RDF tree, including `Bag`, `Seq` and `Alt` containers
    and the namespaces used.
  - **IPTC / Photoshop IRB** — records and datasets (caption, credit, keywords).
  - **ICC** — whether a colour profile is embedded and how large it is.
  - **Container** — the actual segment/chunk layout (JPEG segments, PNG chunks,
    WebP chunks and features, GIF blocks) plus PNG/GIF text comments.
  - **Text report** — a copyable, downloadable plain-text summary.
- **Strip & download** — rebuilds the file from its image data only, removing
  EXIF, GPS, XMP, IPTC, ICC and comments, and downloads the cleaned copy. The
  original on disk is never touched.
- **Privacy card** — a self-contained, script-free SVG summarising what the
  image exposes, handy to share without sharing the photo.
- **Sample files** — one-click synthetic JPEG/PNG/WebP/GIF samples so you can
  explore the tool (and its GPS/privacy scoring) with no file at hand.

## How to use it

1. Drop an image onto the drop zone, click it to browse, or press one of the
   **Sample** buttons. Nothing is uploaded — the file is read with the
   `FileReader` API and parsed in memory.
2. Read the privacy exposure panel first. If GPS or a serial number shows up,
   the image is worth stripping before you share it.
3. Switch between the metadata tabs to see exactly what is embedded.
4. Click **Strip & download** to get a cleaned copy. The status line reports
   which segments were removed and the size change.

## Supported inputs

| Format | Metadata read |
| --- | --- |
| JPEG | EXIF (IFD0, Exif, GPS, Interop, IFD1 + thumbnail), XMP, IPTC/Photoshop IRB, ICC, comments |
| PNG | IHDR dimensions, `tEXt`/`zTXt`/`iTXt` text chunks, `eXIf`, `iCCP`, XMP |
| WebP | VP8X canvas and feature flags, EXIF, XMP, ICC, animation/alpha metadata |
| GIF | version, logical-screen dimensions, comment extensions, XMP application blocks |

## How it works

`tool.js` is a dependency-free UMD module — it loads as
`window.Toolshed.imageMetadataInspector` in the browser and via `require()` in
Node for the test suite. It is a hand-written container parser, not a wrapper
around a library:

- **Format detection** sniffs the JPEG SOI marker, the PNG signature, the
  `RIFF....WEBP` header and the `GIF87a`/`GIF89a` signatures.
- **Container walking** reads JPEG markers (skipping entropy-coded scan data),
  PNG chunk lengths/CRCs, RIFF chunks and GIF blocks, tolerating truncation.
- **EXIF** is a self-contained TIFF reader that honours both endiannesses,
  walks the IFD chain, decodes the standard IFD entry types (BYTE/SHORT/LONG/
  RATIONAL/ASCII/UNDEFINED/SLONG/SRATIONAL) and resolves GPS DMS rationals to
  signed decimal degrees.
- **XMP** is parsed with a small non-validating XML tree builder, then mapped to
  a flat property list, collapsing `rdf:Bag`/`rdf:Seq`/`rdf:Alt` to arrays.
- **IPTC** decodes the 0x1C record/dataset stream; **ICC** reads the profile
  header and description tag.
- **Stripping** rebuilds the container from non-metadata segments only. It is
  deliberately conservative: if the structure cannot be rebuilt without risking
  the image data, it returns an error rather than guessing.
- **Safety:** the module never decodes pixels, never uses `eval` or dynamic code
  execution, never touches the network or storage, and never writes metadata
  into the DOM with `innerHTML` — the UI builds nodes with `textContent`.

Every parser is defensive: a malformed offset, out-of-range length or truncated
segment produces a warning that is shown in the UI, never an uncaught exception.

## Privacy

Everything runs locally in your browser. No image, byte or derived value is ever
uploaded, no network request is made, and nothing is stored. The metadata is read
from the file's own bytes in memory and discarded when you close the tab.
`privacy.dataUploaded` is `false` and `privacy.storage` is `none`.

## Limitations

- Only JPEG, PNG, WebP and GIF are recognised. HEIC/RAW/TIFF files are rejected
  with a clear message rather than guessed at.
- XMP is parsed by a small tree builder, not a validating XML parser; exotic or
  deeply nested packets may be flattened more than a full RDF processor would.
- EXIF MakerNotes (vendor-specific private blocks) are located but not decoded
  field by field.
- Stripping removes metadata segments; it does not re-encode pixels, so image
  data is preserved bit-for-bit.
- A few unusual containers (for example JPEGs with restart markers inside
  metadata scans) may produce warnings; the tool reports what it could not read
  instead of failing silently.

## Browser requirements

Any modern browser with `FileReader`, `Uint8Array`, `Blob` and
`URL.createObjectURL` support. The tool works offline and needs no network.

## Tests

`tests/run.js` is a plain Node script using `assert`, run by `npm run test:tools`.
It exercises the real parsing and stripping code paths against synthetic files
built by the module itself, plus hand-crafted and malformed inputs: endianness
handling, GPS resolution, XMP containers, IPTC truncation, ICC signatures,
strip determinism and non-mutation, one-megabyte PNGs, and random-byte fuzzing.
