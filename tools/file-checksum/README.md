# File Checksum

Compute SHA-1, SHA-256, SHA-384 and MD5 checksums for any file,
right in your browser. Files never leave your machine.

## What it does

- **Four algorithms** — SHA-1, SHA-256, SHA-384 come from the browser's
  Web Crypto, and MD5 comes from a dependency-free JavaScript implementation,
  so it works everywhere, including environments that do not expose MD5 via
  Web Crypto.
- **Pick any combination** — tick the algorithms you want before hashing;
  results are shown only for the selected ones.

- **Drag-and-drop or browse** — drop a file onto the dashed area, or click it
  to open your file picker. The **Try sample** button exercises the same flow
  without touching your disk.
- **Copy with one click** — each digest has a Copy button. Some browsers ask
  for clipboard permission the first time.
- **Clear** — wipes the selection, results, and status.



## How to use

1. Drag a file onto the dashed area, or click it to open your file picker.
2. Tick one or more algorithms (SHA-256 and MD5 are on by default).
3. Click **Hash file** (or just drop the file — dropping hashes immediately).
4. Read the digest values and copy any that you need.

## Accuracy

The core logic is covered by tests against the RFC 1321 MD5 test vectors
(including the empty string)and against Node's `crypto` for all four
algorithms on multi-megabyte random input. See `tests/run.js` for details.

## Privacy

Everything runs locally in your browser. No data is uploaded, sent, or
stored. Hashing happens entirely in your tab using the Web Crypto API (for
SHA-*) and an in-page JavaScript MD5 implementation. Clipboard writes are
local to your machine.

## Limitations

- Files are read fully into memory before hashing, so extremely large files
  (hundreds of MB) consume proportionate memory. For browsers this is
  effectively the same model used by the rest of Toolshed.
- SHA-* rely on your browser's Web Crypto implementation; very old browsers
  may not support all three variants, and will show an error. MD5 always
  works, including in Node and in browsers that do not expose it via Web Crypto.
- MD5 is intentionally implemented locally rather than via Web Crypto because
  the Web Crypto spec does not require MD5 support. Treat MD5 as a checksum
  for integrity verification, not as a collision-resistant cryptographic
  signature.

## Technical notes

- `tool.js` follows the Toolshed UMD pattern: it loads as
  `window.Toolshed.fileChecksum` in the browser and via `require()` in Node
  for tests.
- `compute(input, options)` accepts a `File`, `Blob`, string, `Uint8Array`,
  or `ArrayBuffer`, and returns `{ ok, digests, bytes }` or
  `{ ok: false, message }`. Digest keys are the canonical algorithm names:
  `"SHA-1"`, `"SHA-256"`, `"SHA-384"`, `"MD5"`.
- The MD5 implementation follows RFC 1321 exactly — padding, 64-round
  compression, and little-endian output — and is verified against the RFC's
  official test vectors in `tests/run.js`.