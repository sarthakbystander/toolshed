# Subnet Calculator

Work out IPv4 subnetting without a manual bit-by-bit calculation. Enter an
address and prefix to get the network, broadcast, netmask, wildcard, usable
host range and reverse DNS; split a block into subnets by target prefix or by
hosts-per-subnet; merge a CIDR list into the smallest covering set; and check
whether an address belongs to a range. Everything runs in your browser — no
network requests, no lookups.

## Why use it

Ad-hoc subnet math is error-prone, and this is the kind of task you do
mid-edit while writing a config, planning address space, or debugging a
routing problem. Typing an address and a prefix should give you the whole
answer immediately, including the pieces people usually forget: the wildcard
mask, the usable host range, the reverse-DNS zone, and whether the address you
typed is actually the network or broadcast address.

The calculator is deliberately stateless and input-driven — nothing is stored,
and the page is safe to use with production addressing because no data leaves
the tab.

## What it does

Four modes are available from the tabs:

- **Subnet** — the classic calculation. Given an address and a prefix (typed as
  `10.0.0.1/24`, `10.0.0.1` plus a prefix field, or a dotted netmask such as
  `10.0.0.1/255.255.255.0`), it reports:
  - network and broadcast addresses
  - netmask and wildcard mask
  - usable host range (first and last host)
  - total addresses and usable host count
  - the legacy classful class and the special-purpose classification (private,
    loopback, multicast, documentation, etc.)
  - the full `in-addr.arpa` name and the delegated reverse-DNS zone
  - a binary view of the address with the network bits and host bits shaded
- **Split** — divide a block into a uniform set of subnets, either by giving a
  **target prefix** (e.g. split a `/16` into `/24`s) or a **hosts-per-subnet**
  figure (the smallest prefix that fits that many usable hosts is chosen
  automatically). Results are a table you can copy as CSV or download.
- **Merge** — paste a list of CIDR blocks and collapse adjacent or overlapping
  ones into the minimal set of covering CIDR blocks. Useful for tidying
  firewall rules, allow-lists, or route summaries.
- **Check** — test whether a single address falls inside any block in a list,
  and see exactly which blocks match.

A **reference table** below the calculator lists the netmask, total addresses
and usable hosts for the common prefixes.

## How to use it

1. Pick a tab.
2. Type an address/prefix (or paste a CIDR list in Merge/Check).
3. Press **Calculate** / **Split** / **Merge** / **Check**, or press Enter in
   the address field (Ctrl/Cmd+Enter in the multi-line fields).

Each mode has a **Load sample** button, so the page is never a blank slate.
Results for Split and Merge can be copied or downloaded as CSV; the subnet
result can be copied as plain text.

## Input formats

- **Addresses** — dotted-quad IPv4, e.g. `192.168.10.130`. Leading-zero octets
  like `010` are rejected (they are ambiguous and often octal in other tools).
- **Prefixes** — a slash prefix `/0`–`/32`, a dotted netmask
  (`255.255.255.192`), or nothing (defaults to `/32`).
- **CIDR lists** — whitespace, comma or newline separated.

## Special cases and conventions

- **/31 links** — treated as RFC 3021 point-to-point links: both addresses are
  usable and there is no network/broadcast reservation.
- **/32 host routes** — a single usable address.
- **IPv6** — not supported. If you paste a value containing `:`, the tool says
  so explicitly rather than showing a confusing octet error.
- **Split limits** — splits are capped at 4,096 subnets so a typo cannot freeze
  the page; the largest permitted split is 12 prefix bits below the source
  block. Larger lists show the first 4,096 rows with a note, while copy and
  download always contain the full set.
- **Merge** — overlapping blocks are unioned, not just sorted. Block
  boundaries are aligned, so merging `10.0.0.0/25` and `10.0.0.128/25` yields
  `10.0.0.0/24`.

## Privacy

Everything runs locally in your browser. Input is parsed and computed in
memory; nothing is uploaded, and nothing is written to `localStorage`,
`sessionStorage` or `indexedDB`. There are no network requests of any kind.
The Clipboard API is used only when you click a copy button, and the Blob/URL
API only when you click a download button.

## Browser requirements

A modern evergreen browser. The tool uses only standard DOM APIs — no canvas,
Web Workers, external libraries or build step. The computation is pure
in-memory integer math and is effectively instantaneous for any input the
interface accepts.

## Implementation notes

The address math lives in a dependency-free UMD module
(`window.Toolshed.subnetCalculator` in the browser, `require("../tool.js")` in
Node) so the same code powers the page and the test suite in `tests/run.js`.
IPv4 addresses are held as unsigned 32-bit integers and only formatted to
dotted-quad for display. The UI builds results with DOM nodes and `textContent`
— no `innerHTML` and no `eval` — so input is never interpreted as markup.
