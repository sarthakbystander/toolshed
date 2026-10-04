# Webhook Signature Lab

Work out exactly what a webhook provider signs, generate the signature header
it would send, and verify a signature you received — all in your browser.

Every provider signs a slightly different base string: GitHub HMACs the raw
body, Stripe signs `<timestamp>.<body>`, Slack signs
`v0:<timestamp>:<body>`, Standard Webhooks signs `<id>.<timestamp>.<body>`,
and Shopify base64-encodes the digest instead of hexing it. Getting that wrong
is one of the most common reasons a webhook handler rejects valid traffic.
This tool makes the base string visible and checkable instead of guessed.

## Why use it

- **Debug a failing endpoint.** Paste the raw body and the signature header
  your handler rejected, and see whether the signature is actually wrong or the
  handler is verifying the wrong string.
- **Confirm a secret.** Check that the signing secret you configured is the one
  the sender is using before you go hunting through logs.
- **Test before you ship.** Generate a valid header locally to feed a local
  handler or a test fixture without standing up the real provider.
- **Copy a correct recipe.** Get a curl, Node or Python verification snippet
  with the right base string and a constant-time comparison, instead of
  re-deriving the scheme from documentation.

## What it does

1. **Provider & input** — pick a provider, enter the signing secret, the raw
   request body, and any timestamp or message id the provider includes. A
   **Load sample** button fills in a realistic body so the page is never blank.
2. **Signature** — shows the exact header name and value the provider would
   send, and lets you expand the precise signed payload that was hashed.
3. **Verify** — paste a signature header you received (or reuse the generated
   one) and get a clear valid / invalid verdict, plus the computed digest and
   the candidate values that were compared.
4. **Server-side recipe** — curl, Node and Python reference code for verifying
   that provider in your own handler.

## Supported providers

| Provider | Header | Algorithm | Encoding | Signed payload |
| --- | --- | --- | --- | --- |
| GitHub | `X-Hub-Signature-256` | SHA-256 | hex | `<body>` |
| Stripe | `Stripe-Signature` | SHA-256 | hex | `<t>.<body>` |
| Slack | `X-Slack-Signature` | SHA-256 | hex | `v0:<timestamp>:<body>` |
| Shopify | `X-Shopify-Hmac-Sha256` | SHA-256 | base64 | `<body>` |
| Standard Webhooks | `webhook-signature` | SHA-256 | base64 | `<webhook-id>.<webhook-timestamp>.<body>` |
| Custom HMAC | your choice | SHA-1/256/384/512 | hex or base64 | `<body>` |

## How to use it

1. Choose the provider.
2. Paste the signing secret. It stays in the field and is used only for local
   computation; use **Show** if you want to check what you typed.
3. Paste the **raw** request body — the exact bytes, not a re-serialized JSON
   object. Whitespace and key order are part of the signature.
4. Fill in the timestamp or message id if the provider uses one.
5. Read the generated header value, or paste a received one into **Verify** and
   press **Verify** (or Ctrl/Cmd+Enter).

## Input formats and conventions

- **Secrets** are treated as UTF-8 text, except for Standard Webhooks: a secret
  beginning with `whsec_` is base64-decoded after the prefix, matching the
  scheme. You can paste either the full `whsec_…` value or the decoded key.
- **Signatures** are compared in the provider's encoding. Hex is compared
  case-insensitively; base64 is compared case-sensitively.
- **Multiple signatures** in one header (Stripe's `v1=` rotation, Standard
  Webhooks' space-separated list) are all extracted and compared — any match is
  reported as valid.
- **Stripe timestamps**: the `t=` value inside the received header is what gets
  signed during verification, exactly as a real handler does. The timestamp
  field is used when generating.
- **Empty secret**: Web Crypto rejects a zero-length HMAC key, so the tool
  reports "Secret must not be empty." rather than failing silently.

## What it deliberately does not do

- It does not perform **replay protection**. Stripe and Slack both recommend
  rejecting requests whose timestamp is too far from the current time; the
  recipes include that check for your handler, but the tool does not simulate
  clock skew.
- It does not verify **signatures over arbitrary transformations** (parsed
  JSON, form-encoded bodies, multipart). Providers sign the raw bytes, so the
  tool does too.
- It does not know your provider's secret or call the provider — you supply
  everything.

## Privacy

Everything runs locally in your browser. The secret and payload are used only
to compute a digest in memory with the Web Crypto API; nothing is uploaded, and
nothing is written to `localStorage`, `sessionStorage` or `indexedDB`. There
are no network requests of any kind. The Clipboard API is used only when you
click a copy button. Do not paste production secrets into a shared machine's
browser if you do not control it.

## Browser requirements

A modern evergreen browser with the Web Crypto API (`crypto.subtle`), which is
available over HTTPS and on `localhost`/`file:` in current browsers. No canvas,
Web Workers, external libraries or build step. HMAC over the largest payloads
the textarea accepts is effectively instantaneous.

## Implementation notes

The provider catalogue, payload construction, HMAC, header formatting and
verification all live in a dependency-free UMD module
(`window.Toolshed.webhookSignatureLab` in the browser, `require("../tool.js")`
in Node) so the page and the test suite exercise the same code. Signing is
async because `crypto.subtle` is promise-based; the UI tracks a request token
so a slow keystroke can never overwrite a newer result. The signature
comparison walks the full length of both strings without an early exit,
mirroring the constant-time comparison a handler should use. The UI builds
results with DOM nodes and `textContent` — no `innerHTML` and no `eval` — so a
pasted payload is never interpreted as markup.
