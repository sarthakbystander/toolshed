# Certificate Inspector

Read an X.509 certificate or a PKCS#10 certificate signing request, understand
what it actually claims, check a chain and its signatures, and export a JSON
report — all in the browser, without sending the certificate anywhere.

A certificate is DER-encoded ASN.1: a nested structure that is unreadable until
something decodes it, and `openssl x509 -text` is not always at hand. This tool
parses the structure directly in JavaScript, turns it into a readable report,
and reviews it against the checks a reviewer would run by hand. It also builds
and verifies a chain, so you can confirm that a leaf really was signed by the
intermediate you think it was.

## Why use it

- **Debug a TLS failure.** Paste the certificate your server is presenting and
  read its validity window, its `subjectAltName` entries, its key usage and its
  issuer — the fields that decide whether a handshake succeeds.
- **Check what a chain really is.** Paste a bundle in any order; the tool
  reorders it into a leaf-to-root chain by authority key identifier and verifies
  each link's signature.
- **Review a request before it is signed.** A CSR carries the subject, the
  public key and the extensions the requester is asking for. See them, and see
  whether the request asks for something a CA should refuse.
- **Audit certificate hygiene.** Spot a SHA-1 signature, a 1024-bit RSA key, an
  expired date, a CA flag on a leaf, a lifetime longer than 398 days, or a
  missing revocation endpoint.
- **Produce a report.** Copy or download the parsed certificate as JSON to
  attach to a ticket or feed into a script.

## How to use it

The page is a single scroll with numbered sections.

1. **Input** — paste one or more PEM blocks, a PEM chain in any order, raw DER
   as Base64, or raw DER as hex. Or drop a file onto the pane, or use
   *Choose a file…*. Three sample buttons load a complete three-certificate
   chain, an expired certificate, and a certificate request.
2. **Parsed blocks** — one entry per certificate or request found in the input,
   with its common name, validity state and key size. Select one to inspect it.
   A bundle is parsed block by block; a single broken block is reported without
   discarding the rest.
3. **Overview** — kind, version, serial number, validity window with a progress
   bar, subject, issuer, CA status, public key, signature algorithm, key usage,
   extended key usage, subject alternative names, key identifiers and the
   SHA-1/256/384/512 fingerprints. Copy or download the JSON report here.
4. **Security review** — a levelled list of findings (error, warning, note) for
   the selected item.
5. **Extensions** — every extension with its critical flag, decoded value and
   OID. For a CSR this is the requested extension set.
6. **Chain & signatures** — the certificates ordered into a chain, with each
   link's signature checked against the issuer's key by the Web Crypto API.
7. **X.509 reference** — the concepts the report relies on, in one place.

`Ctrl`/`Cmd` + `Enter` re-parses the input from anywhere on the page.

## Supported inputs

| Input | Accepted as |
| --- | --- |
| PEM | One or more `-----BEGIN CERTIFICATE-----` / `-----BEGIN CERTIFICATE REQUEST-----` blocks, in any order, concatenated or separated by blank lines |
| Raw DER | Base64 of the DER bytes, or hex (whitespace and `:` separators are ignored) |
| Files | Dropped or chosen: `.pem`, `.crt`, `.cer`, `.der`, `.csr`, `.req`, `.txt`. A binary DER file is detected by its leading `0x30` SEQUENCE tag and converted automatically |

Parsed structures include: `subject`, `issuer`, `validity`, `publicKey`
(RSA and EC, with modulus/exponent or named curve), `signatureAlgorithm`,
`signatureHash`, `serialNumber`, `extensions` — basic constraints, key usage,
extended key usage, subject alternative name, subject and authority key
identifier, authority information access, CRL distribution points and
certificate policies, among others — plus SHA-1/256/384/512 fingerprints.

## What it deliberately does not do

- It does not **read private keys**. A `-----BEGIN PRIVATE KEY-----` block is
  detected and refused, so a private key pasted by mistake is not decoded or
  displayed. Mixed input keeps the certificates and skips the key.
- It does not **fetch anything**. It will not download an issuer certificate
  from an AIA URL, fetch a CRL or OCSP response, or resolve a hostname.
- It does not **check revocation**. It shows you the CRL and OCSP endpoints that
  the certificate advertises; asking them is left to you.
