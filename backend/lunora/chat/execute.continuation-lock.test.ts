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
import { continueAfterToolApproval } from "./execute";
import { resumeApprovedRun } from "./lib/agent-run";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

// The resume itself is the model run; the test is about the lock gate and the stream's end state.
vi.mock("./lib/agent-run", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/agent-run")>()),
        resumeApprovedRun: vi.fn(async () => {return { lastMessageId: undefined, paused: false, stopped: false }}),
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
            await ctx.db.patch(threadId, { lockedAt });
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
        const thread = await ctx.db.get(ids.threadId as never);
        const stream = await ctx.db.get(ids.streamId as never);

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
