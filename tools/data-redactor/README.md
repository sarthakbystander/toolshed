# Data Redactor

Find the sensitive parts of a log, ticket, dataset or note and strip them out
before you share it. The tool detects personal data, credentials and network
identifiers, then replaces each match with the strategy you pick — entirely in
your browser. Nothing is uploaded and nothing is stored.

## Why it exists

Copying a stack trace into a bug tracker, pasting a config file into a chat, or
attaching a CSV to a ticket are all easy ways to leak an email address, a card
number, an API key or a customer name. The Data Redactor gives you a fast,
auditable first pass: paste the text, review the findings list, copy the cleaned
output.

Because it runs locally, the sensitive values never travel anywhere to be
redacted — which is the whole point.

## What it detects

| Group | Detectors |
| --- | --- |
| Credentials & secrets | Private key blocks (PEM), AWS access keys, GitHub tokens, Slack tokens, Stripe keys, Google API keys, JWTs, bearer tokens, basic-auth credentials, connection-string passwords, `password=`/`token=`/`api_key=` style assignments |
| Personal data | Email addresses, card numbers (Luhn-checked), IBANs (mod-97 checked), US SSNs, UK National Insurance numbers, phone numbers, person names*, dates of birth*, postal addresses* |
| Network | IPv4 and IPv6 addresses, MAC addresses, URLs |
| Custom | Any literal term you supply — internal codenames, client names, ticket IDs |

\* Off by default. These are heuristic: they only match when the value follows a
labelling field such as `name:`, `dob:` or `address:`, and they can both miss
real values and flag harmless text. Turn them on in the **Detectors** list when
you need them.

Every non-heuristic detector applies a validation check where the format allows
it — card numbers must pass Luhn, IBANs must pass the mod-97 checksum, IPv4
octets must be in range, SSNs must avoid impossible prefixes — which keeps false
positives down.

## Strategies

| Strategy | Example output | Notes |
| --- | --- | --- |
| Redact | `[EMAIL_ADDRESS]` | Typed placeholder. Safest default. Irreversible. |
| Mask | `jo*******@example.com` | Keeps a few characters for readability. Weak on short values. |
| Hash | `EMAIL_ADDRESS:3f786850e3` | Salted SHA-256 fingerprint. Deterministic, so records can be joined across files without revealing values. |
| Tokenize | `EMAIL_ADDRESS_1`, `EMAIL_ADDRESS_2` | A numbered label per distinct value. Repetition stays visible. |
| Remove | (nothing) | Deletes the value, leaving surrounding text intact. |

**Restore originals** reverses a redaction for the current session using the
mapping the tool keeps in memory. It never restores anything it did not produce,
and the mapping is discarded when you close or reload the tab.

## How to use it

1. Paste text into the source box, drag a file onto it, or click **Open file**
   (`.log`, `.txt`, `.json`, `.jsonl`, `.csv`, `.env`, `.yaml`, `.sql` and other
   text formats up to 5 MB).
2. Pick a strategy. Adjust the mask length or add a hash salt if you need one.
3. Optionally add custom terms and enable the heuristic detectors.
4. Click **Redact** (or press Ctrl/Cmd+Enter). **Scan** reports what it found
   without changing anything.
5. Review the findings table, then copy or download the output. The report can
   be copied as Markdown, CSV or JSON — with a **Hide original values** toggle
   so you can share the audit trail itself without leaking the data in it.

**Load sample** fills the box with a realistic mixed log so you can see the
whole flow immediately.

## How it works

The detection engine is a dependency-free UMD module
(`window.Toolshed.dataRedactor` in the browser, `require("../tool.js")` in Node).
It runs each detector's pattern over the text, applies the validator, then
resolves overlaps so that a private-key block wins over the email address
inside it and a connection-string password wins over the surrounding URL.
Findings are returned in ascending position order and never overlap, so the
redactor can rebuild the text in a single pass.

Strategies are applied per finding, with an optional per-detector override
(available through the API; the UI exposes the global strategy). Replacement
values are derived only from the user's own input. The hash strategy uses a
self-contained SHA-256 implementation so it behaves identically in the browser
and in Node without Web Crypto or `node:crypto`.

The UI (`ui.js`) renders every result with `createElement` and `textContent` —
never `innerHTML` — so pasted content cannot inject markup. There is no `eval`,
no dynamic code execution, and no network request of any kind.

## Performance

Detection is linear in the size of the input and comfortably handles inputs in
the hundreds of kilobytes. Patterns are written without nested unbounded
quantifiers, so they cannot exhibit catastrophic backtracking on adversarial
input; a test feeds 20 KB of pathological text through the engine and asserts it
completes quickly.

## Limitations

- Detectors are pattern-based. They can miss unusual formats (for example an
  email split across two lines) and can occasionally flag something harmless
  (a version string that looks like an IP). Review the findings list.
- Heuristic detectors (names, dates of birth, addresses) are deliberately
  conservative and off by default. They are a starting point, not a complete
  solution.
- The mask strategy is not a security control for short values — masking a
  6-character secret still leaks most of it. Use redact, hash or remove for
  anything sensitive.
- Restore works on the text the tool produced in this session; it is a
  convenience for double-checking, not a durable mapping.
- Files are read as UTF-8 text; binary formats are not supported.

## Privacy

Everything runs locally in your browser. Pasted text and opened files are
processed in memory only. Nothing is uploaded, and nothing is written to
`localStorage`, `sessionStorage` or `indexedDB`. There are no network requests,
no analytics and no accounts. The Clipboard API is used only when you click a
copy button, and the File/Blob API only when you click **Download** or open a
file.

## Browser requirements

A modern evergreen browser. The tool uses standard `FileReader`, `Blob`,
`URL.createObjectURL`, `navigator.clipboard`, `Set`/`Map` and DOM APIs. No Web
Worker is needed because detection is fast enough to run synchronously on
realistic inputs.

## Tests

`tests/run.js` covers the SHA-256 implementation against published vectors, each
detector family (positive and negative cases, including Luhn and IBAN checksum
failures), overlap resolution, all five strategies, restore round-tripping,
custom terms, disabled detectors, empty and malformed input, adversarial input
performance, statistics, and the three report formats. Run them with:

```bash
node tools/data-redactor/tests/run.js
```
