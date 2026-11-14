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
import { stopActiveForThread } from "../chat/streaming/persistent/library";
import { _deletePageForThreadId } from "../agent/threads";
import { clearAwaitingInput } from "../agent/table-writes";
import { PENDING_APPROVAL_TTL_MS } from "../chat/lib/tool-approval-cleanup";
import { THREAD_LOCKED_CODE } from "../lib/thread-lock";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
    cancelSubAgentRunsForStop,
    completeResumedRun,
    markDeletedThreadResults,
    cancelDeletedThreadQueue,
    claimQueuedRun,
    afterOwnerMessage,
    finishRun,
    listSubAgentApprovals,
    markRunAwaiting,
    postResult,
    postRunResult,
    releaseHeldResults,
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
const GONE = /gone/u;

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
const listing = async (userId = OWNER, threadId = parentId): Promise<{ cut: string[]; requests: any[] }> =>
    (await as(userId).query(listSubAgentApprovals as never, { parentThreadId: threadId } as never)) as never;
const listed = async (userId?: string, threadId?: string): Promise<any[]> => {
    const { requests } = await listing(userId, threadId);

    return requests;
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
                    // The labels a pause stamps on the call: a tool name may hold a colon, and a connector has no `mcp:` key.
                    {
                        input: { path: "/tmp/old.txt" },
                        providerOptions: { neore: { mcpServerName: "Files", mcpToolName: "files:delete" } },
                        toolCallId: "call-1",
                        toolName: TOOL,
                        type: "tool-call",
                    },
                    { approvalId: APPROVAL_ID, toolCallId: "call-1", type: "tool-approval-request" },
                    // A sibling: the same step asked for a second tool at once.
                    {
                        input: { path: "/tmp/other.txt" },
                        providerOptions: { neore: { mcpServerName: "GitHub", mcpToolName: "create_issue" } },
                        toolCallId: "call-2",
                        toolName: TOOL,
                        type: "tool-call",
                    },
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

        expect(harness.scheduler.list()).toContainEqual(expect.objectContaining({ args: expect.objectContaining({ attempt: 0, runId: nestedId }) }));
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
        expect(harness.scheduler.list()).toContainEqual(expect.objectContaining({ args: expect.objectContaining({ attempt: 0, runId: nestedId }) }));
        expect(await run(async (context) => await postRunResult(context, nestedId, 0))).toBe(true);
        const rowsAfter = await childRows();

        expect(JSON.stringify(rowsAfter.at(-1)?.message)).toContain("The grandchild's answer.");
    });
});

