# UI PACKAGE KNOWLEDGE BASE

**Generated:** 2026-01-23 20:32:15
**Updated:** 2026-10-10 (spreadsheet components)
**Parent:** ../../AGENTS.md

## OVERVIEW

Base UI component library with form elements, data grid, and AI-specific components.

## STRUCTURE

```text
packages/ui/src/
├── components/          # UI components
│   ├── ui/            # Base UI elements
│   ├── form/          # Form components
│   ├── data-grid/      # Data presentation
│   ├── ai-elements/    # AI-specific components
│   └── spreadsheet/   # Spreadsheet renderers, editor, XLSX utils
├── hooks/              # React hooks
├── lib/                # Utilities
├── icons/              # Icon system
├── types/              # TypeScript definitions
└── utils/              # Helper functions
```

## WHERE TO LOOK

| Task            | Location                | Notes                                         |
| --------------- | ----------------------- | --------------------------------------------- |
| Base components | components/ui/          | Buttons, inputs, layouts                      |
| Forms           | components/form/        | Form validation, handling                     |
| Data grid       | components/data-grid/   | Table components                              |
| AI elements     | components/ai-elements/ | AI-specific UI                                |
| Spreadsheet     | components/spreadsheet/ | CSV/XLSX viewers, Univer editor, XLSX convert |
| Hooks           | hooks/                  | Reusable logic                                |
| Icons           | icons/                  | Icon system                                   |

## CONVENTIONS

- **Component-driven**: Reusable, composable components
- **Type-safe**: Full TypeScript coverage
- **Design system**: Consistent styling and patterns
- **Form ready**: Built-in validation and handling

## SPREADSHEET COMPONENTS

```text
components/spreadsheet/
├── index.tsx                 # Barrel exports (renderers, thumbnail, univer utils)
├── csv-renderer.tsx          # Read-only CSV viewer (search, sort, pagination)
├── csv-table.tsx             # Low-level CSS Grid table
├── xlsx-renderer.tsx         # Multi-sheet Excel viewer (read-only)
├── spreadsheet-thumbnail.tsx # Mini 4×4 preview table for artifact cards
├── univer-sheet-editor.tsx   # Editable spreadsheet (Univer.js) — code-split
├── univer-utilities.ts       # csvToUniverWorkbook / univerWorkbookToCsv
├── formula-engine.ts         # Cell ref/range types + formula support
└── xlsx-convert.tsx          # xlsxFileToCSV / downloadAsXlsx — code-split
```

**Code-split imports** (NOT in the barrel to keep bundle small):

```ts
// Univer editor (lazy React component)
const UniverSheetEditor = lazy(() => import("@neore/ui/components/spreadsheet/univer-sheet-editor"));

// XLSX import/export utils (dynamic import)
const { downloadAsXlsx, xlsxFileToCSV } = await import("@neore/ui/components/spreadsheet/xlsx-convert");
```

**Key design decisions:**

- Storage format is always **CSV** (`documents.content`). XLSX is an interchange format only.
- `xlsxFileToCSV` imports first sheet; callers should warn when `sheetCount > 1`.
- `downloadAsXlsx` produces flat-data XLSX (no formulas/cell formatting).
- `SpreadsheetThumbnail` uses IntersectionObserver for lazy parsing.
- Package exports pattern is `"./components/*": "./src/components/*.tsx"` — new files must use `.tsx` extension even if they contain no JSX.

## ANTI-PATTERNS

- Don't create components without proper TypeScript types
- Don't hardcode styles - use design tokens
- Don't bypass form validation patterns
- Don't mix presentation with business logic
