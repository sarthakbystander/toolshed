# Archive Inspector

Open a **ZIP**, **GZIP** (`.gz`, `.tgz`) or **TAR** archive and see exactly what
is inside it — every entry, the real uncompressed size, compression ratio, the
file-type mix, checksum status and a list of safety findings. Everything is read
locally in your browser tab; no file is ever uploaded.

## Why use it

Archives are opaque. Before you extract one you often want to know: what is
actually in here, how big will it become, is there anything suspicious, and did
the download survive intact? Archive Inspector answers those questions without
extracting anything to disk and without trusting the file to a website.

Typical uses:

- Check what a downloaded `.zip` really contains before opening it.
- Spot archive-based malware patterns: path traversal (`../`), absolute paths,
  executables, double extensions, nested archives and decompression bombs.
- Find duplicate entries that silently overwrite each other on extraction.
- Read the compressed size and ratio of a log or dataset archive to judge how
  much space it will take when unpacked.
- Preview a text file, JSON document or image straight from the archive.
- Export a manifest (JSON) or a flat file list (CSV) for a report.

## What it does

- **Detects the format** from the file signature: ZIP (including ZIP64),
  GZIP, TAR (ustar/GNU/PAX), and it recognises — but does not open —
  bzip2, XZ, 7-Zip and RAR so you get a clear message instead of a mystery.
- **Reads the full table of contents** without extracting the payload:
  names, sizes, compressed sizes, compression method, modification time,
  CRC-32 and encryption flag for ZIP; header name and mtime for GZIP; mode,
  owner and link target for TAR.
- **Computes summary statistics**: entry, file and folder counts, total
  uncompressed and packed size, space saved, largest file, deepest path and
  the number of duplicate paths.
- **Breaks files down by type** (by extension) with counts and byte totals.
- **Runs structural and safety checks** and ranks the findings by severity:
  - **high** — path traversal (`../`), absolute paths, names containing
    control characters;
  - **warning** — executables and scripts, duplicate entries, extreme
    decompression ratios (possible zip bombs);
  - **info** — encrypted entries, nested archives, entries with no extension,
    macOS junk (`__MACOSX`, `.DS_Store`, `._*`), very deep paths, very large
    expansions and ZIP64 metadata.
- **Previews an entry** without extracting the whole archive: text for
  text-like files, an inline image for PNG/JPEG/GIF/WebP/BMP/ICO/AVIF, and a
  clear notice for binary content.
- **Extracts a single entry** and offers it as a download, and verifies the
  stored CRC-32 so you can confirm the bytes are intact.
- **Exports** a full JSON report and a CSV file list.

## How to use it

1. Drop an archive onto the drop zone, click it, or press **Choose file**.
2. The overview appears first: format, size, counts, space saved and findings.
3. Use the **Contents** table to browse entries. Click a row to preview the
   file on the right, or use **Download entry** to save just that file.
4. Filter the table by name or extension with the filter box.
5. Use **Download report** (JSON) or **Download list (CSV)** to keep a record.

The **Try sample** button loads a small built-in ZIP (folders, text, JSON, a
PNG, a nested archive, an executable, macOS junk and a traversal entry) so you
can see how a report looks without having your own file to hand.

## Supported input

| Format | Detection | Entries read | Payload readable |
| --- | --- | --- | --- |
| ZIP (store + deflate, ZIP64) | `PK\x03\x04` / `PK\x05\x06` | yes | yes |
| GZIP (`.gz`, `.tgz`) | `1f 8b` | single member | yes |
| TAR (ustar / GNU / PAX) | `ustar` magic at offset 257 | yes | yes |
| bzip2, XZ, 7-Zip, RAR | signature | recognised only | no (clear message) |

ZIP entries using compression methods other than *store* and *deflate* are
listed but cannot be opened. Encrypted entries are listed and flagged but
cannot be read.

## Limitations

- **No BZIP2, XZ, 7-Zip or RAR support.** These need large decoder libraries;
  the tool reports them clearly instead of failing silently. (A `.tar.gz` is
  fully supported — that is a GZIP wrapping a TAR.)
- **Only the first GZIP member is read.** Multi-member GZIP files are rare.
- **Deflate only, not deflate64.** A handful of very old ZIPs use deflate64;
  those entries are listed but not decodable here.
- **No writing.** This tool only reads archives. It never modifies your file.
- Files above 512 MB are refused so a tab cannot run out of memory.
- The entries table shows the first 800 rows; use the filter to narrow it.

## Privacy

Everything happens in your browser using the Web platform's `FileReader`,
`Blob` and `URL.createObjectURL`. **No file data, name or content is sent
anywhere**, there is no network request of any kind, and nothing is stored —
not even in `localStorage`. Close the tab and it is gone.

`privacy.dataUploaded` is `false` and `privacy.storage` is `none` for this
reason.

## Implementation notes

- The parsing core lives in `tool.js` as a dependency-free UMD module
  (`window.Toolshed.archiveInspector` in the browser, `require()` in Node).
  The page's own UI logic sits inline in `index.html`, matching the other
  Toolshed tools.
- **DEFLATE is decoded in-house.** `tool.js` includes a small inflate
  implementation ported from Mark Adler's public-domain `puff` reference, so
  the tool has no third-party dependency and decompresses entries directly.
  GZIP and ZIP both feed into it.
- CRC-32 (IEEE) is computed in the core and used both to verify entry payloads
  and to validate the GZIP trailer.
- All rendering is done with DOM nodes and `textContent`; archive entry names
  and previews are treated as untrusted and never injected as HTML. There is
  no `eval`, no `innerHTML` for user data, and no remote code.
- Path handling normalises `\` to `/` and detects traversal, absolute paths
  and control characters before anything is shown or extracted.

## Browser requirements

Any modern evergreen browser (Chrome, Edge, Firefox, Safari). It needs
`FileReader`, `Blob`, `URL.createObjectURL`, `TextDecoder` and `atob`, all of
which are widely available. It works fully offline.

## Tests

`tests/run.js` is a plain Node script (`node tools/archive-inspector/tests/run.js`,
also run by `npm run verify`). It builds ZIP, GZIP and TAR fixtures in-process —
no binary test assets and no dependencies beyond `node:zlib`, which is used
only to *produce* fixtures the tool then decodes with its own inflate. It
covers format detection, CRC-32 vectors, inflate (stored, fixed and dynamic
blocks, large streams, corruption), ZIP parsing and extraction, GZIP, TAR
(including symlinks and PAX), safety findings, previews, hostile entry names
and payloads (traversal, control characters, markup-looking content), empty
and malformed input, and a large-archive performance check.
