/**
 * A one-shot child waiting on an approval, against the real schema with row-level security on: the run waits and
 * keeps its slot, the parent's card lists the request for the owner alone, an answer on the child's thread (with
 * "Always allow" writing the owner's permission) resumes it, and its end posts to the parent once. The reaper waits
 * for the request's own expiry.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { _deletePageForThreadId } from "../agent/threads";
import { respondToToolApproval } from "../chat/tool-permissions";
import { PENDING_APPROVAL_TTL_MS } from "../chat/lib/tool-approval-cleanup";
import { hashPasscode, mintUnlockProof, newPasscodeEpoch, THREAD_LOCKED_CODE } from "../lib/thread-lock";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { createStreamWithMessage } from "../chat/streaming/index";
import { stopActiveForThread } from "../chat/streaming/persistent/library";
import {
    awaitApproval,
    cancelSubAgentRunsForStop,
    completeResumedRun,
    continuingRun,
    endApprovalWaitForMessage,
    listSubAgentApprovals,
    markRunAwaiting,
    postRunResult,
    reapSubAgentRun,
    resumeAwaitingRun,
} from "./functions";
import { SUB_AGENT_APPROVAL_EXPIRED_MESSAGE, SUB_AGENT_NAME, SUB_AGENT_STALE_MS } from "./logic";

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const APPROVAL_ID = "approval-1";
const TOOL = "mcp_Files__delete";
const TOOL_KEY = "mcp:Files:delete";
const NOT_FOUND = /not found/iu;
const STILL_WORKING = /still working/iu;
const ALREADY_ENDED = /already ended/iu;

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, userId } : null;
        },
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
        getSessionUserWithAnonymous: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

// `user` is a `.global()` (D1) table the in-memory harness cannot write.
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            return { _id: userId };
        },
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let parentId: string;
let childId: string;
let runId: Id<"subAgentRuns">;

beforeAll(async () => {
    registerModule(registry, "chat_streaming_persistent_library", await import("../chat/streaming/persistent/library"));
    registerModule(registry, "sub_agents_functions", await import("./functions"));
}, 60_000);

const as = (userId: string) => harness.withIdentity({ userId } as never);
const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);
/** An internal mutation, as the continuation calls it. */
const internalCall = async (procedure: unknown, args: Record<string, unknown>): Promise<unknown> =>
    await harness.action(async (context: any) => await context.runMutation(procedure, args));
const runRow = async (): Promise<any> => await run(async (context) => await context.db.get("subAgentRuns", runId));
const pendingRequests = async (): Promise<any[]> =>
    await run(
        async (context) =>
            await context.db
                .query("toolApprovalRuns")
                .withIndex("by_threadId_status_createdAt", (q: any) => q.eq("threadId", childId).eq("status", "pending"))
                .collect(),
    );
const answer = async (approvalId: string, decision: string): Promise<unknown> =>
    await as(OWNER).mutation(respondToToolApproval as never, { approvalId, decision, threadId: childId } as never);
const continuations = () => jobsQueueMessages.filter((message) => message.body.functionPath.includes("continueAfterToolApproval"));
/** A request of the same run on the same child turn: the step asked for two tools at once. */
const addSiblingRequest = async (approvalId: string): Promise<void> => {
    await run(async (context) => {
        const rows = await context.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", childId))
            .collect();
        const turn = rows.find((row: any) => row.message.role === "assistant");

        await context.db.patch("messages", turn._id, {
            message: {
                ...turn.message,
                content: [
                    ...turn.message.content,
                    { input: { path: "/tmp/other.txt" }, toolCallId: `call-${approvalId}`, toolName: TOOL, type: "tool-call" },
                    { approvalId, toolCallId: `call-${approvalId}`, type: "tool-approval-request" },
                ],
            },
        });
        await context.db.insert("toolApprovalRuns", {
            approvalId,
            config: CONFIG(),
            createdAt: Date.now(),
            status: "pending",
            threadId: childId,
            userId: OWNER,
        });
    });
};
const runStatus = async (): Promise<string> => {
    const row = await runRow();

    return row.status;
};