describe("a waiting child's requests in its parent conversation", () => {
    it("lists nothing while the child runs, then each request with the tool and server stamped on its call, and its input", async () => {
        expect(await listing()).toStrictEqual({ cut: [], requests: [] });

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
            toolName: "files:delete",
        });
        expect(requests.find((request) => request.approvalId === SIBLING_ID)).toMatchObject({ server: "GitHub", toolName: "create_issue" });
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
                    // Another run's requests, among the first ten (it takes no slot) and last (dropping it cuts nothing).
                    config: ["approval-many-2", "approval-many-11"].includes(approvalId) ? { ...CONFIG(), subAgentRunId: undefined } : CONFIG(),
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

        const { cut, requests } = await listing();
        const byId = new Map(requests.map((request) => [request.approvalId, request]));

        expect(requests).toHaveLength(10);
        // Only the second run's card says more is waiting: the first run's last request was not its own.
        expect(cut).toHaveLength(1);
        expect(cut).not.toContain(runId);
        expect([...byId.keys()]).not.toContain("approval-many-2");
        expect([...byId.keys()]).toContain("approval-many-10");
        // 1,000 emoji left out: characters, not UTF-16 units.
        expect(byId.get("approval-many-0")).toMatchObject({ input: "x".repeat(3999), omittedCharacters: 1000 });
        // An unlabelled call shows its runtime name and no server.
        expect(byId.get("approval-many-1")).toMatchObject({ input: "", omittedCharacters: 0, server: null, toolName: TOOL });
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

describe("a resumed run ended from outside", () => {
    const childStreams = async (): Promise<any[]> =>
        await run(
            async (context) =>
                await context.db
                    .query("persistentStreams")
                    .withIndex("by_threadId", (q: any) => q.eq("threadId", childId))
                    .collect(),
        );
    /**
     * The owner's own approval continuation in the child thread meanwhile, live beside the run's: its request is
     * interactive (no `subAgentRunId`), and it is read first (`pending` before the run's `streaming`).
     */
    const ownerReply = async (): Promise<void> => {
        const [continuation] = await childStreams();
        const { _creationTime, _id, ...fields } = continuation;

        await run(async (context) => {
            await context.db.patch("persistentStreams", _id, { status: "streaming" });
            await context.db.insert("toolApprovalRuns", {
                approvalId: "approval-owner",
                config: { ...CONFIG(), subAgentRunId: undefined },
                createdAt: Date.now(),
                status: "approved",
                threadId: childId,
                userId: OWNER,
            });
            await context.db.insert("persistentStreams", { ...fields, messageId: "approval-owner", status: "pending" });
        });
    };
    const statuses = async () => {
        const streams = await childStreams();

        return Object.fromEntries(streams.map((stream) => [stream.messageId, stream.status]));
    };
    // The harness names no function path for these jobs: a stop of one named stream is the only job with `onlyNamed`.
    const stopJobs = () => harness.scheduler.list().filter((job) => (job.args as { onlyNamed?: boolean } | undefined)?.onlyNamed === true);

    beforeEach(async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await answer(APPROVAL_ID, "approve");
        await ownerReply();
    });

    it("stops its live continuation at once when a Stop ends it, and only that stream and its goal", async () => {
        expect(await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER))).toBe(1);

        const [job] = stopJobs();

        expect(stopJobs()).toHaveLength(1);
        expect(job!.args).toStrictEqual({ messageId: APPROVAL_ID, onlyNamed: true, threadId: childId });

        // A goal the owner set in the child thread is theirs, not the continuation's: the stop leaves it running.
        const goalId = await run(
            async (context) =>
                await context.db.insert("threadGoals", {
                    config: { model: "test-model" },
                    costMicrodollars: 0,
                    createdAt: 1,
                    maxCostMicrodollars: 2_000_000,
                    maxRounds: 5,
                    promptMessageId: "message-owner-goal",
                    round: 0,
                    startMessageId: "message-owner-goal",
                    status: "active",
                    text: "Keep the files tidy",
                    threadId: childId,
                    updatedAt: 1,
                    userId: OWNER,
                    verdicts: [],
                }),
        );

        await internalCall(stopActiveForThread, job!.args as Record<string, unknown>);

        expect(await statuses()).toStrictEqual({ "approval-owner": "pending", [APPROVAL_ID]: "done" });
        expect(await run(async (context) => await context.db.get("threadGoals", goalId))).toMatchObject({ status: "active" });
    });

    it("finds its continuation exactly, behind more than ten earlier live replies in the child thread", async () => {
        await run(async (context) => {
            const [continuation] = await context.db
                .query("persistentStreams")
                .withIndex("by_threadId_messageId", (q: any) => q.eq("threadId", childId).eq("messageId", APPROVAL_ID))
                .collect();
            const { _creationTime, _id, ...fields } = continuation;

            // Eleven replies live before it, then the continuation itself, last in storage order.
            for (let index = 0; index < 11; index += 1) {
                await context.db.insert("persistentStreams", { ...fields, messageId: `message-live-${String(index)}` });
            }

            await context.db.delete("persistentStreams", _id);
            await context.db.insert("persistentStreams", fields);
        });

        expect(await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER))).toBe(1);
        expect(stopJobs().map((job) => job.args)).toStrictEqual([{ messageId: APPROVAL_ID, onlyNamed: true, threadId: childId }]);
    });

    it("schedules no stop for a continuation whose stream has already ended", async () => {
        await run(async (context) => {
            const [continuation] = await context.db
                .query("persistentStreams")
                .withIndex("by_threadId_messageId", (q: any) => q.eq("threadId", childId).eq("messageId", APPROVAL_ID))
                .collect();

            await context.db.patch("persistentStreams", continuation._id, { status: "done" });
        });

        expect(await run(async (context) => await cancelSubAgentRunsForStop(context, parentId, OWNER))).toBe(1);
        expect(stopJobs()).toStrictEqual([]);
    });

    it("stops its live continuation when the reaper fails it past its deadline", async () => {
        const { reapAt } = await runRow();

        await run(async (context) => await reapSubAgentRun(context, runId, reapAt));
        expect(await runStatus()).toBe("failed");
        expect(stopJobs().map((job) => job.args)).toStrictEqual([{ messageId: APPROVAL_ID, onlyNamed: true, threadId: childId }]);
    });

    it("stops nothing once the continuation is no longer live, not the owner's reply beside it", async () => {
        expect(await internalCall(stopActiveForThread, { messageId: "approval-gone", onlyNamed: true, threadId: childId })).toBe(false);
        expect(await statuses()).toStrictEqual({ "approval-owner": "pending", [APPROVAL_ID]: "streaming" });
    });
});

