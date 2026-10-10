# Designer / Canvas AI — Implementation Plan

**Created:** 2026-03-06
**Status:** Planned
**Estimated Effort:** 35–50 hours

## Summary

Extend the existing canvas/artifacts system with design-aware image generation, AI image operations (upscale, background removal, OCR, vectorize, composite), and a client-side image editing toolbar.

## What Already Exists

| Area | Key files | Notes |
|------|-----------|-------|
| Image gen tool | `backend/lunora/chat/tools/image-generation.ts` | FAL models (default `fal:flux-dev`) and Google via OpenRouter, resolved through the model registry |
| Image editing tool | `backend/lunora/chat/tools/image-editing.ts` | `imageEditing` tool: `remove_background`, `upscale`, `style_transfer`, `inpaint`, `face_enhance` |
| Upscale backend | `backend/lunora/chat/functions.ts` | `generateUpscale` action and the `callFalApi` helper |
| Vision tool | `backend/lunora/chat/tools/vision-analysis.ts` | `visionAnalysis`; its modes already include OCR |
| Canvas panel | `apps/web/src/features/canvas/canvas-panel.tsx` | Image artifacts open the lazy-loaded Photon editor (preview by default) |
| Document schema | `backend/lunora/schema.ts` | `documents` table with `kind` (already includes `design`), `content`, `contentJson`, `status` |
| Design presets and styles | `packages/ai/src/design/` | Presets, styles, templates, prompt enhancer |
| Cinema settings | `packages/ai/src/prompts/cinema.ts` | `buildCinemaPrompt`, the existing pattern for style-guided prompts |
| Workflow nodes | `backend/lunora/workflow/` | Upscale node (`executor.ts`) and background-removal node type (`core.ts`) |
| Canvas version history | `apps/web/src/features/canvas/components/canvas-version-history.tsx`, `backend/lunora/agent/document-history.ts` | Version history for documents |

---

## Part 1: Platform Presets (Low — mostly shipped)

**Shipped:** `packages/ai/src/design/presets.ts` (`DESIGN_PRESETS`, `getDesignPreset`, `getPresetsByCategory`, `DESIGN_PRESET_IDS`). Categories in use: social, marketing, print, web, custom. The canvas dialog that picks a preset is `apps/web/src/features/canvas/components/design-preset-selector.tsx`.

**Remaining:** add a `presetId` parameter to `backend/lunora/chat/tools/image-generation.ts` that looks up the preset and sets the dimensions. The image generation tool has no preset or style parameter today.

---

## Part 2: Design Styles (Low — mostly shipped)

**Shipped:** `packages/ai/src/design/styles.ts` (`DESIGN_STYLES`, 16 styles: minimal, bold, elegant, playful, corporate, retro, neon, organic, brutalist, gradient, flat, glassmorphism, isometric, watercolor, duotone, photographic). Each style carries prompt modifiers and negative hints.

Prompt composition is `enhanceDesignPrompt(userPrompt, style, preset)` in `packages/ai/src/design/prompt-enhancer.ts`, which replaces the `buildDesignPrompt` in the original design. Follow the `buildCinemaPrompt` pattern in `packages/ai/src/prompts/cinema.ts` if a new builder is needed.

**Remaining:** add a `styleId` parameter to `backend/lunora/chat/tools/image-generation.ts` that resolves the style and appends its modifiers to the generation prompt.

---

## Part 3: AI Image Operations as Chat Tools (Medium-High)

Expose existing backend capabilities and add the missing ones as AI-callable chat tools.

### 3a. Upscale (exists)
Covered by the `imageEditing` tool's `upscale` operation (2× and 4×), which sits on `generateUpscale` in `backend/lunora/chat/functions.ts`. Do not add a separate tool. Only change the existing one if the plan's input shape (`imageUrl`, `scale: 2 | 4`) is missing something.

### 3b. Background Removal (exists)
Covered by the `imageEditing` tool's `remove_background` operation. The workflow engine has a background-removal node type in `backend/lunora/workflow/core.ts`.

### 3c. OCR / Text Extraction (check first)
The `visionAnalysis` tool already lists OCR among its modes. Before adding a tool, check whether its output can carry `{ text, regions, confidence }`; if not, extend the vision tool rather than adding a new one.

### 3d. Vectorize (Raster to SVG) Tool (Medium-High)
**New file:** `backend/lunora/chat/tools/image-vectorize.ts`
- Input: `{ imageUrl, colorMode }`
- Uses `vtracer` WASM or external API. External calls belong in an action, not in the tool's direct code path.
- Returns: `{ svgContent, svgUrl }`

### 3e. Image Merge/Composite Tool (Medium-High)
**New file:** `backend/lunora/chat/tools/image-merge.ts`
- Input: `{ images: Array<{url, x, y, w, h}>, canvasWidth, canvasHeight }`
- Uses `sharp` for server-side compositing (`sharp` is in the pnpm catalog)
- Returns: `{ imageUrl }`

### 3f. Registration
**Modify:** `backend/lunora/chat/tools/index.ts` — add the new tools (vectorize, merge) to the `ToolName` enum and `getAllTools()`.

---

## Part 4: Client-Side Image Editing Toolbar (High — editor shipped)

