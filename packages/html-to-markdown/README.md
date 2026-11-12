# @neore/html-to-markdown

HTML to Markdown, forked from [turndown](https://github.com/mixmark-io/turndown) 7.2.5 (MIT, Dom Christie and
contributors). The fork starts at upstream commit `b86e2b18539fa4922acf7001902255e2ce5bf0b9`. See [NOTICE](./NOTICE)
for the attributions and [LICENSE](./LICENSE) for the upstream MIT text.

```ts
import TurndownService from "@neore/html-to-markdown";

const markdown = new TurndownService().turndown("<p>Hello <strong>world</strong></p>");
// "Hello **world**"
```

Options and extension points (`keep`, `remove`, `addRule`, `use`) are the same as upstream's, with three API differences:

- `TurndownService` must be constructed with `new` (upstream also allowed a call without it).
- `escape` is an instance property, so overriding `TurndownService.prototype.escape` has no effect.
- Only own rules of `options.rules` are read, not inherited ones (upstream read inherited enumerable keys too).

## Status

This is the first step of the fork: a behaviour-preserving TypeScript port. Its output matches upstream 7.2.5 on:

- the 147 upstream golden cases, with their per-case options (`test/golden.test.ts`);
- the upstream API tests, ported (`test/turndown.test.ts`) and the edge-whitespace internals (`test/edge-whitespace.test.ts`);
- 1,500 seeded random documents in CI (`test/differential.test.ts`). Before the pull request was opened, the same
  generator also ran 40,000 documents across five seeds, with no differences.

The port also replaces four regular expressions that backtrack super-linearly with linear code: the edge-whitespace
split, the code-span padding check, the attribute line-break collapse and the trailing-whitespace trim. The
differential test covers each of them.

## Known limits (fixed in later steps)

- Node has no default parser: tests and the bench pass `@mixmark-io/domino` to `setHTMLParser`. Domino is dropped when the
  converter moves onto an internal tree.
- Node's DOM is still mutated during conversion (upstream's design).
- Reference-style links keep their state on a shared rule object, as upstream does.
- Unsafe `javascript:` hrefs are not filtered, and `<style>`, `<script>` and `display:none` content is not removed.

## Roadmap

1. This port (behaviour-identical), with goldens, a differential test and benchmarks.
2. An internal tree built from the DOM, DOMParser on the main thread, parse5 only for Node and offline use, domino removed.
3. Upstream fixes and the known issues above (per-line escaping, `<br>` handling, list `start`/`value`, hidden content,
   safe hrefs).
4. GFM: tables, strikethrough, task lists, and a paste preset with the rules the composer needs.
5. Use in the composer's paste path, loaded lazily.

## Scripts

- `pnpm test`: unit, golden and differential tests.
- `pnpm test:bench`: this port against upstream 7.2.5 on the paste fixtures, a 5 MB document and adversarial inputs.
