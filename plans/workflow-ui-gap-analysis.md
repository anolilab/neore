# Workflow UI Gap Analysis v2: Features & UX Improvements

**Date:** 2026-03-11 (v2, post-implementation audit)
**Reference:** https://github.com/shrimbly/node-banana (1,239 stars, MIT, actively maintained)
**Scope:** Visual workflow canvas UI, trigger automation UI, and UX polish
**Code:** `apps/web/src/features/workflow/` (canvas, nodes, hooks, stores, utils) and `backend/lunora/workflow/`, `backend/lunora/triggers/`

---

## Status of Original 13 Gaps

All 13 gaps from the original analysis have been **implemented and audited**:

| # | Gap | Status |
|---|-----|--------|
| 1 | Execution History Panel | Done: `components/canvas/execution-history-panel.tsx` with per-node expandable details |
| 2 | Node Output Preview | Done: `NodeOutputPreview` in `components/nodes/base-node.tsx` with image/text/JSON rendering |
| 3 | Connection Drop Menu | Done: `components/canvas/connection-drop-menu.tsx` with auto-edge creation |
| 4 | Prompt-to-Workflow AI | Done: `components/prompt-to-workflow-dialog.tsx` + `backend/lunora/workflow/generate.ts` |
| 5 | Cost/Token Usage Display | **Partial**: backend tracks `usage`, no per-node or summary UI yet (see F1) |
| 6 | Keyboard Shortcuts | Done: shortcuts in `hooks/use-workflow-shortcuts.ts` |
| 7 | Node Alignment/Layout | Done: H/V/D keys + toolbar buttons for align/distribute |
| 8 | Mask Drawing | Done: `components/nodes/mask-editor.tsx` canvas-based brush/eraser with `mask-section.tsx` |
| 9 | Multi-Select Toolbar | Done: duplicate, delete, group, align, distribute buttons |
| 10 | Trigger Execution History | Done: expandable per-trigger execution list |
| 11 | Trigger Inline Edit | Done: in-place edit form |
| 12 | Trigger Test Run | Done: `testRunTrigger` in `backend/lunora/triggers/functions.ts`, with status feedback |
| 13 | Webhook URL Display | Done: copyable URL in trigger card |

---

## New Gaps: Features

### F1. Cost / Token Usage UI (Remaining from #5)
**Priority: P1 | Effort: Medium | Backend Ready: Yes**
- Node usage arrives on `node_complete` events and is kept in the workflow store (`stores/workflow-store.ts`). `workflowExecutions.totalUsage` is stored. Neither is rendered.
- **Needed**: Per-node usage badge after execution (tokens and cost), and a summary column in the execution history panel. See `workflow-cost-indicators.md` for the cost formatting and tiers.
- **Location**: `NodeFooter` in `components/nodes/base-node.tsx`; `ExecutionRow` in `components/canvas/execution-history-panel.tsx`

### F2. Keyboard Shortcuts Help Dialog
**Priority: P1 | Effort: Small | Status: Done**
- `components/canvas/keyboard-shortcuts-dialog.tsx` opens on `?` and lists the shortcuts grouped by category.
- Still open: check the grouped list stays in step when a shortcut is added.

### F3. Node Input Validation
**Priority: P1 | Effort: Medium | Status: Partly done**
- `validateNodes()` in `utils/validate-workflow.ts` checks required fields, and `components/canvas/workflow-controls.tsx` calls it before a run.
- **Scope**: `image` (prompt required in generate mode), `inpaint` (prompt and mask required), `ai` (model required), `code` (code required), `branch` (condition required).
- **Still open**: a visible indicator on the node itself (red outline or warning icon). Confirm the current behaviour before adding it.

### F4. Circular Dependency Detection
**Priority: P1 | Effort: Small | Status: Partly done**
- `detectCycles()` in `utils/validate-workflow.ts` returns the node ids in a cycle, and `workflow-controls.tsx` calls it.
- **Still open**: the red-edge highlight on the canvas for a cycle, and a toast warning when a connection is made. Keep the run blocked while a cycle exists.

### F5. Auto-Layout Algorithm
**Priority: P2 | Effort: Medium | Status: Done**
- `autoLayout()` in `utils/auto-layout.ts` arranges the nodes left to right along the data flow. The "Auto-layout" button in `workflow-controls.tsx` calls `applyAutoLayout()` (in `hooks/use-workflow-shortcuts.ts`).
- No Dagre or ELK dependency is used. The layout is in-house.

### F6. Node Search / Command Palette
**Priority: P2 | Effort: Medium | Status: Partly done**
- `components/canvas/node-search-dialog.tsx` exists. Confirm whether it searches the existing nodes on the canvas (to pan and zoom to them) as well as the node types to add.
- **Still open**: fuzzy matching across all node types and a `Cmd+K` binding, if not already covered.

### F7. Comment / Annotation Nodes
**Priority: P3 | Effort: Small | Status: Done**
- `components/nodes/comment-node.tsx` exists and is in the node set.
- **Still open**: confirm markdown rendering and that the node has no handles.

### F8. Workflow Export / Import
**Priority: P3 | Effort: Small | Status: Done**
- `workflow-controls.tsx` exports the workflow to a JSON file and imports one from a `.json` file.
- **Still open**: validate the imported content against the workflow content shape before loading it.

### F9. Execution Dry-Run / Preview Mode
**Priority: P3 | Effort: Large | Status: Partly done**
- `handleDryRun` in `workflow-controls.tsx` runs a timed highlight of the execution order without calling any API.
- **Still open**: numbered execution-order badges on the nodes, and the estimated cost (see `workflow-cost-indicators.md`).

