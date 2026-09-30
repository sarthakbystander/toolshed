# File Integrity Auditor

Verify a set of files against a checksum manifest and see exactly which ones
match, which were modified, and which are missing. Everything is hashed and
compared locally in your browser — no files are uploaded.

## What it does

`sha256sum -c` and friends are great, but they live on the command line. This
tool does the same job in the browser: paste or drop a manifest, pick the files
you have, and get a per-file verdict.

- **Manifest parsing** — reads GNU coreutils output (`sha256sum`, `md5sum`,
  `sha1sum`, `sha384sum`, `sha512sum`), BSD/`--tag` output
  (`SHA256 (file) = digest`), RFC 9530 HTTP `Content-Digest` values
  (`sha-256=:base64:`), plain `digest  filename` lists, and two-column CSV.
- **Mixed algorithms in one manifest** — each line's algorithm is detected from
  its label or, when unlabelled, from the digest length. A single audit can
  verify MD5 and SHA-256 entries side by side.
- **Five algorithms** — MD5, SHA-1, SHA-256, SHA-384 and SHA-512. SHA-* come
  from the browser's Web Crypto; MD5 uses a bundled RFC 1321 implementation so
  it works even where Web Crypto has no MD5.
- **Folder support** — pick a folder (or drop one) and the tool walks the
  files it contains. Manifest entries are matched on relative path first, then
  on basename.
- **Extra-file detection** — optionally flag files you supplied that the
  manifest does not mention, which is how you catch files that were added.
- **Reports** — download the results as CSV or as a plain-text report.
- **Progress and filtering** — a progress bar while hashing, and status chips
  to filter the table to mismatches, missing files, and so on.

## How to use

1. Paste a manifest into the **Manifest** pane, or drop/choose a manifest file.
   **Load sample manifest** fills in a working example.
2. Choose the files to check in the **Files** pane — **Choose files**,
   **Choose folder**, drag and drop, or **Load sample files**.
3. Click **Run audit**. Results appear per manifest entry, with a summary of
   OK / MISMATCH / MISSING / EXTRA / UNKNOWN counts.
4. Filter the table by status, and download a CSV or text report if you want to
   keep the result.

## Status meanings

| Status | Meaning |
| --- | --- |
| **OK** | The file's digest matches the manifest. |
| **MISMATCH** | The file was found, but its digest differs — it was modified or corrupted. |
| **MISSING** | The manifest lists the file, but it was not among the files you supplied. |
| **EXTRA** | You supplied the file, but the manifest does not list it (optional, on by default). |
| **UNKNOWN** | The entry could not be verified — for example a digest-only record with no file name, or an algorithm the browser cannot compute. |

## Supported manifest formats

```
# GNU coreutils (text and binary mode markers)
36543cf81c9fc03bc42bf729d3d7da7f  readme.txt
ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad *logo.png

# BSD / --tag
SHA256 (server.py) = 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae

# RFC 9530 HTTP Content-Digest
sha-256=:YOnHp7dT6j8SLJPAdM8J3pAxFmuV/THhYAVGqoOkm9E=:

# CSV (either column order)
file.txt,36543cf81c9fc03bc42bf729d3d7da7f
```

Comment lines (`#`) and blank lines are ignored. Unlabelled digests are
identified by length: 32 = MD5, 40 = SHA-1, 64 = SHA-256, 96 = SHA-384,
128 = SHA-512. GNU coreutils backslash escapes (used for newlines and
backslashes in file names) are not decoded; such names are matched literally.

## Privacy

Files are read with the browser's File API and hashed in memory. The tool makes
no network requests, uploads nothing, and writes nothing to storage — no
`localStorage`, no cookies, no analytics. Close the tab and everything is gone.
Reports are generated locally and saved with a `Blob` download.

## Limitations

- Files are matched by name, not by content hash. If two supplied files share a
  basename in different folders, the entry is reported as ambiguous rather than
  guessed.
- Matching prefers the full relative path when the browser supplies one
  (folder selection), and falls back to the basename.
- Files are read fully into memory before hashing, so very large files consume
  proportionate memory.
- Folder selection uses the non-standard `webkitdirectory` attribute; it is
  supported by current Chrome, Edge, Firefox and Safari. Single-file and
  drag-and-drop selection work everywhere.
- SHA digests require Web Crypto. If a browser cannot compute one, the affected
  entries are reported as UNKNOWN and the status line explains why.

## Technical notes

- `tool.js` follows the Toolshed UMD pattern: it loads as
  `window.Toolshed.fileIntegrityAuditor` in the browser and via `require()` in
  Node for tests. It has no dependencies.
- Core exports: `md5`, `md5Create`, `digest`, `shaFallback`, `hashBytes`,
  `canonicalAlgorithm`, `algorithmInfo`, `algorithmFromLength`,
  `normalizeDigest`, `parseManifest`, `parseManifestLine`, `audit`, `toCsv`,
  `toReport`.
- `hashBytes(bytes, algorithms, options)` hashes one buffer for several
  algorithms at once and reports progress through `options.onProgress`.
- `audit(files, entries, options)` returns `{ rows, summary }`, where each row
  carries `status`, `filename`, `expected`, `actual`, `algorithm`, `note` and
  the source `line`.
- Tests live in `tests/run.js` and are run by `npm run test:tools`. They cover
  the RFC 1321 and NIST digest vectors (including the one-million-character
  vector), incremental MD5 against one-shot MD5 across awkward chunk sizes,
  manifest parsing across all supported formats, ambiguous and missing files,
  extra-file detection, CSV escaping, and report generation.
