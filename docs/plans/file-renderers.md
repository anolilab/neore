# File Renderers — Implementation Plan

**Created:** 2026-03-06
**Status:** Planned
**Estimated Effort:** 20–28 hours

## Summary

Enhance in-chat file rendering with dedicated PDF, video, audio, and DOCX viewers, plus improved general file cards. All required heavy dependencies are already in the pnpm catalog — no new packages needed.

## What Already Exists

| Area | Key files | Notes |
|------|-----------|-------|
| Artifact cards | `apps/web/src/features/canvas/document-artifact.tsx` | Handles text, code, sheet, image, design |
| Canvas panel | `apps/web/src/features/canvas/canvas-panel.tsx` | Side panel with editors per kind; images open the Photon editor |
| Chat file parts | `packages/chat-ui/src/chat/message-content.tsx` | The file-part branch picks a lazy renderer by type (PDF, video, audio, DOCX, generic card) |
| File renderers | `packages/ui/src/components/file-renderers/` | `pdf-viewer`, `video-player`, `audio-waveform-player`, `docx-preview`, `pptx-preview`, `json-viewer`, `hex-viewer`, `generic-file-card`, `file-type-utilities` |
| Spreadsheet pattern | `packages/ui/src/components/spreadsheet/` | viewer + thumbnail + editor + lazy load |
| Vault / files | `backend/lunora/vault/` | Private storage, file metadata |

### Current State

Phases 1–5 below are partly shipped. In the tree today:

- PDF viewer (`pdf-viewer.tsx`), video player (`video-player.tsx`, media-chrome with hls.js loaded only for HLS), audio waveform player (`audio-waveform-player.tsx`, wavesurfer.js), DOCX preview (`docx-preview.tsx`, mammoth + DOMPurify), and the generic file card (`generic-file-card.tsx`).
- File-type predicates and `formatFileSize` in `file-type-utilities.tsx`.
- Inline routing by type in `message-content.tsx`, with every renderer lazy-loaded.

Not in the tree: the thumbnail components (`pdf-thumbnail`, `video-thumbnail`, `docx-thumbnail`), the mime-to-icon component (`file-type-icon`), and PDF / video / DOCX viewers in the canvas panel. Check each existing renderer against its phase below before extending it.

The custom Canvas waveform in the original Phase 3 design is not needed: `audio-waveform-player.tsx` already uses wavesurfer.js.

### Dependencies Already Cataloged

| Package | Catalog | Purpose |
|---------|---------|---------|
| `pdfjs-dist` 6.3.289 | file-renderers | PDF rendering. Pinned to the copy `react-pdf` depends on; a second copy breaks the worker. |
| `react-pdf` 11.0.0 | file-renderers | PDF viewer component |
| `media-chrome` 4.19.3 | utils | Video/audio player web components |
| `hls.js` 1.7.3 | file-renderers | HLS streaming (loaded only when needed) |
| `wavesurfer.js` 8.0.1 | file-renderers | Audio waveform |
| `mammoth` 1.13.0 | file-renderers | DOCX → HTML conversion |
| `dompurify` 3.4.16 | security | Sanitises DOCX and SVG output |

---

## Phase 1: PDF Viewer (Medium — 6–8 hrs)

### Shipped

**`packages/ui/src/components/file-renderers/pdf-viewer.tsx`** (lazy loaded). Confirm its feature list (page navigation, zoom, text search, text layer, virtualised pages) against the list below before extending it.

### Remaining

**`packages/ui/src/components/file-renderers/pdf-thumbnail.tsx`** (new file)
- Renders first page at 200px width
- Page count badge overlay
- Skeleton loading state

**Integration**
- `packages/chat-ui/src/chat/message-content.tsx`: PDF file parts render the thumbnail, and clicking it opens the canvas panel
- `apps/web/src/features/canvas/canvas-panel.tsx`: render `pdf-viewer` for PDF attachments with a toolbar (download, print, zoom, nav)
- `apps/web/src/features/canvas/document-artifact.tsx`: PDF thumbnail for artifact cards

