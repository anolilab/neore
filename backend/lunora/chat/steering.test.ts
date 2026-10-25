/**
 * Steering through the real procedures and schema: who may queue a message on
 * a run, what the run takes at a step boundary, and that a delivery and a
 * withdrawal of the same message can never both happen.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "chat_sharing", await import("./sharing"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
});

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
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

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

// eslint-disable-next-line import/first -- the mocks above must be hoisted before these load
import { addMessagesHandler } from "../agent/messages";
// eslint-disable-next-line import/first
import { _deletePageForThreadId } from "../agent/threads";
// eslint-disable-next-line import/first
import { hashPasscode, mintUnlockProof, newPasscodeEpoch } from "../lib/thread-lock";
// eslint-disable-next-line import/first
import schema from "../schema";
// eslint-disable-next-line import/first
import { MAX_QUEUED_STEERS, MAX_STEERS_PER_RUN } from "./lib/steer-queue";
// eslint-disable-next-line import/first
import { deliverSteers, steerRun, withdrawSteer } from "./steering";
// eslint-disable-next-line import/first
import { getActiveStreamForThread } from "./streaming";
// eslint-disable-next-line import/first
import { addChunk, finishStoppedReply, getChunksAfter, getStreamText, setStreamStatus, stopActiveForThread } from "./streaming/persistent/library";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-user";
const OTHER = "other-user";

let harness: Harness;
let threadId: string;
let streamId: string;
let pendingId: string;
let promptId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const steer = async (text: string, userId = OWNER, stream = streamId, steerId?: string): Promise<{ steerId: string }> =>
    (await as(userId).mutation(steerRun as never, { steerId, streamId: stream, text, threadId } as never)) as { steerId: string };

const withdraw = async (steerId: string, userId = OWNER, unlockProof?: string): Promise<{ outcome: string }> =>
    (await as(userId).mutation(withdrawSteer as never, { steerId, streamId, threadId, unlockProof } as never)) as { outcome: string };

const deliver = async (): Promise<{ messageId: string; text: string } | null> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(deliverSteers, { pendingMessageId: pendingId, streamId, threadId, userId: OWNER }));

const insertStream = async (fields: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId: "prompt",
                status: "streaming",
                streamingConfig: { contentType: "text", model: "test-model" },
                threadId,
                userId: OWNER,
                ...fields,
            }),
    );

const streamRow = async () => await harness.run(async (ctx: any) => await ctx.db.get(streamId));

const userRows = async (): Promise<{ order: number; text?: string }[]> => {
    const rows = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());

    return rows.filter((row: { message?: { role?: string } }) => row.message?.role === "user");
};

const steersOnStream = async (): Promise<{ id: string; status: string; text?: string }[]> => {
    const stream = await streamRow();

    return stream.steers;
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));

    // A running turn: the prompt, one step, and the pending row for the next.
    const prompt = await harness.run(
        async (ctx: any) =>
            await addMessagesHandler(ctx, { messages: [{ message: { content: "summarise my file", role: "user" } }], threadId, userId: OWNER } as never),
    );

    promptId = prompt.messages[0]!._id;

    const step = await harness.run(
        async (ctx: any) =>
            await addMessagesHandler(ctx, {
                messages: [
                    { message: { content: [{ text: "Reading it.", type: "text" }], role: "assistant" } },
                    { message: { content: [], role: "assistant" }, status: "pending" },
                ],
                promptMessageId: promptId,
                threadId,
                userId: OWNER,
            } as never),
    );

    pendingId = step.messages[1]!._id;
    streamId = await insertStream();
});

afterEach(() => {
    harness.close();
});

describe("steerRun", () => {
    it("queues the message on the caller's running stream", async () => {
        const { steerId } = await steer("  use the other file  ");

        expect(await steersOnStream()).toStrictEqual([{ id: steerId, status: "queued", text: "use the other file" }]);
    });

    it("queues a repeated steer id once, whether it is still queued or already taken", async () => {
        const { steerId } = await steer("use the other file", OWNER, streamId, "client-steer-1");

        expect(steerId).toBe("client-steer-1");
        expect(await steer("use the other file", OWNER, streamId, "client-steer-1")).toStrictEqual({ steerId });
        expect(await steersOnStream()).toStrictEqual([{ id: steerId, status: "queued", text: "use the other file" }]);

        const delivered = await deliver();

        expect(await steer("use the other file", OWNER, streamId, "client-steer-1")).toStrictEqual({ steerId });
        expect(await steersOnStream()).toStrictEqual([{ id: steerId, messageId: delivered!.messageId, pendingMessageId: pendingId, status: "delivered" }]);
    });

    it("refuses a run someone else asked for", async () => {
        streamId = await insertStream({ userId: OTHER });

        await expect(steer("hi")).rejects.toThrow("Reply not found");
    });

    it("refuses a finished run, a media run and an empty message", async () => {
        await expect(steer(" ".repeat(3))).rejects.toThrow("nothing to send");

        streamId = await insertStream({ status: "done" });
        await expect(steer("hi")).rejects.toThrow("no longer running");

        streamId = await insertStream({ streamingConfig: { contentType: "image", model: "test-model" } });
        await expect(steer("hi")).rejects.toThrow("no longer running");
    });

    it("refuses a group chat, whose runs take no steers", async () => {
        await harness.run(
            async (ctx: any) => await ctx.db.patch(threadId, { groupChat: { mode: "round-robin", participants: [{ addedAt: 0, skillId: "skill-1" }] } }),
        );

        await expect(steer("hi")).rejects.toThrow("group chat");
    });

    it(`holds at most ${String(MAX_QUEUED_STEERS)} waiting messages`, async () => {
        for (let index = 0; index < MAX_QUEUED_STEERS; index += 1) {
            await steer(`message ${String(index)}`);
        }

        await expect(steer("one too many")).rejects.toThrow("Wait for the reply");
    });
});

describe("deliverSteers and withdrawSteer", () => {
    it("delivers every queued message as one user row, and reports them delivered", async () => {
        const first = await steer("use the other file");
        const second = await steer("and keep it short");
        const delivered = await deliver();

        expect(delivered?.text).toBe("use the other file\n\nand keep it short");
        const rows = await userRows();

        expect(rows.map((row) => row.text)).toStrictEqual(["summarise my file", "use the other file\n\nand keep it short"]);
        expect(await steersOnStream()).toStrictEqual([
            { id: first.steerId, messageId: delivered!.messageId, pendingMessageId: pendingId, status: "delivered" },
            { id: second.steerId, messageId: delivered!.messageId, pendingMessageId: pendingId, status: "delivered" },
        ]);
        expect(await withdraw(first.steerId)).toStrictEqual({ outcome: "delivered" });

        const active = await as(OWNER).query(getActiveStreamForThread as never, { threadId } as never);

        expect(active).toStrictEqual({ deliveredSteerIds: [first.steerId, second.steerId], streamId });
    });

    it("never delivers a withdrawn message", async () => {
        const { steerId } = await steer("use the other file");

        expect(await withdraw(steerId)).toStrictEqual({ outcome: "withdrawn" });
        expect(await deliver()).toBeNull();
        expect(await userRows()).toHaveLength(1);
        expect(await withdraw(steerId)).toStrictEqual({ outcome: "unknown" });
    });

    it("closes an id withdrawn before the run held it, so a steerRun still on its way queues nothing", async () => {
        expect(await withdraw("late-steer")).toStrictEqual({ outcome: "unknown" });
        expect(await steersOnStream()).toStrictEqual([{ id: "late-steer", status: "withdrawn" }]);

        // The call the withdrawal overtook now lands: answered, not queued.
        expect(await steer("use the other file", OWNER, streamId, "late-steer")).toStrictEqual({ steerId: "late-steer" });
        expect(await deliver()).toBeNull();
        expect(await userRows()).toHaveLength(1);

        // A second withdrawal does not reopen it.
        expect(await withdraw("late-steer")).toStrictEqual({ outcome: "unknown" });
        expect(await steersOnStream()).toStrictEqual([{ id: "late-steer", status: "withdrawn" }]);
    });

    it("leaves no marker on a settled run, for someone else's run, or past the run's cap", async () => {
        expect(await withdraw("not-mine", OTHER)).toStrictEqual({ outcome: "unknown" });
        expect(await steersOnStream()).toBeUndefined();

        for (let index = 0; index < MAX_STEERS_PER_RUN; index += 1) {
            await withdraw(`closed-${String(index)}`);
        }

        await withdraw("one-too-many");
        expect(await steersOnStream()).toHaveLength(MAX_STEERS_PER_RUN);

        const ended = await insertStream({ status: "done" });

        await as(OWNER).mutation(withdrawSteer as never, { steerId: "after-end", streamId: ended, threadId } as never);
        const endedRow = await harness.run(async (ctx: any) => await ctx.db.get(ended));

        expect(endedRow.steers).toBeUndefined();
    });

    it("delivers nothing when nothing is queued, and leaves the queue for a settled run", async () => {
        expect(await deliver()).toBeNull();

        await steer("use the other file");
        await harness.run(async (ctx: any) => await ctx.db.patch(streamId, { status: "done" }));

        expect(await deliver()).toBeNull();
        expect(await steersOnStream()).toMatchObject([{ status: "queued" }]);
    });

    it("keeps a steer queued when the chat was locked after the run started", async () => {
        await steer("use the other file");
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { lockedAt: Date.now() + 1 }));

        expect(await deliver()).toBeNull();
        expect(await userRows()).toHaveLength(1);
        expect(await steersOnStream()).toMatchObject([{ status: "queued" }]);
    });

    it("tells another user nothing about the run", async () => {
        const { steerId } = await steer("use the other file");

        expect(await withdraw(steerId, OTHER)).toStrictEqual({ outcome: "unknown" });
        expect(await steersOnStream()).toMatchObject([{ status: "queued" }]);
    });

    it("leaves a locked chat's queue alone without its proof, and withdraws with it", async () => {
        const secret = "p".repeat(40);
        const epoch = newPasscodeEpoch();
        const hashed = await hashPasscode("passcode-1", 1000);

        process.env.STORAGE_SIGNING_SECRET = secret;
        const { steerId } = await steer("use the other file");

        await harness.run(async (ctx: any) => {
            await ctx.db.patch(threadId, { lockedAt: Date.now() });
            await ctx.db.insert("threadPasscodes", {
                createdAt: 1,
                epoch,
                failedAttempts: 0,
                hash: hashed.hash,
                iterations: hashed.iterations,
                salt: hashed.salt,
                threadId,
                updatedAt: 1,
                userId: OWNER,
            });
        });

        await expect(withdraw(steerId)).rejects.toThrow("This chat is locked.");
        expect(await steersOnStream()).toMatchObject([{ id: steerId, status: "queued" }]);

        const { proof } = await mintUnlockProof({ epoch, threadId, userId: OWNER }, secret, Date.now());

        expect(await withdraw(steerId, OWNER, proof)).toStrictEqual({ outcome: "withdrawn" });
        expect(await steersOnStream()).toStrictEqual([]);
    });
});

describe("a deleted thread", () => {
    it("keeps no steered text, queued or not yet taken", async () => {
        await steer("use the other file");
        await steer("and keep it short");
        await deliver();
        await steer("one more");

        await harness.run(async (ctx: any) => await ctx.runMutation(_deletePageForThreadId, { threadId }));

        expect(await harness.run(async (ctx: any) => await ctx.db.get(threadId))).toBeNull();

        const remaining = await steersOnStream();

        expect(remaining.map((entry) => entry.status)).toStrictEqual(["delivered", "delivered"]);
        expect(remaining.every((entry) => entry.text === undefined)).toBe(true);
    });
});

describe("the stream after a steered message", () => {
    it("shows only the text after the restart marker, and relays the marker", async () => {
        for (const chunk of [{ text: "Reading the file." }, { restart: true, text: "" }, { text: "The other one." }]) {
            await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: false, streamId, ...chunk }));
        }

        const body = await harness.run(async (ctx: any) => await ctx.runQuery(getStreamText, { streamId }));
        const relayed = await harness.run(async (ctx: any) => await ctx.runQuery(getChunksAfter, { afterIndex: 0, streamId }));

        expect(body).toMatchObject({ text: "The other one." });
        expect(body.speaker).toBeUndefined();
        expect(relayed.chunks).toStrictEqual([{ text: "Reading the file." }, { restart: true, text: "" }, { text: "The other one." }]);
    });
});

describe("a run that ends with a steer untaken", () => {
    const textsOnStream = async () => {
        const entries = await steersOnStream();

        return entries.map((entry) => entry.text);
    };

    it("keeps the entry but not the text, whichever way the run ends", async () => {
        const ways: Record<string, () => Promise<unknown>> = {
            "an error": async () => await harness.run(async (ctx: any) => await ctx.runMutation(setStreamStatus, { status: "error", streamId })),
            "a stop": async () => await harness.run(async (ctx: any) => await ctx.runMutation(stopActiveForThread, { threadId })),
            "the final chunk": async () => await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: true, streamId, text: "Done." })),
        };

        for (const end of Object.values(ways)) {
            const { steerId } = await steer("remember I am vegetarian");

            await end();
            expect(await steersOnStream()).toStrictEqual([{ id: steerId, status: "queued" }]);
            expect(await textsOnStream()).toStrictEqual([undefined]);

            // The client still reconciles it by id, and sends its own copy of the text.
            expect(await withdraw(steerId)).toStrictEqual({ outcome: "withdrawn" });

            streamId = await insertStream();
        }
    });

    it("leaves a run that is still going alone", async () => {
        await steer("use the other file");
        await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: false, streamId, text: "Reading." }));

        expect(await textsOnStream()).toStrictEqual(["use the other file"]);
    });
});

describe("a steer delivered before its step started", () => {
    it("leaves no pre-steer text as the stream's body until the marker is written", async () => {
        await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: false, streamId, text: "Reading the file." }));
        await steer("use the other file");
        await deliver();

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(getStreamText, { streamId }))).toMatchObject({ text: "" });

        await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: false, restart: true, streamId, text: "" }));
        await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: false, streamId, text: "The other one." }));

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(getStreamText, { streamId }))).toMatchObject({ text: "The other one." });
    });
});

describe("a stop after a steered message", () => {
    // What `endStoppedRun` passes: the run's FIRST order and prompt, from the agent's result metadata.
    const stop = async (pendingText: string) => {
        await harness.run(async (ctx: any) => await ctx.db.patch(streamId, { status: "done" }));

        return await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(finishStoppedReply, {
                    continuation: false,
                    order: 0,
                    pendingReasoning: "",
                    pendingText,
                    promptMessageId: promptId,
                    streamId,
                }),
        );
    };

    const rowById = async (id: string) => await harness.run(async (ctx: any) => await ctx.db.get(id));

    it("saves the owed text below the steered message, into the moved pending row", async () => {
        await steer("use the other file");

        const delivered = await deliver();
        const steerRow = await rowById(delivered!.messageId);
        const result = await stop("Reading the other");

        expect(result.messageId).toBe(pendingId);
        expect(await rowById(pendingId)).toMatchObject({
            order: steerRow.order,
            status: "success",
            stepOrder: steerRow.stepOrder + 1,
            text: "Reading the other",
        });
    });

    it("still finds the moved pending row when the steered message was deleted since", async () => {
        await steer("use the other file");

        const delivered = await deliver();
        const steerRow = await rowById(delivered!.messageId);

        await harness.run(async (ctx: any) => await ctx.db.delete(delivered!.messageId));

        const result = await stop("Reading the other");

        expect(result.messageId).toBe(pendingId);
        expect(await rowById(pendingId)).toMatchObject({ order: steerRow.order, status: "success", text: "Reading the other" });
    });

    it("removes the moved pending row when its steered message was deleted and nothing is owed", async () => {
        await steer("use the other file");

        const delivered = await deliver();

        await harness.run(async (ctx: any) => await ctx.db.delete(delivered!.messageId));
        await stop("");

        expect(await rowById(pendingId)).toBeNull();
    });

    it("leaves another run's pending row alone when the steered message was deleted", async () => {
        await steer("use the other file");

        const delivered = await deliver();
        const { _creationTime, _id, ...pendingRow } = await rowById(pendingId);
        const otherId = await harness.run(async (ctx: any) => await ctx.db.insert("messages", { ...pendingRow, order: pendingRow.order + 5 }));

        await harness.run(async (ctx: any) => await ctx.db.delete(delivered!.messageId));
        await stop("");

        expect(await rowById(pendingId)).toBeNull();
        expect(await rowById(otherId)).toMatchObject({ status: "pending" });
    });

    it("removes the moved pending row when nothing is owed, leaving the reply before the steer alone", async () => {
        await steer("use the other file");
        await deliver();

        const before = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());

        await stop("");

        const after = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());

        expect(after.map((row: { _id: string }) => row._id)).toStrictEqual(
            before.map((row: { _id: string }) => row._id).filter((id: string) => id !== pendingId),
        );
    });
});
