/* eslint-disable unicorn/no-await-expression-member */
/**
 * `/chat/start` with `clientMessageId`: a resend saves nothing twice and creates no second thread; it is answered with
 * the first send's ids. The claim, the thread creation, the save, the goal, the stream and the rows are real, and each
 * runs with no nested mutation (one would commit on its own); the runtime around the handler is faked as in
 * `http.guest-note.test.ts`.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { createThreadWithInitialMessage, gateThreadActionHandler } from "./functions";
import { startGoal } from "./goals/internal";
import { runChatStart } from "./http";
import { enqueueJob } from "../lib/job-queue";
import {
    CHAT_START_CLAIM_TTL_MS,
    CHAT_START_LEASE_MS,
    CHAT_START_SCOPE,
    chatStartFingerprint,
    claimChatStart,
    recordStartTitlesScheduled,
    releaseChatStart,
    saveStartPrompt,
} from "./start-claim";
import { createStreamWithMessage } from "./streaming";

const state = vi.hoisted(() => {
    return {
        /** What the thread's agent switch resolves the run's model to (`getRunAgentModel`), when the thread was switched. */
        agentModel: null as string | null,
        charges: 0,
        /** The next queue submission fails, once. */
        enqueueFails: false,
        /** What `startGoal` reads of the account: an anonymous one is refused a goal. */
        goalAccountAnonymous: false,
        /** The next goal start fails, once: the send dies between its save and its goal. */
        goalFails: false,
        /** The ids of every prompt the no-id path saved from the HTTP action. */
        legacySaves: 0,
        /** The references the HTTP scheduler was handed. */
        scheduled: [] as string[],
        /** What each scheduled job was handed, in the same order. */
        scheduledArgs: [] as Record<string, unknown>[],
        /** The next submission of this reference to the HTTP scheduler fails, once. */
        scheduleFails: undefined as string | undefined,
        /** How long the stream creation takes: the clock moves on by this before it runs. */
        streamDelayMs: 0,
        /** The next stream creation fails, once. */
        streamFails: false,
        userId: "owner-user",
    };
});

