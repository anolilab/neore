/**
 * A side chat: a new thread that forks its parent's history up to the parent's latest settled message, linked to the
 * parent as a "side" relationship and keeping the parent's permission mode and bot. The parent is only read: no message,
 * stream, claim or mode change reaches it, so a side chat can start while the parent is still replying (a reply still in
 * flight is not copied: only settled rows are).
 *
 * Refused, before anything is written: a parent that is not the caller's own, a parent that is locked, deleted, archived,
 * temporary, deleting, public, host-run, group or shared, a parent that is not a text chat, one with no model, a parent
 * with no settled message, a parent on a custom endpoint (also when switched to one) (its content is never sent to another model),
 * and a parent in a team the caller has left. Every refusal and every success is logged as metadata: status and reason.
 *
 * The copy mirrors `branchThread` (`chat/functions.ts`), which records a "branch" link; the two should share one helper
 * once this is in place. This one is an action because copying messages is one.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { threadSharedWithOthers } from "../agent/live-grant";
import { isTeamMember } from "../auth/lib/team-helpers";
import { publicThread } from "../agent/threads";
import { insertThread, patchThread } from "../agent/table-writes";
import { vThreadCreateFields, vThreadDoc as vThreadDocument } from "../agent/validators";
import { vWorkerPolicy } from "../sub-agents/validators";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { parseCustomModelId } from "@neore/ai/models";
import { throwUnlessGranted } from "./lib/thread-gate";

/** The most pages `discard` deletes in one action; a child holds at most the parent's settled rows. */
const MAX_DISCARD_PAGES = 1000;

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
    | "shared_or_temporary"
    | "team";

type SideChatParent = {
    activeAgent?: { kind?: string; model?: string };
    /** The last archive time: kept after the chat is reopened, so it does not say whether the chat is archived (see `status`). */
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
    status?: string;
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

    // Unarchiving sets the status back and keeps `archivedAt` as the time of the last archive, so the status is the test.
    if (parent.status === "archived") {
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

/**
 * Whether anyone other than the owner holds a grant on the thread that is still in force. Ordinary invited sharing is recorded
 * only as a grant, so the parent's own flags do not show it: a chat others can read is not forked into a chat only its owner
 * can see. An expired grant, or the owner's own, gives nobody else access, so it does not count.
 */
export const sharedWithOthers = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId);

        return thread?.userId !== undefined && (await threadSharedWithOthers(ctx, args.threadId, thread.userId, ctx.now));
    });

/**
 * Creates the side chat's thread, and for a team parent checks in the same transaction that the owner is still a member. A
 * membership read in another call could be stale by the time the thread is written, so the check and the insert are one
 * decision; `null` means the caller left the team and nothing was written.
 */
export const createSideChatThread = internalMutation
    .input(vThreadCreateFields)
    .output(v.from(v.union(vThreadDocument, v.null())))
    .mutation(async ({ args, ctx }) => {
        if (args.teamId !== undefined && (args.userId === undefined || !(await isTeamMember(ctx, args.teamId, args.userId)))) {
            return null;
        }

        const insertedId = await insertThread(ctx.db, { createdAt: ctx.now, ...args, status: "active" } as Parameters<typeof insertThread>[1]);

        return publicThread((await ctx.db.get("threads", insertedId as Id<"threads">))!);
    });

/** The worker-dispatch policy the parent carries, copied onto the side chat. It is not a thread-creation field, so it is set here. */
export const copyWorkerPolicy = internalMutation
    .input({ threadId: v.id("threads"), workerPolicy: vWorkerPolicy })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await patchThread(ctx.db, args.threadId, { workerPolicy: args.workerPolicy });

        return null;
    });

/** The refusal result, logged as metadata only: the reason and the status, never a title or any message content. */
export const refusedOutcome = (log: { event: (name: string, fields: { reason: string; status: string }) => void }, reason: SideChatRefusal) => {
    log.event("chat.create_side_chat", { reason, status: "refused" });

    return { reason, status: "refused" as const };
};

/**
 * Removes a thread this action just made, with its link: a failed or refused copy leaves neither behind. The paged delete removes the thread
 * row last and schedules its own later pages, so it would leave the partial child readable meanwhile; the pages run here, one after another,
 * until the row is gone, then the usual delete clears what is left (streams, pins, routes).
 */
export const discardNewThread = async (ctx: Pick<ActionCtx, "runMutation">, threadId: Id<"threads">): Promise<void> => {
    // A failed link removal must not leave the child behind: the rest is removed first, and the failure is reported after it.
    const linkFailure = await ctx
        .runMutation(internal.agent.threads.deleteThreadRelationship, { threadId })
        .then(() => undefined)
        .catch((error: unknown) => {
            return { error };
        });

    let cursor: string | undefined;

    for (let page = 0; page < MAX_DISCARD_PAGES; page += 1) {
        const result = await ctx.runMutation(internal.agent.threads._deletePageForThreadId, { cursor, threadId });

        if (result.isDone) {
            break;
        }

        cursor = result.cursor ?? undefined;
    }

    await ctx.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, { threadId });

    if (linkFailure !== undefined) {
        throw linkFailure.error;
    }
};