describe("a result for a parent that waits on its own request", () => {
    const PARENT_REQUEST = "approval-parent";
    const heldPosts = () => harness.scheduler.list().filter((job) => (job.args as { runId?: string } | undefined)?.runId === runId);
    /** The checks that act: those whose token is the run's current one, without it. A superseded check does nothing. */
    const currentChecks = async (): Promise<unknown[]> => {
        const row = await runRow();

        return heldPosts()
            .filter((job) => (job.args as { check?: string }).check === row.postCheckId)
            .map((job) => {
                const args = { ...(job.args as Record<string, unknown>) };

                delete args.check;

                return args;
            });
    };

    beforeEach(async () => {
        // The parent's own reply paused on a request its owner can still answer.
        await run(async (context) => {
            await context.db.insert("messages", {
                message: {
                    content: [
                        { input: { path: "/tmp/parent.txt" }, toolCallId: "call-parent-tool", toolName: TOOL, type: "tool-call" },
                        { approvalId: PARENT_REQUEST, toolCallId: "call-parent-tool", type: "tool-approval-request" },
                    ],
                    role: "assistant",
                },
                order: 1,
                status: "success",
                stepOrder: 0,
                threadId: parentId,
                tool: true,
                userId: OWNER,
            });
            await context.db.insert("toolApprovalRuns", {
                approvalId: PARENT_REQUEST,
                config: { ...CONFIG(), subAgentRunId: undefined },
                createdAt: Date.now(),
                status: "pending",
                threadId: parentId,
                userId: OWNER,
            });
            await context.db.patch("threads", parentId as Id<"threads">, { awaitingInput: "approval" });
        });
        await run(async (context) => await finishRun(context, runId, { error: "boom", kind: "failed" }));
    });

    it("is held while the request is open, and posted once it can no longer be answered", async () => {
        expect(await parentReplies()).toHaveLength(0);
        expect(await currentChecks()).toStrictEqual([{ attempt: 0, failures: 0, runId, waits: 1 }]);

        await run(async (context) => {
            const [row] = await context.db
                .query("toolApprovalRuns")
                .withIndex("by_approvalId", (q: any) => q.eq("approvalId", PARENT_REQUEST))
                .collect();

            await context.db.patch("toolApprovalRuns", row._id, { createdAt: Date.now() - PENDING_APPROVAL_TTL_MS - 1 });
        });

        expect(await run(async (context) => await postRunResult(context, runId, 0))).toBe(true);
        expect(await parentReplies()).toHaveLength(1);
    });

    it("is posted once the request is closed, though no answer is on the turn yet", async () => {
        await run(async (context) => {
            const [row] = await context.db
                .query("toolApprovalRuns")
                .withIndex("by_approvalId", (q: any) => q.eq("approvalId", PARENT_REQUEST))
                .collect();

            await context.db.patch("toolApprovalRuns", row._id, { resolvedAt: Date.now(), status: "denied" });
        });

        expect(await run(async (context) => await postRunResult(context, runId, 0))).toBe(true);
    });

    it("is held though the thread does not show it waits yet: a run records its requests before it says so", async () => {
        await run(async (context) => await clearAwaitingInput(context.db, parentId as Id<"threads">));

        expect(await run(async (context) => await postRunResult(context, runId, 0))).toBe(false);
        expect(await parentReplies()).toHaveLength(0);
    });

    it("is released when the owner sends a new message past the request, though the thread does not show it waits yet", async () => {
        await run(async (context) => await clearAwaitingInput(context.db, parentId as Id<"threads">));
        await internalCall(afterOwnerMessage, { threadId: parentId });

        expect(await currentChecks()).toStrictEqual([{ attempt: 0, runId }]);
    });

    it("is released by a reply that closed a secret request, though no request is pending any more", async () => {
        // The reply's own send denied the secret request it moved past (`discardPausedThreadSecrets`) before this runs.
        await run(async (context) => {
            const [row] = await context.db
                .query("toolApprovalRuns")
                .withIndex("by_approvalId", (q: any) => q.eq("approvalId", PARENT_REQUEST))
                .collect();

            await context.db.patch("toolApprovalRuns", row._id, { resolvedAt: Date.now(), resolvedBy: "abandoned", secretRequest: true, status: "denied" });
        });

        await internalCall(afterOwnerMessage, { threadId: parentId });

        expect(await currentChecks()).toStrictEqual([{ attempt: 0, runId }]);
    });

    it("queues one job for any number of sends while the result is still held", async () => {
        const before = heldPosts().length;

        for (let send = 0; send < 3; send += 1) {
            await internalCall(afterOwnerMessage, { threadId: parentId });
        }

        // The first send moves the check forward; the next two would not, so they queue nothing.
        expect(heldPosts()).toHaveLength(before + 1);
        expect(await currentChecks()).toHaveLength(1);

        // The check it superseded does nothing when it runs: no post, and no backoff loop of its own.
        const row = await runRow();
        const stale = heldPosts().find((job) => (job.args as { check?: string }).check !== row.postCheckId);

        await internalCall(postResult, stale!.args as Record<string, unknown>);

        const after = await runRow();

        expect(heldPosts()).toHaveLength(before + 1);
        expect(after.postCheckId).toBe(row.postCheckId);
        expect(await parentReplies()).toHaveLength(0);
    });

    it("schedules a fresh check on a release once the current one is overdue, which may never have run", async () => {
        // A check now due (deferred, or dead-lettered once its retries ran out): it may never act, so it is not trusted.
        await run(async (context) => await context.db.patch("subAgentRuns", runId, { postCheckAt: Date.now() - 10 * 60_000 }));

        const row = await runRow();
        const before = heldPosts().length;

        await internalCall(afterOwnerMessage, { threadId: parentId });

        const after = await runRow();

        expect(heldPosts()).toHaveLength(before + 1);
        expect(after.postCheckId).not.toBe(row.postCheckId);
        expect(await currentChecks()).toStrictEqual([{ attempt: 0, runId }]);
    });

    it("keeps its queued check through a release that rolls back, and that same job still posts", async () => {
        const row = await runRow();
        const [held] = heldPosts();

        // A release that would move the check forward, in a mutation that then fails: nothing it did is kept.
        await expect(
            run(async (context) => {
                await releaseHeldResults(context, parentId);

                throw new Error("rolled back");
            }),
        ).rejects.toThrow("rolled back");

        const after = await runRow();

        // The job is still queued with its token, still the run's current one, and no replacement was committed.
        expect(heldPosts().map((job) => job.id)).toStrictEqual([held!.id]);
        expect(after.postCheckId).toBe(row.postCheckId);
        expect((held!.args as { check?: string }).check).toBe(row.postCheckId);

        // The request closes; that retained job, as the scheduler holds it, runs and posts.
        await run(async (context) => {
            const [request] = await context.db
                .query("toolApprovalRuns")
                .withIndex("by_approvalId", (q: any) => q.eq("approvalId", PARENT_REQUEST))
                .collect();

            await context.db.patch("toolApprovalRuns", request._id, { resolvedAt: Date.now(), status: "denied" });
        });

        const retained = harness.scheduler.list().find((job) => job.id === held!.id);

        await internalCall(postResult, retained!.args);
        expect(await parentReplies()).toHaveLength(1);
    });

    it("is released when the owner answers the request, to post after the reply the answer starts", async () => {
        await as(OWNER).mutation(respondToToolApproval as never, { approvalId: PARENT_REQUEST, decision: "approve", threadId: parentId } as never);

        expect(await currentChecks()).toStrictEqual([{ attempt: 0, runId }]);
    });
});

