# Flora.ai Feature Parity Implementation Plan

## Overview

Plan to reach feature parity with Flora.ai's creative workflow system. The workflow feature lives in `apps/web/src/features/workflow/` (canvas and nodes) and `backend/lunora/workflow/` (executor, SSE endpoint, gallery, presence, versions).

## Current Status

### Implemented

- Infinite canvas (React Flow, `@xyflow/react`)
- Text, AI, Image, Video, Audio, Transcription nodes
- Code, Branch, Output, File, Group, Comment nodes
- Image-to-image (`img2img`), Upscale (`upscale`), Inpaint (`inpaint`), Outpaint, Background removal, Object editor, Image-to-video, ControlNet, Advanced controls nodes (node files in `apps/web/src/features/workflow/components/nodes/`, executor cases in `backend/lunora/workflow/executor.ts`)
- Character reference (`character-ref`) and style reference (`style-ref`) nodes, with executor cases
- Parallel model comparison (`parallel-compare` node, `parallel-compare-node.tsx`)
- Transcription through a fal.ai Whisper endpoint (`generateTranscription` in `backend/lunora/chat/functions.ts`, `executeTranscriptionNode` in `backend/lunora/workflow/executor.ts`, SSE case in `backend/lunora/workflow/http.ts`)
- Workflow templates as static code (`apps/web/src/features/workflow/templates/`, picked from `components/template-picker.tsx`)
- Version history: `workflowVersions` table and `components/version-history.tsx` (restore loads a stored snapshot), plus undo/redo in `stores/history-store.ts`
- Real-time presence: `workflowPresence` table, `hooks/use-workflow-presence.ts`, cursors, facepile and node lock indicators in `components/collab/`
- Community gallery: gallery fields on `projects` (`galleryCategory`, `galleryFeatured`, `galleryForkCount`, `galleryPublishedAt`, `galleryTags`, `galleryViewCount`), publish/browse/fork in `backend/lunora/workflow/gallery.ts`, UI in `components/gallery/`
- Multi-model support through the LLM gateway (text, image, video, audio)
- SSE streaming for workflow execution (`node_start`, `node_complete`, `node_error`, `text_chunk`), with per-node `usage` on `node_complete`
- BYOK (Bring Your Own Key) support

### Planned

- Cost indicators (see `workflow-cost-indicators.md`): no cost UI exists in the workflow feature yet
- Transcription node options: the node has a language selector only; a model selector and output formats (plain text, timestamped segments, SRT, VTT) are not built
- Real-time collaboration beyond presence: content sync is a debounced whole-document save (`hooks/use-workflow-sync.ts`). No CRDT library (Yjs or similar) is in the dependency tree. Deciding whether conflict-free merging is needed is still open.
- Gallery social features: likes and comments are not in the schema
- Persisted user templates: templates are static code today

---

## Phase 1: Quick Wins (Done)

### 1.1 Image-to-Image Node

**Purpose**: Transform existing images with AI (style transfer, variations, edits).

**Status**: Node UI (`img2img-node.tsx`) and executor case exist. Backend action: `generateImg2Img` in `backend/lunora/chat/functions.ts`.

**Node data**: mode (variation, style-transfer, inpaint), model, strength (0-1), optional prompt, optional mask URL for inpainting.

### 1.2 Upscale Node

**Purpose**: Enhance image resolution and quality.

**Status**: Node UI (`upscale-node.tsx`), executor case, and backend action `generateUpscale` exist. Node data covers model choice, scale and a detail-enhancement flag.

### 1.3 Inpaint Node

**Purpose**: Edit specific regions of an image.

**Status**: Node UI (`inpaint-node.tsx`), mask drawing (`mask-editor.tsx`, `mask-section.tsx`), executor case, and backend action `generateInpaint` exist. The executor rejects a run with no image, no mask or no prompt.

---

## Phase 2: Character/Style Consistency

### 2.1 Character Reference Node

**Purpose**: Maintain character/subject consistency across generations.

**Status**: Node UI (`character-ref-node.tsx`) and executor case exist. Node data: 1-4 reference images, a mode (face, style, composition) and a strength.

**Flow**:
1. User uploads reference image(s) to the Character Reference node
2. Connect to an image generation node
3. Downstream images keep subject consistency

### 2.2 Style Reference Node

