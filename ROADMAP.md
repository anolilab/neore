# Feature roadmap

Features that are missing or incomplete in Neore. Each feature includes its
current state, a full implementation plan, and the files involved. Features are
ordered by priority.

Backend paths below refer to `backend/lunora/` (the Lunora backend). Frontend
paths refer to `apps/web/src/`.

---

## Priority 1 — Billing and payments

### Current state

The database schema includes `stripeCustomerId` and `stripeSubscriptionId`
fields (on a separate branch) and a credit system with tier definitions
(`free`, `pro`, `enterprise`) in `backend/lunora/billing/plans.ts`. No active
payment processor is wired up. Users cannot subscribe, purchase credits, or
manage their billing.

### Goal

Integrate a payment processor (TBD — Stripe, Dodo Payments, or Polar) to support:

- Monthly and yearly subscription plans
- Per-message credit billing with variable costs per model tier
- A customer portal for self-serve subscription management
- Webhook-driven subscription state sync into the backend

### Implementation plan

**Phase A — Payment provider setup**

1. Choose and configure a payment provider, define two products:
   - `pro-monthly` — $10/month, 1,000 message credits
   - `pro-yearly` — $100/year, unlimited free-model messages
2. Add provider API keys and the webhook secret to `backend/.dev.vars` (local)
   and to the Alchemy deploy bindings (`alchemy.run.ts`).
3. Add the provider SDK to the `pnpm-workspace.yaml` catalog and to the
   backend's `package.json`.

**Phase B — Schema changes**

Extend the user record in `backend/lunora/auth/schema.ts` (or the billing
table) with these optional fields:

- `paymentCustomerId` (string)
- `paymentSubscriptionId` (string)
- `subscriptionStatus` (one of `active`, `canceled`, `past_due`)
- `planType` (one of `monthly`, `yearly`)
- `currentPeriodEnd` (number, epoch ms)

**Phase C — Credit cost model**

Create `backend/lunora/billing/creditCosts.ts` with a model-tier lookup:

| Tier | Pricing range | Credits per message |
|---|---|---|
| Free | $0 | 1 |
| Standard | < $3/M tokens | 1 |
| Premium | $3–$15/M | 2 |
| High premium | $15–$50/M | 5 |
| Ultra premium | > $50/M | 15–30 |

Add `creditCost` to each model's entry in `packages/ai/src/models/registry.ts`.

**Phase D — Backend functions**

Create the following internal functions:

- `backend/lunora/billing/provider.ts`
  - `createCustomer` (internal action) — called on first sign-in if no customer ID exists
  - `syncSubscription` (internal mutation) — writes subscription state from webhook payload
  - `getSubscriptionStatus` (query, authenticated) — returns plan type, credits remaining, period end

- `backend/lunora/billing/webhooks.ts`
  - `handleBillingWebhook` (HTTP action) — validates webhook signature, routes
    `subscription.created`, `subscription.updated`, `subscription.canceled`,
    and `order.created` events to `syncSubscription`

Register the webhook route in `backend/lunora/http.ts` at `POST /billing/webhook`.

**Phase E — Credit deduction in chat pipeline**

In `backend/lunora/chat/streaming/` (where the stream is started), before
starting the AI stream:

1. Look up the model's `creditCost` from the model registry.
2. Call an internal `checkAndDeductCredits` mutation that atomically reads the
   user's remaining credits and deducts them, failing with an
   `INSUFFICIENT_CREDITS` error code if the balance is too low.
3. Catch `INSUFFICIENT_CREDITS` in the stream error handler and send a
   structured error event to the frontend.

**Phase F — Frontend**

- `apps/web/src/features/settings/billing-tab.tsx` (new) — shows current plan,
  credits remaining, period end, and a **Manage billing** button that redirects
  to the provider customer portal.
- `apps/web/src/routes/dashboard/settings/billing.tsx` (new) — lazy-loads the
  billing tab and registers it in the settings modal.