const CONFIG = () => {
    return {
        autoMediaEnrichment: false,
        instructions: "system prompt",
        mcpServerNames: ["Files"],
        model: "test-model",
        researchDepth: "balanced" as const,
        searchMode: "web",
        shouldAutoContinue: true,
        subAgentRunId: runId,
        toolNames: [TOOL],
        toolPermissionKeys: { [TOOL]: TOOL_KEY },
    };
};

beforeEach(async () => {
    jobsQueueMessages.length = 0;
    harness = lunoraTest(schema as never);
    parentId = await run(async (context) => await context.db.insert("threads", { status: "active", title: "Parent", userId: OWNER }));
    childId = await run(async (context) => await context.db.insert("threads", { status: "active", title: "Sub-agent: tidy up", userId: OWNER }));

    const now = Date.now();

    runId = await run(
        async (context) =>
            await context.db.insert("subAgentRuns", {
                childThreadId: childId,
                createdAt: now,
                depth: 1,
                parentThreadId: parentId,
                startedAt: now,
                status: "running",
                task: "Tidy up the files",
                toolCallId: "call-parent",
                updatedAt: now,
                userId: OWNER,
            }),
    );

    // What the child's headless run saved and recorded when it stopped on the request.
    await run(async (context) => {
        await context.db.insert("messages", {
            message: { content: "Tidy up the files", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            threadId: childId,
            tool: false,
            userId: OWNER,
        });
        await context.db.insert("messages", {
            message: {
                content: [
                    { input: { path: "/tmp/old.txt" }, toolCallId: "call-1", toolName: TOOL, type: "tool-call" },
                    { approvalId: APPROVAL_ID, toolCallId: "call-1", type: "tool-approval-request" },
                ],
                role: "assistant",
            },
            order: 1,
            status: "success",
            stepOrder: 0,
            threadId: childId,
            tool: true,
            userId: OWNER,
        });
        await context.db.insert("toolApprovalRuns", {
            approvalId: APPROVAL_ID,
            config: CONFIG(),
            createdAt: Date.now(),
            status: "pending",
            threadId: childId,
            userId: OWNER,
        });
    });
});

afterEach(() => {
    harness.close();
});

describe("a child that stopped on a request", () => {
    it("waits, with the request's own expiry as its deadline", async () => {
        const before = Date.now();

        expect(await run(async (context) => await markRunAwaiting(context, runId))).toBe(true);

        const row = await runRow();
        const requests = await run(async (context) => await context.db.query("toolApprovalRuns").collect());
        const request = requests[0];

        expect(row.status).toBe("awaiting");
        // Exactly the request's own expiry, not the admission time plus the TTL.
        expect(request.createdAt).toBeLessThanOrEqual(before);
        expect(row.reapAt).toBe(request.createdAt + PENDING_APPROVAL_TTL_MS);
        expect(row.completedAt).toBeUndefined();
    });

    it("still waits when the run's request has expired by now: the reaper is scheduled at once, with no negative delay", async () => {
        await run(async (context) => {
            const [row] = await context.db.query("toolApprovalRuns").collect();

            await context.db.patch("toolApprovalRuns", row._id, { createdAt: 1 });
        });

        expect(await run(async (context) => await markRunAwaiting(context, runId))).toBe(true);
        expect(await runStatus()).toBe("awaiting");
        const scheduled = await runRow();

        expect(scheduled.reapAt).toBe(1 + PENDING_APPROVAL_TTL_MS);
    });

    it("does not wait on an interactive request of the child's own chat, which is not the run's", async () => {
        await run(async (context) => {
            const [row] = await context.db.query("toolApprovalRuns").collect();

            await context.db.patch("toolApprovalRuns", row._id, { resolvedAt: Date.now(), status: "approved" });
            await context.db.insert("toolApprovalRuns", {
                approvalId: "approval-chat",
                config: {
                    autoMediaEnrichment: false,
                    mcpServerNames: [],
                    model: "test-model",
                    researchDepth: "balanced",
                    searchMode: "web",
                    shouldAutoContinue: true,
                    toolNames: [],
                },
                createdAt: Date.now(),
                status: "pending",
                threadId: childId,
                userId: OWNER,
            });
        });

        expect(await run(async (context) => await markRunAwaiting(context, runId))).toBe(false);
        expect(await runStatus()).toBe("running");
    });

    it("does not wait once the request was answered from the child's own thread", async () => {
        await run(async (context) => {
            const [row] = await context.db.query("toolApprovalRuns").collect();

            await context.db.patch("toolApprovalRuns", row._id, { resolvedAt: Date.now(), status: "approved" });
        });

        expect(await run(async (context) => await markRunAwaiting(context, runId))).toBe(false);
        expect(await runStatus()).toBe("running");
    });

    it("closes the requests a run recorded after it was stopped, so none stays answerable and the child does not show as waiting", async () => {
        await run(async (context) => {
            await context.db.patch("subAgentRuns", runId, { status: "cancelled" });
            await context.db.patch("threads", childId, { awaitingInput: "approval" });
        });

        expect(await run(async (context) => await markRunAwaiting(context, runId))).toBe(false);
        expect(await pendingRequests()).toHaveLength(0);

        const child = await run(async (context) => await context.db.get("threads", childId));

        expect(child.awaitingInput).toBeUndefined();
    });

    it("waits on, and lists, its request behind more than a page of older open requests of the child's chat", async () => {
        await run(async (context) => {
            for (let index = 0; index < 60; index += 1) {
                await context.db.insert("toolApprovalRuns", {
                    approvalId: `chat-${index}`,
                    config: { ...CONFIG(), subAgentRunId: undefined },
                    createdAt: 1 + index,
                    status: "pending",
                    threadId: childId,
                    userId: OWNER,
                });
            }
        });

        expect(await run(async (context) => await markRunAwaiting(context, runId))).toBe(true);

        const approvals = await as(OWNER).query(listSubAgentApprovals as never, { parentThreadId: parentId } as never);

        expect(approvals).toStrictEqual([expect.objectContaining({ approvalId: APPROVAL_ID })]);
    });

    it("is taken down by a Stop of its parent, like a running one", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));

        expect(await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER))).toBe(1);
        expect(await runStatus()).toBe("cancelled");
    });

    it("closes every open request of a stopped run, not only the first page of them", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await run(async (context) => {
            for (let index = 0; index < 60; index += 1) {
                await context.db.insert("toolApprovalRuns", {
                    approvalId: `bulk-${index}`,
                    config: CONFIG(),
                    createdAt: Date.now(),
                    status: "pending",
                    threadId: childId,
                    userId: OWNER,
                });
            }
        });

        expect(await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER))).toBe(1);

        const stillOpen = await run(
            async (context) =>
                await context.db
                    .query("toolApprovalRuns")
                    .withIndex("by_threadId_status_createdAt", (q: any) => q.eq("threadId", childId).eq("status", "pending"))
                    .collect(),
        );

        expect(stillOpen).toHaveLength(0);
    });
});

