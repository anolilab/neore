/**
 * A side chat: a new thread that forks its parent's history up to the parent's latest settled message, linked to the
 * parent as a "side" relationship and keeping the parent's permission mode and bot. The parent is only read: no message,
 * stream, claim or mode change reaches it, so a side chat can start while the parent is still replying (a reply still in
 * flight is not copied: only settled rows are).
 *
 * Refused, before anything is written: a parent that is not the caller's own, a parent that is locked, deleted, archived,
 * temporary, deleting, public, host-run, group or shared, a parent that is not a text chat, one with no model, a parent
 * with no settled message, and a parent on a custom endpoint (also when switched to one) (its content is never sent to another model).
 *
 * The copy mirrors `branchThread` (`chat/functions.ts`), which records a "branch" link; the two should share one helper
 * once this is in place. This one is an action because copying messages is one.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { parseCustomModelId } from "@neore/ai/models";
import { throwUnlessGranted } from "./lib/thread-gate";

/** Why a parent cannot be the start of a side chat. Each is a refusal the caller can show. */
export type SideChatRefusal =
    | "archived"
    | "custom_endpoint"
    | "deleted"
    | "empty"
    | "group_or_shared"
    | "host_run"
    | "locked"
    | "no_model"
    | "not_found"
    | "not_text"
    | "shared_or_temporary";

type SideChatParent = {
    activeAgent?: { kind?: string; model?: string };
    archivedAt?: number;
    deleted?: boolean;
    deletingAt?: number;
    groupChat?: unknown;
    isPublic?: boolean;
    isTemporary?: boolean;
    lockedAt?: number;
    mode?: string;
    model?: string;
    multiChat?: boolean;
    publicAccessToken?: string;
    runner?: string;
};

/** The refusal for a parent thread, or `null` when a side chat may start beside it. Pure, so each rule is pinned by a table. */
export const sideChatRefusalOf = (parent: SideChatParent | null, ownerOk: boolean): SideChatRefusal | null => {
    if (parent === null || !ownerOk) {
        return "not_found";
    }

    if (parent.deleted === true) {
        return "deleted";
    }

    if (parent.lockedAt !== undefined) {
        return "locked";
    }

    if (parent.isTemporary === true || parent.deletingAt !== undefined || parent.isPublic === true || parent.publicAccessToken !== undefined) {
        return "shared_or_temporary";
    }

    if (parent.archivedAt !== undefined) {
        return "archived";
    }

    if (parent.runner === "host") {
        return "host_run";
    }

    if (parent.groupChat !== undefined || parent.multiChat === true) {
        return "group_or_shared";
    }

    if (parent.mode !== undefined && parent.mode !== "text") {
        return "not_text";
    }

    if (parent.model === undefined) {
        return "no_model";
    }

    if (parseCustomModelId(parent.model) !== null) {
        return "custom_endpoint";
    }

    // A parent switched to a custom endpoint runs on it, whatever model the thread started on.
    if (parent.activeAgent?.model !== undefined && parseCustomModelId(parent.activeAgent.model) !== null) {
        return "custom_endpoint";
    }

    return null;
};