describe("deleting a thread", () => {
    const deleteThread = async (threadId: string): Promise<unknown> => await internalCall(_deletePageForThreadId, { threadId });
    const ran = new Set<string>();
    /** The next marking continuation not yet run, by its args (the harness names no function path). */
    const continuation = (): Record<string, unknown> | undefined => {
        const job = harness.scheduler
            .list()
            .find((entry) => (entry.args as { status?: number } | undefined)?.status !== undefined && !ran.has(String(entry.id)));

        if (job) {
            ran.add(String(job.id));
        }

        return job?.args as Record<string, unknown> | undefined;
    };

    /** A run the child delegated itself, still working. */
    const nestedRun = async (): Promise<Id<"subAgentRuns">> =>
        await run(async (context) => {
            const now = Date.now();
            const nestedChild = await context.db.insert("threads", { status: "active", title: "Sub-agent: nested", userId: OWNER });

            return await context.db.insert("subAgentRuns", {
                childThreadId: nestedChild,
                createdAt: now,
                depth: 2,
                parentThreadId: childId,
                startedAt: now,
                status: "running",
                task: "Nested work",
                toolCallId: "call-nested",
                updatedAt: now,
                userId: OWNER,
            });
        });
    const statusOf = async (id: Id<"subAgentRuns">): Promise<string> => {
        const row = await run(async (context) => await context.db.get("subAgentRuns", id));

        return row.status;
    };

    it.each([
        ["waiting", false],
        ["resumed", true],
    ] as const)("ends the %s run it is the child of, and the run that child delegated", async (_case, resumed) => {
        const nested = await nestedRun();

        await run(async (context) => await markRunAwaiting(context, runId));

        if (resumed) {
            await answer(APPROVAL_ID, "approve");
        }

        await deleteThread(childId);

        expect(await runStatus()).toBe("cancelled");
        expect(await statusOf(nested)).toBe("cancelled");
    });

    it("ends the waiting run it delegated, whose result has nowhere to go", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await deleteThread(parentId);

        expect(await runRow()).toMatchObject({ postFailed: expect.stringMatching(GONE), status: "cancelled" });
        expect(await parentReplies()).toHaveLength(0);
    });

    it("ends the worker messages the user typed, which a Stop leaves alone", async () => {
        const typed = await run(async (context) => {
            const now = Date.now();
            const worker = await context.db.insert("threads", { status: "active", title: "Worker", userId: OWNER });

            return await context.db.insert("subAgentRuns", {
                childThreadId: worker,
                clientId: "client-typed",
                createdAt: now,
                depth: 1,
                mode: "worker",
                parentThreadId: parentId,
                startedAt: now,
                status: "running",
                task: "Typed by the user",
                toolCallId: "call-typed",
                updatedAt: now,
                userId: OWNER,
            });
        });

        await deleteThread(parentId);

        const ended = await run(async (context) => await context.db.get("subAgentRuns", typed));

        expect(ended.status).toBe("cancelled");
    });

    it("takes no result posted after its first page, however many it has yet to mark", async () => {
        // More messages than one page, so the thread is still there after the delete's first page.
        await run(async (context) => {
            for (const order of [0, 1]) {
                await context.db.insert("messages", {
                    message: { content: `Message ${String(order)}`, role: "user" },
                    order,
                    status: "success",
                    stepOrder: 0,
                    threadId: parentId,
                    tool: false,
                    userId: OWNER,
                });
            }
        });
        await internalCall(_deletePageForThreadId, { limit: 1, threadId: parentId });
        expect(await run(async (context) => await context.db.get("threads", parentId as Id<"threads">))).not.toBeNull();

        // A run the paged marking has not reached yet: the thread is going, so its post is refused all the same.
        const late = await run(async (context) => {
            const now = Date.now();

            return await context.db.insert("subAgentRuns", {
                childThreadId: childId,
                createdAt: now,
                depth: 1,
                parentThreadId: parentId,
                result: "Late",
                status: "succeeded",
                task: "Late",
                toolCallId: "call-late",
                updatedAt: now,
                userId: OWNER,
            });
        });

        expect(await run(async (context) => await postRunResult(context, late, 0))).toBe(false);
        expect(await parentReplies()).toHaveLength(0);
    });

    it("schedules nothing for a thread with no runs", async () => {
        const lone = await run(async (context) => await context.db.insert("threads", { status: "active", title: "Lone", userId: OWNER }));
        const before = harness.scheduler.list().length;

        await deleteThread(lone);

        expect(
            harness.scheduler
                .list()
                .slice(before)
                .filter((job) => JSON.stringify(job.args).includes(lone)),
        ).toStrictEqual([]);
    });

    it("starts no queued message of a worker that is being deleted, past what its delete has cancelled", async () => {
        const queued = await run(async (context) => {
            const now = Date.now();
            const worker = await context.db.insert("threads", { deletingAt: now, status: "active", title: "Worker", userId: OWNER });

            return await context.db.insert("subAgentRuns", {
                childThreadId: worker,
                createdAt: now,
                depth: 1,
                mode: "worker",
                parentThreadId: parentId,
                runner: { deviceId: "device-1", kind: "host" },
                status: "queued",
                task: "Next message",
                toolCallId: "call-next",
                updatedAt: now,
                userId: OWNER,
            });
        });

        expect(await run(async (context) => await claimQueuedRun(context, queued))).toBeNull();

        const row = await run(async (context) => await context.db.get("subAgentRuns", queued));

        expect(row.status).toBe("cancelled");
    });

    it("does not walk a going worker's queue from one run's end, which its delete cancels in batches", async () => {
        const { going, running } = await run(async (context) => {
            const now = Date.now();
            const thread = await context.db.insert("threads", { deletingAt: now, status: "active", title: "Worker", userId: OWNER });
            const base = {
                childThreadId: thread,
                depth: 1,
                mode: "worker" as const,
                parentThreadId: parentId,
                runner: { deviceId: "device-1", kind: "host" as const },
                updatedAt: now,
                userId: OWNER,
            };
            const current = await context.db.insert("subAgentRuns", {
                ...base,
                createdAt: now - 1,
                startedAt: now,
                status: "running",
                task: "Current",
                toolCallId: "call-current",
            });

            for (let index = 0; index < 205; index += 1) {
                await context.db.insert("subAgentRuns", {
                    ...base,
                    createdAt: now + index,
                    status: "queued",
                    task: `Queued ${String(index)}`,
                    toolCallId: `call-host-${String(index)}`,
                });
            }

            return { going: thread, running: current };
        });

        await run(async (context) => await finishRun(context, running, { kind: "cancelled" }));

        const queued = await run(
            async (context) =>
                await context.db
                    .query("subAgentRuns")
                    .withIndex("by_childThreadId_and_status", (q: any) => q.eq("childThreadId", going).eq("status", "queued"))
                    .collect(),
        );

        expect(queued).toHaveLength(205);
    });

    it("does not walk the queue of a worker whose row is already gone", async () => {
        const { gone, running } = await run(async (context) => {
            const now = Date.now();
            const thread = await context.db.insert("threads", { status: "active", title: "Worker", userId: OWNER });
            const base = {
                childThreadId: thread,
                depth: 1,
                mode: "worker" as const,
                parentThreadId: parentId,
                runner: { deviceId: "device-1", kind: "host" as const },
                updatedAt: now,
                userId: OWNER,
            };
            const current = await context.db.insert("subAgentRuns", {
                ...base,
                createdAt: now - 1,
                startedAt: now,
                status: "running",
                task: "Current",
                toolCallId: "call-gone-current",
            });

            for (let index = 0; index < 205; index += 1) {
                await context.db.insert("subAgentRuns", {
                    ...base,
                    createdAt: now + index,
                    status: "queued",
                    task: `Queued ${String(index)}`,
                    toolCallId: `call-gone-${String(index)}`,
                });
            }

            // The delete's last page took the row.
            await context.db.delete("threads", thread);

            return { gone: thread, running: current };
        });

        await run(async (context) => await finishRun(context, running, { kind: "cancelled" }));

        const queued = await run(
            async (context) =>
                await context.db
                    .query("subAgentRuns")
                    .withIndex("by_childThreadId_and_status", (q: any) => q.eq("childThreadId", gone).eq("status", "queued"))
                    .collect(),
        );

        expect(queued).toHaveLength(205);
    });

    it("lets a result post again to a chat whose delete was abandoned an hour ago or more", async () => {
        await run(async (context) => await context.db.patch("threads", parentId as Id<"threads">, { deletingAt: Date.now() - 2 * 60 * 60_000 }));
        await run(async (context) => await finishRun(context, runId, { error: "boom", kind: "failed" }));

        expect(await parentReplies()).toHaveLength(1);
    });

    it("ends every run it delegated, past the first page of 20", async () => {
        await run(async (context) => {
            const now = Date.now();

            for (let index = 0; index < 25; index += 1) {
                await context.db.insert("subAgentRuns", {
                    createdAt: now + index,
                    depth: 1,
                    parentThreadId: parentId,
                    status: "queued",
                    task: `Delegated ${String(index)}`,
                    toolCallId: `call-delegated-${String(index)}`,
                    updatedAt: now,
                    userId: OWNER,
                });
            }
        });

        await deleteThread(parentId);

        const left = await run(
            async (context) =>
                await context.db
                    .query("subAgentRuns")
                    .withIndex("by_parentThreadId_and_status", (q: any) => q.eq("parentThreadId", parentId).eq("status", "queued"))
                    .collect(),
        );

        expect(left).toStrictEqual([]);
    });

    /** A worker (live) with host runs queued for a lead that is being deleted. */
    const workerForGoingLead = async (queued: number) =>
        await run(async (context) => {
            const now = Date.now();
            const lead = await context.db.insert("threads", { deletingAt: now, status: "active", title: "Lead", userId: OWNER });
            const worker = await context.db.insert("threads", { status: "active", title: "Worker", userId: OWNER });
            const base = {
                childThreadId: worker,
                depth: 1,
                mode: "worker" as const,
                parentThreadId: lead,
                runner: { deviceId: "device-1", kind: "host" as const },
                updatedAt: now,
                userId: OWNER,
            };
            const current = await context.db.insert("subAgentRuns", {
                ...base,
                createdAt: now - 1,
                startedAt: now,
                status: "running",
                task: "Current",
                toolCallId: "call-lead-current",
            });
            const ids = [];

            for (let index = 0; index < queued; index += 1) {
                ids.push(
                    await context.db.insert("subAgentRuns", {
                        ...base,
                        createdAt: now + index,
                        status: "queued",
                        task: `Queued ${String(index)}`,
                        toolCallId: `call-lead-${String(index)}`,
                    }),
                );
            }

            return { current, ids, worker };
        });

    it("refuses at claim a queued run whose lead is being deleted", async () => {
        const { ids } = await workerForGoingLead(1);

        expect(await run(async (context) => await claimQueuedRun(context, ids[0]!))).toBeNull();

        const row = await run(async (context) => await context.db.get("subAgentRuns", ids[0]!));

        expect(row.status).toBe("cancelled");
    });

    it("does not walk a worker's line of runs whose lead is being deleted from one run's end", async () => {
        const { current, worker } = await workerForGoingLead(205);

        await run(async (context) => await finishRun(context, current, { kind: "cancelled" }));

        const queued = await run(
            async (context) =>
                await context.db
                    .query("subAgentRuns")
                    .withIndex("by_childThreadId_and_status", (q: any) => q.eq("childThreadId", worker).eq("status", "queued"))
                    .collect(),
        );

        expect(queued).toHaveLength(205);
    });

    it("cancels a deleted worker's queue past one call's 200, in a continuation", async () => {
        const worker = await run(async (context) => {
            const now = Date.now();
            const thread = await context.db.insert("threads", { status: "active", title: "Worker", userId: OWNER });

            for (let index = 0; index < 205; index += 1) {
                await context.db.insert("subAgentRuns", {
                    childThreadId: thread,
                    createdAt: now + index,
                    depth: 1,
                    mode: "worker",
                    parentThreadId: parentId,
                    status: "queued",
                    task: `Message ${String(index)}`,
                    toolCallId: `call-many-queued-${String(index)}`,
                    updatedAt: now,
                    userId: OWNER,
                });
            }

            return thread;
        });
        const queuedLeft = async (): Promise<number> => {
            const rows = await run(
                async (context) =>
                    await context.db
                        .query("subAgentRuns")
                        .withIndex("by_childThreadId_and_status", (q: any) => q.eq("childThreadId", worker).eq("status", "queued"))
                        .collect(),
            );

            return rows.length;
        };

        await deleteThread(worker);
        expect(await queuedLeft()).toBe(5);

        const jobs = harness.scheduler.list().filter((job) => JSON.stringify(job.args) === JSON.stringify({ threadId: worker }));

        expect(jobs).toHaveLength(1);
        await internalCall(cancelDeletedThreadQueue, { threadId: worker });
        expect(await queuedLeft()).toBe(0);
    });

    it("cancels every queued message of a deleted worker, past the first page", async () => {
        const worker = await run(async (context) => {
            const now = Date.now();
            const thread = await context.db.insert("threads", { status: "active", title: "Worker", userId: OWNER });

            for (let index = 0; index < 25; index += 1) {
                await context.db.insert("subAgentRuns", {
                    childThreadId: thread,
                    createdAt: now + index,
                    depth: 1,
                    mode: "worker",
                    parentThreadId: parentId,
                    status: "queued",
                    task: `Message ${String(index)}`,
                    toolCallId: `call-queued-${String(index)}`,
                    updatedAt: now,
                    userId: OWNER,
                });
            }

            return thread;
        });

        await deleteThread(worker);

        const left = await run(
            async (context) =>
                await context.db
                    .query("subAgentRuns")
                    .withIndex("by_childThreadId_and_status", (q: any) => q.eq("childThreadId", worker).eq("status", "queued"))
                    .collect(),
        );

        expect(left).toStrictEqual([]);
    });

    it("marks every unposted result bound for it gone, past the first page of runs that posted", async () => {
        const unposted = await run(async (context) => {
            const now = Date.now();
            const ended = {
                childThreadId: childId,
                createdAt: now,
                depth: 1,
                parentThreadId: parentId,
                status: "succeeded",
                task: "Old",
                updatedAt: now,
                userId: OWNER,
            };

            for (let index = 0; index < 205; index += 1) {
                await context.db.insert("subAgentRuns", { ...ended, resultPostedAt: now, toolCallId: `call-old-${String(index)}` });
            }

            return await context.db.insert("subAgentRuns", { ...ended, task: "New", toolCallId: "call-new" });
        });

        await deleteThread(parentId);

        // Past one call's budget, the marking goes on in continuations, each from where the last stopped.
        let continued = 0;

        for (let job = continuation(); job !== undefined; job = continuation()) {
            continued += 1;
            await internalCall(markDeletedThreadResults, job);
        }

        expect(continued).toBeGreaterThan(0);

        expect(await run(async (context) => await context.db.get("subAgentRuns", unposted))).toMatchObject({ postFailed: expect.stringMatching(GONE) });
    });

    it("stops a resumed run's live continuation on the deleted child", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await answer(APPROVAL_ID, "approve");
        await deleteThread(childId);

        expect(await runStatus()).toBe("cancelled");
        expect(harness.scheduler.list().map((job) => job.args)).toContainEqual({ messageId: APPROVAL_ID, onlyNamed: true, threadId: childId });
    });
});

