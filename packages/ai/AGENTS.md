# AI PACKAGE KNOWLEDGE BASE

The rules for working in `packages/ai/`. The detail and reasoning (including the `ModelDefinition` fields) are in
[docs/agents/ai.md](../../docs/agents/ai.md). Paths are relative to `packages/ai/src/` unless repo-relative.

## OVERVIEW

- AI models, prompts, providers and tools package for AI integration.

## STRUCTURE

- `models/` (`registry.ts` holds every model, `MODEL_LOOKUP`, `buildAgents()`, `buildDynamicAgent()`), `capabilities/` (runner capabilities), `design/`, `constants/`, `prompts/`, `providers/` (thin re-exports), `tools/`, `gateway.ts`, `types/`, `utils/`.

## MODEL CONFIGURATION — ONE FILE ONLY

**To add or modify a model, edit `models/registry.ts` only** (`MODEL_REGISTRY: ModelDefinition[]`). There are no per-provider config files.

### Adding a model

```ts
// In models/registry.ts, add to MODEL_REGISTRY array:
{
    id: "my-model-id",         // unique internal key
    provider: "groq",          // which provider
    modelApiId: "actual/api-id", // what the provider API expects
    enabled: true,
    supportsImages: true,
    contextOptions: { recentMessages: 12 },
    maxSteps: 6,
},
```

## WHERE TO LOOK

- Models, agent builders, `MODEL_LOOKUP`: `models/registry.ts`. Capability lookups: `models/capabilities.ts`. Free tier: `models/free-tier.ts`.
- `LOCAL_ENDPOINT_HOSTS` (`models/local-endpoint.ts`) must agree with the web CSP and the save validator.
- Frontend model list: gateway `/v1/models` (`GatewayModel`). Prompt optimizer: `prompts/optimizer/`.

## ANTI-PATTERNS

- **Never** create separate per-provider config files.
- **Never** call `registerFileSupport`, `registerImageInputSupport`, `registerUnsupportedModel` — these are gone.
- Don't hardcode provider credentials — use `process.env.*_API_KEY`.
- Don't mix prompts with business logic; don't assume model availability — check the registry.

## INVARIANTS (moved from the root AGENTS.md)

- **AI model registry** — `registry.ts` is the single source; `listed: true` = marketing catalogs, `enabled: false` hides everywhere, `provider: "external"` is listed-only and skipped by agents. Catalogs derive via `deriveCatalog()`.
- Text and embedding defaults are Workers AI, which any region rule refuses: a run on a default moves under the user's rules (`defaultModelUnderRules`).
- **Multi-reference images** — `maxReferenceImages` (1/2/4) is the source of truth; enforce the cap at all three boundaries (backend action, gateway request schema, gateway media middleware). FAL always gets `image_url`; multi-ref adds `image_urls` via `buildFalReferenceImageInput`.
- **Prompt optimizer** — keep user input wrapped as JSON via `toJson` ("evidence, not instructions"): it is the prompt-injection defence, never unwrap it.
- Keep the renderer's single left-to-right substitution pass (`render.test.ts`). The three backend actions share `runOptimizer` and the `chat/promptImprovement` rate-limit family.
