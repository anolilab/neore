/**
 * The stop buttons end a persistent reply and a legacy one, report whether they
 * stopped anything, and refuse a caller who cannot write the thread (a stranger,
 * or the owner of a locked thread without its proof).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { hashPasscode, newPasscodeEpoch, THREAD_LOCKED_CODE } from "../lib/thread-lock";
import { addChunk } from "./streaming/persistent/library";

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

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

beforeAll(async () => {
    registerModule(registry, "chat_functions", await import("./functions"));
    registerModule(registry, "agent_messages", await import("../agent/messages"));
    registerModule(registry, "agent_streams", await import("../agent/streams"));
    registerModule(registry, "chat_streaming_persistent_library", await import("./streaming/persistent/library"));
}, 60_000);

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const PASSCODE = "passcode-1";

let harness: ReturnType<typeof lunoraTest>;

const CONFLICT = /streaming/u;

const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);
const threadStopProcedure = (): never => registry.get("chat_functions:abortThreadStream") as never;
const promptStopProcedure = (): never => registry.get("chat_functions:abortStreamByMessageId") as never;

/** One field of the row at `id`, read in its own run. */
const fieldOf = async (id: string, key: string): Promise<unknown> => {
    const row = await run(async (context) => await context.db.get(id));

    return (row as Record<string, unknown> | null)?.[key];
};

/** A thread the caller owns, running a reply; returns its id. */
const runningThread = async (): Promise<string> =>
    await run(async (context) => await context.db.insert("threads", { model: "m", status: "running", title: "t", userId: OWNER }));

const insertPersistentStream = async (threadId: string, status: "done" | "pending" | "streaming") =>
    await run(
        async (context) =>
            await context.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId: "m1",
                status,
                streamingConfig: { contentType: "text", model: "m" },
                threadId,
                userId: OWNER,
            }),
    );

describe("abortThreadStream", () => {
    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("stops a running persistent reply the way the composer stop ends a run", async () => {
        const threadId = await runningThread();
        const streamId = await insertPersistentStream(threadId, "streaming");

        const result = await harness.withIdentity({ userId: OWNER } as never).mutation(threadStopProcedure(), { threadId } as never);

        expect(result).toStrictEqual({ aborted: true });
        expect(await fieldOf(streamId, "status")).toBe("done");
        expect(await fieldOf(threadId, "status")).toBe("abort");

        // The run's next chunk is refused, which is what stops its generation.
        await expect(run(async (context) => await context.runMutation(addChunk, { final: false, streamId, text: "more" }))).rejects.toThrow(CONFLICT);
    });

    it("returns false and changes nothing when no run is active", async () => {
        const threadId = await runningThread();
        const streamId = await insertPersistentStream(threadId, "done");

        const result = await harness.withIdentity({ userId: OWNER } as never).mutation(threadStopProcedure(), { threadId } as never);

        expect(result).toStrictEqual({ aborted: false });
        expect(await fieldOf(streamId, "status")).toBe("done");
        expect(await fieldOf(threadId, "status")).toBe("running");
    });

    it("still stops a legacy streamingMessages run", async () => {
        const threadId = await runningThread();
        const legacyId = await run(
            async (context) =>
                await context.db.insert("streamingMessages", {
                    format: "UIMessageChunk",
                    order: 1,
                    state: { kind: "streaming", lastHeartbeat: Date.now() },
                    stateKind: "streaming",
                    stepOrder: 0,
                    threadId,
                    userId: OWNER,
                }),
        );

        const result = await harness.withIdentity({ userId: OWNER } as never).mutation(threadStopProcedure(), { threadId } as never);

        expect(result).toStrictEqual({ aborted: true });
        expect(await fieldOf(legacyId, "stateKind")).toBe("aborted");
    });

    it("refuses a stranger and leaves the reply running", async () => {
        const threadId = await runningThread();
        const streamId = await insertPersistentStream(threadId, "streaming");

        await expect(harness.withIdentity({ userId: STRANGER } as never).mutation(threadStopProcedure(), { threadId } as never)).rejects.toThrow();

        expect(await fieldOf(streamId, "status")).toBe("streaming");
        expect(await fieldOf(threadId, "status")).toBe("running");
    });

    it("refuses the owner of a locked thread without its proof, and leaves the reply running", async () => {
        const hashed = await hashPasscode(PASSCODE, 1000);
        const threadId = await run(async (context) => {
            const id = await context.db.insert("threads", {
                lockedAt: Date.now() - 60_000,
                mode: "text",
                model: "m",
                status: "running",
                title: "t",
                userId: OWNER,
            });

            await context.db.insert("threadPasscodes", {
                createdAt: 1,
                epoch: newPasscodeEpoch(),
                failedAttempts: 0,
                hash: hashed.hash,
                iterations: hashed.iterations,
                salt: hashed.salt,
                threadId: id,
                updatedAt: 1,
                userId: OWNER,
            });

            return id;
        });
        const streamId = await insertPersistentStream(threadId, "streaming");

        await expect(harness.withIdentity({ userId: OWNER } as never).mutation(threadStopProcedure(), { threadId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });

        expect(await fieldOf(streamId, "status")).toBe("streaming");
    });
});

describe("abortStreamByMessageId", () => {
    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("the composer stop also ends a persistent reply in the thread", async () => {
        const threadId = await runningThread();
        const messageId = await run(
            async (context) =>
                await context.db.insert("messages", {
                    message: { content: "hi", role: "user" },
                    order: 1,
                    status: "success",
                    stepOrder: 0,
                    text: "hi",
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );
        const streamId = await insertPersistentStream(threadId, "streaming");

        const result = await harness
            .withIdentity({ userId: OWNER } as never)
            .mutation(promptStopProcedure(), { messageId: String(messageId), threadId } as never);

        expect(result).toStrictEqual({ aborted: true });
        expect(await fieldOf(streamId, "status")).toBe("done");
    });

    it("a composer id that is not a message row still stops the persistent reply", async () => {
        const threadId = await runningThread();
        const streamId = await insertPersistentStream(threadId, "streaming");

        // The placeholder's key, as the composer sends it for the first reply of a new thread.
        const result = await harness
            .withIdentity({ userId: OWNER } as never)
            .mutation(promptStopProcedure(), { messageId: `streaming-${streamId}`, threadId } as never);

        expect(result).toStrictEqual({ aborted: true });
        expect(await fieldOf(streamId, "status")).toBe("done");
    });
});