- It does not **decide whether a certificate is trusted**. A valid signature
  proves only that the issuer signed it. Whether that issuer is one your system
  trusts is a question about your trust store, not about the certificate.
- It does not **validate hostnames**. It shows the `subjectAltName` values; the
  matching rules against a hostname are not applied here.
- It does not **parse every extension**. Unknown extensions are shown by OID and
  name with their raw value, rather than guessed at.

## Security review checks

For a certificate:

- Expired, not yet valid, or an inverted validity window.
- A remaining lifetime of 30 days or less (expiring soon).
- A validity window longer than 398 days (the browser CA/Browser Forum cap).
- MD2, MD5 or SHA-1 signature hashes; unrecognised signature algorithm OIDs.
- RSA keys under 1024 bits (error), under 2048 bits (error), under 3072 bits
  (note); EC curves under 224 bits (error) or under 256 bits (warning); DSA keys
  and unrecognised key types.
- A CA certificate whose key usage omits `keyCertSign`.
- No revocation endpoint advertised.
- A leaf with no subject alternative name.

For a request: no subject alternative name requested, and a request that asks
for CA basic constraints.

The review is guidance about the certificate's own contents. It is not a
substitute for a full validation path.

## Implementation notes

All logic lives in a dependency-free UMD module (`window.Toolshed.certificateInspector`
in the browser, `require("../tool.js")` in Node), so the page and the test suite
exercise exactly the same code.

- **ASN.1 DER reader.** A small recursive-descent parser handles the definite
  length form, including multi-byte lengths, and rejects truncated or malformed
  input with a specific error rather than a stack trace.
- **Deterministic.** The same bytes always produce the same report. The parser
  never touches the network, never writes to storage, and never uses `eval` or
  any other dynamic code execution.
- **Cryptography.** Fingerprints and key identifiers use the Web Crypto API
  (`crypto.subtle.digest`) in the browser, with a Node `crypto` fallback used
  only by the test suite. Signature verification uses `crypto.subtle.verify`
  with an imported SPKI public key; ECDSA signatures are converted from the DER
  form a certificate carries to the raw `r‖s` form Web Crypto expects.
- **Chain building.** Issuers are matched by authority key identifier first,
  then by subject/issuer name, which is why a bundle in any order is ordered
  correctly and why a reissued CA with the same subject still links up.
- **Rendering.** Every result is built from DOM nodes and `textContent` — no
  `innerHTML` — so a certificate whose subject or SAN contains markup is shown
  as text and never interpreted.

## Testing

`node tools/certificate-inspector/tests/run.js` runs the suite with plain
`assert`, no test framework. Fixtures are throwaway certificates and requests
in `tests/fixtures.js`; their private keys were never committed and are not
needed to parse or inspect them. The suite covers parsing of certificates,
requests and chains; RSA and EC public keys; every extension the parser knows;
fingerprints checked against OpenSSL's own output; the security review for
expired, not-yet-valid, expiring, SHA-1 and self-signed cases; malformed and
truncated DER; a PEM block that contains markup; a very long SAN list; chain
ordering from a shuffled bundle; signature verification for RSA, ECDSA and CSR
self-signatures; a deliberate key/algorithm mismatch; and determinism across
repeated runs.

The fixtures were generated once with OpenSSL 3.x (a root, an intermediate, a
leaf, an expired certificate, a not-yet-valid certificate, a SHA-1 certificate,
a wildcard certificate, an EC leaf, an EC self-signed certificate, a CSR and a
CSR with a SAN). Regeneration commands are recorded in the commit that added
them; OpenSSL is not a runtime or test dependency.

## Privacy

Everything runs locally in your browser. Certificates and requests are held in
memory, used only for parsing and Web Crypto operations, and never uploaded.
There are no network requests of any kind, no analytics, and nothing written to
`localStorage`, `sessionStorage` or `indexedDB` — reloading the page loses your
input. The Clipboard API and the download link are used only when you click the
corresponding button. A certificate is public by design, but it may still reveal
internal hostnames or an organisation's structure, so be mindful of where you
paste it.

## Browser requirements

A modern evergreen browser with the Web Crypto API (`crypto.subtle`), available
over HTTPS and on `localhost`/`file:`. Parsing is synchronous and instant for
typical certificates. Signature verification is asynchronous and shows a
pending state on the button while the promise settles. No canvas, Web Workers,
external libraries or build step.
