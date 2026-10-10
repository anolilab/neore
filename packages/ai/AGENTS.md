# AI PACKAGE KNOWLEDGE BASE

**Generated:** 2026-01-23 20:32:15
**Updated:** 2026-10-10 (single source of truth in registry.ts; speech models)
**Parent:** ./AGENTS.md

## OVERVIEW

AI models, prompts, providers, and tools package for AI integration.

## STRUCTURE

```text
packages/ai/src/
├── models/
│   ├── registry.ts       # ⭐ ALL models (MODEL_REGISTRY) + buildAgents() + buildDynamicAgent() + MODEL_LOOKUP
│   ├── types.ts          # ModelDefinition, AgentConfig, ProviderKind, ContextOptions, StorageOptions, UsageHandler
│   ├── capabilities.ts   # getFilePartSupportedMimeTypes, isImageInputUnsupportedModel, isToolCallUnsupportedModel
│   ├── gateway-models.ts # GATEWAY_{IMAGE,VIDEO,MUSIC,SPEECH}_MODELS derived from the registry
│   ├── local-endpoint.ts # LOCAL_ENDPOINT_HOSTS (loopback-only local model servers)
│   ├── free-tier.ts      # FREE_TIER_TEXT_MODELS, requiresPaidPlan
│   ├── custom-model-id.ts
│   └── index.ts          # Re-exports from above
├── design/               # Design presets, styles, templates, prompt enhancer
├── constants/            # e.g. cinema (`@neore/ai/constants/cinema`)
├── prompts/              # Prompt templates
├── providers/
│   └── index.ts          # Thin re-exports from models/ (preserves the @neore/ai/providers path the backend imports)
├── tools/                # AI tool definitions
├── gateway.ts            # Backend / gateway / web contract (plain data, no provider SDKs)
├── types/                # Shared types (cinema)
└── utils/                # AI utilities (region.ts)
```

## MODEL CONFIGURATION — ONE FILE ONLY

**To add or modify a model, edit `models/registry.ts` only.**

About 330 entries live in `MODEL_REGISTRY: ModelDefinition[]` in `registry.ts` (text, image, video, music, speech). There are no per-provider config files.

### ModelDefinition fields

```text
interface ModelDefinition {
    id: string;           // Internal key, used everywhere
    provider: ProviderKind; // "openrouter" | "fal" | "openai" | "groq" | "xai" | ... | "external" (listed-only)
    modelApiId: string;   // Actual ID passed to provider factory

    // Agent config (text models)
    contextOptions?: { recentMessages?: number; ... };
    instructions?: string;
    maxRetries?: number;
    maxSteps?: number;

    // Capabilities
    supportsImages?: boolean;
    supportsFileInput?: boolean;
    supportedMimeTypes?: string[];
    supportsToolCalling?: boolean;  // false = no tools

    // UI metadata
    mode?: "text" | "image" | "video" | "music" | "speech-to-text" | "text-to-speech";
    enabled?: boolean;   // false hides the model everywhere
    listed?: boolean;    // true = on marketing pages
    featureFlag?: string; // PostHog flag gating the picker
    isPremium?: boolean;
    filterCapabilities?: string[];
    aspectRatios?: string[];
    supportsNegativePrompt?: boolean;
    maxResolution?: string;
    avgLatencyMs?: number;
    maxDuration?: number;
}
```

### Adding a model

```text
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

| Task                  | Location                 | Notes                                                                       |
| --------------------- | ------------------------ | --------------------------------------------------------------------------- |
| Add/modify a model    | models/registry.ts       | `MODEL_REGISTRY` array — one and only place                                 |
| Agent builders        | models/registry.ts       | `buildAgents()`, `buildDynamicAgent()`                                      |
| Backend model lookup  | models/registry.ts       | `MODEL_LOOKUP` map (O(1) by model ID)                                       |
| Frontend model list   | Gateway `/v1/models`     | `GatewayModel` type from `gateway-types.ts`                                 |
| Capability lookups    | models/capabilities.ts   | `isToolCallUnsupportedModel()` etc.                                         |
| Provider import       | providers/index.ts       | Thin re-export for the backend's `@neore/ai/providers`                      |
| Local model hosts     | models/local-endpoint.ts | `LOCAL_ENDPOINT_HOSTS` — must agree with the web CSP and the save validator |
| Free tier / paid gate | models/free-tier.ts      | `FREE_TIER_TEXT_MODELS`, `requiresPaidPlan`                                 |
| Design presets        | design/                  | Presets, styles, templates, canvas prompt enhancer                          |
| Prompts               | prompts/                 | Template management                                                         |
| Prompt optimizer      | prompts/optimizer/       | Ported linshenkx templates + Mustache renderer with JSON-evidence guard     |
| Tools                 | tools/                   | AI tool definitions                                                         |

## ANTI-PATTERNS

- **Never** create separate per-provider config files (groq.ts, xai.ts were all deleted Feb 18)
- **Never** call `registerFileSupport`, `registerImageInputSupport`, `registerUnsupportedModel` — these are gone
- Don't hardcode provider credentials — use `process.env.*_API_KEY`
- Don't mix prompts with business logic
- Don't assume model availability — check the registry