- `apps/web/src/features/billing/upgrade-banner.tsx` (new) — inline banner shown
  when credits run out or when a free-tier user tries a premium model. Shown in
  the composer area.
- Wire the banner into the composer using the `getSubscriptionStatus` query.

**Phase G — Webhook testing**

Use the provider's sandbox/test environment during development. Add an admin
function `backend/lunora/admin/billing.ts` with a `grantTestCredits` internal
mutation for local testing.

### Files involved

```
backend/lunora/billing/plans.ts               — extend credit tier logic
backend/lunora/billing/provider.ts            — new: payment provider API calls
backend/lunora/billing/webhooks.ts            — new: webhook handler
backend/lunora/billing/creditCosts.ts         — new: model-tier credit lookup
backend/lunora/chat/streaming/                — add credit check before streaming
backend/lunora/http.ts                        — register webhook route
packages/ai/src/models/registry.ts            — add creditCost per model
apps/web/src/features/settings/billing-tab.tsx   — new
apps/web/src/routes/dashboard/settings/billing.tsx — new
apps/web/src/features/billing/upgrade-banner.tsx   — new
pnpm-workspace.yaml                           — add provider SDK to catalog
```

---

## Priority 2 — Dynamic model discovery

### Current state

All models are statically registered in `packages/ai/src/models/registry.ts`
as `MODEL_REGISTRY`. Adding a new model requires a code change and deployment.
OpenRouter and Requesty both expose public model-listing APIs with rich
metadata (pricing, context window, capabilities).

### Goal

Auto-fetch and cache the full model list from OpenRouter and Requesty on a
schedule. Merge the live list with the static registry so hand-tuned config
(display name, creditCost, latency flags) takes precedence. Expose a
`getAvailableModels` query the frontend model picker can subscribe to.

### Implementation plan

**Phase A — Periodic job for model sync**

Create `backend/lunora/models/sync.ts`:

- `syncModelsFromOpenRouter` (internal action) — fetches
  `https://openrouter.ai/api/v1/models`, normalizes each entry into a
  `ModelRecord` shape, and upserts into a `models` table.
- `syncModelsFromRequesty` (internal action) — same for Requesty's listing
  endpoint.
- Add both to the periodic-job list in `backend/lunora/crons.ts` to run every
  hour (periodic jobs are registered there, not as separate cron triggers).

**Phase B — Schema**

Add a `models` table to `backend/lunora/schema.ts` and claim it in the
`backend/lunora/models/module.ts` table list. Fields:

- `providerId` (string) — "openrouter", "requesty", etc.
- `modelId` (string) — provider's model ID
- `displayName` (string)
- `contextWindow` (number)
- `inputPricePer1M`, `outputPricePer1M` (optional numbers)
- `supportsVision`, `supportsTools`, `supportsReasoning`, `isDeprecated` (booleans)
- `lastSeenAt` (number)

Indexes: `by_provider` on `providerId`, `by_modelId` on `modelId`.

**Phase C — Query layer**

In `backend/lunora/models/functions.ts`:

- `getAvailableModels` (query, public) — reads the `models` table, merges with
  the static registry (static config wins on conflicts), filters out deprecated
  entries, and returns a sorted list.
- `getModelById` (query, public) — single model lookup by `modelId`.

**Phase D — Frontend**

- Replace the static import of the model registry in the model picker component
  with the `getAvailableModels` cRPC query.
- The model picker must handle a loading state while the query resolves on
  first load.
- Keep the static registry as an override layer for hand-tuned config; the sync
  job only populates rows that don't conflict.

### Files involved

```
backend/lunora/models/schema.ts        — new: models table definition
backend/lunora/models/sync.ts          — new: sync actions
backend/lunora/models/functions.ts     — new: getAvailableModels query
backend/lunora/crons.ts                — register hourly sync
packages/ai/src/models/registry.ts     — remains as override layer
apps/web/src/features/chat/model-picker/ — consume live query
```

---

## Priority 3 — Named presets system

### Current state

Users can configure a model, system prompt, temperature, and tools per thread.
These settings are lost when starting a new thread. There is no way to save a
named configuration and reuse it.

