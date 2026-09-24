# Toolshed

Toolshed is an open-source collection of useful web tools — free to use, easy to contribute to, and built to run directly in your browser. Each tool solves one focused problem and is independently usable from the website.

## Philosophy

- **Browser-first** — Tools run locally in the browser whenever technically possible. No required backend, no accounts, no data collection.
- **One tool, one problem** — Each directory under `tools/` is a self-contained, independent web tool.
- **Easy contributions** — Adding a tool means adding a directory under `tools/`, not touching the core website architecture.
- **Tiny dependencies** — Browser APIs + vanilla JavaScript + HTML + CSS first. Any dependency must earn its place.

## Repository structure

```text
toolshed/
├── index.html                    # Homepage (the repository is the website)
├── tools/                        # One directory per tool
│   └── <tool-name>/
│       ├── index.html
│       ├── tool.js
│       ├── tool.css
│       ├── tool.json             # Tool metadata (source of truth)
│       ├── README.md
│       └── tests/
├── assets/
│   ├── toolshed.css              # Shared design system (tokens, header, grid, panes, footer)
│   └── logo.svg                  # Site logo — favicon and on-page mark
├── registry/
│   └── tools.json                # Generated from tools/*/tool.json — do not edit
├── scripts/
│   ├── generators/               # Repository generators (registry, indexes, site data, validation)
│   └── qa_verification/          # Repository verification pipeline
├── .github/workflows/
│   ├── verify.yml                # CI verification on push/PR
│   └── deploy.yml                # GitHub Pages deployment from main
├── package.json                  # Node tooling only — not a runtime for tools
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── AGENTS.md                     # Architectural rules for AI agents
└── LICENSE
```

## How tools are organized

Each tool lives at `tools/<tool-name>/` containing its own `index.html`, optional `tool.js` / `tool.css`, a `tool.json` metadata manifest, a README, and tests. The homepage links directly to each tool page.

Tool IDs follow `lowercase-kebab-case` (e.g. `json-formatter`, `image-compressor`) and must match their directory name. The `tool.json` metadata contract is documented in [CONTRIBUTING.md](CONTRIBUTING.md#tool-metadata-contract).

The site shares one design system. All pages load `assets/toolshed.css` (tokens, header, grid, panes, buttons, footer) and use `assets/logo.svg` as the favicon and header logo. Individual tools add only their widget-specific styles in their own `tool.css`.

## How verification works

`npm run verify` runs the repository health checks that are practical today (package.json sanity, JSON validity, tool structure, metadata validation, registry freshness, homepage presence). The planned pipeline is documented in [CONTRIBUTING.md](CONTRIBUTING.md#verification-pipeline) and [AGENTS.md](AGENTS.md#qa-rules). A fresh checkout must pass before changes are merged.

## How contributors can add tools

1. Create `tools/<tool-name>/` (see the [tool structure](CONTRIBUTING.md#tool-structure)).
2. Add your tool's HTML/CSS/JS.
3. Add `tool.json` metadata (see the [contract](CONTRIBUTING.md#tool-metadata-contract)).
4. Add a README and tests where appropriate.
5. Run `npm run generate`.
6. Run `npm run verify`.
7. Open a pull request. Never edit `registry/tools.json` by hand.

Full details in [CONTRIBUTING.md](CONTRIBUTING.md).

## Privacy

Tools must never secretly upload user data. If a future tool needs a network request, that behavior must be explicitly documented in its metadata and README. Private API keys must never be hardcoded into frontend code. See [SECURITY.md](SECURITY.md).

## Deployment

The repository itself is the static website. GitHub Actions deploys `main` to GitHub Pages — no build step required beyond the committed files. See [deploy.yml](.github/workflows/deploy.yml).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Sarthak Bystander.