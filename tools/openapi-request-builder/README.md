# OpenAPI Request Builder

Load an OpenAPI 3 or Swagger 2 document, pick an operation, fill in the
parameters, and get a ready-to-run request with curl, fetch, Node, Python and
raw HTTP snippets. It is a lightweight, offline alternative to clicking around
a hosted API explorer — and nothing you paste is ever uploaded.

## What it does

- **Reads OpenAPI 3.x and Swagger 2.0** documents, either pasted as JSON or
  dropped in as a `.json` file. The version and title are shown once parsed.
- **Lists every operation** grouped by tag, with a free-text filter across
  path, method, summary, operation id and tags.
- **Resolves `$ref`s locally** — schemas, parameters and request bodies
  referenced from `#/components/...` (or `#/definitions/...` in Swagger 2) are
  followed automatically, including simple `allOf` composition. Cyclic
  references are detected and stopped rather than followed forever.
- **Derives example values** from each schema: explicit `example`, then
  `default`, then the first `enum` member, then a sensible type-appropriate
  placeholder (`0`, `""`, `false`, and format-aware strings such as UUIDs,
  dates and emails). Unchecking **Use spec examples** falls back to plain type
  placeholders.
- **Builds the request** as you edit: path parameters are URL-encoded into the
  template, query parameters are only included when enabled, headers are
  applied, and a `Content-Type` is added for a body when one is not already set.
- **Generates five snippets** — `curl`, browser `fetch`, Node.js (`fetch`),
  Python (`requests`) and the raw HTTP/1.1 message — from the current form
  values. JSON bodies are pretty-printed, and Python output uses real Python
  literals (`True`/`False`/`None`) rather than JSON keywords.
- **Flags problems inline**: a missing path parameter or an empty query value
  is called out in the request pane instead of being silently dropped.

## Why you would use it

When you are integrating an API, you usually want three things quickly: what
operations exist, exactly what a request should look like, and a copy-pasteable
snippet in your language. This tool derives all three from the spec itself, so
the request you get matches the contract rather than your memory of it — with no
account, no hosted service, and no data leaving the tab.

## How to use it

1. **Load the spec** — paste JSON into the text area and press **Load spec**
   (or Ctrl/Cmd+Enter), or switch to **Upload file** and drop a `.json` file.
   **Load sample** fills in a small demo API so you can see the flow
   immediately.
2. **Choose an operation** from the list on the right. Use the filter box (the
   `/` key focuses it) or the tag chips to narrow things down.
3. **Fill in the request** — edit path parameters, toggle optional query
   parameters, set headers, and edit the request body. The base URL can be
   switched between the servers declared in the spec or overridden with your
   own.
4. **Copy what you need** — the request URL from the preview, or the snippet in
   any of the five languages.

## Supported input

- **OpenAPI 3.x** (`openapi: "3.x"`) and **Swagger 2.0** (`swagger: "2.0"`),
  as JSON. Request bodies support OpenAPI 3 `requestBody` content maps as well
  as Swagger 2 `body` and `formData` parameters.
- **JSON only.** YAML specs must be converted to JSON first — the tool
  deliberately ships no YAML parser to keep the page dependency-free and small.
- Documents are parsed with `JSON.parse`; malformed JSON produces a readable
  message rather than a crash, and anything lacking an `openapi`/`swagger`
  version field is rejected with an explanation.

## Limitations

- Only local `$ref`s (`#/...`) are resolved. Remote file or URL references are
  ignored, because resolving them would require a network request the tool does
  not make.
- `allOf` composition is merged shallowly; `oneOf`/`anyOf` examples use the
  first branch. Very deeply nested or recursive schemas are bounded by a depth
  limit, so an example may stop early.
- Example generation is heuristic, not a validator — the generated body is a
  starting point to edit, not a guaranteed-valid document.
- Server variables in server URLs (e.g. `https://{region}.example.com`) are
  shown as-is; substitute the values yourself.
- The snippets show the request; the tool does not send it, so there is no
  response viewer.

## Privacy

Everything runs locally in your browser. The pasted or uploaded document is
parsed in memory with `JSON.parse` and, for uploads, read with the `File` /
`FileReader` API. Nothing is uploaded and nothing is written to `localStorage`,
`sessionStorage` or `indexedDB`. The tool makes **no network requests of any
kind** — there is no "send request" button, by design. The Clipboard API is used
only when you click a copy button.

## Browser requirements

A modern evergreen browser. The page uses only standard APIs: `JSON`,
`URL`, `FileReader`, `navigator.clipboard` and DOM APIs. It works offline, and
there is no build step or external dependency.

## Implementation notes

The spec parser, `$ref` resolver, example generator, request builder and
snippet renderers are a dependency-free UMD module (`tool.js`), exposed as
`window.Toolshed.openapiRequestBuilder` in the browser and loadable with
`require("../tool.js")` in Node so the same code powers the page and the test
suite in `tests/run.js`.

The UI builds every list, chip and input with DOM nodes and `textContent` — no
`innerHTML`, no `eval`, no dynamic code execution — so titles, descriptions and
paths from an untrusted document are rendered as text, never as markup. Path
parameter values are percent-encoded before substitution, so a value cannot
inject extra path segments or query parameters into the generated URL.