export const createSideChat = authAction
    .use(rateLimit("chat/create"))
    .input({ threadId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.object({ status: v.literal("ok"), threadId: v.string() }), v.object({ reason: v.string(), status: v.literal("refused") })))
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const threadId = args.threadId as Id<"threads">;
        const parent = await ctx.runQuery(internal.agent.threads.getThreadInternal, { threadId });
        const refuse = (reason: SideChatRefusal) => refusedOutcome(ctx.log, reason);
        const refusal = sideChatRefusalOf(parent, parent?.userId === userId);

        if (refusal !== null || parent === null) {
            return refuse(refusal ?? "not_found");
        }

        const gate = await ctx.runQuery(internal.chat.functions.gateThreadAction, { level: "admin", threadId, userId });

        throwUnlessGranted(gate.outcome, "Admin access denied to this thread");

        if (gate.hostRun) {
            return refuse("host_run");
        }

        if (await ctx.runQuery(internal.chat.side_chat.sharedWithOthers, { threadId })) {
            return refuse("shared_or_temporary");
        }

        // A bot's run model is the bot's, not the thread's: a bot now on a custom endpoint would carry the child there.
        const bot = parent.botId ? await ctx.runQuery(internal.bots.functions.getBotForRun, { botId: parent.botId, userId }) : null;

        if (bot !== null && parseCustomModelId(bot.model) !== null) {
            return refuse("custom_endpoint");
        }

        // The last SETTLED row of the active path: a reply still in flight or one that failed is never copied, and a parent
        // with no settled row has nothing to fork.
        const settledId = await ctx.runQuery(internal.agent.branches.lastSettledMessageId, { threadId });
        const forkEnd =
            settledId === null ? null : await ctx.runQuery(internal.agent.branches.resolveForkEnd, { index: undefined, messageId: settledId, threadId });

        if (forkEnd === null) {
            return refuse("empty");
        }

        // Placed as a branch is (a temporary parent's lasting placement), else in the parent's own organization, cap and project,
        // so the child stays under the same policy and caps as the parent.
        const placement = await ctx.runQuery(internal.agent.threads.lastingChatPlacement, { threadId });
        const created = await ctx.runMutation(internal.chat.side_chat.createSideChatThread, {
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
            // The team and the enabled features are part of where the chat lives and how it runs, as the rest of the placement is.
            ...(parent.teamId !== undefined && { teamId: parent.teamId }),
            ...(parent.enabledFeatures !== undefined && { enabledFeatures: parent.enabledFeatures }),
            // An imported conversation keeps its import marker: quick approval does not trust what an outside file brought in.
            ...(parent.createdBy?.startsWith("import:") === true && { createdBy: parent.createdBy }),
            title: parent.title ?? "",
            userId,
        });

        // The caller left the parent's team after the read above: the check ran inside the insert, so nothing was written.
        if (created === null) {
            return refuse("team");
        }

        const newThreadId = created._id as Id<"threads">;

        // The child is removed with its link, so a failed or refused copy leaves neither behind.
        const discard = async (): Promise<void> => await discardNewThread(ctx, newThreadId);

        try {
            // The child keeps the parent's bot, so its runs keep the same persona. Its permission mode is copied after the re-read below.
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
            const sharedNow = await ctx.runQuery(internal.chat.side_chat.sharedWithOthers, { threadId });
            const nowRefused = sideChatRefusalOf(current, current?.userId === userId) ?? (sharedNow ? "shared_or_temporary" : null);

            if (nowRefused !== null) {
                await discard();

                return refuse(nowRefused);
            }

            // Read here, not at the start: a restriction the owner made while the child was being set up is the mode the child keeps.
            if (current?.permissionMode) {
                await ctx.runMutation(internal.chat.thread_state.copyThreadPermissionMode, { mode: current.permissionMode, threadId: newThreadId });
            }

            await ctx.runAction(internal.agent.messages.cloneThread, {
                copyUserIdForVectorSearch: true,
                refuseTrashedSource: true,
                sourceThreadId: threadId,
                statuses: ["success"],
                targetThreadId: newThreadId,
                upToAndIncludingMessageId: forkEnd.endId,
            });

            // A grant accepted while the copy ran would otherwise leave the invitee able to read a chat made from the history they
            // were not given. This narrows that window and does not close it: closing it needs a fence on accepting an invitation.
            if (await ctx.runQuery(internal.chat.side_chat.sharedWithOthers, { threadId })) {
                await discard();

                return refuse("shared_or_temporary");
            }

            if ((await ctx.runQuery(internal.agent.branches.lastSettledMessageId, { threadId: newThreadId })) === null) {
                await discard();

                return refuse("empty");
            }

            if (parent.activeAgent) {
                await ctx.runMutation(internal.agent.agent_switch.adoptForkAgent, { threadId: newThreadId });
            }

            // The copy carries any context reset (`/clear`): the child is cut at it as the parent is.
            if (parent.hasContextReset) {
                await ctx.runMutation(internal.chat.context_reset.markForkedContextReset, { threadId: newThreadId });
            }

            // A handed-over conversation stays handed over in the copy, so the side chat's tools are not auto-approved on it.
            if (parent.hasHandoff) {
                await ctx.runMutation(internal.chat.context_reset.markForkedHandoff, { threadId: newThreadId });
            }

            // The parent's worker-dispatch policy (sources and hourly cap) governs the child's worker requests too.
            if (parent.workerPolicy) {
                await ctx.runMutation(internal.chat.side_chat.copyWorkerPolicy, { threadId: newThreadId, workerPolicy: parent.workerPolicy });
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

        ctx.log.event("chat.create_side_chat", { branchPoint: forkEnd.index, status: "ok" });

        return { status: "ok" as const, threadId: String(newThreadId) };
    });
