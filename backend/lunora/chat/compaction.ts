/**
 * Context compaction from the client (`agent/thread-compaction.ts` has the mechanism): `/compact`, the thread
 * menu and the "compact" chip all call {@link compactThread}.
 *
 * - `compactThread` replaces the thread's older turns, in what the model is sent, with a summary. The stored
 *   messages are never touched. Owner only (a compaction becomes the history later runs read as the thread's),
 *   refused while a reply is running, and charged to the daily text quota right before the first model call.
 * - `getCompactionStatus` is what the chip and the client need to decide: the estimated size of the next request,
 *   when the thread was last active, and when the standing compaction was made. It is read on demand, not live:
 *   a live query would re-run on every streamed row.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { leafRowOf } from "../agent/agent-switch";
import { compactThreadContext, estimateContext, vCompactionSkip } from "../agent/thread-compaction";
import { hardBlockerOf, ownedBy } from "../agent/thread-summaries";
import { authAction, authQuery, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { chargeCompactionCall } from "./lib/compaction-quota";
import { isLocalBrowserModel, loadCustomProviders } from "./lib/local-turn";
import { throwUnlessGranted, threadGateOutcome } from "./lib/thread-gate";

export const compactThread = authAction
    .use(rateLimit("chat/message"))
    .input({
        threadId: v.id("threads"),
        /** A locked chat's passcode proof, as every call that names the thread carries it. */
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.object({ compacted: v.boolean(), reason: v.optional(vCompactionSkip) }))
    .action(async ({ args: { threadId, unlockProof }, ctx }) => {
        const { plan, role, userId } = ctx.user;
        const gate = await ctx.runQuery(internal.chat.functions.gateThreadAction, { level: "write", threadId, unlockProof, userId });

        throwUnlessGranted(gate.outcome, "Access denied to this thread");

        const outcome = await compactThreadContext(ctx, {
            // Charged only once a model call is certain: a thread with nothing to fold, or a busy one, costs nothing.
            beforeFirstCall: async () => {
                const flags = await ctx.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { userId });

                await chargeCompactionCall(ctx, { _id: userId, isAnonymous: flags.isAnonymous, plan: plan ?? null, role: role ?? null });
            },
            threadId,
            userId,
        });

        ctx.log.event("chat.compact_thread", { compacted: outcome.compacted, reason: outcome.reason ?? "none", userId });

        return outcome;
    });

export const getCompactionStatus = authQuery
    .input({
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(
        v.object({
            /** Whether this caller may compact the thread now: its owner, on a thread that keeps history. */
            canCompact: v.boolean(),
            /** When the compaction the next reply would read from was made. */
            compactedAt: v.optional(v.number()),
            /** Estimated tokens of the next request. */
            contextTokens: v.number(),
            /** When the thread's newest row was written. */
            lastActivityAt: v.optional(v.number()),
        }),
    )
    .query(async ({ args: { threadId, unlockProof }, ctx }) => {
        const { userId } = ctx.user;

        const outcome = await threadGateOutcome(ctx, { level: "read", threadId, unlockProof, userId });

        // A locked chat cannot be compacted, so the chip has nothing to offer; answering instead of throwing keeps
        // THREAD_LOCKED (and the unlock prompt it opens) for the calls that really need the passcode.
        if (outcome === "locked") {
            return { canCompact: false, contextTokens: 0 };
        }

        throwUnlessGranted(outcome, "Access denied to this thread");

        const thread = ownedBy(await ctx.db.get("threads", threadId));

        // The size and the compaction times are the owner's: a collaborator with a read grant gets only that it cannot compact.
        if (!thread || thread.userId !== userId) {
            return { canCompact: false, contextTokens: 0 };
        }

        const tip = await leafRowOf(ctx, thread);

        if (!tip) {
            return { canCompact: false, contextTokens: 0 };
        }

        const { compactedAt, tokens } = await estimateContext(ctx, thread, tip);

        return {
            canCompact:
                thread.userId === userId && hardBlockerOf(thread) === null && !isLocalBrowserModel(thread.model, await loadCustomProviders(ctx, userId)),
            ...(compactedAt !== undefined && { compactedAt }),
            contextTokens: Math.round(tokens),
            lastActivityAt: tip._creationTime,
        };
    });