### Goal

Let users save named presets (a bundle of model + system prompt + temperature +
tool selection), apply a preset when starting a new thread, and share presets
with other users via a link.

### Implementation plan

**Phase A — Schema**

Add a `presets` table in `backend/lunora/presets/module.ts`'s table list, with
the definition in `backend/lunora/presets/schema.ts`. Fields:

- `userId` (id of the owning user)
- `name` (string), `description` (optional string)
- `modelId` (string)
- `systemPrompt` (optional string), `temperature` (optional number)
- `enabledTools` (optional array of strings)
- `isDefault` (boolean), `isPublic` (boolean)
- `shareId` (optional string) — random 20-char ID for sharing
- `version` (number)

Indexes: `by_user` on `userId`, `by_shareId` on `shareId`.

**Phase B — Backend functions**

Create `backend/lunora/presets/functions.ts` (all mutations require auth):

- `createPreset` (mutation) — validates name uniqueness per user, sets
  `version: 1`.
- `updatePreset` (mutation) — increments `version`, enforces ownership.
- `deletePreset` (mutation) — enforces ownership.
- `setDefaultPreset` (mutation) — clears any existing default for the user,
  sets `isDefault: true` on the target.
- `sharePreset` (mutation) — generates a `shareId` and sets `isPublic: true`.
- `listPresets` (query, authenticated) — returns all presets for the current
  user.
- `getSharedPreset` (query, public) — looks up by `shareId`, returns public
  presets only.
- `importSharedPreset` (mutation, authenticated) — copies a shared preset into
  the current user's library.

**Phase C — Built-in templates**

Create `backend/lunora/presets/templates.ts` with ~10 starter presets (coding,
analysis, writing, general). These are returned by `listPresets` as read-only
entries when the user has no presets yet.

**Phase D — Frontend**

- `apps/web/src/features/presets/` (new directory)
  - `PresetManager.tsx` — full CRUD modal (list, create, edit, delete,
    share).
  - `PresetSelector.tsx` — compact dropdown shown in the composer toolbar,
    applies preset to the current thread config.
  - `PresetCard.tsx` — card component used in the manager list.
- Wire `PresetSelector` into the composer toolbar.
- Add **Presets** as a tab in the settings modal for managing saved presets.
- On the route `/presets/shared/[shareId]`, render a public preset preview
  with an **Import** button.

### Files involved

```
backend/lunora/presets/schema.ts        — new
backend/lunora/presets/functions.ts     — new
backend/lunora/presets/templates.ts     — new
apps/web/src/features/presets/          — new directory
apps/web/src/routes/presets/            — new: shared preset page
apps/web/src/features/settings/         — add Presets tab
```

---

## Priority 4 — Token metrics dashboard

### Current state

Credits are deducted per message but the actual token counts, latency, and per-
message cost breakdown are not recorded. Users have no visibility into what
they're spending or how fast models respond.
### Goal

Record token usage, cost, and timing per message. Expose a per-user dashboard
showing daily cost charts, model breakdown, and key performance metrics (time
to first token, tokens per second).

### Implementation plan

**Phase A — Schema**

Add a `tokenUsage` table in `backend/lunora/billing/token-usage.ts`. Fields:

- `userId` (id), `threadId` (id), `messageId` (id)
- `modelId` (string)
- `inputTokens`, `outputTokens` (numbers)
- `estimatedCostUsd` (number)
- `timeToFirstTokenMs`, `totalDurationMs`, `tokensPerSecond` (optional numbers)
- `createdAt` (number)

Indexes: `by_user_date` on `userId` + `createdAt`, `by_thread` on `threadId`.

**Phase B — Recording in the chat pipeline**

In the streaming path (`backend/lunora/chat/streaming/`), after the AI stream
completes:

1. Read `usage` from the AI SDK response (input/output token counts).
2. Record timing: capture `Date.now()` at stream start and at first chunk.
3. Call `recordTokenUsage` (internal mutation) with all metrics.