describe("a new message in a waiting child", () => {
    const after = async (threadId: string): Promise<unknown> => await internalCall(afterOwnerMessage, { threadId });
    /** A row on the child's thread at `order`: the owner's new message, or an assistant turn with a request of the run. */
    const childRow = async (order: number, approvalId?: string): Promise<void> =>
        await run(async (context) => {
            await context.db.insert("messages", {
                message:
                    approvalId === undefined
                        ? { content: "Do it differently.", role: "user" }
                        : {
                              content: [
                                  { input: {}, toolCallId: `call-${approvalId}`, toolName: TOOL, type: "tool-call" },
                                  { approvalId, toolCallId: `call-${approvalId}`, type: "tool-approval-request" },
                              ],
                              role: "assistant",
                          },
                order,
                status: "success",
                stepOrder: 0,
                threadId: childId,
                tool: approvalId !== undefined,
                userId: OWNER,
            });

            if (approvalId !== undefined) {
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

    it("ends the run's wait, which frees its slot and closes its requests", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await childRow(2);

        expect(await after(childId)).toBe(1);
        expect(await runStatus()).toBe("cancelled");
        expect(await pendingRequests()).toHaveLength(0);
    });

    it("ends nothing for a child whose run does not wait, whatever requests are open there", async () => {
        // The run is still running, its requests recorded: a pending sub-agent request alone is no wait to end.
        expect(await after(childId)).toBe(0);
        expect(await runStatus()).toBe("running");
    });

    it("leaves a wait the continuation started again on a request still open", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await childRow(2);
        // The owner answered meanwhile, and the continuation paused on a new request: the run waits on that one.
        await childRow(3, "approval-3");

        expect(await after(childId)).toBe(0);
        expect(await runStatus()).toBe("awaiting");
    });

    it("leaves a resumed run going: it is past its request", async () => {
        await run(async (context) => await markRunAwaiting(context, runId));
        await answer(APPROVAL_ID, "approve");

        expect(await after(childId)).toBe(0);
        expect(await runStatus()).toBe("running");
    });
});
