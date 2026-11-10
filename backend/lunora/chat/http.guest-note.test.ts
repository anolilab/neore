/* eslint-disable unicorn/no-await-expression-member */
/**
 * `/chat/start` with `guestMessageId`: the owner sends a held guest note on. The note's own stored text is saved, marked as
 * guest text, its send is taken once and the stored message is recorded on it. The thread, the note and the guest-link
 * internals are real; the runtime around the handler is faked as in `http.start-agent.test.ts`.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claimRow, GUEST_SEND_LEASE_MS, GUEST_SEND_SCOPE } from "../lib/claim-once";
import { enqueueJob } from "../lib/job-queue";
import schema from "../schema";
import { gateThreadActionHandler } from "./functions";
import { claimGuestNoteSend, getGuestNoteForSend, recordGuestNoteSent, releaseGuestNoteSend } from "./guest-links";
import { runChatStart } from "./http";
import { guestTextPart } from "./lib/attached-text";

const saved = vi.hoisted(() => {
    return {
        charges: 0,
        /** The step of the next send that fails, once. */
        fail: undefined as "agent" | "lost-reply" | "record" | "save" | undefined,
        prompts: [] as { message: { content: unknown[] } }[],
        /** The release of a failed send fails too. */
        releaseFails: false,
        scheduled: [] as string[],
        /** Writes the saved prompt as a real row, as the agent client does. */
        store: async (_message: unknown): Promise<string> => "saved-prompt",
    };
});

/** Whether the next send fails at `step`; a failure happens once. */
const failsAt = (step: typeof saved.fail): boolean => {
    const fails = saved.fail === step;

    if (fails) {
        saved.fail = undefined;
    }

    return fails;
};

vi.mock("../auth/lib/helper", () => {
    return {
        getCurrentUserInternal: async () => {
            return { _id: "owner-user", isAnonymous: false };
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
    return { enqueueJob: vi.fn(async () => {}) };
});
vi.mock("./lib/daily-limit", () => {
    return {
        chargeDailyLimit: async () => {
            saved.charges += 1;

            return { ok: true };
        },
    };
});
vi.mock("./lib/get-agent", () => {
    return {
        default: async () => {
            if (failsAt("agent")) {
                throw new Error("no agent");
            }

            return {
                saveMessage: async (_ctx: unknown, args: { message: { content: unknown[] } }) => {
                    if (failsAt("save")) {
                        throw new Error("the save failed");
                    }

                    saved.prompts.push(args);

                    const messageId = await saved.store(args.message);

                    // The save committed, but its reply never arrived.
                    if (failsAt("lost-reply")) {
                        throw new Error("the save's reply was lost");
                    }

                    return { messageId };
                },
            };
        },
    };
});
vi.mock("../lib/http-scheduler", () => {
    return {
        httpScheduler: () => {
            return {
                runAfter: async (_delay: number, reference: { __lunoraRef: string }) => {
                    saved.scheduled.push(reference.__lunoraRef);
                },
            };
        },
    };
});

const OWNER = "owner-user";
const TITLE_JOBS = /Title|Category/u;
/** A concurrent send finds the note claimed (being sent) or already sent: either way a guest-note 409, never a host-run one. */
const GUEST_SEND_REFUSALS = /^GUEST_NOTE_(ALREADY_SENT|BEING_SENT)$/u;
const MODEL = "openai/gpt-4.1-mini";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;
let noteId: string;

const run = async <T>(body: (ctx: any) => Promise<T>): Promise<T> => await harness.run(body);

/** The guest-link internals and the thread gate read and write the harness; everything else answers as nothing. */
const HANDLERS: Record<string, (args: any) => Promise<unknown>> = {
    "chat_functions:gateThreadAction": async (args) => await run(async (ctx) => await gateThreadActionHandler(ctx, args)),
    "chat_guest_links:claimGuestNoteSend": async (args) => await run(async (ctx) => await ctx.runMutation(claimGuestNoteSend, args)),
    "chat_guest_links:getGuestNoteForSend": async (args) => await run(async (ctx) => await ctx.runQuery(getGuestNoteForSend, args)),
    "chat_guest_links:recordGuestNoteSent": async (args) => {
        if (failsAt("record")) {
            throw new Error("the record failed");
        }

        return await run(async (ctx) => await ctx.runMutation(recordGuestNoteSent, args));
    },
    "chat_guest_links:releaseGuestNoteSend": async (args) => {
        if (saved.releaseFails) {
            throw new Error("the release failed");
        }

        return await run(async (ctx) => await ctx.runMutation(releaseGuestNoteSend, args));
    },
    "chat_streaming:createStreamWithMessage": async () => "stream-1",
};

/** `extra` answers more references, for a test that must reach a check the others never do. */
const fakeContext = (extra: typeof HANDLERS = {}): any => {
    const handlers = { ...HANDLERS, ...extra };
    const call = async (reference: { __lunoraRef: string }, args: unknown) => await (handlers[reference.__lunoraRef]?.(args) ?? null);

    return { auth: { getIdentity: async () => null }, runMutation: call, runQuery: call };
};

const sendNote = async (): Promise<Response> =>
    await runChatStart(fakeContext(), { guestMessageId: noteId, model: MODEL, prompt: "the composer's own text", threadId } as never, "secret");

const noteStatus = async () => (await run(async (ctx) => await ctx.db.get("threadGuestMessages", noteId)))?.status;

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12));
    saved.prompts.length = 0;
    saved.scheduled.length = 0;
    saved.charges = 0;
    saved.releaseFails = false;
    saved.store = async (message) =>
        await run(
            async (ctx) =>
                await ctx.db.insert("messages", { message, order: 5, status: "success", stepOrder: 0, text: "", threadId, tool: false, userId: OWNER }),
        );
    harness = lunoraTest(schema as never);
    threadId = await run(async (ctx) => await ctx.db.insert("threads", { model: MODEL, status: "active", title: "T", userId: OWNER }));
    noteId = await run(async (ctx) => {
        const linkId = await ctx.db.insert("threadGuestLinks", { createdAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, linkHash: "h", threadId, userId: OWNER });

        return await ctx.db.insert("threadGuestMessages", { createdAt: 0, linkId, status: "held", text: "please call me back", threadId, userId: OWNER });
    });
});

