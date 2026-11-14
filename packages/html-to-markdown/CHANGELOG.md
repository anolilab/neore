# Changelog

## 0.1.0

<sub>2026-11-14</sub>

- fix(html-to-markdown): a one-line div placed straight in a list is parted by blank lines (#798)
- feat(web): composer paste converts HTML with @neore/html-to-markdown (#797)
- feat(html-to-markdown): paste budgets, raised text, inline code spaces and line forms (#789)
- feat(html-to-markdown): write formatting set by style and fence every code block in the paste preset (#785)
- feat(html-to-markdown): write Word, Google Docs and lettered lists in the paste preset (#783)
- feat(html-to-markdown): add a paste preset for hidden content, images and composer forms (#781)
- feat(html-to-markdown): add a gfm plugin for tables, strikethrough and task lists (#779)
- fix(html-to-markdown): apply keep and remove before built-in rules (#776)
- fix(html-to-markdown): escape link destinations and text that could start markup (#772)
- fix(html-to-markdown): merge adjacent emphasis and keep line breaks at edges (#721)
- fix(html-to-markdown): reset the rule cache when a rule is added (#739)
- fix(html-to-markdown): fix list starts, nested-list text and wrapped code blocks (#720)
- fix(html-to-markdown): drop non-content text and add safeLinks for paste (#719)
- perf(html-to-markdown): cut conversion time without changing output (#717)
- feat(html-to-markdown): port turndown 7.2.5 to TypeScript (part A) (#716)
