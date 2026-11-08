/**
 * A one-shot child waiting on an approval, against the real schema with row-level security on: the run waits and keeps
 * its slot until the request's own expiry, a Stop or the reaper ends it and denies its request, its beat watch leaves a
 * run that waited to its reaper, and a housekeeping sweep reaps a wait whose reaper was lost.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { PENDING_APPROVAL_TTL_MS } from "../chat/lib/tool-approval-cleanup";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { cancelSubAgentRunsForStop, markRunAwaiting, reapOverdueWaits, reapSubAgentRun, watchSubAgentRunBeat } from "./functions";
import { SUB_AGENT_APPROVAL_EXPIRED_MESSAGE, SUB_AGENT_STALE_MS } from "./logic";

const OWNER = "user-owner";
const APPROVAL_ID = "approval-1";
const SIBLING_ID = "approval-2";
const TOOL = "mcp_Files__delete";
const TOOL_KEY = "mcp:Files:delete";

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
                    // A sibling: the same step asked for a second tool at once.
                    { input: { path: "/tmp/other.txt" }, toolCallId: "call-2", toolName: TOOL, type: "tool-call" },
                    { approvalId: SIBLING_ID, toolCallId: "call-2", type: "tool-approval-request" },
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

        for (const approvalId of [APPROVAL_ID, SIBLING_ID]) {
            await context.db.insert("toolApprovalRuns", {
                approvalId,
                config: CONFIG(),
                createdAt: Date.now(),
                status: "pending",
                threadId: childId,
                userId: OWNER,
            });
        }
    });
});

afterEach(() => {
    harness.close();
});

describe("a child that stopped on a request", () => {
    it("waits until the request's own expiry, then the reaper fails it", async () => {
        expect(await run(async (context) => await markRunAwaiting(context, runId))).toBe(true);

        const { createdAt, reapAt } = await runRow();
        const [first] = await pendingRequests();

        expect(reapAt).toBe(first.createdAt + PENDING_APPROVAL_TTL_MS);

        // The reaper scheduled at admission fires first and finds the later deadline.
        await run(async (context) => await reapSubAgentRun(context, runId, createdAt + SUB_AGENT_STALE_MS));
        expect(await runStatus()).toBe("awaiting");

        await run(async (context) => await reapSubAgentRun(context, runId, reapAt));
        expect(await runRow()).toMatchObject({ error: SUB_AGENT_APPROVAL_EXPIRED_MESSAGE, status: "failed" });
        // Ended, its request can no longer be answered.
        expect(await pendingRequests()).toHaveLength(0);
    });

    it("leaves a run's requests open when it ends without ever having waited", async () => {
        // The seeded requests belong to a run that is still running: it ends without ever having waited, so its end reads no
        // approval rows. The requests stay open, and the claim's refusal for an ended run (lands in the next part: "refuses an answer ...
        // after it ended") keeps them unanswerable; `markRunAwaiting` closes them if the run's own wait comes after.
        expect(await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER))).toBe(1);
        expect(await runStatus()).toBe("cancelled");
        expect(await pendingRequests()).toHaveLength(2);
    });

    it.each([
        ["clears the child's approval wait", "approval", undefined],
        ["leaves the child's open question alone", "question", "question"],
    ] as const)("closes its requests when a later message moved the thread past them, and %s", async (_case, before, after) => {
        await run(async (context) => {
            await context.db.patch("threads", childId, { awaitingInput: before });
            await context.db.insert("messages", {
                message: { content: "Never mind, I did it myself.", role: "user" },
                order: 2,
                status: "success",
                stepOrder: 0,
                threadId: childId,
                tool: false,
                userId: OWNER,
            });
        });

        expect(await run(async (context) => await markRunAwaiting(context, runId))).toBe(false);
        expect(await runStatus()).toBe("cancelled");
        expect(await pendingRequests()).toHaveLength(0);

        const child = await run(async (context) => await context.db.get("threads", childId));

        expect(child.awaitingInput).toBe(after);
    });

    it("is taken down by a Stop of its parent, which denies its open request", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));

        expect(await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER))).toBe(1);
        expect(await runStatus()).toBe("cancelled");
        expect(await pendingRequests()).toHaveLength(0);
    });
});

describe("a child that waited on a request", () => {
    it("is not failed as interrupted by its beat watch while its continuation answers, which does not beat", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        // What an answer leaves: the run is back to running, with the fresh deadline its reaper owns.
        await run(async (context) => await context.db.patch("subAgentRuns", runId, { reapAt: Date.now() + SUB_AGENT_STALE_MS, status: "running" }));

        const { startedAt } = await runRow();

        // Well past the beat watch's silence window: the reaper's deadline owns the run now.
        await run(async (context) => await watchSubAgentRunBeat(context, runId, startedAt, Date.now() + 10 * 60_000));
        expect(await runStatus()).toBe("running");
    });

    it("is reaped by the housekeeping backstop when its own reaper was lost", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await run(async (context) => await context.db.patch("subAgentRuns", runId, { reapAt: Date.now() - 1000 }));

        expect(await internalCall(reapOverdueWaits, {})).toBe(1);
        expect(await runRow()).toMatchObject({ error: SUB_AGENT_APPROVAL_EXPIRED_MESSAGE, status: "failed" });
    });

    it("schedules the backstop's next pass at once when a pass reaps a full batch", async () => {
        // The harness records this self-scheduled job without its path, so the new job is found by id.
        const overdue = async (count: number): Promise<void> =>
            await run(async (context) => {
                const { _creationTime, _id, ...row } = await context.db.get("subAgentRuns", runId);

                for (let index = 0; index < count; index += 1) {
                    await context.db.insert("subAgentRuns", { ...row, reapAt: Date.now() - 1000, status: "awaiting" });
                }
            });

        await overdue(21);

        const before = harness.scheduler.list().map((job) => job.id);

        expect(await internalCall(reapOverdueWaits, {})).toBe(20);

        const [next, ...others] = harness.scheduler.list().filter((job) => !before.includes(job.id));

        expect(next).toBeDefined();
        expect(others).toHaveLength(0);
        // The follow-up, run as the scheduler would, takes the rest and queues no further pass.
        expect(await internalCall(reapOverdueWaits, next?.args ?? {})).toBe(1);
        expect(harness.scheduler.list()).toHaveLength(before.length + 1);
    });
});
