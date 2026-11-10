/**
 * A one-shot child waiting on an approval, against the real schema with row-level security on: the run waits and
 * keeps its slot, only its owner answers on the child's thread (with "Always allow" writing the owner's permission),
 * the answer resumes it once, and its end posts to the parent once. The reaper waits for the request's own expiry.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { respondToToolApproval } from "../chat/tool-permissions";
import { PENDING_APPROVAL_TTL_MS } from "../chat/lib/tool-approval-cleanup";
import { THREAD_LOCKED_CODE } from "../lib/thread-lock";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
    cancelSubAgentRunsForStop,
    completeResumedRun,
    listSubAgentApprovals,
    markRunAwaiting,
    postRunResult,
    reapOverdueWaits,
    reapSubAgentRun,
    watchSubAgentRunBeat,
} from "./functions";
import { SUB_AGENT_APPROVAL_EXPIRED_MESSAGE, SUB_AGENT_NAME, SUB_AGENT_STALE_MS } from "./logic";

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const APPROVAL_ID = "approval-1";
const SIBLING_ID = "approval-2";
const TOOL = "mcp_Files__delete";
const TOOL_KEY = "mcp:Files:delete";
const STILL_WORKING = /still working/iu;
const NOT_FOUND = /not found/iu;
const ONCE_OR_ALWAYS = /once or always/iu;
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
const listed = async (userId = OWNER, threadId = parentId): Promise<any[]> =>
    (await as(userId).query(listSubAgentApprovals as never, { parentThreadId: threadId } as never)) as any[];
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

const parentReplies = async (): Promise<any[]> => {
    const rows = await run(
        async (context) =>
            await context.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", parentId))
                .collect(),
    );

    return rows.filter((row: { agentName?: string }) => row.agentName === SUB_AGENT_NAME);
};

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

    it("closes a run's requests when it ends without ever having waited", async () => {
        // The seeded requests belong to a run that is still running: it failed (or was stopped) between recording them and
        // its wait. Its end closes them, so they do not stay open, with the child shown as waiting, until they expire.
        expect(await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER))).toBe(1);
        expect(await runStatus()).toBe("cancelled");
        expect(await pendingRequests()).toHaveLength(0);
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

describe("answering a waiting child's request", () => {
    beforeEach(async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
    });

    it("writes the owner's permission for Always allow and resumes the child on its own thread, once", async () => {
        expect(await answer(APPROVAL_ID, "always")).toMatchObject({ alreadyResolved: false });

        const prefs = await run(async (context) => await context.db.query("aiUserPreferences").collect());

        expect(prefs[0].toolPermissions).toMatchObject({ [TOOL_KEY]: "auto" });
        expect(continuations()).toHaveLength(1);
        expect(continuations()[0]!.body.args).toMatchObject({ approved: true, config: { subAgentRunId: runId }, threadId: childId });
        // The claim puts the run back to running, in its own transaction.
        expect(await runStatus()).toBe("running");

        // A retried answer resumes nothing more.
        expect(await answer(APPROVAL_ID, "approve")).toMatchObject({ alreadyResolved: true });
        expect(continuations()).toHaveLength(1);
    });

    it("leaves a question the owner was asked in the child's own chat as what it waits on when the owner answers the run", async () => {
        await run(async (context) => await context.db.patch("threads", childId, { awaitingInput: "question" }));
        await answer(APPROVAL_ID, "approve");

        const child = await run(async (context) => await context.db.get("threads", childId));

        expect(child).toMatchObject({ awaitingInput: "question", status: "running" });
    });

    it("resumes with a denial, writing no permission", async () => {
        await answer(APPROVAL_ID, "deny");

        expect(continuations()[0]!.body.args).toMatchObject({ approved: false, config: { subAgentRunId: runId } });
        expect(await runStatus()).toBe("running");
        expect(await run(async (context) => await context.db.query("aiUserPreferences").collect())).toHaveLength(0);
    });

    it("refuses a second answer to the same run while the first one's continuation runs, and keeps that request open", async () => {
        await answer(APPROVAL_ID, "approve");
        await expect(answer(SIBLING_ID, "always")).rejects.toThrow(STILL_WORKING);

        expect(continuations()).toHaveLength(1);
        const open = await pendingRequests();

        expect(open.map((row) => row.approvalId)).toStrictEqual([SIBLING_ID]);

        // The refusal rolled back with its claim: "Always allow" wrote nothing.
        const prefs = await run(async (context) => await context.db.query("aiUserPreferences").collect());

        expect(prefs[0]?.toolPermissions?.[TOOL_KEY]).toBeUndefined();
    });

    it("refuses an allow for an hour or for today, which a sub-agent's headless run would ignore", async () => {
        await expect(answer(APPROVAL_ID, "hour")).rejects.toThrow(ONCE_OR_ALWAYS);
        await expect(answer(APPROVAL_ID, "today")).rejects.toThrow(ONCE_OR_ALWAYS);

        expect(continuations()).toHaveLength(0);
        expect(await runStatus()).toBe("awaiting");
    });

    it("ends a run only for the resume it is still running under", async () => {
        await answer(APPROVAL_ID, "approve");

        const { reapAt } = await runRow();
        const failed = { outcome: { error: "boom", kind: "failed" }, runId };

        // A write for an older resume, or one the run waits again since, ends nothing.
        expect(await internalCall(completeResumedRun, { ...failed, resumedWith: reapAt - 1 })).toBe(false);
        expect(await runStatus()).toBe("running");
        expect(await internalCall(completeResumedRun, { ...failed, resumedWith: reapAt })).toBe(true);
        expect(await runStatus()).toBe("failed");
    });

    it("does not wait again on a retried write for a pause its owner answered since", async () => {
        await answer(APPROVAL_ID, "approve");

        const { reapAt } = await runRow();

        // The sibling request is still open on the latest turn, so only the resume's own deadline tells the writes apart.
        expect(await run(async (context) => await markRunAwaiting(context, runId, reapAt - 1))).toBe(false);
        expect(await runStatus()).toBe("running");

        // The write for the resume that is current still waits on the open sibling.
        expect(await run(async (context) => await markRunAwaiting(context, runId, reapAt))).toBe(true);
        expect(await runStatus()).toBe("awaiting");
    });

    it("refuses anyone but the owner, and the owner while the child is locked", async () => {
        await expect(
            as(STRANGER).mutation(respondToToolApproval as never, { approvalId: APPROVAL_ID, decision: "approve", threadId: childId } as never),
        ).rejects.toThrow(NOT_FOUND);

        await run(async (context) => await context.db.patch("threads", childId as Id<"threads">, { lockedAt: Date.now() }));
        await expect(answer(APPROVAL_ID, "approve")).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });

        expect(continuations()).toHaveLength(0);
        expect(await runStatus()).toBe("awaiting");
    });
});

describe("answering a request the run does not wait on", () => {
    it("refuses an answer before the run waits and after it ended, keeping the request and writing no permission", async () => {
        await expect(answer(APPROVAL_ID, "approve")).rejects.toThrow(STILL_WORKING);
        expect(await pendingRequests()).toHaveLength(2);

        await run(async (context) => await context.db.patch("subAgentRuns", runId, { status: "cancelled" }));
        await expect(answer(APPROVAL_ID, "always")).rejects.toThrow(ALREADY_ENDED);

        expect(continuations()).toHaveLength(0);
        expect(await run(async (context) => await context.db.query("aiUserPreferences").collect())).toHaveLength(0);
    });
});

describe("a request whose sub-agent run ended", () => {
    it("is refused as ended, not answered as an earlier denial", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER));

        await expect(answer(APPROVAL_ID, "approve")).rejects.toThrow(ALREADY_ENDED);
    });
});

describe("the continuation's end", () => {
    it("ends the run with the newest assistant text the continuation saved, posted to the parent once", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await answer(APPROVAL_ID, "approve");

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
        const completion = { messageIds: [answerId, toolRowId], outcome: { kind: "succeeded" }, runId };

        // A retried settlement (the continuation's own retry, or its scheduled one) ends nothing twice.
        expect(await internalCall(completeResumedRun, completion)).toBe(true);
        expect(await internalCall(completeResumedRun, completion)).toBe(false);

        expect(await runRow()).toMatchObject({ result: "Removed /tmp/old.txt.", status: "succeeded" });

        const posts = await parentReplies();

        expect(posts).toHaveLength(1);
        expect(JSON.stringify(posts[0].message)).toContain("Removed /tmp/old.txt.");
    });
});

describe("a child that waited on a request", () => {
    it("is not failed as interrupted by its beat watch while its continuation answers, which does not beat", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await answer(APPROVAL_ID, "approve");

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

    it("posts a nested result held back while its parent's run went, when that run ends without ever having waited", async () => {
        const nestedId = await run(
            async (context) =>
                await context.db.insert("subAgentRuns", {
                    completedAt: Date.now(),
                    createdAt: Date.now(),
                    depth: 2,
                    parentThreadId: childId,
                    result: "The grandchild's answer.",
                    status: "succeeded",
                    task: "Look it up",
                    toolCallId: "call-nested",
                    updatedAt: Date.now(),
                    userId: OWNER,
                }),
        );

        // The child's run goes (running, no wait yet): the result is held.
        expect(await run(async (context) => await postRunResult(context, nestedId, 0))).toBe(false);

        await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER));

        expect(harness.scheduler.list()).toContainEqual(expect.objectContaining({ args: { attempt: 0, runId: nestedId } }));
    });

    it("holds a nested run's result back while it waits, so its request stays answerable, and posts it once the run ends", async () => {
        const nestedId = await run(
            async (context) =>
                await context.db.insert("subAgentRuns", {
                    completedAt: Date.now(),
                    createdAt: Date.now(),
                    depth: 2,
                    parentThreadId: childId,
                    result: "The grandchild's answer.",
                    status: "succeeded",
                    task: "Look it up",
                    toolCallId: "call-nested",
                    updatedAt: Date.now(),
                    userId: OWNER,
                }),
        );
        const childRows = async () =>
            await run(
                async (context) =>
                    await context.db
                        .query("messages")
                        .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", childId))
                        .collect(),
            );
        const rowsBefore = await childRows();

        await run(async (context) => await markRunAwaiting(context, runId));

        expect(await run(async (context) => await postRunResult(context, nestedId, 0))).toBe(false);
        // Nothing landed after the request: it is still the child's latest turn, so it can still be answered.
        expect(await childRows()).toHaveLength(rowsBefore.length);

        await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER));

        // The run's end posts it at once, not at the held post's next check.
        expect(harness.scheduler.list()).toContainEqual(expect.objectContaining({ args: { attempt: 0, runId: nestedId } }));
        expect(await run(async (context) => await postRunResult(context, nestedId, 0))).toBe(true);
        const rowsAfter = await childRows();

        expect(JSON.stringify(rowsAfter.at(-1)?.message)).toContain("The grandchild's answer.");
    });
});

describe("a waiting child's requests in its parent conversation", () => {
    it("lists nothing while the child runs, then each request with its tool, server and input once it waits", async () => {
        expect(await listed()).toStrictEqual([]);

        await run(async (context) => await markRunAwaiting(context, runId));

        const requests = await listed();

        expect(requests.map((request) => request.approvalId).toSorted((left: string, right: string) => left.localeCompare(right))).toStrictEqual([
            APPROVAL_ID,
            SIBLING_ID,
        ]);
        expect(requests.find((request) => request.approvalId === APPROVAL_ID)).toStrictEqual({
            approvalId: APPROVAL_ID,
            childThreadId: childId,
            input: JSON.stringify({ path: "/tmp/old.txt" }, null, 2),
            omittedCharacters: 0,
            runId,
            server: "Files",
            skillSlug: null,
            toolName: "delete",
        });
    });

    it("answers the parent's owner alone: a stranger's read is NOT_FOUND, a locked parent needs its unlock, a locked child is left out", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));

        await expect(listed(STRANGER)).rejects.toThrow(NOT_FOUND);

        await run(async (context) => await context.db.patch("threads", childId as Id<"threads">, { lockedAt: Date.now() }));
        expect(await listed()).toStrictEqual([]);

        await run(async (context) => await context.db.patch("threads", parentId as Id<"threads">, { lockedAt: Date.now() }));
        await expect(listed()).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });
    });

    it("leaves out another run's request, one the child's latest turn has moved past, one on another thread and one answered", async () => {
        await run(async (context) => {
            const [row] = await context.db
                .query("toolApprovalRuns")
                .withIndex("by_approvalId", (q: any) => q.eq("approvalId", SIBLING_ID))
                .collect();

            await context.db.patch("toolApprovalRuns", row._id, { config: { ...CONFIG(), subAgentRunId: undefined } });
            await context.db.insert("toolApprovalRuns", {
                approvalId: "approval-old",
                config: CONFIG(),
                createdAt: Date.now(),
                status: "pending",
                threadId: childId,
                userId: OWNER,
            });
        });
        await run(async (context) => await markRunAwaiting(context, runId));

        const requests = await listed();

        expect(requests.map((request) => request.approvalId)).toStrictEqual([APPROVAL_ID]);

        // Nor a request whose row is on another thread, or already answered.
        const patchRequest = async (fields: Record<string, unknown>) =>
            await run(async (context) => {
                const [row] = await context.db
                    .query("toolApprovalRuns")
                    .withIndex("by_approvalId", (q: any) => q.eq("approvalId", APPROVAL_ID))
                    .collect();

                await context.db.patch("toolApprovalRuns", row._id, fields);
            });

        await patchRequest({ threadId: parentId });
        expect(await listed()).toStrictEqual([]);

        await patchRequest({ status: "denied", threadId: childId });
        expect(await listed()).toStrictEqual([]);
    });

    it("is bounded: ten requests at most across its waiting sub-agents, a long input cut whole characters short with the count of what it left out, and no input shown as none", async () => {
        const ids = Array.from({ length: 12 }, (_, index) => `approval-many-${String(index)}`);
        // A cut at 4,000 units would split the first emoji's surrogate pair.
        const long = `${"x".repeat(3999)}${"😀".repeat(1000)}`;

        await run(async (context) => {
            await context.db.insert("messages", {
                message: {
                    content: ids.flatMap((approvalId, index) => [
                        {
                            input: index < 2 ? [long, undefined][index] : { index },
                            toolCallId: `call-many-${String(index)}`,
                            toolName: TOOL,
                            type: "tool-call",
                        },
                        { approvalId, toolCallId: `call-many-${String(index)}`, type: "tool-approval-request" },
                    ]),
                    role: "assistant",
                },
                order: 2,
                status: "success",
                stepOrder: 0,
                threadId: childId,
                tool: true,
                userId: OWNER,
            });

            for (const approvalId of ids) {
                await context.db.insert("toolApprovalRuns", {
                    approvalId,
                    // Another run's request among the first ten: it takes no slot.
                    config: approvalId === "approval-many-2" ? { ...CONFIG(), subAgentRunId: undefined } : CONFIG(),
                    createdAt: Date.now(),
                    status: "pending",
                    threadId: childId,
                    userId: OWNER,
                });
            }
        });
        await run(async (context) => await markRunAwaiting(context, runId));
        // A second waiting sub-agent in the same conversation: the cap holds across runs, not per run.
        await run(async (context) => {
            const now = Date.now();
            const otherChild = await context.db.insert("threads", { status: "active", title: "Sub-agent: other", userId: OWNER });
            const otherRun = await context.db.insert("subAgentRuns", {
                childThreadId: otherChild,
                createdAt: now,
                depth: 1,
                parentThreadId: parentId,
                startedAt: now,
                status: "awaiting",
                task: "Something else",
                toolCallId: "call-parent-2",
                updatedAt: now,
                userId: OWNER,
            });

            await context.db.insert("messages", {
                message: {
                    content: [
                        { input: {}, toolCallId: "call-other", toolName: TOOL, type: "tool-call" },
                        { approvalId: "approval-other", toolCallId: "call-other", type: "tool-approval-request" },
                    ],
                    role: "assistant",
                },
                order: 0,
                status: "success",
                stepOrder: 0,
                threadId: otherChild,
                tool: true,
                userId: OWNER,
            });
            await context.db.insert("toolApprovalRuns", {
                approvalId: "approval-other",
                config: { ...CONFIG(), subAgentRunId: otherRun },
                createdAt: now,
                status: "pending",
                threadId: otherChild,
                userId: OWNER,
            });
        });

        const requests = await listed();
        const byId = new Map(requests.map((request) => [request.approvalId, request]));

        expect(requests).toHaveLength(10);
        expect([...byId.keys()]).not.toContain("approval-many-2");
        expect([...byId.keys()]).toContain("approval-many-10");
        // 1,000 emoji left out: characters, not UTF-16 units.
        expect(byId.get("approval-many-0")).toMatchObject({ input: "x".repeat(3999), omittedCharacters: 1000 });
        expect(byId.get("approval-many-1")).toMatchObject({ input: "", omittedCharacters: 0 });
    });

    it("reads each child's latest turn on its own, past newer messages in the parent conversation", async () => {
        await run(async (context) => {
            await context.db.insert("messages", {
                message: { content: "Tidy up, please.", role: "user" },
                order: 4,
                status: "success",
                stepOrder: 0,
                threadId: parentId,
                tool: false,
                userId: OWNER,
            });
            await context.db.insert("messages", {
                message: {
                    content: [{ input: { task: "Tidy up the files" }, toolCallId: "call-parent", toolName: "delegateToSubAgent", type: "tool-call" }],
                    role: "assistant",
                },
                order: 5,
                status: "success",
                stepOrder: 0,
                threadId: parentId,
                tool: true,
                userId: OWNER,
            });
        });
        await run(async (context) => await markRunAwaiting(context, runId));

        const requests = await listed();

        expect(requests.map((request) => request.approvalId).toSorted((left: string, right: string) => left.localeCompare(right))).toStrictEqual([
            APPROVAL_ID,
            SIBLING_ID,
        ]);
    });

    it("is answered from the parent through the child's own claim, which resumes the run once and takes the request off the list", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));

        const requests = await listed();
        const request = requests.find((row) => row.approvalId === APPROVAL_ID);

        await expect(
            as(OWNER).mutation(respondToToolApproval as never, { approvalId: request.approvalId, decision: "today", threadId: request.childThreadId } as never),
        ).rejects.toThrow(ONCE_OR_ALWAYS);
        expect(await runStatus()).toBe("awaiting");

        expect(
            await as(OWNER).mutation(
                respondToToolApproval as never,
                { approvalId: request.approvalId, decision: "deny", threadId: request.childThreadId } as never,
            ),
        ).toMatchObject({ alreadyResolved: false });
        expect(continuations()).toHaveLength(1);
        expect(continuations()[0]!.body.args).toMatchObject({ approved: false, threadId: childId });
        expect(await runStatus()).toBe("running");
        expect(await listed()).toStrictEqual([]);
    });
});
