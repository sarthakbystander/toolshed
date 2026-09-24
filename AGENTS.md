# AGENTS.md — Toolshed Architectural Rules

This file is the architectural contract for AI coding agents working in this repository. Treat everything below as binding rules, not suggestions. When a change conflicts with these rules, these rules win. If something here is ambiguous, choose the simplest architecture consistent with the project goals, and document the decision in your PR description.

## What Toolshed is

Toolshed is an open-source collection of independent, browser-based web tools. Each tool solves one focused problem and is independently usable from the website. The site is static:the repository itself is the website, deployed as-is to GitHub Pages. There is no backend, no database, no API server, no accounts, no framework.



## Repository architecture(do not change)

```text
toolshed/
├── index.html                     # Homepage (the repository is the website)
├── tools/                         # One directory per tool — source of truth
│   └── <tool-name>/
│       ├── index.html             # Required — tool page
│       ├── tool.js                # Optional — vanilla JS logic
│       ├── tool.css               # Optional — tool styles
│       ├── tool.json              # Required — metadata contract
│       ├── README.md              # Recommended
│       └── tests/                 # Recommended
├── registry/
│   └── tools.json                 # GENERATED — do not hand-edit
├── scripts/
│   ├── generators/                # Repository generators
│   └── qa_verification/          # Verification pipeline
├── .github/workflows/
│   ├── verify.yml                 # CI verification
│   └── deploy.yml                 # GitHub Pages deploy
├── package.json                   # Node tooling only
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── AGENTS.md
└── LICENSE
```

Hard rules:

- **No `website/`, `src/`, `app/`, or `frontend/` directories.** The repository root is the website. `index.html` is the homepage. Individual tools live at `tools/<id>/index.html` and are linked directly from the homepage.
- **No frontend framework.** No React, Vue, Next.js, Astro, Svelte, etc. Use HTML, CSS, and vanilla JavaScript only. Do not add a build framework for deployment either.
- **No backend, API server, database, or authentication.**
- **Node.js is for repository tooling only** (`scripts/`), never a runtime requirement for the actual tools. Tools must work by opening `index.html` in a browser.
- **Keep dependencies minimal.** Every dependency in `package.json` needs a documented reason. Prefer browser APIs plus vanilla JS.

- **No external analytics by default,** and no network requests from the homepage unless required.



## Tool structure

Every future tool looks like:

```text
tools/
└── json-formatter/
    ├── index.html
    ├── tool.js
    ├── tool.css
    ├── tool.json
    ├── README.md
    └── tests/
```

Adding a new tool must require only adding a directory under `tools/`, plus regenerating `registry/tools.json`. It must never require changing the core website architecture, the generator, or the verifier, unless the change is a deliberate contract evolution.



## Naming rules

Tool IDs and slugs use `lowercase-kebab-case`:no spaces,no underscores,no uppercase,no random abbreviations. Examples:`json-formatter`,`image-compressor`,`color-converter`,`uuid-generator`,`markdown-preview`. The `id` field in `tool.json` must exactly match the directory name.





## Metadata contract

Every tool ships `tool.json`. Required fields:

| Field | Meaning |
| --- | --- |
| `id` | Unique id matching the directory name (`lowercase-kebab-case`). |
| `name` | Human-readable display name. |
| `description` | One or two sentences shown in listings/search. |
| `category` | Coarse homepage grouping (e.g. `Developer`,`Text`,or `Image`). |
| `tags` | Non-empty array of lowercase strings for search. No duplicates. |
| `version` | Semantic version `major.minor.patch`. |
| `runtime` | `browser` (the only allowed value today). |
| `privacy.execution` | `local` (the only allowed value today). |
| `privacy.dataUploaded` | `false` unless the tool deliberately transmits user data;if `true`,document it in the README,and PR. |
| `privacy.storage` | One of `none`,`localStorage`,`sessionStorage`,or `indexedDB`. |

The authoritative schema is `scripts/generators/tool-schema.json`. The bundled validator,used by both generator and verifier,is `scripts/generators/generate-registry.js`. When evolving the contract,add only optional properties — never remove or rename existing fields — and update the schema,the bundled validator,this file,and [CONTRIBUTING.md](CONTRIBUTING.md) together,and keep existing tools passing.



## Registry architecture

```text
tools/*/tool.json
        ↓
generator (npm run generate: node scripts/generators/generate-registry.js)
        ↓
registry/tools.json
        ↓
homepage / search / categories
```

- `tools/` is the single source of truth. Never duplicate tool metadata elsewhere.
- `registry/tools.json` is generated and committed. Never hand-edit it;regenerate via `npm run generate`. Output is deterministic:entries sorted by `id`,tags sorted lexically,stable formatting. If a contributor edits it by hand,revert and regenerate.
- The homepage will be driven by this registry,including tool cards,search,and categories,in future generations. Do not build those now.



## Generator rules

- Only build generators that are actually needed. The registry generator exists today. Future planned responsibilities:search indexes,website data,validating generated output,and other deterministic generation tasks. Do not create speculative generators.
- Generator output must be deterministic — same input,same bytes,regardless of filesystem order,platform,or run count.
- Invalid metadata must fail with a useful error naming the file and problem.
- Generators must run on clean checkouts with `npm install`,and zero extra configuration.
- Keep generators dependency-free where practical. The generator currently uses Node stdlib only.



## QA rules