afterEach(() => {
    vi.useRealTimers();
    harness.close();
});

describe("/chat/start with a held guest note", () => {
    it("saves the note's own text marked as guest text, marks the note sent, and hands no text over for skill detection", async () => {
        expect((await sendNote()).status).toBe(200);

        expect(saved.prompts).toHaveLength(1);
        expect(saved.prompts[0]?.message.content).toStrictEqual([guestTextPart("please call me back", noteId)]);
        expect((await run(async (ctx) => await claimRow(ctx, GUEST_SEND_SCOPE, noteId)))?.result).toEqual(expect.any(String));
        expect(await noteStatus()).toBe("sent");
        expect(vi.mocked(enqueueJob).mock.calls.at(-1)?.[1]).not.toHaveProperty("userPrompt");
        // Nor to the title or category model.
        expect(saved.scheduled.filter((name) => TITLE_JOBS.test(name))).toStrictEqual([]);
    });

    it.each([
        ["twice at once", async () => await Promise.all([sendNote(), sendNote()])],
        [
            "again after its record failed and the lease lapsed",
            async () => {
                saved.fail = "record";

                const first = await sendNote();

                vi.setSystemTime(Date.now() + GUEST_SEND_LEASE_MS + 1);

                return [first, await sendNote()];
            },
        ],
    ])("stores one message, charges once and marks the note sent when it is sent %s", async (_label, sendTwice) => {
        const responses = (await sendTwice()).toSorted((x, y) => x.status - y.status);

        expect(responses.map((response) => response.status)).toStrictEqual([200, 409]);
        // Its own code: a 409 of another kind (a host-run thread's) must not read as one of these.
        expect(await responses[1]?.json()).toMatchObject({ error: expect.stringMatching(GUEST_SEND_REFUSALS) });
        expect(saved.prompts).toHaveLength(1);
        expect(saved.charges).toBe(1);
        expect(await noteStatus()).toBe("sent");
    });

    it("marks a note sent when its save committed but the reply was lost, so a retry is refused", async () => {
        saved.fail = "lost-reply";

        await expect(sendNote()).rejects.toThrow();
        expect(await noteStatus()).toBe("sent");

        const retry = await sendNote();

        expect(retry.status).toBe(409);
        expect(await retry.json()).toMatchObject({ error: "GUEST_NOTE_ALREADY_SENT" });
        expect(saved.prompts).toHaveLength(1);
    });

    it("refuses a note sent into another chat than the one it was left in", async () => {
        const otherThread = await run(async (ctx) => await ctx.db.insert("threads", { model: MODEL, status: "active", title: "U", userId: OWNER }));
        const response = await runChatStart(fakeContext(), { guestMessageId: noteId, model: MODEL, prompt: "x", threadId: otherThread } as never, "secret");

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "GUEST_NOTE_NOT_SENDABLE" });
        expect(saved.prompts).toHaveLength(0);
    });

    it("refuses a note sent to an image model with its own code, so the client keeps it to send once a text model is picked", async () => {
        const response = await runChatStart(
            fakeContext(),
            { guestMessageId: noteId, model: "google/gemini-2.5-flash-image", prompt: "x", threadId } as never,
            "secret",
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "GUEST_NOTE_NEEDS_TEXT_MODEL" });
        expect(saved.prompts).toHaveLength(0);
        expect(await noteStatus()).toBe("held");
    });

    it("refuses a note sent as a goal, whose rounds would carry the guest's words as the owner's", async () => {
        // The thread reads as the owner's, so the later goal-ownership check lets the goal through: only the note's own
        // refusal stops it, before the note's send is claimed and before any charge.
        const ownThread = {
            "agent_threads:getThreadInternal": async () => await run(async (ctx) => await ctx.db.get("threads", threadId)),
            "chat_goals_internal:startGoal": async () => {
                return { goalId: "goal-1", ok: true };
            },
        };
        const response = await runChatStart(
            fakeContext(ownThread),
            { goal: { text: "please call me back" }, guestMessageId: noteId, model: MODEL, prompt: "x", threadId } as never,
            "secret",
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "GUEST_NOTE_AS_GOAL" });
        expect(saved.prompts).toHaveLength(0);
        expect(saved.charges).toBe(0);
        expect(await run(async (ctx) => await claimRow(ctx, GUEST_SEND_SCOPE, noteId))).toBeNull();
        expect(await noteStatus()).toBe("held");
    });

    it("refuses a second send of the same note as already sent, and saves nothing more", async () => {
        await sendNote();

        const second = await sendNote();

        expect(second.status).toBe(409);
        expect(await second.json()).toMatchObject({ error: "GUEST_NOTE_ALREADY_SENT" });
        expect(saved.prompts).toHaveLength(1);
    });

    it("refuses a note another send holds as being sent, not as already sent, and keeps it waiting", async () => {
        expect(await run(async (ctx) => await ctx.runMutation(claimGuestNoteSend, { messageId: noteId, userId: OWNER }))).toHaveProperty("fence");

        const response = await sendNote();

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: "GUEST_NOTE_BEING_SENT" });
        expect(saved.prompts).toHaveLength(0);
        expect(saved.charges).toBe(0);
        expect(await noteStatus()).toBe("held");
    });

    it("refuses a note whose link ended between its lookup and its claim as an ended link, not as sent", async () => {
        const lookupThenEnd = {
            "chat_guest_links:getGuestNoteForSend": async (args: any) => {
                const note = await run(async (ctx) => await ctx.runQuery(getGuestNoteForSend, args));

                await run(async (ctx) => {
                    const row = await ctx.db.get("threadGuestMessages", noteId);

                    await ctx.db.patch("threadGuestLinks", row.linkId, { expiresAt: 1 });
                });

                return note;
            },
        };
        const response = await runChatStart(fakeContext(lookupThenEnd), { guestMessageId: noteId, model: MODEL, prompt: "x", threadId } as never, "secret");

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "GUEST_LINK_ENDED" });
        expect(await noteStatus()).toBe("held");
    });

    it.each(["agent", "save"] as const)("lets a note be sent again when its %s step failed before anything was stored", async (step) => {
        saved.fail = step;

        await expect(sendNote()).rejects.toThrow();
        expect((await sendNote()).status).toBe(200);
        expect(saved.prompts).toHaveLength(1);
    });

    it("fails with the save's own error when releasing the failed send fails too", async () => {
        saved.fail = "save";
        saved.releaseFails = true;

        await expect(sendNote()).rejects.toThrow("the save failed");
    });
});