### Implementation Notes
- Worker loaded separately, as the viewer already does (the worker is imported from `pdfjs-dist` as a `?url` asset).
- Bundle: ~400 KB (worker loaded async, doesn't block main bundle)

---

## Phase 2: Video Player (Medium — 5–7 hrs)

### Shipped

**`packages/ui/src/components/file-renderers/video-player.tsx`** (lazy loaded). Uses media-chrome for controls and loads hls.js only for HLS streams. Confirm playback speed, picture-in-picture, and error/retry against the list below.

### Remaining

**`packages/ui/src/components/file-renderers/video-thumbnail.tsx`** (new file)
- Poster frame or snapshot
- Duration badge overlay
- Play button icon overlay

**Feature list (confirm before building)**
- Playback speed selector: 0.5×, 1×, 1.5×, 2×
- Picture-in-picture support
- Loading spinner, error state with retry
- Responsive 16:9 container

### Integration
- `packages/chat-ui/src/chat/message-content.tsx`: video file parts render the thumbnail, and clicking it expands inline or opens the panel
- `apps/web/src/features/canvas/canvas-panel.tsx`: render `video-player` for video attachments

### Implementation Notes
- Bundle: ~50 KB (media-chrome) + ~60 KB (hls.js, conditional)

---

## Phase 3: Audio Player (Low-Medium — 3–4 hrs)

### Shipped

**`packages/ui/src/components/file-renderers/audio-waveform-player.tsx`** (lazy loaded) with wavesurfer.js. Replaces the Web Audio + Canvas waveform in the original design, which is not planned any more.

### Remaining

Confirm the list below against the shipped player; add what is missing.
- Play/pause button
- Waveform with progress overlay (played vs unplayed)
- Time display: current / total
- Playback speed: 1×, 1.5×, 2×
- Volume control
- Download button
- Compact layout: single row, ~60px height, full chat width

### Integration
- `packages/chat-ui/src/chat/message-content.tsx`: audio file parts render inline (already compact, no thumbnail needed)

### Implementation Notes
- No new dependencies. wavesurfer.js is already cataloged.

---

## Phase 4: DOCX Preview (Medium — 4–6 hrs)

### Shipped

**`packages/ui/src/components/file-renderers/docx-preview.tsx`** (lazy loaded). mammoth converts the document and DOMPurify sanitises the HTML before it renders.

### Remaining

**`packages/ui/src/components/file-renderers/docx-thumbnail.tsx`** (new file)
- First ~200 words of extracted text
- Document title if available
- Word count badge
- Document icon

Confirm the shipped preview covers style mapping for headings, lists and tables, embedded images as data URIs, and the document-style layout (max-width 800px, serif, scoped styles) before adding these.

### Integration
- `packages/chat-ui/src/chat/message-content.tsx`: DOCX file parts render the thumbnail, and clicking it opens the panel
- `apps/web/src/features/canvas/canvas-panel.tsx`: render `docx-preview` for DOCX attachments

### Implementation Notes
- Bundle: ~30 KB (mammoth)

---

## Phase 5: General File Card Improvements (Low — 2–3 hrs)

### Shipped

- `packages/ui/src/components/file-renderers/generic-file-card.tsx` (lazy loaded, used as the fallback in `message-content.tsx`)
- `packages/ui/src/components/file-renderers/file-type-utilities.tsx`: `getFileRendererType`, the `isPdf` / `isVideo` / `isAudio` / `isDocx` / `isImage` predicates, and `formatFileSize`

### Remaining

**`packages/ui/src/components/file-renderers/file-type-icon.tsx`** (new file, unless the generic card already maps icons; check first)
- Mime → icon mapping:
  - `application/pdf` → FileText
  - `video/*` → Video
  - `audio/*` → Music
  - `image/*` → Image
  - DOCX → FileText
  - XLSX → Sheet
  - PPTX → Presentation
  - `application/zip` → Archive
  - `text/*` → FileCode
- Color coding by category

Confirm the generic card covers the rest of the card spec: file name truncated with tooltip, size, type badge, download button, open/preview button when a renderer exists, hover highlight.

---

## New Files Summary

| # | Path | Phase | Status |
|---|------|-------|--------|
| 1 | `packages/ui/src/components/file-renderers/pdf-viewer.tsx` | 1 | Shipped |
| 2 | `packages/ui/src/components/file-renderers/pdf-thumbnail.tsx` | 1 | New |
| 3 | `packages/ui/src/components/file-renderers/video-player.tsx` | 2 | Shipped |
| 4 | `packages/ui/src/components/file-renderers/video-thumbnail.tsx` | 2 | New |
| 5 | `packages/ui/src/components/file-renderers/audio-waveform-player.tsx` | 3 | Shipped |
| 6 | `packages/ui/src/components/file-renderers/docx-preview.tsx` | 4 | Shipped |
| 7 | `packages/ui/src/components/file-renderers/docx-thumbnail.tsx` | 4 | New |
| 8 | `packages/ui/src/components/file-renderers/generic-file-card.tsx` | 5 | Shipped |
| 9 | `packages/ui/src/components/file-renderers/file-type-utilities.tsx` | 5 | Shipped |
| 10 | `packages/ui/src/components/file-renderers/file-type-icon.tsx` | 5 | New |

## Modified Files Summary

| # | Path | Change |
|---|------|--------|
| 1 | `packages/chat-ui/src/chat/message-content.tsx` | Thumbnails for PDF, video and DOCX file parts (routing by type already in place) |
| 2 | `apps/web/src/features/canvas/canvas-panel.tsx` | PDF, video, DOCX viewing in side panel |
| 3 | `apps/web/src/features/canvas/document-artifact.tsx` | PDF/DOCX thumbnail previews for artifact cards |

## New Dependencies

**None.** All required libraries already in pnpm catalog.

---

## Recommended Implementation Order

1. **Phase 5: File Card** — the icon mapping is the remaining piece; all other phases use the card as fallback
2. **Phase 1: PDF Viewer** — thumbnail and canvas panel wiring
3. **Phase 2: Video Player** — thumbnail and canvas panel wiring
4. **Phase 4: DOCX Viewer** — thumbnail and canvas panel wiring
5. **Phase 3: Audio Player** — confirm the feature list against the shipped player

Each phase is independently shippable.
