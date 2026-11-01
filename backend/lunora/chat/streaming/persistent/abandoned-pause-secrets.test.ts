/**
 * A reply paused on a request keeps its saved secret references through the pause (a consumer tool set to `ask`
 * resumes the run). When the person walks away from that pause the ciphertext goes at once instead of waiting out
 * its 24 hours: Stop with nothing live, a new message that moves the conversation past the request, and a Stop
 * that lands before a queued continuation started.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../../../test/registered-api";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../../../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../../../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

// `lib/encryption` reads the key when it loads.
const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

const { default: schema } = await import("../../../schema");
const { createStreamWithMessage } = await import("../index");
const { stopActiveForThread } = await import("./library");
const { storeRequestedSecret } = await import("../../lib/secret-requests");

const OWNER = "user-owner";
const CONFIG = {
    autoMediaEnrichment: false,
    instructions: "system prompt",
    mcpServerNames: [],
    model: "test-model",
    replyKey: "stream-A",
    researchDepth: "balanced" as const,
    searchMode: "chat",
    shouldAutoContinue: true,
    startedBy: OWNER,
    toolNames: ["requestSecret"],
};

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);

const insertSnapshot = async (status: "approved" | "pending", replyKey: string, streamId?: string) =>
    await run(
        async (ctx) =>
            await ctx.db.insert("toolApprovalRuns", {
                approvalId: `appr-${replyKey}-${status}`,
                config: { ...CONFIG, replyKey },
                createdAt: Date.now(),
                status,
                ...(streamId !== undefined && { streamId }),
                threadId,
                userId: OWNER,
            }),
    );

const insertStream = async (status: "done" | "streaming", runClaimedAt?: number, messageId = "prompt") =>
    await run(
        async (ctx) =>
            await ctx.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId,
                status,
                streamingConfig: { contentType: "text", model: "m" },
                threadId,
                userId: OWNER,
                ...(runClaimedAt !== undefined && { runClaimedAt }),
            }),
    );

const storeSecret = async (replyKey: string) =>
    await run(
        async (ctx) =>
            await storeRequestedSecret(ctx, {
                approvalId: `appr-${replyKey}`,
                label: "L",
                now: Date.now(),
                replyKey,
                threadId: threadId as never,
                use: { kind: "provider_key", provider: "openai" },
                userId: OWNER,
                value: "sk-live-0123456789-supersecret",
            }),
    );

/** Whether the reference still holds its ciphertext. */
const holdsValue = async (ref: string): Promise<boolean> =>
    await run(async (ctx) => {
        const rows: { encryptedValue?: string; ref: string }[] = await ctx.db.query("requestedSecrets").collect();

        return rows.find((row) => row.ref === ref)?.encryptedValue !== undefined;
    });

beforeAll(async () => {
    registerModule(registry, "chat_streaming_persistent_library", await import("./library"));
}, 60_000);

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await run(async (ctx) => await ctx.db.insert("threads", { model: "m", status: "active", title: "t", userId: OWNER }));
});

afterEach(() => {
    harness.close();
});