describe("a new message into a child that waits on a request", () => {
    it("denies the request and ends the waiting run", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));

        expect(await internalCall(endApprovalWaitForMessage, { threadId: childId })).toBe(1);
        expect(await runStatus()).toBe("cancelled");

        const rows = await run(async (context) => await context.db.query("toolApprovalRuns").collect());

        expect(rows[0]?.status).toBe("denied");
    });

    it("leaves a working run alone: a sibling request still open while its continuation works waits on no message", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await internalCall(resumeAwaitingRun, { runId });

        expect(await internalCall(endApprovalWaitForMessage, { threadId: childId })).toBe(0);
        expect(await runStatus()).toBe("running");
    });

    it("ends a run whose request the owner's message moved past before the run started waiting", async () => {
        await run(
            async (context) =>
                await context.db.insert("messages", {
                    message: { content: "Never mind, I did it myself.", role: "user" },
                    order: 2,
                    status: "success",
                    stepOrder: 0,
                    threadId: childId,
                    tool: false,
                    userId: OWNER,
                }),
        );

        expect(await run(async (context) => await markRunAwaiting(context, runId))).toBe(false);
        expect(await runStatus()).toBe("cancelled");
        expect(await pendingRequests()).toHaveLength(0);
    });

    it("never ends a worker's run: a worker does not pause on a request", async () => {
        await run(async (context) => await context.db.patch("subAgentRuns", runId, { mode: "worker" }));

        expect(await internalCall(endApprovalWaitForMessage, { threadId: childId })).toBe(0);
        expect(await runStatus()).toBe("running");
    });

    it("leaves a child alone when no request of it is open", async () => {
        await run(async (context) => {
            const [row] = await context.db.query("toolApprovalRuns").collect();

            await context.db.patch("toolApprovalRuns", row._id, { resolvedAt: Date.now(), status: "approved" });
        });

        expect(await internalCall(endApprovalWaitForMessage, { threadId: childId })).toBe(0);
        expect(await runStatus()).toBe("running");
    });
});

