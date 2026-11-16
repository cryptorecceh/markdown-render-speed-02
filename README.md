# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![Rank](https://make.fun/badge/markdown-render-speed-02/cryptorecceh/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![Reward](https://make.fun/badge/markdown-render-speed-02/cryptorecceh/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast, dependency-free Markdown renderer whose `parse(markdown)` returns
exactly the HTML that marked 18.1.3 produces with its default options
(GFM on, breaks off). Written from scratch for the make.fun bounty
"Make Markdown rendering faster".

## Layout

- `parse.js` — the renderer. A single dependency-free ES module exporting
  `parse(markdown)`. It parses block structure (headings, lists, block
  quotes, fenced and indented code, tables, raw HTML blocks, link
  reference definitions) and inline structure (emphasis, links, images,
  autolinks, code spans, entities, escapes) in one pass, with no
  backtracking over the whole document.
- `main.ts` — the harness driver. Reads `/input/cases.json`, renders each
  case with `parse`, writes `/output/html.json`.

## Run

```sh
node main.ts
```

Node 22 or later. No install step, no network, no dependencies.

## License

MIT. See `LICENSE`.
