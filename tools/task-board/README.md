# Task Board

A local-first todo board that runs entirely in your browser. Add tasks with due
dates, priorities and tags, then search, filter, sort and reorder them. The board
saves itself to `localStorage`, so it survives a reload, a closed tab, and a
restart — with no account, no sync service and no server.

## Why use it

Most todo apps want an account before they will store a single line of text.
Task Board is the opposite: open the page and start typing. It is useful when
you want a scratch board that is genuinely private, when you are working on a
machine you do not own, or when you want to keep a project checklist next to the
tooling you are already using. Because it exports plain JSON and Markdown, it is
also a reasonable place to draft a list before moving it somewhere permanent.

## How to use it

1. **Add a task.** Type a title in the *New task* box and press <kbd>Enter</kbd>.
   Optionally set a due date, a priority and comma-separated tags first.
2. **Work the list.** Tick the checkbox to complete a task. *Edit* opens an
   inline form for every field; *Delete* removes the task.
3. **Narrow it down.** The status chips (All, Active, Done, Overdue, Due today,
   Upcoming) combine with the search box, the priority filter, the tag filter and
   the sort order.
4. **Reorder.** With *Manual order* selected, drag a task by its row, or focus it
   and press <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>Alt</kbd>+<kbd>↓</kbd>.
5. **Keep your data.** *Export JSON* writes a versioned backup file,
   *Export Markdown* produces a grouped checklist, and *Import JSON…* reads a
   file back (replace or merge).

Press **Load sample board** at any time to see a populated example.

## What it stores

Each task is an object with:

| Field | Meaning |
| --- | --- |
| `id` | Opaque unique string. |
| `title` | Required, trimmed, at most 200 characters. |
| `notes` | Free text, at most 4000 characters. |
| `done` | Boolean. |
| `priority` | `low`, `normal` or `high`. |
| `due` | `YYYY-MM-DD` local calendar date, or `null`. |
| `tags` | Lowercase, de-duplicated, at most 20 tags of 32 characters. |
| `createdAt`, `updatedAt`, `completedAt` | Epoch milliseconds. |
| `order` | Position used by *Manual order*. |

Due dates are treated as whole calendar days in your local timezone, not as
instants, so a task due "today" stays due today regardless of the hour. Overdue,
today and upcoming are all derived from that comparison at render time.

## Privacy

Everything happens in the page. There is no network request of any kind — no
analytics, no fonts, no CDNs. Tasks live in your browser's `localStorage` under
the key `toolshed:task-board:v1` and are never transmitted anywhere. Exports are
generated in memory and downloaded with a Blob URL. Clearing your browser data,
or using *Delete all tasks*, removes them for good.

Because storage is per-browser and per-origin, the board does not sync between
devices or browsers. Export and import are the intended way to move it.

## Supported input

- **Import** accepts a file produced by *Export JSON*, a bare JSON array of
  tasks, or the legacy `{ version: 1, tasks: [{ text, done }] }` shape. Unknown
  fields are ignored, unreadable entries are skipped with a warning, and a list
  longer than 5000 tasks is truncated. Files above 20 MB are refused.
- Invalid field values are neutralised rather than trusted: an unrecognised
  priority becomes `normal`, a malformed date becomes `null`, a non-boolean
  `done` is treated as `false`, and tags are re-normalised. This matters because
  an imported file is untrusted input.

## Accessibility

Semantic headings, labelled form controls, a real `<ul>` of tasks, visible focus
rings, `aria-live` status regions for saves and messages, and full keyboard
operation (including <kbd>Esc</kbd> to cancel an edit). Status filters are
toggle buttons with `aria-pressed`. The layout collapses to a single column on
narrow screens.

## Technical notes

- `tool.js` is the entire data model — validation, filtering, sorting, the
  immutable list operations, and the serialisation format. It is pure: it never
  touches the DOM, storage or the network, and it ships a UMD export so the same
  code runs in the browser and under `node tests/run.js`.
- `app.js` is the only file that talks to `localStorage` and the DOM. Every piece
  of user text reaches the page through `textContent` or `input.value`; the tool
  never uses `innerHTML`, `eval` or dynamic code execution, so a task title
  containing HTML is displayed as inert text.
- Saves are debounced by 250 ms so rapid edits do not thrash storage, and a
  "Saved" flag confirms each write. If storage is unavailable or full, the tool
  says so plainly and tells you to export rather than failing silently.
- Rendering is capped at 300 rows at a time with a note when more match, which
  keeps the interface responsive on very large boards.
- No dependencies. No build step.

## Tests

```
node tests/run.js
```

The suite covers date handling (including leap years, DST and impossible dates),
tag normalisation, validation, creation, due-status bucketing, statistics,
filtering and sorting, the immutable operations, a full serialise/deserialise
round trip, legacy and bare-array imports, malformed input, hostile field values,
and the size caps.
