/**
 * The cheap model behind every small internal call: memory extraction and
 * compression, knowledge summaries, the task verifier, the group-chat router and
 * the Agent Builder. One accessor, so each of them is metered the same way.
 */
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { DEFAULT_MEMORY_EXTRACTION_MODEL } from "@neore/ai/constants";
import { deriveModelRegions, hasActiveFilters, MODEL_LOOKUP, type ModelDefinition, type ModelFilterRules, requiresPaidPlan } from "@neore/ai/models";
import type { AgentConfig } from "@neore/ai/providers";

import { backupFilterRejection } from "../chat/lib/backup-model.js";
import { GatewayLanguageModel } from "../chat/lib/gateway-language-model.js";
import type { ServiceFetch } from "./services.js";

let _agentsPromise: Promise<Record<string, AgentConfig>> | undefined;

/**
 * The models tried, in order, after the one a caller asked for. They sit on different upstream vendors, so a
 * region or provider rule that excludes the default usually leaves one of them standing.
 */
export const UTILITY_FALLBACK_MODELS: ReadonlyArray<string> = [
    "openai/gpt-4.1-mini",
    "anthropic/claude-haiku-4.5",
    "mistralai/ministral-8b-2501",
    "google/gemini-2.5-flash-lite",
];

/**
 * Every utility model is refused by the user's model filter rules. The background step that asked for it is skipped
 * (or, for a gate, fails closed): content must not go to a model the user forbade.
 */
export class NoAllowedUtilityModelError extends Error {
    readonly code = "no-allowed-utility-model";

    constructor() {
        super("No background model is allowed by your model filter rules");
        this.name = "NoAllowedUtilityModelError";
    }
}

/** The text of the refusal, for a caller that shows it to the user. */
export const NO_ALLOWED_UTILITY_MODEL_MESSAGE = "None of the background models is allowed by your model filter rules, so this step was skipped.";

/**
 * Marks a rules object as belonging to a user whose plan opens paid-plan models (an admin or a paid tier), the
 * gate a chat run applies (`canRunPaidModel`). A symbol key, so it survives a spread, stays out of the JSON the
 * gateway receives and out of `hasActiveFilters`. Absent means the plan is unknown or free: background calls run
 * on the platform's keys, so a free user's candidate must be a free-tier model.
 */
const PAID_PLAN_GRANT = Symbol("neore.utilityPaidPlanGrant");

/** `rules` carrying whether the user's plan opens paid-plan models, for `pickUtilityModelId`. */
export const withPaidPlanGrant = (rules: ModelFilterRules, granted: boolean): ModelFilterRules =>
    granted ? ({ ...rules, [PAID_PLAN_GRANT]: true } as ModelFilterRules) : rules;

/** Whether the gateway will serve this candidate from its EU endpoint: it pins an OpenRouter call only for exactly `["EU"]`. */
const routedToEuEndpoint = (definition: ModelDefinition, rules: ModelFilterRules | undefined): boolean => {
    const allowed = rules?.allowedRegions;

    return definition.provider === "openrouter" && allowed?.length === 1 && allowed[0] === "EU" && deriveModelRegions(definition).includes("EU");
};

/**
 * Whether a candidate can honour the user's blocked regions. The gateway does not turn `blockedRegions` into a
 * routing restriction, so a model reachable in a blocked region could be served from it: with any region blocked,
 * only a model whose EVERY region is outside the list qualifies (the shared predicate refuses only when all are blocked).
 */
export const avoidsBlockedRegions = (definition: ModelDefinition, rules: ModelFilterRules | undefined): boolean => {
    const blocked = rules?.blockedRegions;

    if (!blocked || blocked.length === 0) {
        return true;
    }

    // The gateway's EU-pinned endpoint serves the call from the EU alone, whatever other regions the model has.
    if (routedToEuEndpoint(definition, rules) && !blocked.includes("EU")) {
        return true;
    }

    return deriveModelRegions(definition).every((region) => !blocked.includes(region));
};

/**
 * Whether a candidate can honour the user's allowed regions. The shared predicate accepts a model when ANY of its
 * regions is allowed, but the gateway pins an OpenRouter call to a region only for exactly `["EU"]` (the EU endpoint);
 * otherwise it may be served from any of the model's regions. So a candidate qualifies when EVERY region of it is
 * allowed, or when the gateway will route it to the one allowed endpoint.
 */