`npm run verify`,which runs `node scripts/qa_verification/verify.js`,currently checks:package.json sanity,JSON validity across the repo,tool structure (no stray files under `tools/`,and every tool directory validates against the contract),registry freshness (registry is byte-identical to what the generator produces),homepage presence,and required docs/workflows presence.

The planned pipeline,future stages added as they become meaningful,and never faked:

```text
Pull Request
    ↓
Schema validation
Tool structure validation
Metadata validation
Tests / linting
Security checks
Link / asset checks
Registry validation
Website validation
    ↓
PASS
```

Rules:

- Never create fake tests or placeholder checks to make the pipeline look complete. Every check must verify something real,and fail with a useful,specific error.
- Commands from repo root:`npm run generate` then `npm run verify`. Both must exit 0.
- CI (`.github/workflows/verify.yml`) runs both on pushes to `main` and on PRs. A PR that fails verification is not mergable.
- Verification must remain deterministic,and fast enough for every contribution.



## Security expectations

- Code runs in the visitor's browser. No malicious JavaScript,obfuscation,trackers,cryptominers,or data exfiltration. Ever.
- No external scripts by default:no CDN references,no remote runtime loading. Commit assets locally,so the site is deterministic,auditable,and works offline.
- No unexpected network requests. Any network call must be explicit,user-visible,and documented in `tool.json` (`privacy.dataUploaded` set to `true`),the tool README,and the PR description.
- Never hardcode private API keys,tokens,or credentials in committed files. Secrets belong to the user,supplied at runtime in the browser,if ever needed.
- Do not introduce authentication,cookies,or tracking by default.
- Full policy:[SECURITY.md](SECURITY.md)。



## Privacy expectations

The core principle:

> Tools should run locally in the browser whenever technically possible

Preferred flow:

```text
User → Browser → Tool
```

Not:

```text
User → Toolshed server → Third-party API
```

- `privacy.dataUploaded` must stay `false` unless the tool has a real,documented network feature.
- Prefer browser APIs over libraries,and prefer local processing over network processing.



## GitHub Pages constraints

- The site is static,and served from the committed repository. Everything needed to render a page must be committed,including no build output,and nothing generated at deploy time beyondwhat is already committed.
- Deployment happens from `main` via `.github/workflows/deploy.yml` (`configure-pages` → `upload-pages-artifact` → `deploy-pages`). No separate build framework is introduced just for deployment.
- Relative links matter:tool pages live under `tools/<id>/`,so asset paths must resolve relative to that page,as in `tool.js` or `./tool.css`,not root-absolute,so the site works at a project Pages URL like `https://user.github.io/toolshed/`. The homepage links to tools via `tools/<id>/`,relative,not `/tools/...`.
- No backend means no redirects,no rewriting,and no server-side processing at deploy time.



## What agents should NOT change

- The overall architecture,including directory layout,homepage-at-root,and tools-under-`tools/`.
- The `tool.json` contract,without the full evolution procedure,which includes the schema,the bundled validator,CONTRIBUTING.md,AGENTS.md,and backward-compatible optional fields.
- The generated status of `registry/tools.json` — regenerate it,do not hand-edit it.
- The no-framework,no-backend,browser-first constraints.
- The `package.json` philosophy:tooling-only,and minimal dependencies.
- The verification philosophy:real checks only,and no fake tests.
- The privacy and security invariants documented here,and in [SECURITY.md](SECURITY.md).

.

.

If a task seems to require changing one of these,stop,and flag it in the PR description with a justification. Do not silently restructure the repo.



## How to add a tool

1. Create `tools/<id>/` per the structure above,where the id matches the directory name,and is `lowercase-kebab-case`.
2. Write vanilla HTML/CSS/JS. Keep it self-contained,and offline-capable. Reference assets relatively,as in `tool.js` or `tool.css`.
3. Add `tool.json` per the metadata contract,using the example above. Verify with `npm run generate`.
4. Add a `README.md` explaining what the tool does,how to use it,and any privacy notes,and add tests where appropriate.
5. From the repository root,run `npm run generate` to regenerate the registry,and then `npm run verify`. Both must pass.
6. Add files under `tools/<id>/` only,plus the regenerated `registry/tools.json`. Do not touch core site files,the generator,or the verifier,unless the contract is deliberately evolving.
7. In the PR description,note the `category` (new or reused),any network behavior,and any deviations from these rules.



## How to verify changes

From the repository root:

```bash
npm run generate   # regenerate registry/tools.json
npm run verify     # run repository health checks
```

Guidance:

- If `npm run verify` fails,fix the underlying issue,and do not weakenthe checks or silence them.
- Confirm you have not created stray files under `tools/`,whereonly tool directories,and the `.gitkeep`,belong there.
- Confirm `registry/tools.json` is byte-identical after a second `npm run generate`,to confirm determinism.
- If you changed the generator or verifier,run `node --check <file>` for syntax,and then both commands,and update docs if the behavior changed.
- Before committing,run `git status`,and review that only intended files changed.
- Keep commits focused:a tool contribution should touch `tools/<id>/` plus `registry/tools.json` and nothing else.



## Definition of done

A change is done when:it obeys every rule above;`npm run generate` produces stable output;`npm run verify` exits 0;docs and metadata are internally consistent;no hidden dependencies,network calls,or secrets were introduced;and the change is additive and non-breaking to existing tools,unless the change explicitly evolves the backwards-compatible contract.