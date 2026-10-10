/**
 * Thin re-exports preserving the `@neore/ai/providers` import path used by the backend.
 * Imports from registry to avoid pulling `@anolilab/ai-model-registry` into the
 * backend bundler's dependency graph (that package is only resolvable from packages/ai/node_modules).
 */
export type { AgentModel } from "../models/registry";
export { buildAgents, buildDynamicAgent, MODEL_REGISTRY } from "../models/registry";
export type { AgentConfig, ContextOptions, ModelDefinition, ProviderKind, StorageOptions, UsageHandler } from "../models/types";