The Vercel AI SDK exposes usage via the `onFinish` callback in `streamText`:

```ts
onFinish: ({ usage, response }) => {
  await ctx.runMutation(internal.billing.tokenUsage.record, {
    userId, threadId, messageId,
    modelId: selectedModel,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    estimatedCostUsd: calculateCost(selectedModel, usage),
    timeToFirstTokenMs,
    totalDurationMs: Date.now() - streamStartTime,
    tokensPerSecond: usage.completionTokens / (totalDuration / 1000),
  });
}
```

**Phase C — Query layer**

In `backend/lunora/billing/token-usage.ts`:

- `getTokenUsageSummary` (query, authenticated) — returns daily aggregates for
  the last 30 days: total cost, input/output tokens, message count.
- `getModelBreakdown` (query, authenticated) — returns per-model cost and
  token totals.
- `getMessageMetrics` (query, authenticated) — per-message metrics for a given
  thread.

**Phase D — Frontend**

Create `apps/web/src/features/token-metrics/` with:

- `TokenMetricsDashboard.tsx` — top-level wrapper with date range selector.
- `DailyCostChart.tsx` — line chart of daily spend (use the existing charting
  library already in the project).
- `ModelBreakdownTable.tsx` — table of cost and token counts by model.
- `MessageTokenMetrics.tsx` — shown inline below each assistant message: input
  tokens, output tokens, TTFT, tokens/sec, estimated cost.

Add a **Usage** tab to the settings modal linking to the dashboard.

### Files involved

```
backend/lunora/billing/token-usage.ts          — new: schema + record mutation + queries
backend/lunora/chat/streaming/                 — add onFinish recording
apps/web/src/features/token-metrics/           — new directory
apps/web/src/features/settings/                — add Usage tab
```

---

## Priority 5 — PDF export

### Current state

`backend/lunora/chat/sharing.ts` exposes `getFullThreadForExport` which returns
the raw thread data. There is no client-side rendering of this data into a
downloadable PDF.

### Goal

Add a **Download as PDF** button to the thread view that generates a formatted,
paginated PDF from the conversation, preserving markdown, code blocks, and
structure.

### Implementation plan

**Phase A — Dependencies**

Add `@react-pdf/renderer` to `pnpm-workspace.yaml` catalog and to
`apps/web/package.json`. This library renders a React component tree to a PDF
binary entirely in the browser.

**Phase B — PDF template component**

Create `apps/web/src/features/chat/export/ThreadPdf.tsx`:

```tsx
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

export function ThreadPdf({ thread, messages }) {
  return (
    <Document>
      <Page style={styles.page}>
        <View style={styles.header}>
          <Text>anole.chat — {thread.title}</Text>
        </View>
        {messages.map((msg) => (
          <MessageBlock key={msg._id} message={msg} />
        ))}
        <View style={styles.footer} fixed>
          <Text render={({ pageNumber, totalPages }) =>
            `${pageNumber} / ${totalPages}`
          } />
        </View>
      </Page>
    </Document>
  );
}
```

`MessageBlock` handles role labels (User / Assistant), plain text, and renders
code blocks in a monospace style. Markdown parsing uses a minimal text
transformer (strip `*`, `**`, `#` for structural formatting; preserve code
fence content verbatim).

**Phase C — Export trigger**

In the thread header toolbar (wherever the share button lives):

1. Add a **Download PDF** button.
2. On click, call `getFullThreadForExport` via cRPC.
3. Use `@react-pdf/renderer`'s `pdf()` function to generate a `Blob`, then
   trigger a browser download via `URL.createObjectURL`.

Because `@react-pdf/renderer` is large, load it lazily:

```ts
const { pdf } = await import("@react-pdf/renderer");
```

**Phase D — Styling**

Use `StyleSheet.create` for consistent spacing. Font: embed a subset of
`Inter` or fall back to `Helvetica`. Apply alternating background colors for
user vs. assistant turns.

### Files involved

