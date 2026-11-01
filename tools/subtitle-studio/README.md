# Subtitle Studio

Open a SubRip (`.srt`) or WebVTT (`.vtt`) subtitle file and work on it like an
editor: retime and stretch cues, repair overlaps, find and replace, rewrap long
lines, check reading speed, split and merge, then export the result. Everything
is parsed and edited locally in your browser — the file never leaves your
machine.

## Why

Subtitle files arrive from everywhere and are usually slightly wrong. A file
ripped at 25 fps is out of sync on a 23.976 fps release. A machine transcript
has overlaps and one-line cues hundreds of characters long. A translation pass
left stale `<font>` tags and doubled spaces. Fixing that by hand in a text editor
is slow and error-prone, and uploading the file to an online service means
handing a copy of the video's script to someone else.

This tool covers the whole repair loop in one page: see what is wrong, fix it,
check it again, and download the corrected file.

## What it does

- **Parses both common formats.** SubRip and WebVTT are detected automatically,
  or you can force a format. It tolerates CRLF line endings, a UTF-8 BOM,
  optional cue indices and cue identifiers, WebVTT `NOTE` / `STYLE` / `REGION`
  blocks, and trailing cue settings such as `align:start`.
- **Shows a cue list** with a virtualized view, so a file with thousands of cues
  stays responsive. Cues with problems are flagged inline.
- **Edits cues directly.** Change the start, end and text of any cue, nudge it
  earlier or later, split it at its midpoint, merge it with the next cue, or
  delete it.
- **Retimes the whole file or one cue.** Shift by milliseconds, seconds or
  frames (using the selected frame rate), or stretch the timing by a percentage
  around an optional anchor — the usual way to convert between frame rates.
- **Repairs timing in one pass.** Sorts cues by start time, clamps negative
  times, removes overlaps, and enforces a minimum duration and an optional
  minimum gap between cues.
- **Cleans up text.** Find and replace across every cue, with regular
  expression, case-sensitive and whole-word options. Regular-expression
  replacements support capture groups and the usual `$1`, `$&`, `` $` `` and
  `$'` tokens. Rewrap long lines to a maximum length and line count. Strip
  inline markup (`<i>`, `<b>`, `<font …>`, WebVTT timestamp tags and ASS
  override blocks such as `{\an8}`).
- **QA pass.** Reports overlaps, cues that are too short or too long, cues with
  no text, reading speed above a characters-per-second limit, too many lines,
  and lines that are too long. Click any finding to jump to that cue.
- **Statistics.** Cue count, word count, runtime, average cue duration, average
  reading speed and the first cue's start time.
- **Exports SRT, WebVTT, plain text or CSV.** WebVTT export can keep cue
  identifiers; plain text can include or omit timecodes. CSV includes index,
  start, end, duration, character count, reading speed and text, so you can sort
  and filter a subtitle file in a spreadsheet.
- **One-click repair.** "Fix all problems" runs the timing repair, markup strip
  and rewrap in sequence, then re-runs the checks.

## How to use it

1. Drag an `.srt` or `.vtt` file onto the drop zone, click **Open file**, or
   paste subtitle text and click **Parse text**. **Load sample** fills the page
   with a small file that has an overlap, a too-short cue, a too-long cue and
   some markup, so you can see the checks working.
2. Work through the cue list. Click a cue to select it, or use the arrow keys.
   The cue editor appears below the list.
3. Use the retime, text and QA panels on the right to fix what the checks found.
4. Pick an output format and click **Copy** or **Download**. The download is
   named after the file you opened, with the new extension.

## Supported input

| Format | Extension | Notes |
| --- | --- | --- |
| SubRip | `.srt` | Optional numeric index lines; comma or dot milliseconds; hours optional. |
| WebVTT | `.vtt` | `WEBVTT` header, `NOTE`/`STYLE`/`REGION` blocks, cue identifiers, cue settings. |

Timecodes are accepted as `HH:MM:SS,mmm`, `HH:MM:SS.mmm`, `MM:SS.mmm` or
`MM:SS`. A cue whose block has no readable timecode line is skipped, and the
count of skipped blocks is reported rather than silently ignored.

## Limitations

- Styling is reduced to the tags each format supports. Inline markup is
  preserved through SRT/VTT export but is stripped by the **Strip markup**
  action, and WebVTT `STYLE` and `REGION` blocks are not written back out on
  export — the cues are.
- Plain-text and CSV exports flatten multi-line cues onto one line.
- Reading-speed checks use character count, not a language-specific timing
  model. The default limits (21 characters per second, 42 characters per line,
  two lines) are common broadcast conventions and are editable in the QA panel.
- Files are limited to 12 MB and 20,000 cues, which keeps parsing fast and
  prevents a pathological file from freezing the tab.
- There is no audio or video playback, so timing is edited by numbers and
  relative adjustments rather than by watching along. This keeps the tool fully
  local and dependency-free.

## Privacy

Everything runs in the browser. Files are read with the `File` API, parsed and
edited in memory, and exported with `Blob` downloads. There is no network
request, no analytics, no account and no storage — closing the tab discards the
work. `tool.json` records this as `privacy.dataUploaded: false` and
`privacy.storage: none`.

## Technical notes

The parsing, timing, QA and export logic lives in `tool.js` as a UMD module
exposed on `window.Toolshed.subtitleStudio` and via `module.exports`, so the same
code runs in the page and in the Node test suite. The cue list is virtualized:
only the rows in view are in the DOM, positioned against a spacer sized to the
full list. All user text is rendered with `textContent`, never `innerHTML`, and
nothing is ever evaluated as code.

## Tests

`node tests/run.js` (or `npm run test:tools` from the repository root) runs the
suite in `tests/`. It covers timecode parsing and formatting round trips, SRT
and VTT parsing including malformed and empty input, tag stripping, shifts,
stretching, overlap repair, find and replace, wrapping, split and merge, QA
rules, statistics, every export format, and a realistic edit pipeline.
