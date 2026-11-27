/**
 * `/chat/edit` saves and regenerates from the edited prompt, so hidden characters (tag block, bidi controls) are
 * removed here too: a client that skips the composer cannot put them into the thread or the model's context.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return {
        charges: 0,
        enqueued: [] as { notTyped?: unknown; prompt?: string }[],
        /** The edited row is a guest's note the owner sent on. */
        guestRow: false,
        /** The thread's owner; anyone else editing in it is a stranger. */
        owner: "user-a",
        /** The edited row's own content, when a test sets it. */
        row: undefined as unknown,
        saved: [] as { message: { content: { text?: string; type: string }[] } }[],
        /** The sign-in is an admin acting as the owner (`impersonating`), or cannot be confirmed (`unconfirmed`). */
        signIn: "own" as "impersonating" | "own" | "unconfirmed",
        /** The thread keeps no memory (`statelessMode`): its reply saves the prompt again from plain text. */
        stateless: false,
        /** A pull request watch holds a wake lease on the thread. */
        wakeHeld: false,
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
        auth: { getIdentity: async () => (state.signIn === "unconfirmed" ? null : { sessionId: "session-1" }) },
        runMutation: async (reference: { __lunoraRef?: string }, args: (typeof state.saved)[number]) => {
            if (String(reference.__lunoraRef).includes("saveEditedSibling")) {
                state.saved.push(args);

                return "edited-1";
            }

            return null;
        },
        runQuery: async (reference: { __lunoraRef?: string }) => {
            const name = String(reference.__lunoraRef);

            if (name.includes("getSessionOrganizationForCap")) {
                return state.signIn === "impersonating" ? { impersonating: true, organizationId: null } : { organizationId: null };
            }

            if (name.includes("getMessagesByIdsUnfiltered")) {
                return [
                    {
                        message: state.row ?? (state.guestRow ? { content: [guestTextPart("a guest's words", "note-1")], role: "user" } : { role: "user" }),
                        threadId: THREAD_ID,
                    },
                ];
            }

            if (name.includes("wakeLeaseHeldFor")) {
                return state.wakeHeld;
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

const edit = async (text: unknown, extra: Record<string, unknown> = {}): Promise<Response> =>
    await editMessageHttpAction(
        context(),
        new Request("https://example.test/chat/edit", {
            body: JSON.stringify({
                content: [text].flat().map((part) => {
                    return { text: part, type: "text" };
                }),
                messageId: MESSAGE_ID,
                ...extra,
            }),
            method: "POST",
        }),
    );

beforeEach(() => {
    state.charges = 0;
    state.enqueued = [];
    state.saved = [];
    state.guestRow = false;
    state.signIn = "own";
    state.row = undefined;
    state.stateless = false;
    state.owner = "user-a";
    state.wakeHeld = false;
});

describe("editMessageHttpAction while a pull request watch is waking the chat", () => {
    it("refuses the edit with a conflict before anything is written or charged, and lets it through once the lease is released", async () => {
        state.wakeHeld = true;

        const refused = await edit("reworded");

        expect(refused.status).toBe(409);
        await expect(refused.json()).resolves.toMatchObject({ error: "A pull request watch is replying to this chat. Try again in a moment." });
        expect(state.saved).toStrictEqual([]);
        expect(state.enqueued).toStrictEqual([]);
        expect(state.charges).toBe(0);

        state.wakeHeld = false;

        const allowed = await edit("reworded");

        expect(allowed.status).toBe(200);
        expect(state.saved).toHaveLength(1);
    });
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

    it("refuses an edit whose file list is an object, as a bad request, before anything is read", async () => {
        const response = await editMessageHttpAction(
            context(),
            new Request("https://example.test/chat/edit", {
                body: JSON.stringify({ content: [{ text: "fix this", type: "text" }], fileIds: { length: 1 }, messageId: MESSAGE_ID }),
                method: "POST",
            }),
        );

        expect(response.status).toBe(400);
        expect(state.saved).toStrictEqual([]);
        expect(state.charges).toBe(0);
    });

    it("refuses an edit whose file list is null, as a bad request", async () => {
        const response = await editMessageHttpAction(
            context(),
            new Request("https://example.test/chat/edit", {
                body: JSON.stringify({ content: [{ text: "fix this", type: "text" }], fileIds: null, messageId: MESSAGE_ID }),
                method: "POST",
            }),
        );

        expect(response.status).toBe(400);
        expect(state.saved).toStrictEqual([]);
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

describe("editMessageHttpAction text the owner did not type", () => {
    const marked = (notTyped: unknown) => [{ providerOptions: { neore: { notTyped } }, text: "fix this", type: "text" }];

    it("keeps the mark of the prompt it replaces, so an edit never launders a draft from a link", async () => {
        state.row = { content: [{ providerOptions: { neore: { notTyped: { draft: "promptLink" } } }, text: "x", type: "text" }], role: "user" };

        const response = await edit("fix this");

        expect(response.status).toBe(200);
        expect(state.saved[0]?.message.content).toStrictEqual(marked({ draft: "promptLink" }));
    });

    it("marks an edit holding someone else's saved prompt, one an admin acting as the owner sends, and one whose sign-in is not confirmed", async () => {
        await edit("fix this", { draftFrom: "sharedPrompt" });
        state.signIn = "impersonating";
        await edit("fix this");
        state.signIn = "unconfirmed";
        await edit("fix this");

        expect(state.saved.map((saved) => saved.message.content)).toStrictEqual([
            marked({ draft: "sharedPrompt" }),
            marked({ impersonated: true }),
            marked({ impersonated: true }),
        ]);
    });

    it("hands a stateless reply the marks, so the prompt it saves again stays marked; an own edit hands none", async () => {
        state.stateless = true;
        await edit("fix this", { draftFrom: "sharedPrompt" });
        await edit("fix this");

        expect(state.enqueued.map((job) => job.notTyped)).toStrictEqual([{ draft: "sharedPrompt" }, undefined]);
    });

    it('marks a recalled prompt an admin wrote as the owner, sent again as "impersonated"', async () => {
        await edit("fix this", { draftFrom: "impersonated" });

        expect(state.saved[0]?.message.content).toStrictEqual(marked({ impersonated: true }));
    });

    it("refuses a draft source nobody named, and saves nothing", async () => {
        const response = await edit("fix this", { draftFrom: "typed" });

        expect(response.status).toBe(400);
        expect(state.saved).toStrictEqual([]);
    });
});
