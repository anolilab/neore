/**
 * `/chat/edit` saves and regenerates from the edited prompt, so hidden characters (tag block, bidi controls) are
 * removed here too: a client that skips the composer cannot put them into the thread or the model's context.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return {
        enqueued: [] as { prompt?: string }[],
        saved: [] as { message: { content: { text?: string; type: string }[] } }[],
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
    return { chargeDailyLimit: async () => ({ ok: true }) };
});
vi.mock("./lib/enabled-model", () => {
    return { assertPaidModel: async () => {} };
});

const { editMessageHttpAction } = await import("./http");

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
                return [{ message: { role: "user" }, threadId: THREAD_ID }];
            }

            if (name.includes("getThreadInternal")) {
                return { model: "openai/gpt-4.1-mini", userId: "user-a" };
            }

            if (name.includes("gateThreadAction")) {
                return { isWorker: false, outcome: "ok" };
            }

            return null;
        },
    }) as never;

const edit = async (text: string): Promise<Response> =>
    await editMessageHttpAction(
        context(),
        new Request("https://example.test/chat/edit", {
            body: JSON.stringify({ content: [{ text, type: "text" }], messageId: MESSAGE_ID }),
            method: "POST",
        }),
    );

beforeEach(() => {
    state.enqueued = [];
    state.saved = [];
});

describe("editMessageHttpAction hidden characters", () => {
    it("saves and regenerates from the edited text without hidden characters", async () => {
        const response = await edit("fix\u{E0041}\u{202E} this\u{7}");

        expect(response.status).toBe(200);
        expect(state.saved[0]?.message.content).toStrictEqual([{ text: "fix this", type: "text" }]);
        expect(state.enqueued[0]?.prompt).toBe("fix this");
    });

    it("refuses an edit made only of hidden characters and saves nothing", async () => {
        const response = await edit("\u{E0041}\u{202E}");

        expect(response.status).toBe(400);
        expect(state.saved).toStrictEqual([]);
        expect(state.enqueued).toStrictEqual([]);
    });
});
