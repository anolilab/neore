/**
 * Model filter rules and filtering engine. The engine lives in `@neore/ai/models` so the backend can apply the
 * very rules the gateway enforces; this module keeps the gateway's import path.
 */
export { type FilterableModel, filterModels, getModelRejectionReason, hasActiveFilters, isModelAllowed, type ModelFilterRules } from "@neore/ai/models";
