/**
 * A tool-approval continuation is claimed before its lock check. A chat locked
 * AFTER its stream was created must be refused, and the refusal must finish the
 * claimed stream and take the thread out of `running`; otherwise the stream is
 * stuck pending and redelivery cannot resume it. A stream created AFTER the lock
 * was admitted under the proof and must still resume.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { internal } from "../_generated/internal";
import { continueAfterToolApproval, settleSubAgentRun } from "./execute";
import { noteGoalPaused } from "./goals/execute";
import { failRun, resumeApprovedRun } from "./lib/agent-run";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

// The resume itself is the model run; the test is about the lock gate and the stream's end state.
// The real one, unless a test makes the step after a continuation's settlement fail.
vi.mock("./goals/execute", async (importOriginal) => {
    const original = await importOriginal<typeof import("./goals/execute")>();

    return { ...original, noteGoalPaused: vi.fn(original.noteGoalPaused) };
});

vi.mock("./lib/agent-run", async (importOriginal) => {
    const original = await importOriginal<typeof import("./lib/agent-run")>();

    return {
        ...original,
        failRun: vi.fn(original.failRun),
        resumeApprovedRun: vi.fn(async () => {
            return { lastMessageId: undefined, paused: false, stopped: false };
        }),
    };
});

const OWNER = "owner-1";
/** Long before any stream these tests create: the chat was locked before the stream started. */
const LOCKED_BEFORE_STREAM = 1_700_000_000_000;

const config = {
    autoMediaEnrichment: false,
    mcpServerNames: [],
    model: "test-model",
    researchDepth: "balanced" as const,
    searchMode: "",
    shouldAutoContinue: false,
    toolNames: [],
};

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "chat_goals_internal", await import("./goals/internal"));
    registerModule(registry, "chat_streaming", await import("./streaming"));
    registerModule(registry, "chat_streaming_persistent_library", await import("./streaming/persistent/library"));
    registerModule(registry, "sub_agents_functions", await import("../sub-agents/functions"));
});

beforeEach(() => {
    vi.mocked(resumeApprovedRun).mockClear();
});

/** A running chat with its paused stream. `lockedAt` is set (or not) by the caller. */
const seedPausedRun = async (harness: ReturnType<typeof lunoraTest>, lockedAt: number | undefined) =>
    await harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { status: "running", title: "Chat", userId: OWNER });
        const messageId = await ctx.db.insert("messages", {
            message: { content: "Run the tool", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "Run the tool",
            threadId,
            tool: false,
            userId: OWNER,
        });
        const streamId = await ctx.db.insert("persistentStreams", {
            expiresAt: Date.now() + 60_000,
            messageId,
            status: "pending",
            streamingConfig: { contentType: "text", model: "test-model" },
            threadId,
            userId: OWNER,
        });

        if (lockedAt !== undefined) {
            await ctx.db.patch("threads", threadId, { lockedAt });
        }

        return { streamId: String(streamId), threadId: String(threadId) };
    });

const resume = async (harness: ReturnType<typeof lunoraTest>, ids: { streamId: string; threadId: string }) =>
    await harness.action(
        async (ctx: any) =>
            await ctx.runAction(continueAfterToolApproval, {
                approvalId: "approval-1",
                approved: true,
                config,
                streamId: ids.streamId,
                threadId: ids.threadId,
                userId: OWNER,
            }),
    );

const readRows = async (harness: ReturnType<typeof lunoraTest>, ids: { streamId: string; threadId: string }) =>
    await harness.run(async (ctx: any) => {
        const thread = await ctx.db.get("threads", ids.threadId as never);
        const stream = await ctx.db.get("persistentStreams", ids.streamId as never);

        return { status: thread?.status, streamStatus: stream?.status };
    });