---

## New Gaps: UX / Polish

### U1. Node Top Toolbar Actions
**Priority: P1 | Effort: Small | Status: Partly done**
- Download is implemented (`handleDownload` in `components/nodes/node-top-toolbar.tsx`): images download as PNG, text and JSON as files. Upload is implemented (`handleFileChange`) and accepts image and video.
- The Tools dropdown lists Upscale, Inpaint, Outpaint, Remove BG and Img2Img (`IMAGE_TOOLS`), each with a node type.
- **Still open**: confirm each Tools item creates the right node, and what the bookmark button does. It reads a `bookmarked` flag from node data, but nothing in this audit confirmed a handler that sets it.

### U2. Model Lists Duplicated Between Node Body and Toolbar
**Priority: P2 | Effort: Small | Status: Done**
- The toolbar gets its model options from the gateway model list through `utils/model-options.ts`, the same source the node bodies use. No separate hard-coded arrays remain in `node-top-toolbar.tsx`.

### U3. Connection Drop Menu Shows All Node Types Regardless of Context
**Priority: P2 | Effort: Small | Status: Partly done**
- `connection-drop-menu.tsx` splits the node types into suggested and remaining groups (`suggestedNodeSet`).
- **Still open**: check that the suggestions follow the source node's output type (image source suggests image-compatible nodes, and so on).

### U4. No Loading Skeleton for Node Properties
**Priority: P3 | Effort: Trivial | Status: Not re-audited**
- When a node's model list is loading, the Select can show empty. Add a placeholder or skeleton to the Select triggers.

### U5. Group Node Collapse
**Priority: P2 | Effort: Medium | Status: Done**
- `components/nodes/group-node.tsx` has a collapsed state that hides the children and shows a child count badge.
- **Still open**: confirm the collapsed node shows its input and output count.

### U6. Execution History Panel Positioning
**Priority: P2 | Effort: Trivial | Status: Done**
- The panel uses `right-4` with flex layout, not the old hard-coded `right-[340px]` offset. Its width is still a fixed 320px, which is acceptable at the sizes the canvas supports today.

### U7. `ExecutionRow` Uses `Record<string, any>` Types
**Priority: P2 | Effort: Small | Status: Done**
- The execution history panel uses typed interfaces (`ExecutionRecord`).

### U8. Accessibility Gaps in Canvas Controls
**Priority: P2 | Effort: Small | Status: Partly done**
- Done: the mask editor's brush and eraser have `aria-label` and `aria-pressed`, and the execution history expand button has `aria-expanded`.
- **Still open**: the bottom toolbar toggle buttons have no `aria-pressed`, and the connection drop menu has no focus trap, so keyboard users can tab out.
- Target: WCAG 2.1 AA (see `CLAUDE.md`).

### U9. Prompt-to-Workflow Dialog Cast
**Priority: P3 | Effort: Trivial | Status: Done**
- `components/prompt-to-workflow-dialog.tsx` calls `loadContent` with a typed object. No `as any` cast remains in the workflow feature.

### U10. Bottom Toolbar Quick-Add Missing Many Node Types
**Priority: P2 | Effort: Trivial | Status: Done**
- `QUICK_ADD_GROUPS` in `components/canvas/workflow-bottom-toolbar.tsx` groups the node types, and covers the nodes that were missing earlier.

---

## Priority Summary

| Priority | Items | Theme |
|----------|-------|-------|
| **P1** | F1 (cost UI, open), F3 and F4 (indicators on nodes, open), U1 (toolbar, partly done) | **Safety & completeness**: things that erode trust or cause silent failures |
| **P2** | F6 (search, partly done), U3 (smart drop menu, partly done), U4 (skeletons), U8 (a11y, partly done) | **Polish & productivity** |
| **P3** | F9 (estimate and order badges, open), U4 (skeletons) | **Nice-to-have** differentiation |

---

## What We Have That node-banana Doesn't (Updated)

- **Real-time collaboration**: cursors, facepile, node lock indicators, presence (`components/collab/`, `workflowPresence`)
- **Trigger/automation system**: schedule (cron), webhook, event triggers with auto-continue (25 steps)
- **Version history**: `workflowVersions` snapshots with a restore action, plus separate undo/redo (`stores/history-store.ts`)
- **Gallery/publishing**: publish workflows to the community gallery with categories and tags (`backend/lunora/workflow/gallery.ts`)
- **Node grouping**: drag-to-nest with parent-child relationships, auto-resize, lock
- **27 specialized node types**: including controlnet, character-ref, style-ref, parallel-compare, advanced-controls
- **Rich per-node toolbar**: model picker, aspect ratio, number-of-images stepper, tools dropdown, expand-to-fullscreen, lock/bookmark/download
- **Mask drawing**: canvas-based brush/eraser for inpaint and object-editor masks
- **Connection drop menu**: auto-create and auto-connect nodes on connection drop
- **AI workflow generation**: natural language to a complete workflow via the prompt dialog
- **Backend persistence**: server-side workflow storage on Lunora with Better Auth

---

## Recommended Implementation Order

1. **F1 (cost and usage UI)**: backend data exists and is already streamed to the client; only rendering is missing
2. **F3 and F4 (node indicators)**: validation and cycle detection run, but their results are not shown on the nodes
3. **U1 (toolbar confirmation)**: confirm the Tools items and the bookmark behaviour, then close the item
4. **U8 (a11y)**: `aria-pressed` on the bottom toolbar, and a focus trap on the drop menu
5. **U3 (context-aware drop menu)**: filter suggestions by the source output type
6. **F9 (order badges and estimate)**: after F1, so the estimate can reuse the cost code
