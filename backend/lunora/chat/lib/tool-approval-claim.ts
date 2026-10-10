/**
 * The authorisation + state-transition core of `respondToToolApproval`, kept
 * apart from the procedure so it can be driven against a real schema in tests.
 *
 * Claiming is the single `pending -> approved|denied` transition on the
 * `toolApprovalRuns` row. Mutations are serialised per shard, so a double click
 * or a second tab reads the row AFTER the first transition and gets the existing
 * outcome back instead of starting a second continuation.
 */
import { LunoraError } from "lunorash/server";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { loadActivePathTail } from "../../agent/branch-rows";
import { isToolApprovalRunExpired } from "./tool-approval-cleanup";
import type { ToolRunConfig } from "./tool-run-config";
import { admitOwnedThread, resolveThreadReadAccess } from "../../agent/thread-read-access";

export type ToolApprovalDecision = "always" | "approve" | "deny";

export type ClaimResult =
    | { kind: "already-resolved"; status: "approved" | "denied" | "pending"; streamId: string | null }
    | { config: ToolRunConfig; kind: "claimed"; ownerId: string; runId: Id<"toolApprovalRuns">; toolName: string | null };

/** How far back the "is this still the latest assistant turn" check looks. */
const LATEST_MESSAGE_WINDOW = 20;

interface StoredPart {
    approvalId?: string;
    toolCallId?: string;
    toolName?: string;
    type?: string;
}

const partsOf = (message: Doc<"messages">): StoredPart[] => {
    const content = (message.message as { content?: unknown } | undefined)?.content;

    return Array.isArray(content) ? (content as StoredPart[]) : [];
};

const roleOf = (message: Doc<"messages">): string | undefined => (message.message as { role?: string } | undefined)?.role;

/**
 * Is `approvalId` an unanswered request on the thread's LATEST assistant turn?
 * Returns the requested tool's name when it is, `undefined` when it is not.
 *
 * A newer user or assistant message means the conversation moved on and the
 * request is stale; a tool message answering this id means it was resolved.
 */
export const findPendingApprovalOnLatestTurn = async (
    ctx: Pick<QueryCtx, "db">,
    threadId: Id<"threads">,
    approvalId: string,
): Promise<{ toolName: string | null } | undefined> => {
    const thread = await ctx.db.get(threadId);
    // A branched thread's latest turn is the end of the path the user is on;
    // the newest rows in storage order may belong to a sibling branch.
    const recent = thread?.activeLeafMessageId
        ? await loadActivePathTail(ctx, threadId, thread.activeLeafMessageId, LATEST_MESSAGE_WINDOW)
        : await ctx.db
              .query("messages")
              .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
              .order("desc")
              .take(LATEST_MESSAGE_WINDOW);

    for (const message of recent) {
        const role = roleOf(message);
        const parts = partsOf(message);

        if (role === "tool") {
            if (parts.some((p) => p.type === "tool-approval-response" && p.approvalId === approvalId)) {
                return undefined;
            }

            continue;
        }

        if (role !== "assistant") {
            return undefined;
        }

        const request = parts.find((p) => p.type === "tool-approval-request" && p.approvalId === approvalId);

        if (!request) {
            return undefined;
        }

        const call = parts.find((p) => p.type === "tool-call" && p.toolCallId === request.toolCallId);

        return { toolName: call?.toolName ?? null };
    }

    return undefined;
};

/** Owner, or a non-expired `write`/`admin` grant. */
const canWriteThread = async (ctx: Pick<MutationCtx, "db">, thread: Doc<"threads">, callerId: string): Promise<boolean> => {
    if (thread.userId === callerId) {
        return true;
    }

    const access = await ctx.db.threadAccess.findFirst({ where: { threadId: thread._id, userId: callerId } });

    return !!access && (access.permission === "write" || access.permission === "admin") && (!access.expiresAt || access.expiresAt >= Date.now());
};

