import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { restartImportJob } from "./functions";
import { CANCELLED_IMPORT_MESSAGE } from "./restart";
import { importCounts, processConversationBatch, reapRestartableImport } from "./steps";

// The session is read straight off the harness identity: `user` is a `.global()`
// (D1) table the in-memory harness cannot write (as in `workflow/stored-urls.test.ts`).
const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

const OWNER = "owner";
const KEPT = "chat-import/owner/job";
const FAILED_AT = 1_700_000_000_000;

const insertJob = (harness: ReturnType<typeof lunoraTest>, overrides: Record<string, unknown> = {}) =>
    harness.run(
        async (ctx: any) =>
            await ctx.db.insert("chatImportJobs", {
                completedAt: FAILED_AT,
                createdAt: FAILED_AT - 1000,
                errorMessage: "boom",
                failedConversations: 1,
                importedConversations: 3,
                provider: "chatgpt",
                r2Key: KEPT,
                status: "failed",
                totalConversations: 5,
                userId: OWNER,
                ...overrides,
            }),
    );

describe("restartImportJob", () => {
    it("refuses another user's job as not found", async () => {
        const harness = lunoraTest(schema as never);
        const jobId = await insertJob(harness);

        await expect(harness.withIdentity({ userId: "stranger" }).mutation(restartImportJob as never, { jobId } as never)).rejects.toThrow(
            "Import job not found",
        );
    });

    it("refuses a cancelled import", async () => {
        const harness = lunoraTest(schema as never);
        const jobId = await insertJob(harness, { errorMessage: CANCELLED_IMPORT_MESSAGE });

        await expect(harness.withIdentity({ userId: OWNER }).mutation(restartImportJob as never, { jobId } as never)).rejects.toThrow("cannot be restarted");
    });

    it("refuses a job whose file was not kept", async () => {
        const harness = lunoraTest(schema as never);
        const jobId = await insertJob(harness, { r2Key: "" });

        await expect(harness.withIdentity({ userId: OWNER }).mutation(restartImportJob as never, { jobId } as never)).rejects.toThrow("cannot be restarted");
    });

    it("refuses a failed run that has no conversations left to run", async () => {
        const harness = lunoraTest(schema as never);
        const jobId = await insertJob(harness, { failedConversations: 2, importedConversations: 3 });

        await expect(harness.withIdentity({ userId: OWNER }).mutation(restartImportJob as never, { jobId } as never)).rejects.toThrow("cannot be restarted");
    });

    it("refuses when another import is already processing", async () => {
        const harness = lunoraTest(schema as never);
        const jobId = await insertJob(harness);

        await insertJob(harness, { completedAt: undefined, errorMessage: undefined, r2Key: "", status: "processing" });

        await expect(harness.withIdentity({ userId: OWNER }).mutation(restartImportJob as never, { jobId } as never)).rejects.toThrow("already in progress");
    });

    it("moves a restartable job back to processing and clears its failure", async () => {
        const harness = lunoraTest(schema as never);
        const jobId = await insertJob(harness);

        await harness.withIdentity({ userId: OWNER }).mutation(restartImportJob as never, { jobId } as never);

        const job = await harness.run(async (ctx: any) => await ctx.db.get(jobId));

        expect(job.status).toBe("processing");
        expect(job.completedAt).toBeUndefined();
        expect(job.errorMessage).toBeUndefined();
        expect(job.r2Key).toBe(KEPT);
    });
});

describe("reapRestartableImport", () => {
    it("deletes the kept file for the failure it was scheduled for", async () => {
        const harness = lunoraTest(schema as never);
        const jobId = await insertJob(harness);

        await harness.run(async (ctx: any) => await ctx.runMutation(reapRestartableImport, { failedAt: FAILED_AT, jobId, r2Key: KEPT }));

        const job = await harness.run(async (ctx: any) => await ctx.db.get(jobId));

        expect(job.r2Key).toBe("");
    });

    it("does nothing after a newer failure moved the job on", async () => {
        const harness = lunoraTest(schema as never);
        const jobId = await insertJob(harness, { completedAt: FAILED_AT + 60_000 });

        await harness.run(async (ctx: any) => await ctx.runMutation(reapRestartableImport, { failedAt: FAILED_AT, jobId, r2Key: KEPT }));

        const job = await harness.run(async (ctx: any) => await ctx.db.get(jobId));

        expect(job.r2Key).toBe(KEPT);
    });

    it("does nothing while the job is processing again", async () => {
        const harness = lunoraTest(schema as never);
        const jobId = await insertJob(harness, { completedAt: undefined, errorMessage: undefined, status: "processing" });

        await harness.run(async (ctx: any) => await ctx.runMutation(reapRestartableImport, { failedAt: FAILED_AT, jobId, r2Key: KEPT }));

        const job = await harness.run(async (ctx: any) => await ctx.db.get(jobId));

        expect(job.r2Key).toBe(KEPT);
    });
});

describe("processConversationBatch", () => {
    it("commits the batch's counts on the job, so a restart resumes after them", async () => {
        const harness = lunoraTest(schema as never);
        const jobId = await insertJob(harness, {
            completedAt: undefined,
            errorMessage: undefined,
            failedConversations: 0,
            importedConversations: 0,
            r2Key: KEPT,
            status: "processing",
        });

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(processConversationBatch, {
                    conversations: [
                        { messages: [{ content: "hi", role: "user" }], title: "one" },
                        { messages: [], title: "empty counts as failed" },
                    ],
                    jobId,
                    provider: "chatgpt",
                    userId: OWNER,
                }),
        );

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(importCounts, { jobId }))).toStrictEqual({ failed: 1, imported: 1, total: 5 });
    });
});