describe("continueAfterToolApproval and the chat lock", () => {
    it("refuses a chat locked after its stream started, and finishes the stream and the thread", async () => {
        const harness = lunoraTest(schema as never);

        try {
            // Locked one minute in the future: at or after the stream's creation, so the stream is refused.
            const ids = await seedPausedRun(harness, Date.now() + 60_000);

            await resume(harness, ids);

            expect(resumeApprovedRun).not.toHaveBeenCalled();

            const rows = await readRows(harness, ids);

            expect(["done", "error", "timeout"]).toContain(rows.streamStatus);
            expect(rows.status).toBe("active");
        } finally {
            harness.close();
        }
    });

    it("resumes a chat whose lock predates the stream, the admitted case", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await seedPausedRun(harness, LOCKED_BEFORE_STREAM);

            await resume(harness, ids);

            expect(resumeApprovedRun).toHaveBeenCalledOnce();

            // Nothing finalised the stream on this path: the run itself owns its end.
            const rows = await readRows(harness, ids);

            expect(rows.streamStatus).toBe("pending");
        } finally {
            harness.close();
        }
    });
});

describe("continueAfterToolApproval and the pause it answered", () => {
    const awaitingOf = async (harness: ReturnType<typeof lunoraTest>, ids: { threadId: string }) =>
        await harness.run(async (ctx: any) => {
            const thread = await ctx.db.get("threads", ids.threadId as never);

            return { awaitingInput: thread?.awaitingInput, status: thread?.status };
        });

    it("removes the pause when the user stops the resumed run", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await seedPausedRun(harness, undefined);

            await harness.run(async (ctx: any) => await ctx.db.patch("threads", ids.threadId as never, { awaitingInput: "approval" }));
            // A stop ends the stream before the run returns.
            vi.mocked(resumeApprovedRun).mockImplementationOnce(async () => {
                await harness.run(async (ctx: any) => await ctx.db.patch("persistentStreams", ids.streamId as never, { status: "done" }));

                return { lastMessageId: undefined, paused: false, stopped: true };
            });

            await resume(harness, ids);

            expect(await awaitingOf(harness, ids)).toEqual({ awaitingInput: undefined, status: "active" });
        } finally {
            harness.close();
        }
    });

    it("leaves the pause alone while a newer run holds the thread", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await seedPausedRun(harness, undefined);

            // The stream is still live: a newer run owns `awaitingInput` now.
            await harness.run(async (ctx: any) => await ctx.db.patch("threads", ids.threadId as never, { awaitingInput: "question" }));
            vi.mocked(resumeApprovedRun).mockResolvedValueOnce({ lastMessageId: undefined, paused: false, stopped: true });

            await resume(harness, ids);

            const { awaitingInput } = await awaitingOf(harness, ids);

            expect(awaitingInput).toBe("question");
        } finally {
            harness.close();
        }
    });

    it("keeps the request a resumed run paused on again", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await seedPausedRun(harness, undefined);

            vi.mocked(resumeApprovedRun).mockResolvedValueOnce({ awaitingInput: "question", lastMessageId: undefined, paused: true, stopped: false });

            await resume(harness, ids);

            expect(await awaitingOf(harness, ids)).toEqual({ awaitingInput: "question", status: "active" });
        } finally {
            harness.close();
        }
    });
});