```
apps/web/src/features/chat/export/ThreadPdf.tsx    — new: PDF template
apps/web/src/features/chat/export/usePdfExport.ts  — new: hook triggering download
apps/web/src/features/chat/thread-header/          — add Download PDF button
pnpm-workspace.yaml                                — add @react-pdf/renderer
apps/web/package.json                              — add @react-pdf/renderer
```

---

## Priority 6 — Smart code detection in the composer

### Current state

When users paste code into the message composer, it is treated as plain text.
Long code blocks reduce readability.

### Goal

Automatically detect pasted content that looks like code, wrap it in a
markdown code fence, and detect the programming language.

### Implementation plan

**Phase A — Detection logic**

Create `apps/web/src/features/chat/composer/codeDetector.ts`:

- `detectCode(text: string): { isCode: boolean; language: string }` — uses
  heuristics:
  - More than 2 lines with consistent indentation (tabs or ≥ 2 spaces).
  - Presence of common syntax tokens: `{`, `}`, `=>`, `function`, `def`,
    `class`, `import`, `export`, `SELECT`, `FROM`, `<tag>`.
  - File-extension-like patterns in the first line (shebang `#!/`).
- Language detection priority: check for shebang, then keyword density
  (Python: `def`/`import`; JS/TS: `const`/`=>`, `function`; SQL:
  `SELECT`/`FROM`; HTML: `<`/`>`; Shell: `$`/`#!/bin/bash`).

**Phase B — Paste handler**

In the composer textarea's `onPaste` handler:

1. Read `clipboardData.getData("text")`.
2. Run `detectCode(text)`.
3. If `isCode`, replace the pasted text with ` ```language\n{text}\n``` `.
4. Show a brief toast: "Code detected — wrapped in a code block. Press Ctrl+Z
   to undo."

**Phase C — Manual trigger**

Add a keyboard shortcut `Ctrl+K` (Mac: `Cmd+K`) that wraps the currently
selected text in a code fence. Register this in
`apps/web/src/features/chat/composer/keybindings.ts`.

### Files involved

```
apps/web/src/features/chat/composer/codeDetector.ts  — new: detection logic
apps/web/src/features/chat/composer/                 — add onPaste handler + Ctrl+K
apps/web/src/features/chat/composer/keybindings.ts   — register Ctrl+K binding
```

---

## Priority 7 — Provider health dashboard

### Current state

If an AI provider's API is down or degraded, users see cryptic error messages
in the chat interface. There is no system-level view of provider health.

### Goal

Fetch status from each provider's public status page on a schedule and surface
a health indicator in the settings modal and optionally inline in the model
picker.

### Implementation plan

**Phase A — Status fetching**

Create `backend/lunora/providers/health.ts`:

- Define a list of providers with their status-page JSON endpoints:
  - OpenAI: `https://status.openai.com/api/v2/status.json`
  - Anthropic: `https://status.anthropic.com/api/v2/status.json`
  - Google: `https://status.cloud.google.com/incidents.json`
  - Groq, OpenRouter, Requesty: their respective status endpoints (or a ping
    check to `/models`).
- `checkProviderHealth` (internal action) — fetches each endpoint, normalizes
  to `{ provider, status: "operational" | "degraded" | "outage", updatedAt }`,
  and upserts into a `providerHealth` table.
- Add to the periodic-job list in `backend/lunora/crons.ts` every 5 minutes.
 
**Phase B — Schema**

Add a `providerHealth` table (in `backend/lunora/providers/module.ts`'s table
list) with fields `provider` (string), `status` (one of `operational`,
`degraded`, `outage`), and `updatedAt` (number). Index: `by_provider` on
`provider`.

**Phase C — Query**

`getProviderHealth` (query, public) — returns the latest row per provider.

**Phase D — Frontend**

Create `apps/web/src/features/provider-health/ProviderHealthDashboard.tsx`:

- A table with a colored dot (green / yellow / red) per provider and a
  "Last updated" timestamp.
- Add a **Provider status** section inside the settings modal's **Chat** tab or
  as a standalone settings page.
