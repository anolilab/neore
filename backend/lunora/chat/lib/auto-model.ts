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
 * The registry row for a route answer. The gateway names its models in its own namespace (`claude-sonnet-4`,
 * `gpt-4.1`); the registry's ids carry a vendor prefix (`anthropic/claude-sonnet-4`). Exact id first, then the one
 * enabled text row whose id ends in `/<routed id>`; an ambiguous or missing answer is `undefined`.
 */
export const registryModelForRoute = (routed: { modelApiId: string; modelId: string }): ModelDefinition | undefined => {
    const exact = enabledModelOf(routed.modelId, { mode: "text" });

    if (exact) {
        return exact;
    }

    const suffix = `/${routed.modelId}`;
    const matches = MODEL_REGISTRY.filter(
        (row) => (row.id.endsWith(suffix) || row.modelApiId === routed.modelApiId) && enabledModelOf(row.id, { mode: "text" }),
    );

    return matches.length === 1 ? matches[0] : undefined;
};

/** What the conversation the run sends holds, read from the thread's path (`chat/auto-model-context.ts`). */
export interface ConversationShape {
    /** A lower bound on the conversation's size in tokens; `0` when it is short. */
    contextTokens: number;
    files: boolean;
    images: boolean;
}

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

    try {
        const [plan, conversation] = await Promise.all([request.plan(), request.conversation()]);
        const routed = await routeViaGateway(ctx, {
            ...(conversation.contextTokens > 0 && { contextTokens: conversation.contextTokens }),
            messages: [{ content: prompt, role: "user" }],
            ...(filterRules && { modelFilterRules: gatewayRules(filterRules) }),
            threadId,
            userId,
            userTier: routingTierOf(plan),
        });
        const definition = registryModelForRoute(routed);

        if (!definition) {
            streamLogger.debug(`[AutoModel] ${routed.modelId} is not a registry model; keeping ${fallbackModel}`);

            return fallbackModel;
        }

        const capabilities = backupCapabilities(definition);

        if (
            backupFilterRejection(definition, filterRules) !== null ||
            !capabilities.tools ||
            (conversation.images && !capabilities.images) ||
            (conversation.files && !capabilities.files) ||
            !(await canRunPaidModel(ctx, userId, definition, plan))
        ) {
            return fallbackModel;
        }

        return definition.id;
    } catch (error) {
        streamLogger.warn(`[AutoModel] routing failed; keeping ${fallbackModel}:`, error);

        return fallbackModel;
    }
};