// `user` is a `.global()` (D1) table the in-memory harness cannot write: a goal's account is looked up here.
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            return { _id: userId, isAnonymous: state.goalAccountAnonymous };
        },
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
                runAfter: async (_delay: number, reference: { __lunoraRef: string }, args: Record<string, unknown>) => {
                    if (state.scheduleFails === reference.__lunoraRef) {
                        state.scheduleFails = undefined;

                        throw new Error("the scheduler refused the job");
                    }

                    state.scheduled.push(reference.__lunoraRef);
                    state.scheduledArgs.push(args);
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
vi.mock("./lib/get-agent", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/get-agent")>()),
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
    "agent_agent_switch:getRunAgentModel": async () => state.agentModel,
    "agent_threads:getThreadInternal": async (args) => await run(async (ctx) => await ctx.db.get("threads", args.threadId)),
    "chat_functions:createThreadWithInitialMessage": async (args) =>
        await run(async (ctx) => await (createThreadWithInitialMessage as any).handler(withoutNestedMutations(ctx), args)),
    "chat_functions:gateThreadAction": async (args) => await run(async (ctx) => await gateThreadActionHandler(ctx, args)),
    "chat_goals_internal:startGoal": async (args) => {
        if (state.goalFails) {
            state.goalFails = false;

            throw new Error("the goal could not be started");
        }

        return await run(async (ctx) => await (startGoal as any).handler(withoutNestedMutations(ctx), args));
    },
    "chat_start_claim:claimChatStart": async (args) => await run(async (ctx) => await ctx.runMutation(claimChatStart, args)),
    "chat_start_claim:recordStartTitlesScheduled": async (args) => await run(async (ctx) => await ctx.runMutation(recordStartTitlesScheduled, args)),
    "chat_start_claim:releaseChatStart": async (args) => await run(async (ctx) => await ctx.runMutation(releaseChatStart, args)),
    "chat_start_claim:saveStartPrompt": async (args) => await run(async (ctx) => await (saveStartPrompt as any).handler(withoutNestedMutations(ctx), args)),
    "chat_streaming:createStreamWithMessage": async (args) => {
        vi.setSystemTime(Date.now() + state.streamDelayMs);

        if (state.streamFails) {
            state.streamFails = false;

            throw new Error("the stream could not be made");
        }

        return await run(async (ctx) => await (createStreamWithMessage as any).handler(withoutNestedMutations(ctx), args));
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

const countRows = async (table: "messages" | "persistentStreams" | "threadGoals" | "threads") =>
    await run(async (ctx) => (await ctx.db.query(table).collect()).length);

/** What the send's claim recorded. */
const startRecord = async (clientMessageId: string): Promise<{ goalId?: string; messageId?: string; streamId?: string; threadId?: string }> =>
    await run(async (ctx) => {
        const rows = await ctx.db.query("idempotencyClaims").collect();
        const row = rows.find(
            (claim: { key: string; scope: string }) => claim.scope === CHAT_START_SCOPE && claim.key === `${state.userId}:${clientMessageId}`,
        );

        return JSON.parse(row.result);
    });

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12));
    state.agentModel = null;
    state.charges = 0;
    state.enqueueFails = false;
    state.goalAccountAnonymous = false;
    state.goalFails = false;
    state.legacySaves = 0;
    state.scheduled.length = 0;
    state.scheduledArgs.length = 0;
    state.scheduleFails = undefined;
    state.streamDelayMs = 0;
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

        // The stream row and the claim's record of it are the same stream, written by the real `createStreamWithMessage`.
        const stream = await run(async (ctx) => await ctx.db.get("persistentStreams", first.json.streamId));

        expect(stream).toMatchObject({ messageId: first.json.messageId, status: "pending", threadId });
        expect(await startRecord("send-1")).toMatchObject({ messageId: first.json.messageId, streamId: first.json.streamId, threadId });
        expect(await countRows("persistentStreams")).toBe(1);
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
        const fingerprint = await chatStartFingerprint({ contentType: "text", prompt: "hello", settings: { model: MODEL }, threadId });
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
        expect(await startRecord("half")).toMatchObject({ streamId: resumed.json.streamId });
        expect(await countRows("persistentStreams")).toBe(1);
    });

    it("runs the goal a resumed send's first try started, and starts no second one", async () => {
        state.streamFails = true;

        const goal = { goal: { text: "Ship the report" }, prompt: "Make the report" };

        await expect(send({ clientMessageId: "goal", threadId, ...goal })).rejects.toThrow("the stream could not be made");

        const [firstGoal] = await run(async (ctx) => await ctx.db.query("threadGoals").collect());

        expect(firstGoal).toMatchObject({ status: "active" });

        vi.setSystemTime(Date.now() + CHAT_START_LEASE_MS);

        const resumed = await send({ clientMessageId: "goal", threadId, ...goal });

        expect(resumed.status).toBe(200);
        expect(await countRows("threadGoals")).toBe(1);
        expect(await run(async (ctx) => await ctx.db.get("threadGoals", firstGoal._id))).toMatchObject({ status: "active" });
        expect(await startRecord("goal")).toMatchObject({ goalId: firstGoal._id, streamId: resumed.json.streamId });
    });

    it("leaves a goal a later message started running when it resumes an older send, and still ends one started before it", async () => {
        const goal = async (clientMessageId: string): Promise<string> => {
            expect((await send({ clientMessageId, goal: { text: "Ship the report" }, prompt: `Goal ${clientMessageId}`, threadId })).status).toBe(200);

            const goals = await run(async (ctx) => await ctx.db.query("threadGoals").collect());

            return goals.at(-1)._id;
        };

        const olderGoal = await goal("older-goal");

        vi.setSystemTime(Date.now() + 1000);
        state.streamFails = true;
        await expect(send({ clientMessageId: "older", threadId })).rejects.toThrow("the stream could not be made");
        vi.setSystemTime(Date.now() + 1000);

        // A goal another message started while the older send lay dead: it ends the goal before it, and runs.
        const newerGoal = await goal("newer-goal");

        expect(await run(async (ctx) => await ctx.db.get("threadGoals", olderGoal))).toMatchObject({ status: "stopped", stopReason: "superseded" });

        // The older send's goal-less stream would have ended a goal before its prompt, never a later one: the earlier goal is active again to check both.
        await run(async (ctx) => await ctx.db.patch("threadGoals", olderGoal, { status: "active" }));
        vi.setSystemTime(Date.now() + CHAT_START_LEASE_MS);

        expect((await send({ clientMessageId: "older", threadId })).status).toBe(200);
        expect(await run(async (ctx) => await ctx.db.get("threadGoals", newerGoal))).toMatchObject({ status: "active" });
        expect(await run(async (ctx) => await ctx.db.get("threadGoals", olderGoal))).toMatchObject({ status: "stopped", stopReason: "superseded" });
    });

    it("ends the goal of a prompt saved in the same millisecond as a newer send's", async () => {
        expect((await send({ clientMessageId: "tie-goal", goal: { text: "Ship the report" }, prompt: "Make the report", threadId })).status).toBe(200);

        const [goal] = await run(async (ctx) => await ctx.db.query("threadGoals").collect());

        // No clock moved: the goal and the next prompt carry the same millisecond.
        expect((await send({ clientMessageId: "tie-next", threadId })).status).toBe(200);
        expect(await run(async (ctx) => await ctx.db.get("threadGoals", goal._id))).toMatchObject({ status: "stopped", stopReason: "superseded" });
    });

    it("ends an older prompt's goal that started after a newer send saved its prompt", async () => {
        const olderGoal = { goal: { text: "Ship the report" }, prompt: "Make the report" };

        state.goalFails = true;
        await expect(send({ clientMessageId: "older-goal", threadId, ...olderGoal })).rejects.toThrow("the goal could not be started");
        vi.setSystemTime(Date.now() + 1000);
        state.streamFails = true;
        await expect(send({ clientMessageId: "newer", threadId })).rejects.toThrow("the stream could not be made");
        vi.setSystemTime(Date.now() + CHAT_START_LEASE_MS);

        // The older send's goal starts now, after the newer prompt was saved, and runs until the newer send's stream.
        expect((await send({ clientMessageId: "older-goal", threadId, ...olderGoal })).status).toBe(200);

        const { goalId } = await startRecord("older-goal");

        expect(await run(async (ctx) => await ctx.db.get("threadGoals", goalId))).toMatchObject({ status: "active" });
        expect((await send({ clientMessageId: "newer", threadId })).status).toBe(200);
        expect(await run(async (ctx) => await ctx.db.get("threadGoals", goalId))).toMatchObject({ status: "stopped", stopReason: "superseded" });
    });

    it("leaves a later prompt's goal running when it resumes an older goal send, and starts no second active goal", async () => {
        state.goalFails = true;
        await expect(send({ clientMessageId: "older-goal", goal: { text: "Ship the report" }, prompt: "Make the report", threadId })).rejects.toThrow(
            "the goal could not be started",
        );
        vi.setSystemTime(Date.now() + 1000);
        expect((await send({ clientMessageId: "newer-goal", goal: { text: "Ship the slides" }, prompt: "Make the slides", threadId })).status).toBe(200);

        const [newerGoal] = await run(async (ctx) => await ctx.db.query("threadGoals").collect());

        vi.setSystemTime(Date.now() + CHAT_START_LEASE_MS);

        const resumed = await send({ clientMessageId: "older-goal", goal: { text: "Ship the report" }, prompt: "Make the report", threadId });

        // The older prompt is answered as an ordinary turn: its goal is not started beside the later one.
        expect(resumed.status).toBe(200);
        expect(await run(async (ctx) => await ctx.db.get("threadGoals", newerGoal._id))).toMatchObject({ status: "active" });
        expect(await countRows("threadGoals")).toBe(1);
        expect(await startRecord("older-goal")).toMatchObject({ streamId: resumed.json.streamId });
        expect((await startRecord("older-goal")).goalId).toBeUndefined();
    });

    it("renews the claim's expiry when it resumes a send late in its day, so the stream it makes still finds the claim", async () => {
        state.streamFails = true;

        await expect(send({ clientMessageId: "late", threadId })).rejects.toThrow("the stream could not be made");

        // Resumed a second before the claim expires; making the stream takes two.
        vi.setSystemTime(Date.now() + CHAT_START_CLAIM_TTL_MS - 1000);
        state.streamDelayMs = 2000;

        const resumed = await send({ clientMessageId: "late", threadId });

        expect(resumed.status).toBe(200);
        expect(await startRecord("late")).toMatchObject({ messageId: resumed.json.messageId, streamId: resumed.json.streamId });
        expect(await countRows("messages")).toBe(1);
    });

    it("runs a resumed send on the model its first try saved its prompt with, though the thread's agent changed since", async () => {
        const OTHER_MODEL = "anthropic/claude-haiku-4.5";

        state.streamFails = true;
        await expect(send({ clientMessageId: "switched", threadId })).rejects.toThrow("the stream could not be made");

        // The thread was switched to another agent while the send lay dead.
        await run(async (ctx) => await ctx.db.patch("threads", threadId, { activeAgent: { kind: "model", model: OTHER_MODEL } }));
        state.agentModel = OTHER_MODEL;
        vi.setSystemTime(Date.now() + CHAT_START_LEASE_MS);

        const resumed = await send({ clientMessageId: "switched", threadId });

        expect(resumed.status).toBe(200);
        expect(await run(async (ctx) => await ctx.db.get("persistentStreams", resumed.json.streamId))).toMatchObject({ streamingConfig: { model: MODEL } });
        expect(vi.mocked(enqueueJob).mock.calls.at(-1)?.[1]).toMatchObject({ streamId: resumed.json.streamId, streamingConfig: { model: MODEL } });
    });

    it("answers every resend of a send whose goal was refused after its save with that refusal, and never runs it", async () => {
        const goalSend = { clientMessageId: "refused-goal", goal: { text: "Ship the report" }, prompt: "Make the report", threadId };

        state.goalAccountAnonymous = true;

        const refused = await send(goalSend);

        expect(refused.status).toBe(400);

        // At once, and after the lease once the account may run goals: the same refusal, no stream and no second charge.
        expect(await send(goalSend)).toStrictEqual(refused);
        state.goalAccountAnonymous = false;
        vi.setSystemTime(Date.now() + CHAT_START_LEASE_MS);
        expect(await send(goalSend)).toStrictEqual(refused);
        expect(await countRows("persistentStreams")).toBe(0);
        expect(await countRows("threadGoals")).toBe(0);
        expect(await countRows("messages")).toBe(1);
        expect(state.charges).toBe(1);
    });

    it("refuses the same id on a different send, and never answers it with the first send's thread", async () => {
        const first = await send({ clientMessageId: "reused", threadId });

        // Another prompt, the same one with no thread (which would mint a token for a thread this request never gated), or
        // the same prompt with another page attached or another setting, which the first send's run would not have used.
        for (const body of [
            { prompt: "something else", threadId },
            {},
            { pageContext: { text: "Another page", title: "Page", url: "https://example.com/" }, threadId },
            { searchMode: "research", threadId },
        ]) {
            const reused = await send({ clientMessageId: "reused", ...body });

            expect(reused.status).toBe(422);
            expect(reused.json).toStrictEqual({ error: "CLIENT_MESSAGE_ID_REUSED", message: expect.any(String) });
        }

        expect((await send({ clientMessageId: "reused", threadId })).json).toMatchObject({ duplicate: true, messageId: first.json.messageId });
        expect(await countRows("messages")).toBe(1);

        // A goal's round cap, with the same goal text.
        expect((await send({ clientMessageId: "goal-cap", goal: { maxRounds: 5, text: "Ship it" }, threadId })).status).toBe(200);
        expect((await send({ clientMessageId: "goal-cap", goal: { maxRounds: 3, text: "Ship it" }, threadId })).status).toBe(422);
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

    it("schedules a new chat's title and category once when a resend recovers a run whose queue submission failed", async () => {
        state.enqueueFails = true;

        await expect(send({ clientMessageId: "unqueued-chat" })).rejects.toThrow("the queue refused the run");
        expect(state.scheduled).toStrictEqual([]);

        const recovered = await send({ clientMessageId: "unqueued-chat" });

        expect(recovered.json).toMatchObject({ duplicate: true, streamId: expect.any(String) });
        expect(state.scheduled.toSorted((left, right) => left.localeCompare(right, "en"))).toStrictEqual([
            "chat_functions:createCategoryChat",
            "chat_functions:createTitleChat",
        ]);

        // The run still waits for the queue: another resend queues it again, but schedules no second paid title or category.
        expect((await send({ clientMessageId: "unqueued-chat" })).json).toMatchObject({ duplicate: true });
        expect(enqueueJob).toHaveBeenCalledTimes(3);
        expect(state.scheduled).toHaveLength(2);
    });

    it("hands the title jobs to the next resend when the recovering one could not schedule them all", async () => {
        state.enqueueFails = true;

        await expect(send({ clientMessageId: "unscheduled-chat" })).rejects.toThrow("the queue refused the run");

        // The recovering resend queues the run, but the scheduler refuses the category job.
        state.scheduleFails = "chat_functions:createCategoryChat";
        expect((await send({ clientMessageId: "unscheduled-chat" })).json).toMatchObject({ duplicate: true });
        expect(state.scheduled).toStrictEqual(["chat_functions:createTitleChat"]);

        // The next resend schedules the category only, keyed by the prompt; the one after schedules nothing.
        const resent = await send({ clientMessageId: "unscheduled-chat" });

        expect(state.scheduled).toStrictEqual(["chat_functions:createTitleChat", "chat_functions:createCategoryChat"]);
        expect(state.scheduledArgs[1]).toMatchObject({ promptId: resent.json.messageId });

        await send({ clientMessageId: "unscheduled-chat" });
        expect(state.scheduled).toHaveLength(2);
    });

    it("schedules only the title job on the next resend when the first try scheduled its category but not its title", async () => {
        state.scheduleFails = "chat_functions:createTitleChat";

        const first = await send({ clientMessageId: "untitled-only" });

        expect(state.scheduled).toStrictEqual(["chat_functions:createCategoryChat"]);

        // The category was scheduled and recorded: the resend submits the title alone, under the prompt's billing key.
        expect((await send({ clientMessageId: "untitled-only" })).json).toMatchObject({ duplicate: true });
        expect(state.scheduled).toStrictEqual(["chat_functions:createCategoryChat", "chat_functions:createTitleChat"]);
        expect(state.scheduledArgs[1]).toMatchObject({ jobId: first.json.messageId });

        await send({ clientMessageId: "untitled-only" });
        expect(state.scheduled).toHaveLength(2);
    });

    it("keys every category job two concurrent resends schedule by the one saved prompt", async () => {
        state.enqueueFails = true;

        await expect(send({ clientMessageId: "concurrent-resends" })).rejects.toThrow("the queue refused the run");

        // Both arrive before either records its jobs: each may schedule the category, and `createCategoryChat` admits one model call per prompt.
        const resends = await Promise.all([send({ clientMessageId: "concurrent-resends" }), send({ clientMessageId: "concurrent-resends" })]);
        const categoryJobs = state.scheduledArgs.filter((_args, index) => state.scheduled[index] === "chat_functions:createCategoryChat");

        expect(resends.map((resent) => resent.json.duplicate)).toStrictEqual([true, true]);
        expect(categoryJobs.length).toBeGreaterThan(0);
        expect(new Set(categoryJobs.map((job) => job.promptId))).toStrictEqual(new Set([resends[0].json.messageId]));
    });

    it("schedules no title jobs on a resend of a send whose first try scheduled them, though its run still waits", async () => {
        const first = await send({ clientMessageId: "titled" });

        expect(state.scheduled.toSorted((left, right) => left.localeCompare(right, "en"))).toStrictEqual([
            "chat_functions:createCategoryChat",
            "chat_functions:createTitleChat",
        ]);
        expect(state.scheduledArgs.find((_args, index) => state.scheduled[index] === "chat_functions:createTitleChat")).toMatchObject({
            jobId: first.json.messageId,
        });
        // The category job is keyed by the prompt too, so a second delivery of it never calls the model (`createCategoryChat`).
        expect(state.scheduledArgs.find((_args, index) => state.scheduled[index] === "chat_functions:createCategoryChat")).toMatchObject({
            promptId: first.json.messageId,
        });

        // No worker took the run yet: the resend queues it again, and schedules no second title or category.
        expect((await send({ clientMessageId: "titled" })).json).toMatchObject({ duplicate: true });
        expect(enqueueJob).toHaveBeenCalledTimes(2);
        expect(state.scheduled).toHaveLength(2);
    });

    it("hands a resend the title jobs a recovery could not schedule, though a worker took the run since", async () => {
        state.enqueueFails = true;

        await expect(send({ clientMessageId: "claimed-run" })).rejects.toThrow("the queue refused the run");

        // The recovering resend queues the run, but the scheduler refuses the category job.
        state.scheduleFails = "chat_functions:createCategoryChat";

        const recovered = await send({ clientMessageId: "claimed-run" });

        expect(state.scheduled).toStrictEqual(["chat_functions:createTitleChat"]);

        // A worker claims the stream before the next resend.
        await run(async (ctx) => await ctx.db.patch("persistentStreams", recovered.json.streamId, { runClaimedAt: Date.now(), status: "streaming" }));

        expect((await send({ clientMessageId: "claimed-run" })).json).toMatchObject({ duplicate: true });
        // The run is not queued a third time; the missing category job is scheduled, keyed by the prompt.
        expect(enqueueJob).toHaveBeenCalledTimes(2);
        expect(state.scheduled).toStrictEqual(["chat_functions:createTitleChat", "chat_functions:createCategoryChat"]);
        expect(state.scheduledArgs[1]).toMatchObject({ promptId: recovered.json.messageId });

        await send({ clientMessageId: "claimed-run" });
        expect(state.scheduled).toHaveLength(2);
    });

    it("schedules a new chat's title when it resumes the send that died before its stream", async () => {
        state.streamFails = true;

        await expect(send({ clientMessageId: "untitled" })).rejects.toThrow();
        vi.setSystemTime(Date.now() + CHAT_START_LEASE_MS);

        expect((await send({ clientMessageId: "untitled" })).status).toBe(200);
        expect(state.scheduled).toContain("chat_functions:createTitleChat");
        expect(await countRows("threads")).toBe(2);
    });

    it("stamps a new chat's prompt with the agent that runs it: the model, a custom endpoint's id, or the fallback for a model outside the registry", async () => {
        for (const [model, agentName] of [
            [MODEL, MODEL],
            ["custom:my-endpoint/llama-3", "custom:my-endpoint/llama-3"],
            ["retired/model-that-is-gone", DEFAULT_CHAT_MODEL],
        ] as const) {
            for (const clientMessageId of [undefined, `agent-${String(agentName.length)}-${model.length}`]) {
                const sent = await send({ ...(clientMessageId !== undefined && { clientMessageId }), model });
                const prompt = await run(async (ctx) => await ctx.db.get("messages", sent.json.messageId));

                expect(prompt).toMatchObject({ agentName });
            }
        }
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

describe("chatStartFingerprint", () => {
    it("digests the same settings alike whatever order their keys were written in, and different values apart", async () => {
        const request = { contentType: "video" as const, prompt: "a shot", threadId: "thread-1" };
        const settings = { cinemaSettings: { camera: "dolly", lens: "35mm" }, model: "m" };
        // The same keys inserted in reverse, outside and inside `cinemaSettings` (a literal would be key-sorted by the formatter).
        const reversed = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).toReversed()) as T;
        const reorderedSettings = reversed({ ...settings, cinemaSettings: reversed(settings.cinemaSettings) });

        expect(Object.keys(reorderedSettings)).toStrictEqual(["model", "cinemaSettings"]);
        expect(Object.keys(reorderedSettings.cinemaSettings)).toStrictEqual(["lens", "camera"]);

        const written = await chatStartFingerprint({ ...request, settings });
        const reordered = await chatStartFingerprint({ ...request, settings: reorderedSettings });
        const changed = await chatStartFingerprint({ ...request, settings: { cinemaSettings: { camera: "dolly", lens: "50mm" }, model: "m" } });

        expect(reordered).toBe(written);
        expect(changed).not.toBe(written);
    });
});
