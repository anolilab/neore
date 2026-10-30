# @neore/ai

The model registry and the AI-side data the rest of the monorepo shares: every
model Neore knows about (text, image, video, music, speech), the capability
rules for models and for agent runners, prompt templates, design presets, the
tool names, and the contract between the backend, the LLM gateway and the web
app. Private, built with packem to `dist/`.

Imported by `backend/lunora` (agent runs, evals, tasks, sub-agents, workflows),
`services/llm-gateway`, `apps/web`, `apps/browser-extension` and
`packages/chat-ui`. The package root (`@neore/ai`) is intentionally empty:
import only the subpaths below, so a consumer that needs one of them does not
pull every provider SDK.

## Exports

| Subpath                                                                            | What it holds                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@neore/ai/models`                                                                 | `MODEL_REGISTRY`, `MODEL_LOOKUP`, the derived `TEXT_/IMAGE_/VIDEO_/MUSIC_CATALOG`, `buildAgents` / `buildDynamicAgent`, MIME and tool-call capability lookups, free-tier gate, custom-model ids, local-endpoint validation, FAL video pricing and inputs, model filters |
| `@neore/ai/providers`                                                              | Thin re-export of the registry and agent builders, kept for the path the backend imports                                                                                                                                                                                |
| `@neore/ai/capabilities`                                                           | What a _runner_ (cloud agent loop, headless run, host agent) can do: `CLOUD_INTERACTIVE_CAPABILITIES` etc., and the rules `capabilityOf`, `followUpControl`, `visibleModes`, `selectableModels`                                                                         |
| `@neore/ai/gateway`                                                                | The backend / gateway / web contract: billing modes, custom provider formats, plain data only                                                                                                                                                                           |
| `@neore/ai/constants`                                                              | Default model ids per task (`DEFAULT_CHAT_MODEL`, `DEFAULT_IMAGE_MODEL`, …)                                                                                                                                                                                             |
| `@neore/ai/constants/cinema`, `@neore/ai/types/cinema`, `@neore/ai/prompts/cinema` | The cinema prompt system (see `cinema-prompt-system.md`)                                                                                                                                                                                                                |
| `@neore/ai/prompts`                                                                | `{{variable}}` prompt helpers: `extractVariables`, `hasVariables`, variable replacement                                                                                                                                                                                 |
| `@neore/ai/prompts/optimizer`                                                      | Prompt-optimizer templates and `buildUserOptimizerPrompt` / `buildSystemOptimizerPrompt`                                                                                                                                                                                |
| `@neore/ai/design`                                                                 | Design presets, styles, templates and the canvas prompt enhancer                                                                                                                                                                                                        |
| `@neore/ai/tools`                                                                  | `AppDefaultToolkit` and `DefaultToolName` enums                                                                                                                                                                                                                         |
| `@neore/ai/provenance`                                                             | `markAiGeneratedImage`, `sniffImageMediaType`, `withPngOutput`                                                                                                                                                                                                          |
| `@neore/ai/utils`                                                                  | `getRegionFromHeaders`, `isEURegion`, `isEURequest`                                                                                                                                                                                                                     |

```ts
// backend/lunora/chat/lib/agent-run.ts
import { MODEL_LOOKUP, parseCustomModelId } from "@neore/ai/models";

const definition = MODEL_LOOKUP.get(modelId); // O(1) by model id
```

```ts
// backend/lunora/chat/functions.ts — the optimizer wraps user input as JSON evidence
import { buildUserOptimizerPrompt } from "@neore/ai/prompts/optimizer";

const { systemPrompt, userPrompt } = buildUserOptimizerPrompt(style, prompt.trim(), { improvementInstructions });
```

## Things to know

- **`src/models/registry.ts` is the only place a model is defined.** Add or
  change an entry in `MODEL_REGISTRY`; there are no per-provider config files.
  `listed: true` puts a model in marketing catalogs, `enabled: false` hides it
  everywhere, and `provider: "external"` is listed-only and skipped by agents.
  The `*_CATALOG` arrays are derived from the registry, not edited.
- **`@neore/ai/models` is not capabilities.** `models/capabilities.ts` is what a
  _model_ accepts as input (files, images, tools); `capabilities/` is what a
  _runner_ can do. The latter is dependency-free plain data because the web app,
  the desktop main process, the backend and the mobile app all read it
  (`plans/provider-capabilities.md`).
- **Local model hosts live in `models/local-endpoint.ts`.** `LOCAL_ENDPOINT_HOSTS`
  must agree with the web app's CSP and the backend's loopback validator
  (root `CLAUDE.md`, "Local models").
- **Prompt optimizer:** user input is wrapped as JSON and the model is told to
  treat it as evidence, not instructions. Do not unwrap it. `render.ts`
  substitutes in a single left-to-right pass so a value containing `{{var}}` is
  not substituted again; `render.test.ts` pins that.
- **The package is built; consumers read `dist/`.** In a fresh checkout or
  worktree run `pnpm build:packages` first, or types imported from here degrade.
- Provider credentials come from the environment (`process.env.*_API_KEY`) or
  are passed in; never hard-code them.

More notes sit in `AGENTS.md`; `cinema-prompt-system.md`,
`prompt-file-naming-proposal.md` and `prompt-tests-summary.md` document the
prompt side.

## Development

```bash
pnpm --filter @neore/ai run build        # packem build --development
pnpm --filter @neore/ai run build:prod
pnpm --filter @neore/ai run test         # vitest run
pnpm --filter @neore/ai run lint:types   # tsc --noEmit
pnpm --filter @neore/ai run lint:eslint
pnpm --filter @neore/ai run lint:prettier
```

Through `vis`, target the project by its `package.json` name:
`pnpm vis run test --projects=@neore/ai`.
