# Workflow Cost Indicators Implementation Plan

## Overview

Add cost indicators to the visual workflow builder to show relative pricing across models and provide cost estimates before and after execution.

## Goals

1. **Pre-execution cost estimates**: show estimated costs before running a workflow
2. **Model cost comparison**: display relative pricing in node model selectors
3. **Real-time cost tracking**: update costs as the workflow executes
4. **Post-execution cost summary**: show total cost breakdown after completion

## Existing Infrastructure to Leverage

### Model Pricing Data
- Gateway model list: `GatewayModel` in `packages/ai/src/models/gateway-types.ts`, with `pricing.input_per_million` and `pricing.output_per_million` (per 1M tokens)
- Model picker reads `model.pricing?.input_per_million` in `apps/web/src/components/model-picker/model-picker.tsx`

### Relative Cost Display (already built)
- `getCostMultiplier()` in `apps/web/src/components/model-picker/model-picker.tsx` maps a per-1M input price to 3×, 5×, 10× tiers. Extract it and reuse it for the workflow badge instead of writing a second tier table.
- `formatPricing()` in `apps/web/src/components/model-picker/utilities.ts` formats a per-1M price for display.

### Usage and Cost Formatting (already built)
- Chat: `formatCostUsd()` and `formatCredits()` in `apps/web/src/features/chat/thread/format-cost.ts` format gateway microdollars. The workflow cost display should use these, not a new `formatCost`.
- Chat: `MessageCostBadge` (`apps/web/src/features/chat/thread/message-cost-badge.tsx`) is the existing per-message cost badge. Match its look for the workflow node badge.
- Backend: `backend/lunora/agent/message-cost.ts` computes a message's cost.

### Workflow Usage Storage
- Each node's result carries `usage` (prompt, completion and total tokens). The SSE `node_complete` event sends it (`backend/lunora/workflow/http.ts`), and the client keeps it per node (`apps/web/src/features/workflow/hooks/use-workflow.ts`, `stores/workflow-store.ts`).
- Execution rows carry a `totalUsage` field (`workflowExecutions` in `backend/lunora/schema.ts`).
- Nothing in the workflow UI renders `usage` yet. The data exists; the display does not.

## Implementation Steps

### Phase 1: Cost Calculation Utilities

**New file: `packages/ai/src/models/cost.ts`**

Pure functions, no UI:
- `calculateCost(usage, price)`: tokens times per-1M price, for input and output, summed. Returns microdollars, to match the gateway and `formatCostUsd`.
- A relative tier for a per-1M input price, reusing the thresholds of `getCostMultiplier`. Move the thresholds here and have the model picker import them, so there is one table.
- `estimateWorkflowCost(nodes, models)`: sums a per-node estimate.

Per-node estimate assumptions (planning values, to be tuned):
- AI nodes: a fixed input and output token budget per node (on the order of 500 input and 1,000 output tokens)
- Image nodes: priced per image, not per token
- Video nodes: priced per second of output
- Audio nodes: priced per 1M characters
- Transcription nodes: priced per minute of audio, with the duration unknown until run, so the estimate uses a default length

### Phase 2: Model Selector Cost Display

**Modify: `apps/web/src/features/workflow/components/nodes/ai-node.tsx`**

Show the relative-cost badge next to the model selector trigger and in each option. The node model lists come from `apps/web/src/features/workflow/utils/model-options.ts`.

**New file: `apps/web/src/features/workflow/components/cost-badge.tsx`**

A small badge that takes a per-1M input price (or a per-unit price for media) and renders the relative tier. Two sizes (`sm` in dropdown rows, `md` on the trigger). Colour by tier, with text and not colour alone carrying the meaning, for WCAG 2.1 AA.

### Phase 3: Workflow Cost Estimate Panel

**New file: `apps/web/src/features/workflow/components/canvas/workflow-cost-panel.tsx`**

A small panel anchored bottom-right of the canvas. Collapsed, it shows the estimated total. Expanded, it lists the estimate per node with its model. It recomputes when nodes change (memoised on the node list) and renders nothing when the graph has no costed nodes.

### Phase 4: Real-time Execution Cost Tracking

**Modify: `apps/web/src/features/workflow/hooks/use-workflow.ts`**

On each `node_complete` event that carries `usage`, compute the node's cost from its model's price and add it to a per-node map and a running total. Node cost must use the model that ran the node. Keep the price lookup inside the hook so the component tree does not repeat it.

### Phase 5: Node Execution Cost Display

**Modify: `apps/web/src/features/workflow/components/nodes/base-node.tsx`**

Show the node's actual cost in its footer after the node completes (the footer is `NodeFooter`). Show nothing while running or when the cost is zero. This footer is also where the per-node usage badge from the gap analysis (F1 in `workflow-ui-gap-analysis.md`) would go, so build them together.

### Phase 6: Execution Summary Modal

**New file: `apps/web/src/features/workflow/components/execution-summary-modal.tsx`**

Shown after a run completes:
- Total cost, per node and per model
- Token usage totals
- Comparison of actual cost against the pre-run estimate

The execution history panel (`components/canvas/execution-history-panel.tsx`) is the other place to show a per-run total.

## Media Generation Cost Handling

Media generation (image, video, audio) has different pricing models:

| Type | Pricing Model | Example |
|------|---------------|---------|
| Image (Flux) | Per image | ~$0.003/image |
| Video (Mochi) | Per second | ~$0.25/second |
| Audio (TTS) | Per 1M characters | ~$15/1M chars |

These need their own cost path in `cost.ts`, keyed by model id, rather than the per-token formula. The table of unit prices is a planning value and should be checked against the provider's current price list before it ships. Where a run returns a cost from the gateway, prefer that over a computed estimate.

## UI Components Summary

| Component | Location | Purpose |
|-----------|----------|---------|
| `CostBadge` | Model selectors (`components/cost-badge.tsx`) | Show relative cost tier (3×, 5×, 10× and the existing picker tiers) |
| `WorkflowCostPanel` | Canvas bottom-right | Pre-execution estimate |
| Node cost footer | Below executed nodes (`base-node.tsx`) | Actual cost per node |
| `ExecutionSummaryModal` | After a run | Full cost breakdown |

## Files to Create

1. `packages/ai/src/models/cost.ts` (new): cost calculation and tiers
2. `apps/web/src/features/workflow/components/cost-badge.tsx` (new): cost indicator badge
3. `apps/web/src/features/workflow/components/canvas/workflow-cost-panel.tsx` (new): estimate panel
4. `apps/web/src/features/workflow/components/execution-summary-modal.tsx` (new): summary modal

## Files to Modify

1. `apps/web/src/features/workflow/components/nodes/ai-node.tsx`: cost badge in the model selector
2. `apps/web/src/features/workflow/components/nodes/image-node.tsx`: cost badge
3. `apps/web/src/features/workflow/components/nodes/video-node.tsx`: cost badge
4. `apps/web/src/features/workflow/components/nodes/audio-node.tsx`: cost badge
5. `apps/web/src/features/workflow/hooks/use-workflow.ts`: cost tracking in the streaming hook
6. `apps/web/src/features/workflow/components/nodes/base-node.tsx`: display execution cost
7. `apps/web/src/features/workflow/components/canvas/workflow-canvas.tsx`: add the cost panel
8. `backend/lunora/workflow/http.ts`: include the model price in SSE events, if the client cannot read it from the model list

## Dependencies

- Gateway model list with pricing (`packages/ai/src/models/`)
- Existing usage tracking (node `usage` on SSE events, `workflowExecutions.totalUsage`)

## Testing Strategy

1. Unit tests for `cost.ts` (calculation, tier boundaries, media units)
2. Component tests for `CostBadge` rendering, including the zero and unknown-price cases
3. Hook tests for cost accumulation from `node_complete` events
4. E2E test for a full workflow run showing node and total cost

---

# Transcription Node: Whisper Integration

## Overview

Transcription converts audio or speech to text. It runs a fal.ai Whisper endpoint.

## Current State

- **Backend action**: `generateTranscription` in `backend/lunora/chat/functions.ts`, an internal action. It takes the audio URL, language, model (a fal endpoint, default `fal-ai/whisper`), thread and user. It returns the full `text`, a `chunks` array of `{ text, timestamp }` entries, and the `model` used. It reads `FAL_API_KEY`.
- **Executor**: `executeTranscriptionNode` in `backend/lunora/workflow/executor.ts` finds the audio input from the upstream node, calls the action and passes only `text` downstream. The chunk timestamps are dropped.
- **SSE endpoint**: `backend/lunora/workflow/http.ts` has a `transcription` case that calls `executeTranscriptionNodeStreaming`, which returns the same text output.
- **UI**: `apps/web/src/features/workflow/components/nodes/transcription-node.tsx` has a language selector only (default "auto").

## Remaining Work

### Phase 1: Keep Timestamps and Add Node UI Options

- Pass the `chunks` through the executor and the SSE case as node metadata, not only `text`. Subtitle formats need the timestamps.
- **Modify: `apps/web/src/features/workflow/components/nodes/transcription-node.tsx`**: add a model selector (the fal Whisper endpoint is the only option today) and an output format selector: plain text, timestamped segments, SRT subtitles, VTT subtitles. Format SRT and VTT from the chunks.

### Phase 2: Cost Entry

Record the price of the fal Whisper endpoint in the cost table in `packages/ai/src/models/cost.ts` (see Media Generation Cost Handling). Transcription cost depends on audio duration. The action does not return a duration today, so either add it to the action's output or take the length from the file.

## Pricing

Not yet recorded for the fal endpoint in use. Look up the current per-minute price of `fal-ai/whisper` before adding the cost entry. Do not reuse an OpenAI list price, since the call does not go to OpenAI.

## Files to Modify

1. `backend/lunora/chat/functions.ts`: return duration with the chunks (only if cost needs it)
2. `backend/lunora/workflow/executor.ts` and `backend/lunora/workflow/http.ts`: pass chunks through as node metadata
3. `apps/web/src/features/workflow/components/nodes/transcription-node.tsx`: model and output format options

## Dependencies

- fal.ai API with `FAL_API_KEY` (set as a backend secret)
- Audio file fetching capability (the action fetches the audio URL)

---

## Future Enhancements

1. Cost optimization suggestions (recommend cheaper models)
2. Cost comparison between workflow versions
