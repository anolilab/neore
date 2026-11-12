/* eslint-disable unicorn/no-await-expression-member */
/**
 * `/chat/start` with `clientMessageId`: a resend saves nothing twice and creates no second thread; it is answered with
 * the first send's ids. The claim, the thread creation, the save and the rows are real, and the saves run with no
 * nested mutation (one would commit on its own); the runtime around the handler is faked as in `http.guest-note.test.ts`.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { createThreadWithInitialMessage, gateThreadActionHandler } from "./functions";
import { runChatStart } from "./http";
import { enqueueJob } from "../lib/job-queue";
import { CHAT_START_LEASE_MS, chatStartFingerprint, claimChatStart, recordStartStream, releaseChatStart, saveStartPrompt } from "./start-claim";

const state = vi.hoisted(() => {
    return {
        charges: 0,
        /** The next queue submission fails, once. */
        enqueueFails: false,
        /** The ids of every prompt the no-id path saved from the HTTP action. */
        legacySaves: 0,
        /** The references the HTTP scheduler was handed. */
        scheduled: [] as string[],
        /** The next stream creation fails, once. */
        streamFails: false,
        userId: "owner-user",
    };
});

vi.mock("../auth/lib/helper", () => {
    return {
        getCurrentUserInternal: async () => {
            return { _id: state.userId, isAnonymous: false };
        },
    };
});
vi.mock("../lib/thread-shard", () => {
    return { threadShardFor: async () => "shard" };
});
vi.mock("../lib/http-shard", () => {
    return { inShard: async (ctx: unknown, _shardKey: string, handler: (ctx: unknown) => Promise<unknown>) => await handler(ctx) };
});
vi.mock("../lib/job-queue", () => {
    return {
        enqueueJob: vi.fn(async () => {
            if (!state.enqueueFails) {
                return;
            }

            state.enqueueFails = false;

            throw new Error("the queue refused the run");
        }),
    };
});
vi.mock("./lib/daily-limit", () => {
    return {
        chargeDailyLimit: async () => {
            state.charges += 1;

            return { ok: true };
        },
    };
});
vi.mock("../lib/http-scheduler", () => {
    return {
        httpScheduler: () => {
            return {
                runAfter: async (_delay: number, reference: { __lunoraRef: string }) => {
                    state.scheduled.push(reference.__lunoraRef);
                },
            };
        },
    };
});

/** The no-id path's save, writing a real row in the transaction it is handed. */
const fakeAgent = {
    saveMessage: async (ctx: any, args: { message: unknown; threadId: string }) => {
        const messageId = await ctx.db.insert("messages", {
            message: args.message,
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "",
            threadId: args.threadId,
            tool: false,
        });

        return { messageId };
    },
};

// The no-id path saves from the HTTP action, through a harness transaction of its own.
vi.mock("./lib/get-agent", () => {
    return {
        default: async () => {
            return {
                saveMessage: async (_ctx: unknown, args: { message: unknown; threadId: string }) => {
                    state.legacySaves += 1;

                    return await harness.run(async (ctx: any) => await fakeAgent.saveMessage(ctx, args));
                },
            };
        },
    };
});

const OWNER = "owner-user";
const MODEL = "openai/gpt-4.1-mini";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const run = async <T>(body: (ctx: any) => Promise<T>): Promise<T> => await harness.run(body);

/** A mutation's ctx that refuses a nested mutation: it would be a separate transaction, so the save would not be atomic. */
const withoutNestedMutations = (ctx: any): any =>
    Object.assign(Object.create(ctx), {
        runMutation: async () => {
            throw new Error("a nested mutation commits on its own");
        },
    });