describe("a paused reply that is abandoned", () => {
    it("loses its saved reference when Stop is pressed with nothing live, and another reply's is kept", async () => {
        const paused = await storeSecret("stream-A");
        const approvedElsewhere = await storeSecret("stream-B");

        await insertSnapshot("pending", "stream-A");
        await insertSnapshot("approved", "stream-B");
        await insertStream("done", Date.now());

        await run(async (ctx) => await ctx.runMutation(stopActiveForThread, { threadId }));

        expect(await holdsValue(paused)).toBe(false);
        expect(await holdsValue(approvedElsewhere)).toBe(true);
    });

    it("keeps it while a claimed live reply is stopped through its own run, which drops its references when it ends", async () => {
        const live = String(await insertStream("streaming", Date.now()));
        const ref = await storeSecret(live);

        await insertSnapshot("pending", live);

        await run(async (ctx) => await ctx.runMutation(stopActiveForThread, { threadId }));

        expect(await holdsValue(ref)).toBe(true);
    });

    it("drops a stopped paused reply's references although another reply is live", async () => {
        const paused = String(await insertStream("done", Date.now(), "prompt-A"));
        const live = String(await insertStream("streaming", Date.now(), "prompt-B"));
        const stopped = await storeSecret(paused);
        const running = await storeSecret(live);

        await insertSnapshot("pending", paused, paused);

        await run(async (ctx) => await ctx.runMutation(stopActiveForThread, { messageId: "prompt-A", threadId }));

        expect(await holdsValue(stopped)).toBe(false);
        expect(await holdsValue(running)).toBe(true);
    });

    it("keeps a live continuation's references when it is past the first page of live streams", async () => {
        const ref = await storeSecret("stream-A");

        await insertSnapshot("pending", "stream-A");

        for (let index = 0; index < 55; index += 1) {
            await insertStream("streaming", Date.now());
        }

        const continuation = await insertStream("streaming", Date.now());

        await insertSnapshot("approved", "stream-A", continuation);
        await run(
            async (ctx) =>
                await ctx.runMutation(createStreamWithMessage, {
                    messageId: "m2",
                    streamingConfig: { contentType: "text", model: "m" },
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await holdsValue(ref)).toBe(true);
    });

    it("loses it when a new message moves the conversation past the request", async () => {
        const ref = await storeSecret("stream-A");

        await insertSnapshot("pending", "stream-A");
        await run(
            async (ctx) =>
                await ctx.runMutation(createStreamWithMessage, {
                    messageId: "m2",
                    streamingConfig: { contentType: "text", model: "m" },
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await holdsValue(ref)).toBe(false);
    });

    it("loses it when Stop lands before the queued continuation started, which claimStreamRun would refuse", async () => {
        const ref = await storeSecret("stream-A");
        const continuation = await insertStream("streaming");

        await insertSnapshot("approved", "stream-A", continuation);

        await run(async (ctx) => await ctx.runMutation(stopActiveForThread, { threadId }));

        expect(await holdsValue(ref)).toBe(false);
    });

    it("keeps the references of a reply whose continuation is live while another request of the same pause stays pending", async () => {
        const ref = await storeSecret("stream-A");
        const continuation = await insertStream("streaming", Date.now());

        await insertSnapshot("pending", "stream-A");
        await insertSnapshot("approved", "stream-A", continuation);
        await run(
            async (ctx) =>
                await ctx.runMutation(createStreamWithMessage, {
                    messageId: "m2",
                    streamingConfig: { contentType: "text", model: "m" },
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await holdsValue(ref)).toBe(true);
    });

    it("clears only the paused replies' references in one pass and leaves a reply that was not paused", async () => {
        const first = await storeSecret("stream-A");
        const second = await storeSecret("stream-B");
        const other = await storeSecret("stream-C");

        await insertSnapshot("pending", "stream-A");
        await insertSnapshot("pending", "stream-B");
        await insertSnapshot("approved", "stream-C");

        const { discardPausedThreadSecrets } = await import("../../lib/secret-requests");
        const dropped = await run(async (ctx) => await discardPausedThreadSecrets(ctx, { threadId: threadId as never }));

        expect(dropped).toBe(2);
        expect(await holdsValue(first)).toBe(false);
        expect(await holdsValue(second)).toBe(false);
        expect(await holdsValue(other)).toBe(true);
    });

    it("loses only the stopped prompt's references when Stop names a prompt with nothing live", async () => {
        const streamA = String(await insertStream("done", Date.now(), "prompt-A"));
        const streamB = String(await insertStream("done", Date.now(), "prompt-B"));
        const stopped = await storeSecret(streamA);
        const paused = await storeSecret(streamB);

        await insertSnapshot("pending", streamA, streamA);
        await insertSnapshot("pending", streamB, streamB);
        await run(async (ctx) => await ctx.runMutation(stopActiveForThread, { messageId: "prompt-A", threadId }));

        expect(await holdsValue(stopped)).toBe(false);
        expect(await holdsValue(paused)).toBe(true);
    });

    it("denies the abandoned pause's requests and reads a late spend as abandoned", async () => {
        const ref = await storeSecret("stream-A");

        await insertSnapshot("pending", "stream-A");
        await run(
            async (ctx) =>
                await ctx.runMutation(createStreamWithMessage, {
                    messageId: "m2",
                    streamingConfig: { contentType: "text", model: "m" },
                    threadId,
                    userId: OWNER,
                }),
        );

        const [snapshot] = await run(async (ctx) => await ctx.db.query("toolApprovalRuns").collect());

        expect(snapshot).toMatchObject({ resolvedBy: "abandoned", status: "denied" });

        const { takeRequestedSecret } = await import("../../lib/secret-requests");
        const spend = await run(
            async (ctx) => await takeRequestedSecret(ctx, { kind: "provider_key", now: Date.now(), ref, startedBy: OWNER, threadId, userId: OWNER }),
        );

        expect(spend).toStrictEqual({ ok: false, status: "abandoned" });
    });
});
