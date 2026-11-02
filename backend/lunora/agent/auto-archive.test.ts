/**
 * `archiveIfStillIdle` must see a live run however many finished streams the
 * thread has: the live one is inserted last, past any sample of the first 50.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { pendingApprovalCutoff } from "../chat/lib/tool-approval-cleanup";
import { MAX_LENGTH } from "../lib/validators";
import { archiveIfStillIdle, autoArchiveContinue } from "./auto-archive";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "user-owner";
const CUTOFF = 10_000;
const FINISHED_STREAMS = 60;

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const finishedStreams = (count: number): string[] => {
    const statuses: string[] = [];

    for (let index = 0; index < count; index += 1) {
        statuses.push("done");
    }

    return statuses;
};

const archiveAfter = (statuses: string[]) =>
    harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Old", updatedAt: 1, userId: OWNER });

        for (const status of statuses) {
            await ctx.db.insert("persistentStreams", {
                expiresAt: CUTOFF * 10,
                messageId: "m-1",
                status,
                streamingConfig: { contentType: "text", model: "gpt-4o" },
                threadId,
                userId: OWNER,
            });
        }

        return await ctx.runMutation(archiveIfStillIdle, { cutoff: CUTOFF, threadId });
    });

describe("archiveIfStillIdle and live streams", () => {
    it("archives a thread whose streams all finished", async () => {
        expect(await archiveAfter(finishedStreams(FINISHED_STREAMS))).toBe(true);
    });

    it("keeps a thread whose one live stream sits behind more than 50 finished ones", async () => {
        const statuses = [...finishedStreams(FINISHED_STREAMS), "streaming"];

        expect(await archiveAfter(statuses)).toBe(false);
    });

    it("keeps a thread with a pending stream behind finished ones", async () => {
        const statuses = [...finishedStreams(FINISHED_STREAMS), "pending"];

        expect(await archiveAfter(statuses)).toBe(false);
    });
});

describe("archiveIfStillIdle and requests waiting on the owner", () => {
    const archiveWithApproval = (status: "approved" | "pending", createdAt = Date.now()) =>
        harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Old", updatedAt: 1, userId: OWNER });

            await ctx.db.insert("toolApprovalRuns", {
                approvalId: "approval-1",
                config: {
                    autoMediaEnrichment: false,
                    mcpServerNames: [],
                    model: "test-model",
                    researchDepth: "balanced",
                    searchMode: "chat",
                    shouldAutoContinue: false,
                    toolNames: [],
                },
                createdAt,
                status,
                threadId,
                userId: OWNER,
            });

            return await ctx.runMutation(archiveIfStillIdle, { cutoff: CUTOFF, threadId });
        });

    it("keeps a thread with a pending approval, question or secret card", async () => {
        expect(await archiveWithApproval("pending")).toBe(false);
    });

    it("archives a thread whose request expired unanswered", async () => {
        expect(await archiveWithApproval("pending", 1)).toBe(true);
    });

    it("keeps a thread whose request is created exactly at the cutoff, and archives one a millisecond older", async () => {
        const now = Date.now();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

        try {
            expect(await archiveWithApproval("pending", pendingApprovalCutoff(now))).toBe(false);
            expect(await archiveWithApproval("pending", pendingApprovalCutoff(now) - 1)).toBe(true);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("keeps a thread whose live request sits behind many expired ones", async () => {
        const kept = await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Old", updatedAt: 1, userId: OWNER });
            const config = {
                autoMediaEnrichment: false,
                mcpServerNames: [],
                model: "m",
                researchDepth: "balanced",
                searchMode: "chat",
                shouldAutoContinue: false,
                toolNames: [],
            };

            for (let index = 0; index < 30; index += 1) {
                await ctx.db.insert("toolApprovalRuns", {
                    approvalId: `old-${index}`,
                    config,
                    createdAt: 1 + index,
                    status: "pending",
                    threadId,
                    userId: OWNER,
                });
            }

            await ctx.db.insert("toolApprovalRuns", { approvalId: "live", config, createdAt: Date.now(), status: "pending", threadId, userId: OWNER });

            return await ctx.runMutation(archiveIfStillIdle, { cutoff: CUTOFF, threadId });
        });

        expect(kept).toBe(false);
    });

    it("archives a thread whose request was answered", async () => {
        expect(await archiveWithApproval("approved")).toBe(true);
    });
});

describe("autoArchiveContinue cursor", () => {
    it("refuses a cursor longer than the cursor bound", async () => {
        await expect(
            harness.run(async (ctx: any) => await ctx.runMutation(autoArchiveContinue, { cursor: "c".repeat(MAX_LENGTH.cursor + 1) })),
        ).rejects.toThrow();
    });

    it("issues pagination cursors well under the bound", async () => {
        const cursor = await harness.run(async (ctx: any) => {
            for (let index = 0; index < 2; index += 1) {
                await ctx.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Old", updatedAt: index + 1, userId: OWNER });
            }

            const { continueCursor } = await ctx.db
                .query("threads")
                .withIndex("by_user_and_updatedAt", (q: any) => q.eq("userId", OWNER).lt("updatedAt", CUTOFF))
                .order("desc")
                .paginate({ cursor: null, numItems: 1 });

            return continueCursor as string;
        });

        expect(cursor.length).toBeLessThan(MAX_LENGTH.cursor);
    });
});
