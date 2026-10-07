# JWT Inspector

Read a JSON Web Token, understand what it says, check whether its signature is
real, and build one of your own — all in the browser, without sending the token
or the key anywhere.

JWTs are opaque at a glance: three Base64url segments that most people paste
into a decoder and trust. This tool goes further. It decodes the header and
claims, turns the timestamp claims into dates, reviews the token for the
well-known mistakes (no expiry, `alg: none`, algorithm confusion, oversized
lifetimes), verifies the signature against a secret, a PEM key or a JWKS, and
can sign a fresh token with the same code path. Everything is client-side.

## Why use it

- **Debug an auth failure.** Paste the token a client sent and see its `exp`,
  `nbf`, `iss` and `aud` before you go digging through server logs.
- **Check a signature you received.** Confirm a token really was signed by the
  key you expect, against the exact original segments — the same thing a
  verifier does, without writing a throwaway script.
- **Review a token's hygiene.** Spot missing expiry, `alg: none`, a lifetime
  measured in years, or a claim that looks like it is carrying a password.
- **Create test fixtures.** Build a signed token with the right `iat`/`exp`
  window for a local handler or an integration test, using an HMAC secret or a
  generated key pair.
- **Understand the format.** The reference section spells out the structure,
  the signing input, the standard claims and the algorithms in one place.

## How to use it

The page is a single scroll with numbered steps.

1. **Token** — paste a JWT. A leading `Bearer ` and surrounding quotes are
   stripped for you. Two sample buttons load a realistic HS256 token (with a
   far-future expiry so the review has no critical findings) and a live RS256
   token whose public key and JWKS are pre-filled for the verify step.
2. **Security review** — an automatic, leveled list of findings: critical,
   warning and informational. It updates as you type.
3. **Header** and **Payload** — syntax-highlighted JSON with a copy button.
   Highlighting is built from DOM nodes, so nothing in the token is ever
   interpreted as markup.
4. **Claim breakdown** — every claim with its registered name, rendered value
   and a status note. Time claims (`exp`, `nbf`, `iat`) are shown as ISO dates
   plus a relative description.
5. **Verify signature** — paste the key material and press **Verify**. The
   algorithm is read from the token header. For HMAC tokens paste the shared
   secret; for RSA/EC/EdDSA paste a public key as PEM or JWK. There is also a
   **Verify with JWKS** panel for a provider's key set.
6. **Build a token** — choose an algorithm, optionally set a `kid`, edit the
   payload JSON, supply a key, and press **Sign**. The result can be copied or
   sent straight back into the inspector with **Inspect this token**.

`Ctrl`/`Cmd` + `Enter` re-decodes the token from anywhere on the page.

## Supported algorithms

| Family | Algorithms | Key you supply to verify / sign |
| --- | --- | --- |
| HMAC | `HS256`, `HS384`, `HS512` | The shared secret (raw text or an `oct` JWK) |
| RSA PKCS#1 v1.5 | `RS256`, `RS384`, `RS512` | Public key (verify) / private key (sign) as PEM or JWK |
| RSA-PSS | `PS256`, `PS384`, `PS512` | As above |
| ECDSA | `ES256`, `ES384`, `ES512` | As above, on P-256 / P-384 / P-521 |
| EdDSA | `EdDSA` (Ed25519) | As above |

`alg: none` is recognised and reported as a critical finding; the tool refuses
to "verify" an unsecured token.

## Input formats and conventions

- **Tokens** may be wrapped in `Bearer ` and/or double quotes; both are
  stripped. Any three dot-separated segments decode. A five-segment token is
  reported as a JWE (encrypted), which this tool does not decrypt.
- **Secrets** are treated as UTF-8 text. A JSON object with `kty: "oct"` and a
  Base64url `k` is accepted as an HMAC key.
- **Public/private keys** are accepted as a `-----BEGIN … KEY-----` PEM block or
  as a JWK JSON object. RSA and EC keys may be in PKCS#8/SPKI or the older
  PKCS#1/SEC1 PEM forms.
- **JWKS** is the `{ "keys": [ … ] }` document an identity provider publishes.
  Keys whose `kid` or `alg` conflict with the token header are skipped; keys
  that omit those fields are still tried, since single-key JWKS documents
  sometimes leave `kid` out.
- **Time claims** are Unix seconds. `exp`, `nbf` and `iat` are shown as both an
  ISO timestamp and a relative phrase.
- **Audiences** may be a string or an array; both are displayed, and a
  non-string entry is flagged.

## What it deliberately does not do

- It does not **decrypt JWE** tokens. Only signed (JWS) tokens are handled.
- It does not **validate claims against a policy**. It tells you whether a token
  has expired and what claims it carries; deciding whether `iss` or `aud` are
  the ones you trust is your call, and belongs on the server.
- It does not **check revocation**, call an identity provider, or fetch a JWKS
  over the network. You paste the JWKS yourself, which keeps the tool offline
  and means the token's issuer never learns it was inspected.
- It does not **guess** an HMAC secret. If the signature does not match the key
  you supplied, it says so; it does not try to crack anything.

## A note on trust

Decoding proves nothing. A readable payload only means it was Base64url-encoded
— anyone can produce one. Always verify the signature, and pin the expected
algorithm on the server rather than trusting the `alg` in the token header.

## Privacy

Everything runs locally in your browser. Tokens and keys are held in memory,
used only for decoding and Web Crypto operations, and never uploaded. There are
no network requests of any kind, no analytics, and nothing written to
`localStorage`, `sessionStorage` or `indexedDB` — reloading the page loses your
input. The Clipboard API is used only when you click a copy button. Because a
JWT is a bearer credential and a private key is a secret, be mindful of the
machine you paste them into.

## Browser requirements

A modern evergreen browser with the Web Crypto API (`crypto.subtle`), available
over HTTPS and on `localhost`/`file:`. HMAC verification is effectively
instantaneous. RSA and EC key import is fast for typical key sizes; the tool
shows a pending state on the verify and sign buttons while the promise settles.
No canvas, Web Workers, external libraries or build step.

## Implementation notes

All logic lives in a dependency-free UMD module (`window.Toolshed.jwtInspector`
in the browser, `require("../tool.js")` in Node) so the page and the test suite
exercise the same code. Decoding is deliberately forgiving — it only
Base64url-decodes and parses JSON — so malformed tokens can still be inspected,
while verification is strict and hashes the exact original segments rather than
a re-serialised copy. Algorithm handling is table-driven, which keeps the UI,
the verifier and the tests in agreement and lets unsupported algorithms fail
with a clear message. The verifier reports which stage failed (parse, algorithm,
key, signature) so an error can be acted on. ECDSA verification uses the raw
`r‖s` signature form JWS requires, and a DER-length signature is called out
rather than reported as a generic mismatch. The UI renders every result with DOM
nodes and `textContent` — no `innerHTML`, no `eval` — so a pasted token is never
executed or interpreted as markup.
