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
import { respondToToolApproval } from "../chat/tool-permissions";
import { PENDING_APPROVAL_TTL_MS } from "../chat/lib/tool-approval-cleanup";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
    awaitApproval,
    cancelSubAgentRunsForStop,
    completeResumedRun,
    endApprovalWaitForMessage,
    listSubAgentApprovals,
    markRunAwaiting,
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

        expect(row.status).toBe("awaiting");
        expect(row.reapAt).toBeGreaterThanOrEqual(before + PENDING_APPROVAL_TTL_MS);
        expect(row.completedAt).toBeUndefined();
    });

    it("does not wait once the request was answered from the child's own thread", async () => {
        await run(async (context) => {
            const [row] = await context.db.query("toolApprovalRuns").collect();

            await context.db.patch("toolApprovalRuns", row._id, { resolvedAt: Date.now(), status: "approved" });
        });

        expect(await run(async (context) => await markRunAwaiting(context, runId))).toBe(false);
        expect(await runStatus()).toBe("running");
    });

    it("is taken down by a Stop of its parent, like a running one", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));

        expect(await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER))).toBe(1);
        expect(await runStatus()).toBe("cancelled");
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

    it("ends a worker's waiting run and starts the message queued behind it", async () => {
        const queuedId = await run(
            async (context) =>
                await context.db.insert("subAgentRuns", {
                    childThreadId: childId,
                    createdAt: Date.now() + 1,
                    depth: 1,
                    mode: "worker",
                    parentThreadId: parentId,
                    status: "queued",
                    task: "Tidy up again",
                    updatedAt: Date.now(),
                    userId: OWNER,
                }),
        );

        await run(async (context) => await context.db.patch("subAgentRuns", runId, { mode: "worker" }));

        expect(await internalCall(endApprovalWaitForMessage, { threadId: childId })).toBe(1);
        expect(await runStatus()).toBe("cancelled");

        // The queued message's run is handed to a job: its status moves on when the job claims it.
        const started = jobsQueueMessages.filter((message) => JSON.stringify(message.body).includes(queuedId));

        expect(started).toHaveLength(1);
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
                runId,
                server: "Files",
                skillSlug: null,
                task: "Tidy up the files",
                toolName: TOOL,
            },
        ]);
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

        const continuations = jobsQueueMessages.filter((message) => message.body.functionPath.includes("continueAfterToolApproval"));

        expect(continuations).toHaveLength(1);
        expect(continuations[0]!.body.args).toMatchObject({ approved: true, config: { subAgentRunId: runId }, threadId: childId });

        const second = await as(OWNER).mutation(respondToToolApproval as never, { approvalId: APPROVAL_ID, decision: "approve", threadId: childId } as never);

        expect(second).toMatchObject({ alreadyResolved: true });
        expect(jobsQueueMessages.filter((message) => message.body.functionPath.includes("continueAfterToolApproval"))).toHaveLength(1);
    });

    it("refuses anyone but the owner", async () => {
        await expect(
            as(STRANGER).mutation(respondToToolApproval as never, { approvalId: APPROVAL_ID, decision: "approve", threadId: childId } as never),
        ).rejects.toThrow();
        expect(jobsQueueMessages).toHaveLength(0);
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

        expect(await internalCall(completeResumedRun, { lastMessageId: answerId, outcome: { kind: "succeeded" }, runId })).toBe(true);
        expect(await internalCall(completeResumedRun, { lastMessageId: answerId, outcome: { kind: "succeeded" }, runId })).toBe(false);

        expect(await runRow()).toMatchObject({ result: "Removed /tmp/old.txt.", status: "succeeded" });

        const posts = await parentReplies();

        expect(posts).toHaveLength(1);
        expect(JSON.stringify(posts[0].message)).toContain("Removed /tmp/old.txt.");
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

        await internalCall(completeResumedRun, { lastMessageId: elsewhere, outcome: { kind: "succeeded" }, runId });

        expect(await runRow()).toMatchObject({ result: "" });
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

    it("still fails a run that never waited at its admission deadline", async () => {
        const { createdAt } = await runRow();

        await run(async (context) => await reapSubAgentRun(context, runId, createdAt + SUB_AGENT_STALE_MS));
        expect(await runStatus()).toBe("failed");
    });
});