describe("a sub-agent child's continuation", () => {
    /** A paused child thread with its run, resumed with `resumed` (or refused at its lock), and the run row after it. */
    const resumeChild = async (options: {
        /** The step after the continuation's settlement throws (`noteGoalPaused`). */
        failAfterSettling?: boolean;
        /** The continuation throws, and closing its stream (`failRun`) throws too. */
        failWithCleanup?: boolean;
        lockedAt?: number;
        /** A newer answer resumes the run while this continuation runs: it sets another deadline. */
        newerResume?: boolean;
        /** The deadline this run's resume set, and a request of the run open on the child's latest turn. */
        pausedAgainAt?: number;
        /** The owner was asked a question in the child thread while the continuation ran. */
        questionMeanwhile?: boolean;
        resumed?: { awaitingInput?: "approval"; paused: boolean; stopped: boolean };
        status?: "cancelled";
        /** Records the run's status at the moment the continuation closes its stream (`failRun`). */
        watchClose?: boolean;
    }) => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await seedPausedRun(harness, options.lockedAt);
            const runId = await harness.run(
                async (ctx: any) =>
                    await ctx.db.insert("subAgentRuns", {
                        childThreadId: ids.threadId,
                        createdAt: Date.now(),
                        depth: 1,
                        parentThreadId: "parent-thread",
                        startedAt: Date.now(),
                        status: options.status ?? "running",
                        task: "Tidy up",
                        toolCallId: "call-parent",
                        updatedAt: Date.now(),
                        userId: OWNER,
                        ...(options.pausedAgainAt !== undefined && { reapAt: options.pausedAgainAt }),
                    }),
            );

            if (options.pausedAgainAt !== undefined) {
                // What the continuation saved when it paused again: a request of the run on the child's latest turn.
                await harness.run(async (ctx: any) => {
                    await ctx.db.insert("messages", {
                        message: {
                            content: [
                                { input: {}, toolCallId: "call-2", toolName: "mcp_Files__delete", type: "tool-call" },
                                { approvalId: "approval-2", toolCallId: "call-2", type: "tool-approval-request" },
                            ],
                            role: "assistant",
                        },
                        order: 0,
                        status: "success",
                        stepOrder: 1,
                        threadId: ids.threadId,
                        tool: true,
                        userId: OWNER,
                    });
                    await ctx.db.insert("toolApprovalRuns", {
                        approvalId: "approval-2",
                        config: { ...config, subAgentRunId: runId },
                        createdAt: Date.now(),
                        status: "pending",
                        threadId: ids.threadId,
                        userId: OWNER,
                    });
                });
            }

            let statusWhenClosed: string | undefined;

            if (options.watchClose) {
                vi.mocked(failRun).mockImplementationOnce(async () => {
                    const row = await harness.run(async (ctx: any) => await ctx.db.get("subAgentRuns", runId));

                    statusWhenClosed = row.status;

                    return { replaced: false };
                });
            }

            if (options.failAfterSettling) {
                vi.mocked(noteGoalPaused).mockRejectedValueOnce(new Error("goal write failed"));
            }

            if (options.failWithCleanup) {
                vi.mocked(failRun).mockRejectedValue(new Error("stream write failed"));
            }

            if (options.failWithCleanup && !options.lockedAt) {
                vi.mocked(resumeApprovedRun).mockRejectedValueOnce(new Error("model call failed"));
            } else if (options.resumed) {
                const { resumed } = options;

                vi.mocked(resumeApprovedRun).mockImplementationOnce(async () => {
                    if (options.questionMeanwhile) {
                        await harness.run(async (ctx: any) => await ctx.db.patch("threads", ids.threadId as never, { awaitingInput: "question" }));
                    }

                    if (options.newerResume && options.pausedAgainAt !== undefined) {
                        await harness.run(async (ctx: any) => await ctx.db.patch("subAgentRuns", runId, { reapAt: (options.pausedAgainAt ?? 0) + 1 }));
                    }

                    return { lastMessageId: undefined, ...resumed };
                });
            }

            await harness.action(
                async (ctx: any) =>
                    await ctx.runAction(continueAfterToolApproval, {
                        approvalId: "approval-1",
                        approved: true,
                        config: { ...config, subAgentRunId: runId },
                        streamId: ids.streamId,
                        threadId: ids.threadId,
                        userId: OWNER,
                    }),
            );

            return await harness.run(async (ctx: any) => {
                const row = await ctx.db.get("subAgentRuns", runId);
                const approvals = await ctx.db.query("toolApprovalRuns").collect();
                const child = await ctx.db.get("threads", ids.threadId as never);

                return {
                    ...row,
                    childAwaitingInput: child?.awaitingInput,
                    openRequests: approvals.filter((approval: { status: string }) => approval.status === "pending").length,
                    statusWhenClosed,
                };
            });
        } finally {
            harness.close();
        }
    };

    it("ends the run as failed when the child was stopped meanwhile, or locked after its stream started", async () => {
        expect(await resumeChild({ resumed: { paused: false, stopped: true } })).toMatchObject({ error: "This sub-agent was stopped.", status: "failed" });
        expect(await resumeChild({ lockedAt: Date.now() + 60_000 })).toMatchObject({
            error: "The sub-agent's conversation can no longer continue.",
            status: "failed",
        });
    });

    it("closes a locked child's stream before ending its run, so the run's end does not stop it first", async () => {
        expect(await resumeChild({ lockedAt: Date.now() + 60_000, watchClose: true })).toMatchObject({ status: "failed", statusWhenClosed: "running" });
    });

    it("runs nothing for a run stopped or reaped between the answer and the job's start", async () => {
        expect(await resumeChild({ status: "cancelled" })).toMatchObject({ status: "cancelled" });
        expect(resumeApprovedRun).not.toHaveBeenCalled();
    });

    it("waits again for the resume that paused, and not once a newer answer resumed the run meanwhile", async () => {
        const pausedAgain = { pausedAgainAt: Date.now() + 60 * 60_000, resumed: { paused: true, stopped: false } };

        expect(await resumeChild(pausedAgain)).toMatchObject({ status: "awaiting" });
        expect(await resumeChild({ ...pausedAgain, newerResume: true })).toMatchObject({ status: "running" });
    });

    it("leaves a run that waits again waiting, with its request open, when a later step of the continuation fails", async () => {
        expect(
            await resumeChild({ failAfterSettling: true, pausedAgainAt: Date.now() + 60 * 60_000, resumed: { paused: true, stopped: false } }),
        ).toMatchObject({ openRequests: 1, status: "awaiting" });
    });

    it("ends the run as failed when closing a failed continuation's stream throws too", async () => {
        try {
            expect(await resumeChild({ failWithCleanup: true })).toMatchObject({ status: "failed" });
            expect(await resumeChild({ failWithCleanup: true, lockedAt: Date.now() + 60_000 })).toMatchObject({
                error: "The sub-agent's conversation can no longer continue.",
                status: "failed",
            });
        } finally {
            vi.mocked(failRun).mockRestore();
        }
    });

    it("leaves a question the owner was asked in the child as what it waits on when the continuation pauses again", async () => {
        expect(
            await resumeChild({
                pausedAgainAt: Date.now() + 60 * 60_000,
                questionMeanwhile: true,
                resumed: { awaitingInput: "approval", paused: true, stopped: false },
            }),
        ).toMatchObject({ childAwaitingInput: "question", status: "awaiting" });
    });

    it("hands a pause back to the run's wait, and schedules an end whose write failed", async () => {
        const runId = "run-1" as never;
        // The deadline the resume this continuation runs under set: every write, and its retry, is bound to it.
        const resumedWith = 42;
        const paused = { runMutation: vi.fn(async () => true), scheduler: { runAfter: vi.fn(async () => "job") } };

        expect(await settleSubAgentRun(paused as never, runId, { kind: "paused" }, resumedWith)).toBe(true);
        expect(paused.runMutation).toHaveBeenCalledWith(internal.sub_agents.functions.awaitApproval, { resumedWith, runId });

        const failing = {
            runMutation: vi.fn(async () => {
                throw new Error("write failed");
            }),
            scheduler: { runAfter: vi.fn(async () => "job") },
        };
        const completion = { messageIds: ["m1"], outcome: { kind: "succeeded" }, resumedWith, runId };

        expect(await settleSubAgentRun(failing as never, runId, { kind: "succeeded", messageIds: ["m1"] }, resumedWith)).toBe(false);
        expect(failing.runMutation).toHaveBeenCalledWith(internal.sub_agents.functions.completeResumedRun, completion);
        expect(failing.scheduler.runAfter).toHaveBeenCalledWith(expect.any(Number), internal.sub_agents.functions.completeResumedRun, completion);
        expect(await settleSubAgentRun(failing as never, runId, { kind: "paused" }, resumedWith)).toBe(true);
        expect(failing.scheduler.runAfter).toHaveBeenCalledWith(expect.any(Number), internal.sub_agents.functions.awaitApproval, { resumedWith, runId });
    });
});
