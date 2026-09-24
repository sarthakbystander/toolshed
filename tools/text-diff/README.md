# Text Diff

Compare two versions of some text and see exactly what changed, line by line.

## What it does

- **Compare** two texts and highlight added, removed and unchanged lines
- **Stats** — the summary shows how many lines were added and removed
- **Clear** — reset both inputs

## How it works

The tool splits both texts into lines, computes a longest common subsequence
(LCS) so the diff is minimal and intuitive, then renders a side-by-side view:
coral rows were removed, green rows were added, and line numbers on each side
track source positions. Large inputs switch to a greedy matcher so the page
stays responsive. Press Ctrl/Cmd+Enter to compare.

## Privacy

Everything runs locally in your browser. Neither text ever leaves your tab.

## Limitations

- Line-level diff only — no intra-line character highlighting yet.
- Very large inputs (tens of thousands of lines) use the greedy matcher,
  which is faster but may produce a less optimal diff.