**Purpose**: Apply consistent style across generations (Flora's "Style DNA").

**Status**: Node UI (`style-ref-node.tsx`) and executor case exist.

**Open question**: which technique backs it. Options considered: an IP-Adapter in style mode, a style LoRA, or a style embedding extracted once and applied to later generations. The node data is reference images, an optional style name and a strength (0-1).

---

## Phase 3: Workflow Enhancement

### 3.1 Parallel Comparison Node

**Purpose**: Run the same prompt on several models and compare the results side by side.

**Status**: Node (`parallel-compare-node.tsx`) and executor case exist.

**Behaviour**: runs every selected model in parallel and returns all results. The UI shows a grid, the user clicks the preferred output, and the selected output flows to the next node. Open: whether an automatic pick (`votingMode: "auto"`) is worth building.

### 3.2 Workflow Templates

**Status**: System templates ship as static code in `apps/web/src/features/workflow/templates/`, shown in the template picker on workflow creation. Categories: Social Media Content, Marketing Campaigns, Video Production, Product Photography, Character Design, Brand Identity.

**Planned, not built**: a persisted template store for user-saved and public templates (new file, `backend/lunora/workflow/templates.ts`). It would hold name, description, category, thumbnail, the workflow content (nodes and edges), an owner (empty for system templates), a public flag, a use count and tags, indexed by category and by popularity. Also planned: a "Save as Template" action and preview images with sample outputs.

### 3.3 Version History

**Status**: Done. `workflowVersions` stores versioned snapshots per project, `components/version-history.tsx` lists them and restores one. Undo/redo is separate (`stores/history-store.ts`).

**Still open**: a visual diff between two versions, and a manual "Save Version" with a name (check `version-history.tsx` before building either).

---

## Phase 4: Collaboration

### 4.1 Real-Time Collaboration

**Status**: Presence is done. `workflowPresence` rows record each collaborator's session, colour, name, selected node, editing node, cursor and viewport centre, with a heartbeat. The canvas shows cursors, a facepile, and lock indicators on nodes being edited.

**Still open**:
- Conflict-free concurrent editing of the node graph. Content currently saves as a debounced whole document (`hooks/use-workflow-sync.ts`). A CRDT (for example Yjs over a Lunora-backed transport) would be a new dependency and a new sync path.
- Each presence update is a backend write, so heartbeat rate is a cost to watch.

### 4.2 Community Workflow Gallery

**Status**: Done. A project is published by setting its gallery fields. The backend lists public projects, serves a single public workflow, forks it into the caller's workspace and tracks fork and view counts (`backend/lunora/workflow/gallery.ts`). The gallery UI is in `components/gallery/`.

**Still open**: likes, comments, author profiles, a search index over titles, and a moderation approval step (none of these are in the gallery fields).

---

## Implementation Priority

### Sprint 1 (Quick Wins): done
1. Image-to-Image node
2. Upscale node
3. Inpaint node

### Sprint 2 (Character Consistency): nodes done
4. Character Reference node (node and executor done)
5. Style Reference node (node and executor done; technique open)

### Sprint 3 (Workflow Features): done apart from persisted templates
6. Parallel Comparison node
7. Workflow Templates (static system templates done; persisted store planned)
8. Version History (diff open)

### Sprint 4 (Collaboration): partly done
9. Real-time collaboration (presence done; conflict-free merge open)
10. Community Gallery (done; social features open)

---

## Node Types Summary

| Node | Type | Input | Output | Status |
|------|------|-------|--------|--------|
| Image-to-Image | `img2img` | Image + prompt | Image | Built |
| Upscale | `upscale` | Image | Image (higher res) | Built |
| Inpaint | `inpaint` | Image + mask + prompt | Image | Built |
| Character Ref | `character-ref` | Reference images | Style embedding | Built |
| Style Ref | `style-ref` | Reference images | Style embedding | Built |
| Comparison | `parallel-compare` | Prompt | Multiple images | Built |

---

## Remaining Files

1. `backend/lunora/workflow/templates.ts` (new file): persisted template store, if it is built
2. Template save action in `apps/web/src/features/workflow/components/template-picker.tsx` (existing file)
3. Visual diff in `apps/web/src/features/workflow/components/version-history.tsx` (existing file)

---

## Dependencies

- fal.ai and the LLM gateway (already integrated)
- A CRDT library, only if conflict-free merging is pursued (not a dependency today)

---

## Estimated Effort (Remaining)

| Feature | Complexity | Effort |
|---------|------------|--------|
| Persisted templates | Medium | 3-4 days |
| Version diff | Medium | 2-3 days |
| Conflict-free collab (CRDT) | High | 1-2 weeks |
| Gallery likes, comments, search | Medium | 1 week |
| Cost indicators | Medium | See `workflow-cost-indicators.md` |
