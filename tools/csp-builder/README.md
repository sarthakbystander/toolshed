# Content Security Policy Builder

Build, decode, validate and export Content Security Policy (CSP) headers
without leaving the browser. Start from a preset or paste an existing policy,
edit it directive by directive, see what the browser will actually enforce, and
copy the result out as a header, meta tag or server config.

## Why

A CSP is one of the most effective defences against cross-site scripting, but
writing one by hand is error-prone. A typo silently drops a directive, a missing
`default-src` leaves fetch directives wide open, and `'unsafe-inline'` quietly
undoes the protection you were trying to add. This tool makes the policy
explicit: it resolves fallbacks, explains each directive, flags weak sources,
and gives you a ready-to-paste header.

## What it does

- **Build** — start from the *Strict*, *Baseline*, or *Baseline + Google
  Analytics* preset, then add or remove directives and edit their sources.
  Every directive has a short plain-language description and a default value.
- **Import** — paste a `Content-Security-Policy` header, a bare policy, a
  report-only header, or a `<meta http-equiv>` tag and the tool decodes it into
  editable directives. HTML entities in a meta tag are decoded.
- **Resolve fallbacks** — a directive you do not set is not automatically
  blocked. The *Resolved directives* table shows the effective value for each
  directive and where it came from (`script-src-elem` → `script-src` →
  `default-src`, `worker-src` → `child-src` → `script-src` → `default-src`, and
  so on).
- **Validate** — errors and warnings for unknown keyword sources, very short
  nonces, plaintext `http:` sources, wildcards, values given to
  `upgrade-insecure-requests`, non-URL `report-uri` values, sandbox tokens, and
  deprecated directives.
- **Score** — a 0–100 heuristic grade that rewards a restrictive `default-src`,
  no `'unsafe-inline'`/`'unsafe-eval'` in `script-src`, `object-src 'none'`,
  and set `base-uri`, `frame-ancestors` and `form-action`.
- **Export** — copy as an HTTP header, HTML meta tag, Apache `Header always
  set`, Nginx `add_header`, a Cloudflare Transform Rule note, a Netlify
  `_headers` block, a Report-Only header, or JSON.
- **Report-Only toggle** — export the policy as `Content-Security-Policy-Report-Only`
  to trial it without breaking anything.

## How to use

1. Pick a preset and click **Apply preset**, or paste a policy into **Import**
   and click **Import into builder**.
2. Edit each directive's sources in the **Directives** pane. Changes update the
   policy and the analysis live.
3. Read the **Analysis** pane: the grade, the good/warn/bad findings, and any
   errors or warnings.
4. Choose an export format and click **Copy**, then paste the result into your
   server config, `<head>`, or CDN rule.

**Load sample policy** fills in a realistic policy with deliberate weaknesses so
you can see the analysis in action.

## Supported inputs

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com
Content-Security-Policy-Report-Only: default-src 'none'; report-to csp-endpoint
default-src 'none'; img-src 'self' data:; script-src 'nonce-0123456789abcdef'
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
```

Directive names are case-insensitive. Both `;` and `,` separate directives.
Values inside single quotes are kept intact, so `data:` sources with commas are
not split.

## Scoring

The score is a heuristic, not a security guarantee. It rewards the directives
that reliably block common attacks and penalises the ones that usually undo
them. Treat a high score as "no obvious holes" and a low score as "look here
first" — then test the policy against your real pages, ideally in Report-Only
mode first.

## Privacy

Everything is computed in your browser from the text you type. The tool makes no
network requests, uploads nothing, and writes nothing to storage — no
`localStorage`, no cookies, no analytics. Copying uses the browser clipboard
API. Close the tab and the policy is gone.

## Limitations

- The score cannot know which hosts your site legitimately loads from; a "bad"
  finding may be a deliberate choice.
- Import decodes the common header, bare-policy and meta-tag forms. It does not
  strip HTML comments or resolve HTML entities other than the quote, ampersand
  and angle-bracket forms.
- `frame-ancestors` is ignored by browsers when delivered in a `<meta>` tag. The
  export includes it if you set it, so use a real HTTP header for clickjacking
  protection.
- Nonces and hashes are validated for shape only; the tool cannot check that a
  nonce matches a real script.
- Deprecated directives (`report-uri`, `prefetch-src`, `navigate-to`,
  `block-all-mixed-content`) are accepted and flagged, not removed.

## Technical notes

- `tool.js` follows the Toolshed UMD pattern: it loads as
  `window.Toolshed.cspBuilder` in the browser and via `require()` in Node for
  tests. It has no dependencies and uses no `eval` or dynamic code execution.
- Core exports: `parseCSP`, `buildPolicy`, `effectiveSources`, `validatePolicy`,
  `validateSource`, `intersectPolicies`, `mergePolicies`, `explainPolicy`,
  `explainDirective`, `auditPolicy`, `exportPolicy`, `applyPreset`,
  `presetNames`, `catalog`, `sourceSuggestions`, plus the `CATALOG`, `PRESETS`
  and `DEPRECATED` tables.
- `parseCSP(text)` returns `{ ok, directives, order, errors, warnings, reportOnly }`.
- `auditPolicy(parsed)` returns `{ score, grade, findings }` where each finding
  carries a `level` of `good`, `warn`, `info` or `bad`.
- `exportPolicy(format, policy)` accepts either a policy object or a raw string;
  `format` is one of `header`, `meta`, `apache`, `nginx`, `cloudflare`,
  `netlify`, `report-only` or `json`.
- Tests live in `tests/run.js` and run under `npm run test:tools`. They cover
  header/bare/meta/report-only parsing, quoting and comma handling, directive
  fallbacks, validation (unsafe sources, nonces, sandbox tokens, valueless
  directives), intersection and merge, explanations, scoring, and every export
  format.
