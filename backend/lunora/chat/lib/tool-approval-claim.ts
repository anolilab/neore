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
import { throwThreadLocked } from "../../lib/thread-lock";

export type ToolApprovalDecision = "always" | "approve" | "deny" | "hour" | "today";

export type ClaimResult =
    | { kind: "already-resolved"; status: "approved" | "denied" | "pending"; streamId: string | null }
    | { config: ToolRunConfig; kind: "claimed"; ownerId: string; runId: Id<"toolApprovalRuns">; toolName: string | null };

/** How far back the "is this still the latest assistant turn" check looks. */
const LATEST_MESSAGE_WINDOW = 20;

interface StoredPart {
    approvalId?: string;
    input?: unknown;
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
    const request = await findPendingRequestOnLatestTurn(ctx, threadId, approvalId);

    return request && { toolName: request.toolName };
};

/** An unanswered request on a thread's latest assistant turn: the call's id, tool and arguments. */
export interface PendingToolRequest {
    input: unknown;
    toolCallId: string | null;
    toolName: string | null;
}

/**
 * The thread's newest rows, newest first, as far back as the latest-turn check looks: on a branched thread, the end of
 * the path the user is on. A query that admitted several threads passes a `reader` keyed on this one.
 */
export const latestTurnRows = async (
    reader: Pick<QueryCtx, "db">,
    threadId: Id<"threads">,
    activeLeafMessageId: string | undefined,
): Promise<Doc<"messages">[]> =>
    activeLeafMessageId
        ? await loadActivePathTail(reader, threadId, activeLeafMessageId, LATEST_MESSAGE_WINDOW)
        : await reader.db
              .query("messages")
              .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
              .order("desc")
              .take(LATEST_MESSAGE_WINDOW);

/** The requests in an assistant message's `parts` that `answered` does not hold, by approval id, each with its call. */
const unansweredRequests = (parts: ReadonlyArray<StoredPart>, answered: ReadonlySet<string>): Map<string, PendingToolRequest> => {
    const open = new Map<string, PendingToolRequest>();

    for (const request of parts) {
        if (request.type !== "tool-approval-request" || request.approvalId === undefined || answered.has(request.approvalId)) {
            continue;
        }

        const call = parts.find((p) => p.type === "tool-call" && p.toolCallId === request.toolCallId);

        open.set(request.approvalId, { input: call?.input, toolCallId: call?.toolCallId ?? null, toolName: call?.toolName ?? null });
    }

    return open;
};

/**
 * The unanswered requests of the latest assistant turn in `recent` (newest first), by approval id. Tool messages newer
 * than that turn answer requests; a newer user message (or none in the window) means the conversation moved on.
 */
export const openRequestsOfLatestTurn = (recent: ReadonlyArray<Doc<"messages">>): Map<string, PendingToolRequest> => {
    const answered = new Set<string>();

    for (const message of recent) {
        const role = roleOf(message);

        if (role === "assistant") {
            return unansweredRequests(partsOf(message), answered);
        }

        if (role !== "tool") {
            return new Map();
        }

        for (const part of partsOf(message)) {
            if (part.type === "tool-approval-response" && part.approvalId !== undefined) {
                answered.add(part.approvalId);
            }
        }
    }

    return new Map();
};

/** The same lookup as `findPendingApprovalOnLatestTurn`, with the call's id and arguments too: what a pending request shows a reader. */
export const findPendingRequestOnLatestTurn = async (
    ctx: Pick<QueryCtx, "db">,
    threadId: Id<"threads">,
    approvalId: string,
): Promise<PendingToolRequest | undefined> => {
    const thread = await ctx.db.get("threads", threadId);

    return openRequestsOfLatestTurn(await latestTurnRows(ctx, threadId, thread?.activeLeafMessageId)).get(approvalId);
};

