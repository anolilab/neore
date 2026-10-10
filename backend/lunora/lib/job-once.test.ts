/**
 * `enqueueJob(ref, args, { once })` routes a job through `runJobOnce`, which
 * claims the stamped `jobId` before the target runs. Media generation relies on
 * it: every delivery would otherwise be a second paid provider call.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import schema from "../schema";
import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { claimKey, completeKey } from "./claim-once";
import { JOB_LEASE_MS, runJobOnce } from "./job-once";
import { enqueueJob } from "./job-queue";

const NOW = 1_800_000_000_000;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    jobsQueueMessages.length = 0;
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

/** An action ctx whose `runAction` records (or fails) the target call. */
const actionContext = (target: (path: string, args: unknown) => void = () => {}) => {
    const ran: { args: unknown; path: string }[] = [];
    const ctx = {
        runAction: async (reference: { __lunoraRef: string }, args: unknown) => {
            ran.push({ args, path: reference.__lunoraRef });
            target(reference.__lunoraRef, args);
        },
        runMutation: async (reference: unknown, args: unknown) => {
            const registered = reference === internal.lib.claim_once.claimKey ? claimKey : completeKey;

            return await harness.run(async (inner: any) => await inner.runMutation(registered, args));
        },
    };

    return { ctx, ran };
};

const deliver = async (ctx: unknown, jobId = "job-1") =>
    await (runJobOnce as unknown as { handler: (ctx: unknown, args: unknown) => Promise<unknown> }).handler(ctx, {
        args: { prompt: "a cat" },
        jobId,
        target: "chat_functions:generateImage",
        userId: "u1",
    });

describe("enqueueJob with once", () => {
    it("stamps a jobId and wraps the target in runJobOnce", async () => {
        await enqueueJob(
            internal.chat.functions.generateAudio,
            { model: "m", prompt: "p", threadId: "t", userId: "u1" },
            {
                once: { onLapse: { args: { threadId: "t" }, ref: internal.chat.media_abandon.failAbandonedMediaJob }, userId: "u1" },
            },
        );

        const body = jobsQueueMessages[0]?.body as { args: Record<string, unknown>; functionPath: string };

        expect(body.functionPath).toBe("lib_job_once:runJobOnce");
        expect(body.args).toStrictEqual({
            args: { model: "m", prompt: "p", threadId: "t", userId: "u1" },
            jobId: expect.any(String),
            onLapse: { args: JSON.stringify({ threadId: "t" }), target: "chat_media_abandon:failAbandonedMediaJob" },
            target: "chat_functions:generateAudio",
            userId: "u1",
        });
    });
});

describe("runJobOnce", () => {
    it("runs the target for the first delivery only", async () => {
        const { ctx, ran } = actionContext();

        await deliver(ctx);
        await deliver(ctx);

        // The target gets the claim key as `jobId`, to stamp on what it creates.
        expect(ran).toStrictEqual([{ args: { jobId: "job-1", prompt: "a cat" }, path: "chat_functions:generateImage" }]);
    });

    it("completes the claim when the target throws, so the queue's retry is a no-op", async () => {
        const failing = actionContext(() => {
            throw new Error("provider down");
        });

        await expect(deliver(failing.ctx)).rejects.toThrow("provider down");

        vi.setSystemTime(NOW + JOB_LEASE_MS + 1);

        const retry = actionContext();

        await deliver(retry.ctx);
        expect(retry.ran).toHaveLength(0);
    });

    it("never re-runs a job whose delivery died mid-run — a late redelivery is refused too", async () => {
        // A delivery that claimed and then vanished: the lease is taken, never completed.
        await harness.run(
            async (inner: any) => await inner.runMutation(claimKey, { key: "job-1", leaseMs: JOB_LEASE_MS, scope: "job", ttlMs: 24 * 60 * 60 * 1000 }),
        );

        vi.setSystemTime(NOW + JOB_LEASE_MS + 1);

        const late = actionContext();

        await deliver(late.ctx);
        expect(late.ran).toHaveLength(0);
    });
});
