# @neore/ui

The base component library: buttons, dialogs, forms, menus, the data grid, a
spreadsheet viewer/editor, markdown rendering, the AI-specific elements of the
chat, the shared hooks and utilities, and the global stylesheet. Private; it is
consumed as TypeScript source, with no build step.

Interactive primitives come from `@base-ui/react`, which provides ARIA roles,
keyboard navigation and focus trapping. Prefer composing those over writing a
custom widget. Used by `apps/web` (hundreds of imports), `apps/browser-extension`
and `packages/chat-ui`.

## Exports

Every export is a wildcard onto a source folder, so a new file is importable at
once, with no barrel to update:

| Path                     | Maps to                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@neore/ui/components/*` | `src/components/*.tsx`, nested folders included (`ai-elements/`, `data-grid/`, `form/`, `spreadsheet/`, `canvas-editor/`, `image-editor/`, `file-renderers/`, `elevenlabs/`) |
| `@neore/ui/hooks/*`      | `src/hooks/*.ts` (`use-data-grid`, `use-debounced-callback`, `use-streamdown-plugins`, …)                                                                                    |
| `@neore/ui/utils/*`      | `src/utils/*.ts` (`cn`, `code-highlighter`, `keyboard-shortcuts`, `relative-time`, `truncate`, …)                                                                            |
| `@neore/ui/icons/*`      | `src/icons/*.tsx` (provider and brand icons)                                                                                                                                 |
| `@neore/ui/global.css`   | `src/global.css`, imported once by the app stylesheet (`apps/web/src/styles.css`)                                                                                            |
| `@neore/ui/data/icons`   | `src/data/icons-data.ts`, the icon-picker's name/category/tag index                                                                                                          |

The `components` pattern ends in `.tsx`: a new component file must use that
extension even if it contains no JSX. A file in `src/lib/` is internal and has
no export path.

<!-- eslint-skip -->

```tsx
import { Button } from "@neore/ui/components/button";
import { cn } from "@neore/ui/utils/cn";
```

## Things to know

- **Accessibility is the target (WCAG 2.1 AA).** `eslint-plugin-jsx-a11y` is
  active; do not disable its rules. Icon-only buttons need an `aria-label`;
  decorative icons get `aria-hidden="true"`. `global.css` has a global
  `prefers-reduced-motion` rule, and motion components must respect it too.
- **KaTeX and Mermaid stay off the startup path.** Reach `@streamdown/math` and
  `@streamdown/mermaid` only through `@neore/ui/hooks/use-streamdown-plugins`.
  A static import anywhere makes them eager again.
- **Code blocks are highlighted by TanStack Highlight**, not Shiki:
  `utils/code-highlighter` is a Streamdown `CodeHighlighterPlugin`, and
  `utils/code-highlight-themes` holds a palette per theme name. A theme name
  added to the app's list needs a palette there, or it falls back to GitHub.
- **Spreadsheets:** CSV is the stored format; XLSX is interchange only. The
  Univer editor (`components/spreadsheet/univer-sheet-editor`) and
  `components/spreadsheet/xlsx-convert` are deliberately not in the barrel;
  load them with `lazy()` / dynamic `import()`.
- **The data grid** keeps every hook call of `useDataGrid` in
  `hooks/use-data-grid.ts`; the bodies of its large callbacks are plain
  functions under `hooks/data-grid/`. Do not turn them into `use*` hooks:
  `useDataGrid` has destructuring defaults, so the React Compiler skips it,
  and a new default-free hook would start being compiled (`AGENTS.md`).
- Strings that reach users go through Lingui; the catalogs live in the apps.

More detail: `AGENTS.md` (structure and the data-grid and spreadsheet layout)
and the root `CLAUDE.md`.

## Development

```bash
pnpm --filter @neore/ui run test         # vitest run
pnpm --filter @neore/ui run test:watch
pnpm --filter @neore/ui run lint:types   # tsc --noEmit
pnpm --filter @neore/ui run lint:eslint
pnpm --filter @neore/ui run lint:prettier
```

`scripts/generate-icons-data.js` rebuilds `src/data/icons-data.ts`; it clones
the Lucide repository, so run it by hand and only when refreshing the icon
index.

With `vis`, target the project by its `package.json` name:
`pnpm vis run test --projects=@neore/ui`.
