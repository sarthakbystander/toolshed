# UUID Generator

Generate RFC 4122 version 4 UUIDs right in your browser.

## What it does

- **Generate** 1-1000 UUIDs at a time
- **Copy one** — each generated UUID has its own copy button
- **Copy all** — copy every UUID at once
- **Clear** — wipe the list and start over

## How it works

Each UUID uses 122 bits of randomness sourced from `crypto.getRandomValues`
(the browser's cryptographically secure random source), with the version and
variant bits set per RFC 4122. If the browser is in a non-HTTPS context where
`crypto` is unavailable, a `Math.random` fallback is used instead.

## Privacy

Everything runs locally in your browser. UUIDs are generated on your device and
nothing is ever transmitted.

## Limitations

- Version 4 (random) only; no time-based (v1), name-based (v3/v5) or
  ordered (v6/v7) UUIDs yet.
- In non-secure contexts the fallback is not cryptographically secure.
