/**
 * `/chat/edit` saves and regenerates from the edited prompt, so hidden characters (tag block, bidi controls) are
 * removed here too: a client that skips the composer cannot put them into the thread or the model's context.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return {
        charges: 0,
        enqueued: [] as { prompt?: string }[],
        /** The edited row is a guest's note the owner sent on. */
        guestRow: false,
        /** The thread's owner; anyone else editing in it is a stranger. */
        owner: "user-a",
        saved: [] as { message: { content: { text?: string; type: string }[] } }[],
        /** The thread keeps no memory (`statelessMode`): its reply saves the prompt again from plain text. */
        stateless: false,
    };
});

vi.mock("../auth/lib/helper", () => {
    return {
        getCurrentUserInternal: async () => {
            return { _id: "user-a", isAnonymous: false };
        },
    };
});
vi.mock("../lib/job-queue", () => {
    return {
        enqueueJob: async (_ref: unknown, args: { prompt?: string }) => {
            state.enqueued.push(args);
        },
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
vi.mock("./lib/enabled-model", () => {
    return { assertPaidModel: async () => {} };
});

const { editMessageHttpAction } = await import("./http");
const { guestTextPart } = await import("./lib/attached-text");

const MESSAGE_ID = "j57a1b2c3d4e5f6g7h8i9j0k1l2m3n4o";
const THREAD_ID = "k57a1b2c3d4e5f6g7h8i9j0k1l2m3n4o";

const context = () =>
    ({
        auth: { getIdentity: async () => null },
        runMutation: async (reference: { __lunoraRef?: string }, args: (typeof state.saved)[number]) => {
            if (String(reference.__lunoraRef).includes("saveEditedSibling")) {
                state.saved.push(args);

                return "edited-1";
            }

            return null;
        },
        runQuery: async (reference: { __lunoraRef?: string }) => {
            const name = String(reference.__lunoraRef);

            if (name.includes("getMessagesByIdsUnfiltered")) {
                return [
                    {
                        message: state.guestRow ? { content: [guestTextPart("a guest's words", "note-1")], role: "user" } : { role: "user" },
                        threadId: THREAD_ID,
                    },
                ];
            }

            if (name.includes("getThreadInternal")) {
                return { model: "openai/gpt-4.1-mini", statelessMode: state.stateless, userId: state.owner };
            }

            if (name.includes("gateThreadAction")) {
                return { isWorker: false, outcome: "ok" };
            }

            return null;
        },
    }) as never;

const edit = async (text: unknown): Promise<Response> =>
    await editMessageHttpAction(
        context(),
        new Request("https://example.test/chat/edit", {
            body: JSON.stringify({
                content: [text].flat().map((part) => {
                    return { text: part, type: "text" };
                }),
                messageId: MESSAGE_ID,
            }),
            method: "POST",
        }),
    );

beforeEach(() => {
    state.charges = 0;
    state.enqueued = [];
    state.saved = [];
    state.guestRow = false;
    state.stateless = false;
    state.owner = "user-a";
});

describe("editMessageHttpAction hidden characters", () => {
    it("saves and regenerates from the edited text without hidden characters", async () => {
        const response = await edit("fix\u{E0041}\u{202E} this\u{7}");

        expect(response.status).toBe(200);
        expect(state.saved[0]?.message.content).toStrictEqual([{ text: "fix this", type: "text" }]);
        expect(state.enqueued[0]?.prompt).toBe("fix this");
        expect(state.charges).toBe(1);
    });

    it("refuses an edit made only of hidden characters and saves nothing", async () => {
        const response = await edit("\u{E0041}\u{202E}");

        expect(response.status).toBe(400);
        expect(state.saved).toStrictEqual([]);
        expect(state.enqueued).toStrictEqual([]);
        expect(state.charges).toBe(0);
    });

    it("drops a blank text part and keeps the edit when another part has text", async () => {
        const response = await edit(["\u{E0041}\u{202E}", "fix this"]);

        expect(response.status).toBe(200);
        expect(state.saved[0]?.message.content).toStrictEqual([{ text: "fix this", type: "text" }]);
    });

    it.each([
        ["missing", undefined],
        ["null", null],
        ["an object", { text: "fix this" }],
    ])("refuses a text part whose text is %s and saves nothing", async (_label, text) => {
        const response = await edit(text);

        expect(response.status).toBe(400);
        expect(state.saved).toStrictEqual([]);
        expect(state.enqueued).toStrictEqual([]);
        expect(state.charges).toBe(0);
    });

    it("keeps the guest mark and the note's id on an edit of a guest's note the owner sent on", async () => {
        state.guestRow = true;

        const response = await edit("reworded");

        expect(response.status).toBe(200);
        expect(state.saved[0]?.message.content).toStrictEqual([guestTextPart("reworded", "note-1")]);
    });

    it("refuses an edit of a guest's note in a stateless chat, whose reply would save an untagged copy of it", async () => {
        state.guestRow = true;
        state.stateless = true;

        const response = await edit("reworded");

        expect(response.status).toBe(400);
        expect(state.saved).toStrictEqual([]);
        expect(state.enqueued).toStrictEqual([]);
        expect(state.charges).toBe(0);
    });

    it("answers a stranger's edit of a guest's note like a missing message, so its guest text cannot be probed", async () => {
        state.guestRow = true;
        state.owner = "user-b";

        const response = await edit("reworded");

        expect(response.status).toBe(404);
    });
});