export const createSideChat = authAction
    .use(rateLimit("chat/create"))
    .input({ threadId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.object({ status: v.literal("ok"), threadId: v.string() }), v.object({ reason: v.string(), status: v.literal("refused") })))
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const threadId = args.threadId as Id<"threads">;
        const parent = await ctx.runQuery(internal.agent.threads.getThreadInternal, { threadId });
        const refusal = sideChatRefusalOf(parent, parent?.userId === userId);

        if (refusal !== null || parent === null) {
            return { reason: refusal ?? "not_found", status: "refused" as const };
        }

        const gate = await ctx.runQuery(internal.chat.functions.gateThreadAction, { level: "admin", threadId, userId });

        throwUnlessGranted(gate.outcome, "Admin access denied to this thread");

        if (gate.hostRun) {
            return { reason: "host_run", status: "refused" as const };
        }

        // The last SETTLED row of the active path: a reply still in flight or one that failed is never copied, and a parent
        // with no settled row has nothing to fork.
        const settledId = await ctx.runQuery(internal.agent.branches.lastSettledMessageId, { threadId });
        const forkEnd =
            settledId === null ? null : await ctx.runQuery(internal.agent.branches.resolveForkEnd, { index: undefined, messageId: settledId, threadId });

        if (forkEnd === null) {
            return { reason: "empty", status: "refused" as const };
        }

        // Placed as a branch is (a temporary parent's lasting placement), else in the parent's own organization, cap and project,
        // so the child stays under the same policy and caps as the parent.
        const placement = await ctx.runQuery(internal.agent.threads.lastingChatPlacement, { threadId });
        const created = await ctx.runMutation(internal.agent.threads.createThread, {
            language: parent.language,
            ...placement,
            ...(placement.organizationId === undefined && parent.organizationId !== undefined && { organizationId: parent.organizationId }),
            ...(placement.capOrganizationId === undefined && parent.capOrganizationId !== undefined && { capOrganizationId: parent.capOrganizationId }),
            ...(parent.projectId !== undefined && { projectId: parent.projectId }),
            model: parent.model,
            // The run settings the parent's replies use, so the side chat answers the same way.
            ...(parent.autoModel !== undefined && { autoModel: parent.autoModel }),
            ...(parent.customSystemPrompt !== undefined && { customSystemPrompt: parent.customSystemPrompt }),
            ...(parent.reasoningEffort !== undefined && { reasoningEffort: parent.reasoningEffort }),
            ...(parent.statelessMode !== undefined && { statelessMode: parent.statelessMode }),
            title: parent.title ?? "",
            userId,
        });
        const newThreadId = created._id as Id<"threads">;

        // The child is removed with its link, so a failed or refused copy leaves neither behind.
        const discard = async (): Promise<void> => {
            await ctx.runMutation(internal.agent.threads.deleteThreadRelationship, { threadId: newThreadId });
            await ctx.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, { threadId: newThreadId });
        };

        try {
            // The child keeps the parent's stored mode and bot, so its runs keep the same rules and persona.
            if (parent.permissionMode) {
                await ctx.runMutation(internal.chat.thread_state.copyThreadPermissionMode, { mode: parent.permissionMode, threadId: newThreadId });
            }

            if (parent.botId) {
                await ctx.runMutation(internal.agent.threads.updateThread, { patch: { botId: parent.botId }, threadId: newThreadId });
            }

            await ctx.runMutation(internal.agent.threads.createThreadRelationship, {
                branchPoint: forkEnd.index,
                branchType: "side",
                parentThreadId: threadId,
                threadId: newThreadId,
            });

            // Re-read just before the copy: a parent locked, deleted or archived meanwhile is not copied. This narrows the race with
            // a delete or lock and does not remove it; a full fence would need a claim the delete and lock paths also honour.
            const current = await ctx.runQuery(internal.agent.threads.getThreadInternal, { threadId });
            const nowRefused = sideChatRefusalOf(current, current?.userId === userId);

            if (nowRefused !== null) {
                await discard();

                return { reason: nowRefused, status: "refused" as const };
            }

            await ctx.runAction(internal.agent.messages.cloneThread, {
                copyUserIdForVectorSearch: true,
                sourceThreadId: threadId,
                statuses: ["success"],
                targetThreadId: newThreadId,
                upToAndIncludingMessageId: forkEnd.endId,
            });

            if ((await ctx.runQuery(internal.agent.branches.lastSettledMessageId, { threadId: newThreadId })) === null) {
                await discard();

                return { reason: "empty", status: "refused" as const };
            }

            if (parent.activeAgent) {
                await ctx.runMutation(internal.agent.agent_switch.adoptForkAgent, { threadId: newThreadId });
            }

            // The copy carries any context reset (`/clear`): the child is cut at it as the parent is.
            if (parent.hasContextReset) {
                await ctx.runMutation(internal.chat.context_reset.markForkedContextReset, { threadId: newThreadId });
            }

            const createdThread = await ctx.runQuery(internal.agent.threads.getThreadInternal, { threadId: newThreadId });

            if (createdThread) {
                await ctx.runMutation(internal.lib.document_history.recordHistory, {
                    attribution: { action: "insert", metadata: { branchPoint: forkEnd.index, sideChatOf: threadId }, source: "manual" },
                    doc: createdThread,
                    documentId: newThreadId,
                    isDeleted: false,
                    organizationId: createdThread.organizationId ?? undefined,
                    tableName: "threads",
                    userId,
                });
            }
        } catch (error) {
            // A child left half-copied would be an empty chat the person never asked for.
            await discard();

            throw error;
        }

        return { status: "ok" as const, threadId: String(newThreadId) };
    });