const staysInAllowedRegions = (definition: ModelDefinition, rules: ModelFilterRules | undefined): boolean => {
    const allowed = rules?.allowedRegions;

    if (!allowed || allowed.length === 0) {
        return true;
    }

    const regions = deriveModelRegions(definition);

    if (regions.every((region) => allowed.includes(region))) {
        return true;
    }

    return routedToEuEndpoint(definition, rules);
};

/**
 * The first of `preferred` then the fallbacks (or `preferred` alone with `strict`) that the user's rules allow,
 * judged by the same predicate that vets a run's backup model, and by the paid-plan rule: a model outside the free
 * tier needs the plan grant (`withPaidPlanGrant`). `undefined` when none does.
 */
export const pickUtilityModelId = (
    rules: ModelFilterRules | undefined,
    preferred: string = DEFAULT_MEMORY_EXTRACTION_MODEL,
    strict = false,
): string | undefined => {
    const candidates = strict ? [preferred] : [preferred, ...UTILITY_FALLBACK_MODELS.filter((id) => id !== preferred)];

    const paidPlan = rules !== undefined && (rules as Record<symbol, unknown>)[PAID_PLAN_GRANT] === true;

    return candidates.find((id) => {
        const definition = MODEL_LOOKUP.get(id);

        return (
            definition !== undefined &&
            definition.enabled !== false &&
            (paidPlan || !requiresPaidPlan(definition)) &&
            avoidsBlockedRegions(definition, rules) &&
            staysInAllowedRegions(definition, rules) &&
            backupFilterRejection(definition, rules) === null
        );
    });
};

/** `pickUtilityModelId`, or the typed refusal. */
export const requireUtilityModelId = (rules: ModelFilterRules | undefined, preferred?: string, strict = false): string => {
    const id = pickUtilityModelId(rules, preferred, strict);

    if (id === undefined) {
        throw new NoAllowedUtilityModelError();
    }

    return id;
};

/**
 * Who a utility call is for. A call made for a user carries that user's model filter rules (`loadModelFilterRules`,
 * `{}` for none): the type refuses a `userId` without them, so a new caller cannot skip the rules by omission.
 */
export type UtilityModelContext = ({ rules?: undefined; userId?: undefined } | { rules: ModelFilterRules; userId: string }) & { threadId?: string };

export interface UtilityModelOptions {
    /** Use the named model alone, with no fallback: for a gate whose verdict depends on which model judged it. */
    strict?: boolean;
}

/**
 * Returns the language model for a utility call — `DEFAULT_MEMORY_EXTRACTION_MODEL` unless the caller names another
 * registry model — or, when the user's model filter rules refuse it, the first fallback they allow. Throws
 * `NoAllowedUtilityModelError` when none is allowed; the caller skips its step (see each call site).
 *
 * All calls are routed through the LLM Gateway — over its service binding,
 * `gateway` (`gatewayFetch(ctx)` from the calling action) — for token counting,
 * cost tracking, and usage analytics. The context attaches userId/threadId for
 * per-user attribution, and its rules reach the gateway too, where
 * `requireZDR` / `denyDataCollection` shape the provider routing.
 *
 * Uses a module-level promise cache so providers are only loaded once.
 * If the initial load fails, the cache is cleared so the next call retries —
 * preventing a permanently poisoned promise from breaking the pipeline.
 */
export const getUtilityModel = async (
    gateway: ServiceFetch,
    context?: UtilityModelContext,
    preferred: string = DEFAULT_MEMORY_EXTRACTION_MODEL,
    options?: UtilityModelOptions,
): Promise<LanguageModelV3> => {
    const rules = context?.rules;
    const model = requireUtilityModelId(rules, preferred, options?.strict);

    if (!_agentsPromise) {
        _agentsPromise = import("@neore/ai/providers")
            .then(({ buildAgents }) => buildAgents())
            .catch((error: unknown) => {
                _agentsPromise = undefined; // clear so next call retries
                throw error;
            });
    }

    const agents = await _agentsPromise;
    const agent = agents[model];

    if (!agent?.chat) {
        throw new Error(`Utility model "${model}" is not available`);
    }

    // Route through LLM Gateway for token counting, cost tracking, and usage analytics.
    const modelDefinition = MODEL_LOOKUP.get(model);

    if (modelDefinition && modelDefinition.provider !== "external") {
        return new GatewayLanguageModel({
            gateway,
            modelApiId: modelDefinition.modelApiId,
            modelFilterRules: hasActiveFilters(rules) ? rules : undefined,
            modelId: model,
            provider: modelDefinition.provider,
            threadId: context?.threadId,
            userId: context?.userId ?? "system",
        }) as unknown as LanguageModelV3;
    }

    return agent.chat as LanguageModelV3;
};
