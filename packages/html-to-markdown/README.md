# @neore/html-to-markdown

HTML to Markdown, forked from [turndown](https://github.com/mixmark-io/turndown) 7.2.5 (MIT, Dom Christie and
contributors). The fork starts at upstream commit `b86e2b18539fa4922acf7001902255e2ce5bf0b9`. See [NOTICE](./NOTICE)
for the attributions and [LICENSE](./LICENSE) for the upstream MIT text.

```ts
import TurndownService from "@neore/html-to-markdown";

const markdown = new TurndownService().turndown("<p>Hello <strong>world</strong></p>");
// "Hello **world**"
```

Options and extension points (`addRule`, `use`) are the same as upstream's, with four API differences:

- `TurndownService` must be constructed with `new` (upstream also allowed a call without it).
- `escape` is an instance property, so overriding `TurndownService.prototype.escape` has no effect.
- Only own rules of `options.rules` are read, not inherited ones (upstream read inherited enumerable keys too).
- Built-in rules no longer win over `keep` and `remove`, so `keep("p")` on `<p>Hello world</p>` gives `<p>Hello world</p>`,
  where upstream gives `Hello world`, and `remove("i")` drops an `<i>` and its content. The order is: the blank rule,
  rules added with `addRule` (newest first), then `keep`, then `remove`, then the built-in rules. A blank element goes to
  the blank rule first, even past `addRule` and `keep`, so `keep(["p"])` on `<p></p>a` gives `a`. An `addRule` rule still
  comes before `keep`, and a tag in both `keep` and `remove` is kept. `remove` does not convert the removed element's
  children. `keep` does, so a custom `keepReplacement` receives the converted content. The default `keepReplacement`
  ignores its content, so the children of a kept element are not converted either. With the default, a referenced link
  inside a kept element leaves no orphan `[1]: x` definition. A custom `keepReplacement` that ignores `content` still
  converts the children, so `<span><a href="x">l</a></span>` with `linkStyle: "referenced"` and
  `keepReplacement: (c, n) => n.outerHTML` gives `<span><a href="x">l</a></span>\n\n[1]: x`.

Keeping or removing a structural tag drops its Markdown. The tag is output as HTML, or removed, so no list markers or
code fences are left:

```ts
const service = new TurndownService();

service.keep(["li"]);
service.turndown("<ul><li>a</li><li>b</li></ul>"); // "<li>a</li>\n\n<li>b</li>"

const pre = new TurndownService();

pre.keep(["pre"]);
pre.turndown("<pre><code>x</code></pre>"); // "<pre><code>x</code></pre>", raw HTML, not a code block
```

## GitHub Flavored Markdown

`gfm` is a plugin for tables, strikethrough and task list items:

```ts
import TurndownService, { gfm } from "@neore/html-to-markdown";

new TurndownService().use(gfm).turndown("<table><tr><th>a</th></tr><tr><td><s>1</s></td></tr></table>");
// "| a |\n| --- |\n| ~~1~~ |"
```

- A table's first row is its header. A cell that spans columns or rows leaves empty cells, so the cells after it stay
  under their own headers. A cell spans down to the end of its row group at most. A caption goes above the table.
- A cell is one line: a line break is a space, a list is its items joined by `; `, a heading is strong text, and every
  pipe is escaped, inside code too. A table nested in a cell is the text of its cells.
- A table whose spans would fill more than 100,000 cells is written as its cells' text, a line per row.
- `<del>`, `<s>` and `<strike>` are `~~text~~`. A checkbox is `[x] ` or `[ ] `.
- An element that a `remove` filter matches is left out, even where a gfm rule would write it.
- The table is laid out from the text gfm's own rules keep for each cell and caption. A rule added after `gfm` for
  `td`, `th` or `caption` takes those elements from it, and the table does not write what that rule returns: its output
  reaches the row mixed with the other cells', with no place in the grid.

## Paste preset

`paste` is a preset for HTML pasted into a chat composer, with the options it is written for:

```ts
import TurndownService, { paste, PASTE_OPTIONS } from "@neore/html-to-markdown";

new TurndownService(PASTE_OPTIONS).use(paste).turndown(html);
```

- It uses the `gfm` plugin, and `PASTE_OPTIONS` turns `safeLinks` on.
- What the page does not show is left out: an element with `hidden`, `aria-hidden="true"`, an `sr-only` or
  `visually-hidden` class, or a style whose last valid `display` is `none`, `visibility` is `hidden` or `collapse`, or
  `content-visibility` is `hidden` (an earlier `!important` declaration wins, and comments are skipped). A closed
  `<details>` is written as its summary alone, and a `<dialog>` that is not open is left out. So are scripts, styles, media, buttons, selects, text areas, embedded documents and
  `<svg>`. A checkbox is a task box (`[x] ` or `[ ] `), from the `gfm` rules. The checks apply to the elements inside
  what is converted, as all rules do: pass the HTML as a string, or a container, not a hidden element itself.
- An image is written as text only when it draws an emoji (its alt text) or a formula (an image with a `math` class,
  as inline math). Any other image is dropped: a pasted picture arrives as a file, if at all.
- A formula with a TeX annotation is written as inline math; without one, its visible text stays.
- The forms are the ones people type: `- ` and `1. ` with one space, a plain newline for a line break, fenced code,
  `#` headings, `*` emphasis and `---` rules.

The rest of the composer's paste behaviour (Word and Google Docs lists, formatting set by style, code languages)
follows in the next parts.

## Status

This is the first step of the fork: a behaviour-preserving TypeScript port, except for `keep` and `remove` on built-in
tags (see the API differences). Its output matches upstream 7.2.5 on:

- the 147 upstream golden cases, with their per-case options (`test/golden.test.ts`);
- the upstream API tests, ported (`test/turndown.test.ts`) and the edge-whitespace internals (`test/edge-whitespace.test.ts`);
- 1,500 seeded random documents in CI (`test/differential.test.ts`). Before the pull request was opened, the same
  generator also ran 40,000 documents across five seeds, with no differences.

The port also replaces four regular expressions that backtrack super-linearly with linear code: the edge-whitespace
split, the code-span padding check, the attribute line-break collapse and the trailing-whitespace trim. The
differential test covers each of them.

## Known limits (fixed in later steps)

- Runtimes without `DOMParser`, such as Node and Workers, have no default parser: tests and the bench pass
  `@mixmark-io/domino` to `setHTMLParser`. Domino is dropped when the converter moves onto an internal tree.
- Node's DOM is still mutated during conversion (upstream's design).
- Reference-style links keep their state on a shared rule object, as upstream does.
- `<style>`, `<script>`, `<noscript>`, `<template>` and `<title>` emit nothing (a divergence from upstream). Unsafe link
  destinations are kept unless the `safeLinks` option is on (off by default, as upstream). `display:none` content is not
  removed.

## Roadmap

1. This port (behaviour-identical), with goldens, a differential test and benchmarks.
2. An internal tree built from the DOM, DOMParser on the main thread, parse5 only for Node and offline use, domino removed.
3. Upstream fixes and the known issues above (per-line escaping, `<br>` handling, list `start`/`value`, hidden content,
   safe hrefs).
4. GFM: tables, strikethrough and task lists (the `gfm` plugin), then a paste preset (`paste`) with the rules the composer needs.
5. Use in the composer's paste path, loaded lazily.

## Scripts

- `pnpm test`: unit, golden and differential tests.
- `pnpm test:bench`: this port against upstream 7.2.5 on the paste fixtures, a 5 MB document and adversarial inputs.