export const claimToolApproval = async (
    ctx: Pick<MutationCtx, "db">,
    args: { approvalId: string; callerId: string; decision: ToolApprovalDecision; threadId: Id<"threads"> },
): Promise<ClaimResult> => {
    const { approvalId, callerId, decision, threadId } = args;
    // Through the access helper, so a write collaborator still gets the FORBIDDEN
    // below rather than a row-level-security NOT_FOUND, and the owner's thread is
    // admitted for the reads that follow.
    const access = await resolveThreadReadAccess(ctx, threadId, callerId);
    const thread = access?.kind === "full" ? access.thread : null;

    // One message for "missing" and "not yours", so the answer does not reveal
    // whether a thread id exists.
    if (!thread || thread.deleted || !(await canWriteThread(ctx, thread, callerId))) {
        throw new LunoraError("NOT_FOUND", "Thread not found");
    }

    // Approving runs the tool with the OWNER's MCP servers and keys, so only the
    // owner may answer — a write collaborator can steer the chat, not spend
    // someone else's credentials. They already know the thread exists.
    if (thread.userId !== callerId) {
        throw new LunoraError("FORBIDDEN", "Only the thread owner can answer a tool request");
    }

    admitOwnedThread(ctx, thread, callerId);

    const run = await ctx.db
        .query("toolApprovalRuns")
        .withIndex("by_approvalId", (q) => q.eq("approvalId", approvalId))
        .first();

    // No snapshot means the run that paused cannot be reproduced. Fail closed
    // rather than resume with a guessed (possibly wider) tool set.
    if (!run || run.threadId !== threadId || run.userId !== thread.userId) {
        throw new LunoraError("NOT_FOUND", "This tool request can no longer be resumed");
    }

    // Past retention but not yet swept: refuse it. Not deleted here — this path
    // throws, and a throw rolls the mutation (and any delete) back.
    if (isToolApprovalRunExpired(run, Date.now())) {
        throw new LunoraError("NOT_FOUND", "This tool request can no longer be resumed");
    }

    if (run.status !== "pending") {
        return { kind: "already-resolved", status: run.status, streamId: run.streamId ?? null };
    }

    const pending = await findPendingApprovalOnLatestTurn(ctx, threadId, approvalId);

    if (!pending) {
        throw new LunoraError("CONFLICT", "This tool request is no longer pending");
    }

    await ctx.db.patch(run._id, {
        resolvedAt: Date.now(),
        resolvedBy: callerId,
        status: decision === "deny" ? "denied" : "approved",
    });

    return { config: run.config, kind: "claimed", ownerId: run.userId, runId: run._id, toolName: pending.toolName };
};

/** Approval ids requested by a run, read from the messages it saved. */
export const collectApprovalRequestIds = (savedMessages: ReadonlyArray<{ message?: { content?: unknown; role?: string } }> | undefined): string[] => {
    const ids: string[] = [];

    const messages = savedMessages ?? [];

    for (const saved of messages) {
        const content = saved.message?.role === "assistant" ? saved.message.content : undefined;

        if (!Array.isArray(content)) {
            continue;
        }

        for (const part of content as StoredPart[]) {
            if (part.type === "tool-approval-request" && part.approvalId) {
                ids.push(part.approvalId);
            }
        }
    }

    return ids;
};

/** The approval ids among a run's saved requests that are `askUser` questions — what the notification calls a question. */
export const collectAskUserApprovalIds = (
    savedMessages: ReadonlyArray<{ message?: { content?: unknown; role?: string } }> | undefined,
    askUserToolName: string,
): string[] => {
    const ids: string[] = [];
    const messages = savedMessages ?? [];

    for (const saved of messages) {
        const content = saved.message?.role === "assistant" ? saved.message.content : undefined;

        if (!Array.isArray(content)) {
            continue;
        }

        const parts = content as StoredPart[];
        const askUserCalls = new Set(
            parts.flatMap((part) => (part.type === "tool-call" && part.toolName === askUserToolName && part.toolCallId ? [part.toolCallId] : [])),
        );

        for (const part of parts) {
            if (part.type === "tool-approval-request" && part.approvalId && part.toolCallId && askUserCalls.has(part.toolCallId)) {
                ids.push(part.approvalId);
            }
        }
    }

    return ids;
};
