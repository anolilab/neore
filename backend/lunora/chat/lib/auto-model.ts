/**
 * "Auto": a thread whose sends each run on ONE concrete model the gateway's query routing picks (`/internal/route`).
 *
 * The thread keeps a concrete `model` (the fallback) and a separate `autoModel` flag, so every read of a thread's
 * model keeps working. The choice is made inside the run, where the service binding exists, and the run then names
 * that model like any other: `/internal/model/proxy` runs exactly it, so usage and billing stay per concrete model.
 * Auto never writes a switch divider and never touches `threads.model` or `threads.activeAgent`.
 */
import { enabledModelOf, MODEL_REGISTRY, type ModelDefinition, type ModelFilterRules, parseCustomModelId } from "@neore/ai/models";

import type { ActionCtx } from "../../_generated/server";
import { streamLogger } from "../../lib/logger";
import { canRunPaidModel, type RunPlan } from "./agent-run";
import { backupCapabilities, backupFilterRejection } from "./backup-model";
import { routeViaGateway } from "./gateway-client";

/** The gateway's `userTier` strings that open the expensive pools (`routing/tier-override.ts`). */
const routingTierOf = (plan: RunPlan): "admin" | "free" | "pro" => {
    if (plan.isAdmin) {
        return "admin";
    }

    return plan.plan === "premium" ? "pro" : "free";
};

export interface AutoGate {
    /** The run's model after a bot or a skill had its say; auto replaces only the composer's own pick. */
    currentModel: string;
    isAnonymous: boolean;
    pinnedByBotOrSkill: boolean;
    prompt: string;
    thread: { activeAgent?: unknown; autoModel?: boolean; botId?: string; groupChat?: unknown; runner?: "host"; userId?: string };
    userId: string;
}

/**
 * Whether this run routes. Plain hosted text threads only, in the owner's own turn, and only while the thread was
 * never switched: a switched thread keeps the agent its path derives.
 */
export const shouldRouteAuto = ({ currentModel, isAnonymous, pinnedByBotOrSkill, prompt, thread, userId }: AutoGate): boolean =>
    thread.autoModel === true &&
    !thread.activeAgent &&
    !thread.botId &&
    !thread.groupChat &&
    thread.runner !== "host" &&
    thread.userId === userId &&
    !isAnonymous &&
    !pinnedByBotOrSkill &&
    prompt.trim().length > 0 &&
    parseCustomModelId(currentModel) === null &&
    enabledModelOf(currentModel, { mode: "text" }) !== undefined;

/**
 * The registry row for a route answer: the enabled text row on the answer's own provider and API model. The gateway's
 * names (`claude-sonnet-4`) differ from the registry's vendor-prefixed ids, so the match is by provider and API model,
 * never by name alone. A missing or ambiguous match is `undefined`.
 */
export const registryModelForRoute = (routed: { modelApiId: string; modelId: string; provider: string }): ModelDefinition | undefined => {
    // Only an entry on the gateway's own provider and API model is the routed model. A name match alone reaches a
    // different provider (the same model through a reseller), so it keeps the fallback instead.
    const sameModel = (row: ModelDefinition) => row.provider === routed.provider && row.modelApiId === routed.modelApiId;
    const exact = enabledModelOf(routed.modelId, { mode: "text" });

    if (exact && sameModel(exact)) {
        return exact;
    }

    const matches = MODEL_REGISTRY.filter((row) => sameModel(row) && enabledModelOf(row.id, { mode: "text" }));

    return matches.length === 1 ? matches[0] : undefined;
};

/** What the conversation the run sends holds, read from the thread's path (`chat/auto-model-context.ts`). */
export interface ConversationShape {
    /** A lower bound on the conversation's size in tokens; `0` when it is short. */
    contextTokens: number;
    files: boolean;
    images: boolean;
}

/** How long a route may take before the run keeps its fallback model. */
const AUTO_ROUTE_TIMEOUT_MS = 3000;

export interface AutoRequest {
    conversation: () => Promise<ConversationShape>;
    fallbackModel: string;
    filterRules: ModelFilterRules | undefined;
    plan: () => Promise<RunPlan>;
    prompt: string;
    threadId: string;
    userId: string;
}

/** A registry id (`anthropic/claude-sonnet-4`) in both spellings the gateway's candidates may use (`claude-sonnet-4`). */
const bothSpellings = (ids: string[] | undefined): string[] | undefined => ids && [...new Set(ids.flatMap((id) => [id, id.slice(id.lastIndexOf("/") + 1)]))];

/** The user's model lists in the gateway's namespace; the routed answer is still checked against the originals. */
const gatewayRules = (rules: ModelFilterRules): ModelFilterRules => {
    const allowedModels = bothSpellings(rules.allowedModels);
    const blockedModels = bothSpellings(rules.blockedModels);

    return { ...rules, ...(allowedModels && { allowedModels }), ...(blockedModels && { blockedModels }) };
};

/**
 * The model this send runs on: the routed one when it is a registry model the user may run (filters, plan, and the
 * capabilities the conversation needs), else `fallbackModel`. Auto must never fail a send the fallback could serve,
 * so every read it needs is inside the guard.
 */
export const resolveAutoModel = async (ctx: ActionCtx, request: AutoRequest): Promise<string> => {
    const { fallbackModel, filterRules, prompt, threadId, userId } = request;

    // Auto is optional and has a fallback ready, so a slow route gives up early rather than delaying the reply.
    const keepFallback = (reason: string) => {
        streamLogger.info(`[AutoModel] keeping ${fallbackModel}: ${reason}`);

        return fallbackModel;
    };

    try {
        const [plan, conversation] = await Promise.all([request.plan(), request.conversation()]);
        const routed = await routeViaGateway(
            ctx,
            {
                ...(conversation.contextTokens > 0 && { contextTokens: conversation.contextTokens }),
                messages: [{ content: prompt, role: "user" }],
                ...(filterRules && { modelFilterRules: gatewayRules(filterRules) }),
                threadId,
                userId,
                userTier: routingTierOf(plan),
            },
            { timeoutMs: AUTO_ROUTE_TIMEOUT_MS },
        );
        const definition = registryModelForRoute(routed);

        if (!definition) {
            return keepFallback(`${routed.modelId} is not a registry model`);
        }

        const capabilities = backupCapabilities(definition);

        if (backupFilterRejection(definition, filterRules) !== null) {
            return keepFallback(`${definition.id} is filtered out`);
        }

        if (!capabilities.tools) {
            return keepFallback(`${definition.id} has no tool support`);
        }

        if ((conversation.images && !capabilities.images) || (conversation.files && !capabilities.files)) {
            return keepFallback(`${definition.id} lacks an attachment kind the run needs`);
        }

        if (!(await canRunPaidModel(ctx, userId, definition, plan))) {
            return keepFallback(`${definition.id} is not on the plan`);
        }

        streamLogger.info(`[AutoModel] routed to ${definition.id} (was ${fallbackModel})`);

        return definition.id;
    } catch (error) {
        streamLogger.warn(`[AutoModel] routing failed; keeping ${fallbackModel}:`, error);

        return fallbackModel;
    }
};
