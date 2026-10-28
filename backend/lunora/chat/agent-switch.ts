/**
 * Switching a thread's agent mid-conversation (plans/harness-switch.md, slice S1: cloud models).
 *
 * `switchThreadAgent` records the change as one divider row in the transcript
 * (`agent/agent-switch-logic.ts`); the next turn runs on the model the active path ends on
 * (`agent/agent-switch.ts`). The new model sees the same history it always did — no handoff yet.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { leafRowOf, pathExceedsColdStart, resolvePathAgent } from "../agent/agent-switch";
import { sameAgent } from "../agent/agent-switch-logic";
import { type AgentRef, vAgentRef } from "../agent/agent-switch-validators";
import { getMaxMessage } from "../agent/messages";
import { insertAgentSwitchRow, patchThread } from "../agent/table-writes";
import { requireThreadPermission } from "../agent/thread-read-access";
import { isThreadStreaming } from "../agent/thread-streaming";
import { claimOnce } from "../lib/claim-once";
import { authMutation, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { assertPaidModel, requireEnabledModel } from "./lib/enabled-model";

/** Why a switch was refused, for the client to word: the `data.code` of the error. */
export const AGENT_SWITCH_STREAMING = "AGENT_SWITCH_STREAMING";
export const AGENT_SWITCH_UNSUPPORTED = "AGENT_SWITCH_UNSUPPORTED";

/**
 * A `clientId` is remembered this long. A double tap is over in seconds; the rest is for a stale
 * click replayed after later switches, which must not undo them.
 */
const AGENT_SWITCH_CLAIM_TTL_MS = 10 * 60 * 1000;

const refuse = (code: string, message: string): never => {
    throw new LunoraError("BAD_REQUEST", message, { data: { code } });
};

interface SwitchResult {
    agent: AgentRef;
    /** The conversation is long enough that the next reply re-reads it without the provider's cache (`PROMPT_CACHE_COLD_START_TOKENS`). */
    coldStartCostly: boolean;
    messageId: string | null;
    switched: boolean;
}

interface SwitchArgs {
    clientId: string;
    target: { kind: "host" } | { kind: "model"; model: string };
    threadId: Id<"threads">;
    unlockProof?: string;
    userId: string;
}

/** `switchThreadAgent`'s body, with the caller passed in so the harness can drive it. */
export const switchThreadAgentHandler = async (ctx: MutationCtx, args: SwitchArgs): Promise<SwitchResult> => {
    // The right a collaborator already has to pick the model of a send.
    const { thread } = await requireThreadPermission(ctx, args.threadId, args.userId, "write", args.unlockProof);

    if (args.target.kind !== "model") {
        return refuse(AGENT_SWITCH_UNSUPPORTED, "Switching to a host agent is not available yet");
    }

    // A bot runs on its bot's model, a group chat on its participants, and a media thread has no model to swap.
    if (thread.botId || thread.groupChat || thread.multiChat || (thread.mode !== undefined && thread.mode !== "text")) {
        return refuse(AGENT_SWITCH_UNSUPPORTED, "This chat runs on a fixed agent");
    }

    // Checked again when the turn runs: a plan can change in between.
    const definition = requireEnabledModel(args.target.model, { mode: "text" }, "chat");

    await assertPaidModel(ctx, args.userId, definition);

    // A hard rule, so a transcript never has two agents writing at once.
    if (await isThreadStreaming(ctx, thread._id)) {
        throw new LunoraError("CONFLICT", "Wait for the reply to finish, or stop it, before switching", { data: { code: AGENT_SWITCH_STREAMING } });
    }

    const leaf = await leafRowOf(ctx, thread);
    const from = leaf && (await resolvePathAgent(ctx, thread, leaf));

    if (!leaf || !from) {
        return refuse(AGENT_SWITCH_UNSUPPORTED, "There is nothing to switch from yet");
    }

    const to: AgentRef = { kind: "model", model: definition.id };

    // The caller's, not the thread's: the claims table is shared and a `clientId` is client-chosen.
    const claimed = await claimOnce(ctx, "switch", `${args.userId}:${thread._id}:${args.clientId}`, AGENT_SWITCH_CLAIM_TTL_MS, args.userId);

    if (!claimed || sameAgent(from, to)) {
        return { agent: from, coldStartCostly: false, messageId: null, switched: false };
    }

    // Past every row, so a sibling branch's `order` is never reused; a branched thread also names its
    // parent, because the previous row in storage order may sit on another branch.
    const last = await getMaxMessage(ctx, thread._id);
    const order = (last?.order ?? -1) + 1;
    const messageId = await insertAgentSwitchRow(ctx.db, {
        order,
        ...(thread.activeLeafMessageId && { parentMessageId: leaf._id }),
        part: { from, mode: "full", startMessageId: leaf._id, to },
        threadId: thread._id,
        userId: args.userId,
    });

    await patchThread(ctx.db, thread._id, {
        activeAgent: to,
        // The row now ends the path the thread displays.
        ...(thread.activeLeafMessageId && { activeLeafMessageId: messageId }),
        updatedAt: Date.now(),
    });

    ctx.log.event("chat.agent_switch", { from: from.model, threadId: thread._id, to: to.model });

    return { agent: to, coldStartCostly: await pathExceedsColdStart(ctx, thread._id, leaf), messageId, switched: true };
};

export const switchThreadAgent = authMutation
    .use(rateLimit("chat/update"))
    .input({
        clientId: v.string().max(MAX_LENGTH.id),
        target: v.union(
            v.object({ kind: v.literal("model"), model: v.string().max(MAX_LENGTH.short) }),
            // Offered host agents arrive with the host slices; the shape is accepted so a refusal can be typed.
            v.object({ kind: v.literal("host") }),
        ),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.object({ agent: vAgentRef, coldStartCostly: v.boolean(), messageId: v.union(v.string(), v.null()), switched: v.boolean() }))
    .mutation(async ({ args, ctx }) => await switchThreadAgentHandler(ctx, { ...args, userId: ctx.user.userId }));