/** Owner, or a non-expired `write`/`admin` grant. */
const canWriteThread = async (ctx: Pick<MutationCtx, "db">, thread: Doc<"threads">, callerId: string): Promise<boolean> => {
    if (thread.userId === callerId) {
        return true;
    }

    const access = await ctx.db.threadAccess.findFirst({ where: { threadId: thread._id, userId: callerId } });

    return !!access && (access.permission === "write" || access.permission === "admin") && (!access.expiresAt || access.expiresAt >= Date.now());
};

/** `resolvedBy` of a request denied because the person walked away from the pause that held it (Stop, or a new message). */
export const APPROVAL_ABANDONED_BY = "abandoned";

/** `error.data.code` of the refusal to answer such a request; the card words it. */
export const TOOL_REQUEST_ABANDONED = "TOOL_REQUEST_ABANDONED";

/** `resolvedBy` of a request closed because the sub-agent run that waited on it ended (`sub-agents/functions.ts`). */
export const SUB_AGENT_RUN_ENDED_BY = "run-ended";

/** `error.data.code` of the refusal to answer a sub-agent's request while the sub-agent is still working. */
export const SUB_AGENT_STILL_WORKING = "SUB_AGENT_STILL_WORKING";

export const claimToolApproval = async (
    ctx: Pick<MutationCtx, "db">,
    args: { approvalId: string; callerId: string; decision: ToolApprovalDecision; threadId: Id<"threads">; unlockProof?: string | null },
): Promise<ClaimResult> => {
    const { approvalId, callerId, decision, threadId, unlockProof } = args;
    // Through the access helper, so a write collaborator still gets the FORBIDDEN
    // below rather than a row-level-security NOT_FOUND, and the owner's thread is
    // admitted for the reads that follow.
    const access = await resolveThreadReadAccess(ctx, threadId, callerId, unlockProof);

    // A locked chat's approval resumes its run, so the owner's proof is needed here too.
    if (access?.kind === "locked") {
        throwThreadLocked();
    }

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

    // Denied by walking away, not by an answer: nothing is waiting on it any more, so a late answer is refused rather than echoed.
    if (run.status === "denied" && run.resolvedBy === APPROVAL_ABANDONED_BY) {
        throw new LunoraError("CONFLICT", "This request was closed when the conversation moved on. Ask again in the chat", {
            data: { code: TOOL_REQUEST_ABANDONED },
        });
    }

    // Closed because the sub-agent run that waited on it ended, not by an answer: said as such.
    if (run.status === "denied" && run.resolvedBy === SUB_AGENT_RUN_ENDED_BY) {
        throw new LunoraError("CONFLICT", "This sub-agent has already ended");
    }

    if (run.status !== "pending") {
        return { kind: "already-resolved", status: run.status, streamId: run.streamId ?? null };
    }

    const pending = await findPendingApprovalOnLatestTurn(ctx, threadId, approvalId);

    if (!pending) {
        throw new LunoraError("CONFLICT", "This tool request is no longer pending");
    }

    // A sub-agent's request is answered only while its run waits on it. Its continuation puts the run back to running in this
    // transaction (`resumeClaimedRun`), so a second answer to the same run, or one sent before the run starts waiting, is
    // refused here and its request stays open, instead of being consumed by a continuation that cannot run it.
    if (run.config.subAgentRunId !== undefined) {
        // A sub-agent child runs headless, and a headless run never reads a time-boxed allow: it would be ignored.
        if (decision === "hour" || decision === "today") {
            throw new LunoraError("BAD_REQUEST", "A sub-agent's request can be allowed once or always, or denied");
        }

        const subAgentRun = await ctx.db.get("subAgentRuns", run.config.subAgentRunId);

        if (subAgentRun?.status === "queued" || subAgentRun?.status === "running") {
            throw new LunoraError("CONFLICT", "The sub-agent is still working on another request. This one closes when its run ends", {
                data: { code: SUB_AGENT_STILL_WORKING },
            });
        }

        if (subAgentRun?.status !== "awaiting") {
            throw new LunoraError("CONFLICT", "This sub-agent has already ended");
        }
    }

    await ctx.db.patch("toolApprovalRuns", run._id, {
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
