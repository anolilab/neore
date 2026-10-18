# Workflow canvas accessibility — Implementation Plan

**Created:** 2026-10-19
**Status:** Implemented (2026-10-19)
**Scope:** `apps/web/src/features/workflow/components/canvas/workflow-canvas.tsx`

## Why

The project targets WCAG 2.1 AA. The canvas is `@xyflow/react`, which ships its
own screen-reader strings (node/edge keyboard instructions, the live-region
announcements, controls and minimap labels) in English only, while the rest of
the app is translated with lingui. Its tab order also follows array order, not
the visual position of nodes (a known upstream issue), so keyboard users reach
nodes in the order they were created.

## Plan

1. Pass `ariaLabelConfig` (a prop of `@xyflow/react` ≥ 12.7 — confirm against
   the installed version) with lingui messages for every key. Built in a
   `useMemo` keyed on the active locale.
2. Give `<ReactFlow>` an `aria-label` for the canvas region, and the `MiniMap`
   an `ariaLabel`.
3. Tab order: render nodes sorted by `(y, x)` of their position before handing
   them to React Flow, via a pure `sortNodesForFocus` helper that returns the
   same array when already ordered. Only the DOM/focus order changes — node
   ids, store contents and persisted order are untouched. Selected/dragged
   nodes keep their z-index through React Flow's own `zIndex`, which is
   independent of array order.
4. Locale catalogs are extracted by the project's lingui flow; no hand edits to
   `messages.po`.

## Tests

`sort-nodes-for-focus.test.ts` (ordering, stability on ties, same reference when
already sorted) and a render test that the canvas receives a localized
`ariaLabelConfig`.

## Out of scope

Moving nodes with the keyboard beyond what React Flow already provides.

## As built

- `hooks/use-canvas-aria-labels.ts` returns the full `AriaLabelConfig` (typed in
  full, so a key added by a later `@xyflow/react` fails `tsc`).
- `utils/sort-nodes-for-focus.ts` keeps every parent ahead of its children and
  sorts a child by its absolute position; the store is untouched.
- Side effect: the stacking of overlapping UNSELECTED nodes now follows the
  sorted order, not creation order. Selected and dragged nodes are unaffected.
- Not covered: a render test of the whole canvas, and any check in a browser or
  with a screen reader.