describe("listSubAgentApprovals", () => {
    beforeEach(async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
    });

    it("shows the parent's owner which child asks, for which tool and with what input", async () => {
        const approvals = await as(OWNER).query(listSubAgentApprovals as never, { parentThreadId: parentId } as never);

        expect(approvals).toStrictEqual([
            {
                approvalId: APPROVAL_ID,
                childThreadId: childId,
                input: expect.stringContaining("/tmp/old.txt"),
                omittedCharacters: 0,
                runId,
                server: "Files",
                skillSlug: null,
                task: "Tidy up the files",
                toolName: TOOL,
            },
        ]);
    });

    it("cuts a long input and says how much it left out, for the card to word", async () => {
        await run(async (context) => {
            const rows = await context.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", childId))
                .collect();
            const turn = rows.find((row: any) => row.message.role === "assistant");

            await context.db.patch("messages", turn._id, {
                message: {
                    ...turn.message,
                    content: [{ ...turn.message.content[0], input: "x".repeat(4500) }, turn.message.content[1]],
                },
            });
        });

        const [approval] = (await as(OWNER).query(listSubAgentApprovals as never, { parentThreadId: parentId } as never)) as any[];

        expect(approval.input).toHaveLength(4000);
        expect(approval.omittedCharacters).toBe(500);
    });

    it("refuses anyone else as if the conversation did not exist", async () => {
        await expect(as(STRANGER).query(listSubAgentApprovals as never, { parentThreadId: parentId } as never)).rejects.toThrow(NOT_FOUND);
    });

    it("leaves out a request that is no longer open", async () => {
        await run(async (context) => {
            const [row] = await context.db.query("toolApprovalRuns").collect();

            await context.db.patch("toolApprovalRuns", row._id, { resolvedAt: Date.now(), status: "denied" });
        });

        expect(await as(OWNER).query(listSubAgentApprovals as never, { parentThreadId: parentId } as never)).toStrictEqual([]);
    });

    it("refuses a locked parent without its unlock proof, and lists the request with it", async () => {
        const secret = "p".repeat(40);
        const epoch = newPasscodeEpoch();
        const hashed = await hashPasscode("correct horse battery", 1000);

        process.env.STORAGE_SIGNING_SECRET = secret;
        await run(async (context) => {
            await context.db.patch("threads", parentId as Id<"threads">, { lockedAt: Date.now() });
            await context.db.insert("threadPasscodes", {
                createdAt: 1,
                epoch,
                failedAttempts: 0,
                hash: hashed.hash,
                iterations: hashed.iterations,
                salt: hashed.salt,
                threadId: parentId,
                updatedAt: 1,
                userId: OWNER,
            });
        });

        const { proof } = await mintUnlockProof({ epoch, threadId: parentId, userId: OWNER }, secret, Date.now());

        await expect(as(OWNER).query(listSubAgentApprovals as never, { parentThreadId: parentId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
        expect(await as(OWNER).query(listSubAgentApprovals as never, { parentThreadId: parentId, unlockProof: proof } as never)).toHaveLength(1);
    });
});

describe("answering from the parent's card", () => {
    beforeEach(async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
    });

    it("writes the owner's permission for Always allow and resumes the child on its own thread, once", async () => {
        const first = await as(OWNER).mutation(respondToToolApproval as never, { approvalId: APPROVAL_ID, decision: "always", threadId: childId } as never);

        expect(first).toMatchObject({ alreadyResolved: false });

        const prefs = await run(async (context) => await context.db.query("aiUserPreferences").collect());

        expect(prefs[0].toolPermissions).toMatchObject({ [TOOL_KEY]: "auto" });

        expect(continuations()).toHaveLength(1);
        expect(continuations()[0]!.body.args).toMatchObject({ approved: true, config: { subAgentRunId: runId }, threadId: childId });
        // The claim puts the run back to running, in its own transaction.
        expect(await runStatus()).toBe("running");

        const second = await as(OWNER).mutation(respondToToolApproval as never, { approvalId: APPROVAL_ID, decision: "approve", threadId: childId } as never);

        expect(second).toMatchObject({ alreadyResolved: true });
        expect(continuations()).toHaveLength(1);
    });

    it("refuses a second answer to the same run while the first one's continuation runs, and keeps that request open", async () => {
        await addSiblingRequest("approval-2");

        await answer(APPROVAL_ID, "approve");
        await expect(answer("approval-2", "always")).rejects.toThrow(STILL_WORKING);

        expect(continuations()).toHaveLength(1);
        const open = await pendingRequests();

        expect(open.map((row) => row.approvalId)).toStrictEqual(["approval-2"]);

        // The refusal rolled back with its claim: "Always allow" wrote nothing.
        const prefs = await run(async (context) => await context.db.query("aiUserPreferences").collect());

        expect(prefs[0]?.toolPermissions?.[TOOL_KEY]).toBeUndefined();
    });

    it("refuses anyone but the owner", async () => {
        await expect(
            as(STRANGER).mutation(respondToToolApproval as never, { approvalId: APPROVAL_ID, decision: "approve", threadId: childId } as never),
        ).rejects.toThrow();
        expect(jobsQueueMessages).toHaveLength(0);
    });
});

describe("answering a request the run does not wait on", () => {
    it("refuses an answer sent before the run waits, and keeps the request open", async () => {
        await expect(answer(APPROVAL_ID, "approve")).rejects.toThrow(STILL_WORKING);

        expect(continuations()).toHaveLength(0);
        expect(await pendingRequests()).toHaveLength(1);

        // Once it waits, the same request is answered.
        await run(async (context) => await markRunAwaiting(context, runId));
        expect(await answer(APPROVAL_ID, "approve")).toMatchObject({ alreadyResolved: false });
    });

    it("refuses an answer to a run that ended, and writes no permission for Always allow", async () => {
        await run(async (context) => await context.db.patch("subAgentRuns", runId, { status: "cancelled" }));

        await expect(answer(APPROVAL_ID, "always")).rejects.toThrow(ALREADY_ENDED);

        expect(continuations()).toHaveLength(0);
        expect(await run(async (context) => await context.db.query("aiUserPreferences").collect())).toHaveLength(0);
    });
});

describe("a new message saved into the child", () => {
    it("schedules the end of the run's wait from the write that opens the reply's stream, so ending it never fails the send", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));

        await internalCall(createStreamWithMessage, {
            messageId: "new-prompt",
            streamingConfig: { contentType: "text", model: "test-model" },
            threadId: childId,
            userId: OWNER,
        });

        // The harness does not name a function reference: the scheduled end is told apart by its only argument.
        expect(harness.scheduler.list()).toContainEqual(expect.objectContaining({ args: { threadId: childId } }));

        await internalCall(endApprovalWaitForMessage, { threadId: childId });
        expect(await runStatus()).toBe("cancelled");
        expect(await pendingRequests()).toHaveLength(0);
    });
});