const HANDLERS: Record<string, (args: any) => Promise<unknown>> = {
    "chat_functions:createThreadWithInitialMessage": async (args) =>
        await run(async (ctx) => await (createThreadWithInitialMessage as any).handler(withoutNestedMutations(ctx), args)),
    "chat_functions:gateThreadAction": async (args) => await run(async (ctx) => await gateThreadActionHandler(ctx, args)),
    "chat_start_claim:claimChatStart": async (args) => await run(async (ctx) => await ctx.runMutation(claimChatStart, args)),
    "chat_start_claim:releaseChatStart": async (args) => await run(async (ctx) => await ctx.runMutation(releaseChatStart, args)),
    "chat_start_claim:saveStartPrompt": async (args) => await run(async (ctx) => await (saveStartPrompt as any).handler(withoutNestedMutations(ctx), args)),
    "chat_streaming:createStreamWithMessage": async (args) => {
        if (state.streamFails) {
            state.streamFails = false;

            throw new Error("the stream could not be made");
        }

        // What `createStreamWithMessage` does for a send: its stream row and, in the same transaction, the claim's record of it.
        return await run(async (ctx) => {
            const streamId = await ctx.db.insert("persistentStreams", {
                expiresAt: Number.MAX_SAFE_INTEGER,
                messageId: args.messageId,
                status: "pending",
                streamingConfig: { contentType: "text", model: MODEL },
                threadId: args.threadId,
                userId: args.userId,
            });

            if (args.startClaim) {
                await recordStartStream(ctx, args.startClaim, streamId);
            }

            return streamId;
        });
    },
};

const fakeContext = (): any => {
    const call = async (reference: { __lunoraRef: string }, args: unknown) => await (HANDLERS[reference.__lunoraRef]?.(args) ?? null);

    return { auth: { getIdentity: async () => null }, runMutation: call, runQuery: call };
};

const send = async (body: Record<string, unknown>): Promise<{ json: any; status: number }> => {
    const response = await runChatStart(fakeContext(), { model: MODEL, prompt: "hello", ...body } as never, "secret");

    return { json: await response.json(), status: response.status };
};

const countRows = async (table: "messages" | "threads") => await run(async (ctx) => (await ctx.db.query(table).collect()).length);

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12));
    state.charges = 0;
    state.enqueueFails = false;
    state.legacySaves = 0;
    state.scheduled.length = 0;
    state.streamFails = false;
    vi.mocked(enqueueJob).mockClear();
    state.userId = OWNER;
    harness = lunoraTest(schema as never);
    threadId = await run(async (ctx) => await ctx.db.insert("threads", { model: MODEL, status: "active", title: "T", userId: OWNER }));
});

afterEach(() => {
    vi.useRealTimers();
    harness.close();
});