### 4a. Canvas Toolbar Quick Actions (Low)
**Modify:** `apps/web/src/features/canvas/components/canvas-toolbar.tsx` (no image actions exist today)
- Add `imageActions`: Upscale 2×/4×, Remove BG, OCR, Vectorize
- Send them through the chat composer, using the `setComposerText` store action that `prompt-improvement-panel.tsx` already uses

### 4b. Image Editor (shipped on Photon)
The editor is built on Photon, already in the tree under `packages/ui/src/components/image-editor/`:

| File | Purpose |
|------|---------|
| `photon-image-editor.tsx` | The editor component |
| `photon-operations.ts` | Operation catalogue grouped as transform, adjust, color, filter, effect, channel; plus `FILTER_PRESETS` |
| `photon-types.ts` | Photon module types |
| `photon-editor-messages.tsx` | Editor UI messages |

Operations today include rotate (clockwise, counter-clockwise, 180°), flip (horizontal, vertical), brightness, contrast, hue, saturation, gamma, grayscale, sepia, invert, blur, sharpen, edge detection, noise reduction, and filter presets. No crop or text-overlay operation was found.

Before building any remaining editor capability (crop with aspect lock, text overlay, undo/redo), check which of these `photon-operations.ts` already covers. No extra editor dependency is needed.

### 4c. Canvas Panel Integration
**Modify:** `apps/web/src/features/canvas/canvas-panel.tsx`
- View mode: read-only preview (existing)
- Edit mode: the Photon editor, already lazy-loaded (existing)
- On save: export the edited image and write it back as a new document version, so it lands in the existing version history (`canvas-version-history.tsx`, `backend/lunora/agent/document-history.ts`). The save path is not built yet.

### 4d. Preset & Style Picker UI (Medium)
- Preset picker: already exists as `apps/web/src/features/canvas/components/design-preset-selector.tsx`. Extend it if needed; do not duplicate it.
- **New files:** `apps/web/src/features/canvas/components/style-picker.tsx` (horizontal strip of style cards) and `apps/web/src/features/canvas/components/designer-toolbar.tsx` (combined picker above the image generation prompt)

---

## Part 5: Schema Changes (Low)

**Modify:** the `documents` table in `backend/lunora/schema.ts`. Add:
- an optional `designerMeta` object, with optional `presetId`, `styleId`, original width and height, and a list of operations, each with a `type` (`"upscale"`, `"bg_remove"`, `"crop"`, ...) and a `timestamp`
- optional `imageWidth`, `imageHeight` and `imageFormat` columns

All of these are optional, so this is the widen step. Use the `lunora-migration-helper` skill for the change.

---

## New Files Summary

| # | Path | Phase | Status |
|---|------|-------|--------|
| 1 | `packages/ai/src/design/presets.ts` | 1 | Shipped |
| 2 | `packages/ai/src/design/styles.ts` | 2 | Shipped |
| 3 | `packages/ai/src/design/prompt-enhancer.ts` | 2 | Shipped |
| 4 | `backend/lunora/chat/tools/image-vectorize.ts` | 3 | New |
| 5 | `backend/lunora/chat/tools/image-merge.ts` | 3 | New |
| 6 | `apps/web/src/features/canvas/components/style-picker.tsx` | 4 | New |
| 7 | `apps/web/src/features/canvas/components/designer-toolbar.tsx` | 4 | New |

## Modified Files Summary

| # | Path | Change |
|---|------|--------|
| 1 | `backend/lunora/chat/tools/image-generation.ts` | Add `presetId`, `styleId` params |
| 2 | `backend/lunora/chat/tools/index.ts` | Register the new vectorize and merge tools |
| 3 | `backend/lunora/schema.ts` | Add `designerMeta` and image dimension fields to `documents` |
| 4 | `apps/web/src/features/canvas/canvas-panel.tsx` | Save path for edits; designer toolbar; new design entry |
| 5 | `apps/web/src/features/canvas/components/canvas-toolbar.tsx` | `imageActions` quick action array |
| 6 | `backend/lunora/chat/tools/vision-analysis.ts` | Only if OCR output needs the `{ text, regions, confidence }` shape |

## New Dependencies

None expected. The editor is already in place. `sharp` is in the pnpm catalog and may be needed by the merge tool.

---

## Implementation Order

| Phase | Steps | Complexity | Parallelizable |
|-------|-------|------------|----------------|
| **A** | Wire `presetId` and `styleId` into image generation (data already shipped) | Low | Yes |
| **B** | Confirm the `imageEditing` tool covers upscale and background removal; no new tools | Low | Yes |
| **C** | OCR (extend vision tool if needed), vectorize and merge tools (new backend actions) | Medium-High | Yes |
| **D** | Editor gaps only (crop, text overlay, undo/redo) if `photon-operations.ts` lacks them | Medium | Yes |
| **E** | Canvas integration: save path, toolbar, style picker, designer toolbar, version history | Medium | After A, B, D |

Phases A–D can run in parallel. Phase E depends on all of them.

## Risks

| Risk | Mitigation |
|------|-----------|
| FAL API rate limits / cost | Cache results in R2; show cost estimate before operation |
| Editor bundle size | Already code-split: the Photon editor is loaded lazily from the canvas panel |
| SVG vectorization quality | Offer detail options; show preview before saving |
| OCR accuracy | Use vision model; show confidence; allow edit |