describe("the continuation's end", () => {
    const parentReplies = async () => {
        const rows = await run(
            async (context) =>
                await context.db
                    .query("messages")
                    .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", parentId))
                    .collect(),
        );

        return rows.filter((row: { agentName?: string }) => row.agentName === SUB_AGENT_NAME);
    };

    beforeEach(async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
    });

    it("puts the run back to running, then ends it with the child's last row as its answer, posted once", async () => {
        expect(await internalCall(resumeAwaitingRun, { runId })).toBe(true);
        expect(await internalCall(resumeAwaitingRun, { runId })).toBe(false);
        expect(await runStatus()).toBe("running");

        const answerId = await run(
            async (context) =>
                await context.db.insert("messages", {
                    message: { content: [{ text: "Removed /tmp/old.txt.", type: "text" }], role: "assistant" },
                    order: 2,
                    status: "success",
                    stepOrder: 0,
                    threadId: childId,
                    tool: false,
                    userId: OWNER,
                }),
        );

        expect(await internalCall(completeResumedRun, { messageIds: [answerId], outcome: { kind: "succeeded" }, runId })).toBe(true);
        expect(await internalCall(completeResumedRun, { messageIds: [answerId], outcome: { kind: "succeeded" }, runId })).toBe(false);

        expect(await runRow()).toMatchObject({ result: "Removed /tmp/old.txt.", status: "succeeded" });

        const posts = await parentReplies();

        expect(posts).toHaveLength(1);
        expect(JSON.stringify(posts[0].message)).toContain("Removed /tmp/old.txt.");
    });

    it("answers with the newest assistant text when the continuation's last saved row is a tool result", async () => {
        await internalCall(resumeAwaitingRun, { runId });

        const answerId = await run(
            async (context) =>
                await context.db.insert("messages", {
                    message: { content: [{ text: "Removed /tmp/old.txt.", type: "text" }], role: "assistant" },
                    order: 2,
                    status: "success",
                    stepOrder: 0,
                    threadId: childId,
                    tool: false,
                    userId: OWNER,
                }),
        );
        const toolRowId = await run(
            async (context) =>
                await context.db.insert("messages", {
                    message: { content: [{ output: { type: "text", value: "ok" }, toolCallId: "call-1", toolName: TOOL, type: "tool-result" }], role: "tool" },
                    order: 3,
                    status: "success",
                    stepOrder: 0,
                    threadId: childId,
                    tool: true,
                    userId: OWNER,
                }),
        );

        expect(await internalCall(completeResumedRun, { messageIds: [answerId, toolRowId], outcome: { kind: "succeeded" }, runId })).toBe(true);
        expect(await runRow()).toMatchObject({ result: "Removed /tmp/old.txt.", status: "succeeded" });
    });

    it("never answers with text from before the approval when the continuation saves only a tool result", async () => {
        await run(
            async (context) =>
                await context.db.insert("messages", {
                    message: { content: [{ text: "Earlier answer.", type: "text" }], role: "assistant" },
                    order: 1,
                    status: "success",
                    stepOrder: 0,
                    threadId: childId,
                    tool: false,
                    userId: OWNER,
                }),
        );
        await internalCall(resumeAwaitingRun, { runId });

        const toolRowId = await run(
            async (context) =>
                await context.db.insert("messages", {
                    message: { content: [{ output: { type: "text", value: "ok" }, toolCallId: "call-1", toolName: TOOL, type: "tool-result" }], role: "tool" },
                    order: 3,
                    status: "success",
                    stepOrder: 0,
                    threadId: childId,
                    tool: true,
                    userId: OWNER,
                }),
        );

        expect(await internalCall(completeResumedRun, { messageIds: [toolRowId], outcome: { kind: "succeeded" }, runId })).toBe(true);
        expect(JSON.stringify(await runRow())).not.toContain("Earlier answer");
        expect(await runStatus()).toBe("succeeded");
    });

    it("never answers with a reply the owner started in the child while the continuation ran", async () => {
        await internalCall(resumeAwaitingRun, { runId });

        await run(
            async (context) =>
                await context.db.insert("messages", {
                    message: { content: [{ text: "The owner's own reply.", type: "text" }], role: "assistant" },
                    order: 4,
                    status: "success",
                    stepOrder: 0,
                    threadId: childId,
                    tool: false,
                    userId: OWNER,
                }),
        );
        const toolRowId = await run(
            async (context) =>
                await context.db.insert("messages", {
                    message: { content: [{ output: { type: "text", value: "ok" }, toolCallId: "call-1", toolName: TOOL, type: "tool-result" }], role: "tool" },
                    order: 3,
                    status: "success",
                    stepOrder: 0,
                    threadId: childId,
                    tool: true,
                    userId: OWNER,
                }),
        );

        expect(await internalCall(completeResumedRun, { messageIds: [toolRowId], outcome: { kind: "succeeded" }, runId })).toBe(true);
        expect(await runRow()).toMatchObject({ result: "", status: "succeeded" });
    });

    it("resumes with the origin that reached the run, so an unattended chain is not read as the lead's", async () => {
        await run(async (context) => await context.db.patch("subAgentRuns", runId, { dispatchedBy: "trigger" }));
        await internalCall(resumeAwaitingRun, { runId });

        expect(await run(async (context) => await context.runQuery(continuingRun, { runId }))).toStrictEqual({ origin: "trigger" });

        await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER));
        expect(await run(async (context) => await context.runQuery(continuingRun, { runId }))).toBeNull();
    });

    it("waits again when the continuation stopped on another request", async () => {
        await internalCall(resumeAwaitingRun, { runId });

        expect(await internalCall(awaitApproval, { runId })).toBe(true);
        expect(await runStatus()).toBe("awaiting");
    });

    it("never takes a row from another thread as the answer", async () => {
        await internalCall(resumeAwaitingRun, { runId });

        const elsewhere = await run(
            async (context) =>
                await context.db.insert("messages", {
                    message: { content: "not the child's", role: "assistant" },
                    order: 5,
                    status: "success",
                    stepOrder: 0,
                    threadId: parentId,
                    tool: false,
                    userId: OWNER,
                }),
        );

        await internalCall(completeResumedRun, { messageIds: [elsewhere], outcome: { kind: "succeeded" }, runId });

        expect(await runRow()).toMatchObject({ result: "" });
    });
});