- Optionally, show a small colored dot next to provider-grouped models in the
  model picker when status is not `"operational"`.

### Files involved

```
backend/lunora/providers/health.ts         — new: fetch + upsert + query
backend/lunora/providers/schema.ts         — new: providerHealth table
backend/lunora/crons.ts                    — add 5-minute health check
apps/web/src/features/provider-health/     — new directory
apps/web/src/features/settings/            — add status section
```

---

## Priority 8 — Admin cleanup dashboard

### Current state

The admin panel (`/dashboard/settings/admin/`) has user management and audit
logs. There is no automated or scheduled process for removing inactive
anonymous or stale user records.

### Goal

Add an interactive cleanup dashboard for admins to preview, configure, and
execute bulk removal of inactive users, with dry-run support and execution
logs.

### Implementation plan

**Phase A — Schema**

Add two tables in `backend/lunora/admin/cleanup.ts`:

- `cleanupConfigs` — `thresholdDays` (number: inactive for N days → eligible),
  `batchSize` (number: max deletions per run), `isEnabled` (boolean), and an
  optional reference to the scheduled job.
- `cleanupLogs` — `runAt` (number), `mode` (one of `dry_run`, `execute`),
  `eligibleCount`, `deletedCount`, `durationMs` (numbers), `triggeredBy`
  (string: "scheduled" or a user id). Index: `by_runAt` on `runAt`.

**Phase B — Backend functions**

In `backend/lunora/admin/cleanup.ts` (all require admin role):

- `previewCleanup` (action) — returns count of users matching cleanup criteria
  without deleting. Criteria: anonymous users last active > `thresholdDays`
  ago with no messages in that window.
- `executeCleanup` (action) — runs in batches of `batchSize`, deletes eligible
  users and their threads/messages, writes a `cleanupLogs` entry.- `scheduleCleanup` (mutation) — registers or cancels a recurring job.
- `getCleanupConfig` (query) — returns current config.
- `updateCleanupConfig` (mutation) — updates thresholds and batch size.
- `listCleanupLogs` (query) — paginated log history.

**Phase C — Frontend**

Create `apps/web/src/features/admin/AdminCleanupDashboard.tsx`:

- **Config panel** — editable threshold days and batch size, enable/disable
  toggle, scheduled vs. manual mode.
- **Preview panel** — shows eligible user count before executing.
- **Execute button** — with a confirmation dialog and dry-run checkbox.
- **Logs table** — paginated history of past runs with mode, counts, duration.

Add the dashboard to the existing `/dashboard/settings/admin/` route.

### Files involved

```
backend/lunora/admin/cleanup.ts                    — new: functions + schema
apps/web/src/features/admin/AdminCleanupDashboard.tsx — new
apps/web/src/routes/dashboard/settings/admin/      — add cleanup section
```

---

## Summary table

| # | Feature | Priority | Effort | Key new files |
|---|---|---|---|---|
| 1 | Billing / Polar | High | Large | `backend/lunora/billing/webhooks.ts`, `apps/web/src/features/settings/billing-tab.tsx` |
| 2 | Dynamic model discovery | High | Medium | `backend/lunora/models/sync.ts`, `backend/lunora/models/schema.ts` |
| 3 | Named presets | Medium | Medium | `backend/lunora/presets/`, `apps/web/src/features/presets/` |
| 4 | Token metrics | Medium | Medium | `backend/lunora/billing/token-usage.ts`, `apps/web/src/features/token-metrics/` |
| 5 | PDF export | Medium | Small | `apps/web/src/features/chat/export/ThreadPdf.tsx` |
| 6 | Smart code detection | Low | Small | `apps/web/src/features/chat/composer/codeDetector.ts` |
| 7 | Provider health | Low | Small | `backend/lunora/providers/health.ts`, `apps/web/src/features/provider-health/` |
| 8 | Admin cleanup | Low | Small | `backend/lunora/admin/cleanup.ts`, `apps/web/src/features/admin/AdminCleanupDashboard.tsx` |