describe("/chat/start with clientMessageId", () => {
    it("saves a resend into an existing thread once and answers it with the first send's ids and a token for its stream", async () => {
        const first = await send({ clientMessageId: "send-1", threadId });
        const second = await send({ clientMessageId: "send-1", threadId });

        expect(first.status).toBe(200);
        expect(first.json).not.toHaveProperty("duplicate");
        expect(second.status).toBe(200);
        expect(second.json).toMatchObject({
            duplicate: true,
            messageId: first.json.messageId,
            streamId: first.json.streamId,
            streaming: true,
            streamToken: expect.any(String),
            threadId,
        });
        expect(await countRows("messages")).toBe(1);
        expect(state.charges).toBe(1);
    });

    it("creates one thread for a resend of a new chat's first message", async () => {
        const first = await send({ clientMessageId: "new-chat" });
        const second = await send({ clientMessageId: "new-chat" });

        expect(second.json).toMatchObject({ duplicate: true, messageId: first.json.messageId, threadId: first.json.threadId });
        expect(await countRows("threads")).toBe(2);
        expect(await countRows("messages")).toBe(1);
    });

    it("saves one message when the same send arrives twice at once, and answers the other from the first", async () => {
        const responses = await Promise.all([send({ clientMessageId: "twice", threadId }), send({ clientMessageId: "twice", threadId })]);
        // The other is told the send is under way, or, once the first finished, answered with its ids.
        const fresh = responses.filter((response) => response.status === 200 && response.json.duplicate !== true);
        const other = responses.find((response) => !fresh.includes(response));

        expect(fresh).toHaveLength(1);
        expect(other?.status === 409 ? other.json.error : other?.json.messageId).toBe(
            other?.status === 409 ? "CHAT_START_IN_PROGRESS" : fresh[0]?.json.messageId,
        );
        expect(await countRows("messages")).toBe(1);
        expect(state.charges).toBe(1);
    });

    it("keeps one user's id apart from another's", async () => {
        await send({ clientMessageId: "shared-id" });
        state.userId = "other-user";

        const other = await send({ clientMessageId: "shared-id" });

        expect(other.json).not.toHaveProperty("duplicate");
        expect(await countRows("messages")).toBe(2);
    });

    it("takes over a send that died before its save, and refuses the dead send's late save", async () => {
        const fingerprint = await chatStartFingerprint({ contentType: "text", prompt: "hello", threadId });
        const dead = await run(async (ctx) => await ctx.runMutation(claimChatStart, { clientMessageId: "dead", fingerprint, streams: true, userId: OWNER }));

        expect((await send({ clientMessageId: "dead", threadId })).status).toBe(409);

        vi.setSystemTime(Date.now() + CHAT_START_LEASE_MS);

        expect((await send({ clientMessageId: "dead", threadId })).json).not.toHaveProperty("duplicate");
        await expect(
            run(async (ctx) => await ctx.runMutation(saveStartPrompt, { claim: dead.claim, messageContent: [], model: MODEL, threadId })),
        ).rejects.toThrow();
        expect(await countRows("messages")).toBe(1);
    });

    it("makes the stream of a send that saved its prompt but died before its stream, without saving or charging again", async () => {
        state.streamFails = true;

        await expect(send({ clientMessageId: "half", threadId })).rejects.toThrow();
        expect((await send({ clientMessageId: "half", threadId })).status).toBe(409);

        vi.setSystemTime(Date.now() + CHAT_START_LEASE_MS);

        const resumed = await send({ clientMessageId: "half", threadId });
        const again = await send({ clientMessageId: "half", threadId });

        expect(resumed.status).toBe(200);
        expect(resumed.json.streamId).toEqual(expect.any(String));
        expect(again.json).toMatchObject({ duplicate: true, messageId: resumed.json.messageId, streamId: resumed.json.streamId });
        expect(await countRows("messages")).toBe(1);
        expect(state.charges).toBe(1);
    });

    it("refuses the same id on a different send, and never answers it with the first send's thread", async () => {
        const first = await send({ clientMessageId: "reused", threadId });

        // Another prompt, or the same one with no thread (which would mint a token for a thread this request never gated).
        for (const body of [{ prompt: "something else", threadId }, {}]) {
            const reused = await send({ clientMessageId: "reused", ...body });

            expect(reused.status).toBe(422);
            expect(reused.json).toStrictEqual({ error: "CLIENT_MESSAGE_ID_REUSED", message: expect.any(String) });
        }

        expect((await send({ clientMessageId: "reused", threadId })).json).toMatchObject({ duplicate: true, messageId: first.json.messageId });
        expect(await countRows("messages")).toBe(1);
    });

    it("queues the run again on a resend when the first send recorded its stream but its queue submission failed", async () => {
        state.enqueueFails = true;

        await expect(send({ clientMessageId: "unqueued", threadId })).rejects.toThrow("the queue refused the run");
        expect(enqueueJob).toHaveBeenCalledTimes(1);

        const resent = await send({ clientMessageId: "unqueued", threadId });

        expect(resent.json).toMatchObject({ duplicate: true, streamId: expect.any(String) });
        expect(enqueueJob).toHaveBeenCalledTimes(2);
        expect(vi.mocked(enqueueJob).mock.calls[1]?.[1]).toMatchObject({ messageId: resent.json.messageId, streamId: resent.json.streamId, threadId });
        expect(await countRows("messages")).toBe(1);
    });

    it("schedules a new chat's title when it resumes the send that died before its stream", async () => {
        state.streamFails = true;

        await expect(send({ clientMessageId: "untitled" })).rejects.toThrow();
        vi.setSystemTime(Date.now() + CHAT_START_LEASE_MS);

        expect((await send({ clientMessageId: "untitled" })).status).toBe(200);
        expect(state.scheduled).toContain("chat_functions:createTitleChat");
        expect(await countRows("threads")).toBe(2);
    });

    it("refuses a malformed id and an id on a regenerate", async () => {
        expect((await send({ clientMessageId: "has:colon", threadId })).status).toBe(400);
        expect((await send({ clientMessageId: "x".repeat(129), threadId })).status).toBe(400);
        expect((await send({ clientMessageId: "ok", parentId: "p", regenerate: true, threadId })).status).toBe(400);
        expect(await countRows("messages")).toBe(0);
    });

    it("saves every send without an id, as before", async () => {
        await send({ threadId });
        await send({ threadId });

        expect(state.legacySaves).toBe(2);
        expect(await countRows("messages")).toBe(2);
    });
});