describe("a nested result for a child that waits on a request", () => {
    it("is held back while the child waits, so its request stays on the latest turn, and posted once the wait is over", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));

        const now = Date.now();
        const nestedId = await run(
            async (context) =>
                await context.db.insert("subAgentRuns", {
                    completedAt: now,
                    createdAt: now,
                    depth: 2,
                    parentThreadId: childId,
                    result: "Nested answer.",
                    startedAt: now,
                    status: "succeeded",
                    task: "Look deeper",
                    toolCallId: "call-nested",
                    updatedAt: now,
                    userId: OWNER,
                }),
        );
        const nestedPosts = async () => {
            const rows = await run(
                async (context) =>
                    await context.db
                        .query("messages")
                        .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", childId))
                        .collect(),
            );

            return rows.filter((row: { agentName?: string }) => row.agentName === SUB_AGENT_NAME);
        };

        expect(await run(async (context) => await postRunResult(context, nestedId, 0))).toBe(false);
        expect(await nestedPosts()).toHaveLength(0);
        expect(harness.scheduler.list()).toContainEqual(expect.objectContaining({ args: { attempt: 0, failures: 0, runId: nestedId } }));
        // The request is still the child's latest turn: the owner can answer it.
        expect(await as(OWNER).query(listSubAgentApprovals as never, { parentThreadId: parentId } as never)).toHaveLength(1);

        await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER));

        expect(await run(async (context) => await postRunResult(context, nestedId, 0))).toBe(true);
        expect(await nestedPosts()).toHaveLength(1);
    });
});

describe("the reaper of a waiting run", () => {
    it("leaves it until the request expires, then fails it", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));

        const { createdAt, reapAt } = await runRow();

        // The reaper scheduled at admission fires first and finds a later deadline.
        await run(async (context) => await reapSubAgentRun(context, runId, createdAt + SUB_AGENT_STALE_MS));
        expect(await runStatus()).toBe("awaiting");

        await run(async (context) => await reapSubAgentRun(context, runId, reapAt));
        expect(await runRow()).toMatchObject({ error: SUB_AGENT_APPROVAL_EXPIRED_MESSAGE, status: "failed" });
    });

    it("gives a resumed run a fresh window: the waiting deadline's reaper does nothing early", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));

        const { reapAt: waitingDeadline } = await runRow();

        await internalCall(resumeAwaitingRun, { runId });

        const { reapAt } = await runRow();

        expect(reapAt).toBeLessThan(waitingDeadline);

        await run(async (context) => await reapSubAgentRun(context, runId, reapAt - 1));
        expect(await runStatus()).toBe("running");

        await run(async (context) => await reapSubAgentRun(context, runId, reapAt));
        expect(await runStatus()).toBe("failed");
    });

    it("stops the resumed child's own stream when the reaper fails the run, so its tools stop running", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await answer(APPROVAL_ID, "approve");
        const { reapAt } = await runRow();

        await run(async (context) => await reapSubAgentRun(context, runId, reapAt));
        expect(await runStatus()).toBe("failed");

        // The harness does not name a function reference, so the stop is told apart by its arguments: only the stream the
        // answer opened (keyed on the approval id), not every live reply of the child thread.
        expect(harness.scheduler.list()).toContainEqual(expect.objectContaining({ args: { messageId: APPROVAL_ID, onlyNamed: true, threadId: childId } }));
    });

    it("stops nothing when the continuation ended before the scheduled stop ran, not even the owner's own reply", async () => {
        await internalCall(createStreamWithMessage, {
            messageId: "owner-prompt",
            streamingConfig: { contentType: "text", model: "test-model" },
            threadId: childId,
            userId: OWNER,
        });

        expect(await internalCall(stopActiveForThread, { messageId: APPROVAL_ID, onlyNamed: true, threadId: childId })).toBe(false);

        const live = await run(
            async (context) =>
                await context.db
                    .query("persistentStreams")
                    .withIndex("by_threadId_status", (q: any) => q.eq("threadId", childId).eq("status", "pending"))
                    .collect(),
        );

        expect(live.map((stream: { messageId: string }) => stream.messageId)).toStrictEqual(["owner-prompt"]);
    });

    it("stops nothing when the run has no continuation streaming: a reply the owner started in the child keeps going", async () => {
        // The run's request was answered; the run is running, with no stream of its own yet.
        await run(async (context) => {
            const [row] = await context.db.query("toolApprovalRuns").collect();

            await context.db.patch("toolApprovalRuns", row._id, { resolvedAt: Date.now(), status: "approved" });
        });
        await internalCall(createStreamWithMessage, {
            messageId: "owner-prompt",
            streamingConfig: { contentType: "text", model: "test-model" },
            threadId: childId,
            userId: OWNER,
        });

        await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER));
        expect(await runStatus()).toBe("cancelled");
        expect(harness.scheduler.list()).not.toContainEqual(expect.objectContaining({ args: expect.objectContaining({ threadId: childId }) }));
    });

    it("still fails a run that never waited at its admission deadline", async () => {
        const { createdAt } = await runRow();

        await run(async (context) => await reapSubAgentRun(context, runId, createdAt + SUB_AGENT_STALE_MS));
        expect(await runStatus()).toBe("failed");
    });
});

describe("deleting the child thread of a waiting run", () => {
    it("ends the run as cancelled and tells the parent it ended, so the slot is not held until the reaper", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        expect(await runStatus()).toBe("awaiting");

        await run(async (context) => await context.runMutation(_deletePageForThreadId, { threadId: childId as never }));

        expect(await run(async (context) => await context.db.get("threads", childId))).toBeNull();
        expect(await runStatus()).toBe("cancelled");
        expect(await runRow()).toMatchObject({ resultPostedAt: expect.any(Number) });

        const parentMessages = await run(
            async (context) =>
                await context.db
                    .query("messages")
                    .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", parentId))
                    .collect(),
        );

        expect(parentMessages.filter((row: { agentName?: string }) => row.agentName === SUB_AGENT_NAME)).toHaveLength(1);
    });
});
