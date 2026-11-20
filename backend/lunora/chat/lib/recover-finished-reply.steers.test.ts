/**
 * A reply recovered after its worker died: the after-run work sees the steers the run took, with their text and row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { afterRun } from "./agent-run";
import { recoverFinishedReply } from "./recover-finished-reply";

vi.mock("./agent-run", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("./agent-run")>()), afterRun: vi.fn(async () => undefined) };
});
vi.mock("../../lib/cross-shard", () => {
    return { callOnShard: vi.fn(async () => null) };
});

const PROMPT_ROW = { _creationTime: 1, _id: "prompt-row", message: { content: "plan the trip", role: "user" }, userId: "user-1" };
const REPLY_ROW = { _creationTime: 2, _id: "reply-row", message: { content: "Here is a plan", role: "assistant" } };
const STEER_ROW = { _creationTime: 3, _id: "steer-row", message: { content: "use the train\n\nand keep it short", role: "user" } };

const contextWith = (steerRows: ReadonlyArray<unknown>) => {
    const runQuery = vi.fn(async (_ref: unknown, args: { messageIds?: string[]; threadId?: string }) => {
        if (args.threadId !== undefined) {
            return null;
        }

        const ids = args.messageIds ?? [];

        if (ids.includes("steer-row")) {
            return steerRows;
        }

        if (ids.includes("prompt-row")) {
            return [PROMPT_ROW];
        }

        return [REPLY_ROW];
    });

    return { runMutation: vi.fn(async () => undefined), runQuery, scheduler: { runAfter: vi.fn(async () => "job") } };
};

const reply = {
    goal: false,
    messageId: "prompt-row",
    replyRowIds: ["reply-row"],
    threadId: "thread-1",
    userId: "user-1",
    userPrompt: "plan the trip",
};

describe("recoverFinishedReply steers", () => {
    beforeEach(() => {
        vi.mocked(afterRun).mockClear();
    });

    it("hands the after-run work the steers the run took, with their text and row", async () => {
        expect.assertions(1);

        await recoverFinishedReply(contextWith([STEER_ROW]) as never, { ...reply, steerRowIds: ["steer-row"] });

        expect(vi.mocked(afterRun).mock.calls[0]?.[1]).toMatchObject({
            prompt: "plan the trip",
            steered: [{ messageId: "steer-row", sentAt: 3, text: "use the train\n\nand keep it short" }],
        });
    });

    it("dates each steer of one row by when it was sent, not by the row", async () => {
        expect.assertions(1);

        // Two steers saved in one message ("use the train" + "and keep it short", 14 + 19 characters, a blank line apart).
        const row = { ...STEER_ROW, _creationTime: 900 };

        await recoverFinishedReply(contextWith([row]) as never, {
            ...reply,
            steerRowIds: ["steer-row"],
            steers: [
                { messageId: "steer-row", sentAt: 100, textLength: 13 },
                { messageId: "steer-row", sentAt: 500, textLength: 17 },
            ],
        });

        expect(vi.mocked(afterRun).mock.calls[0]?.[1]).toMatchObject({
            steered: [
                { messageId: "steer-row", sentAt: 100, text: "use the train" },
                { messageId: "steer-row", sentAt: 500, text: "and keep it short" },
            ],
        });
    });

    it("gives the after-run work no steers when the run took none", async () => {
        expect.assertions(1);

        await recoverFinishedReply(contextWith([]) as never, reply);

        expect(vi.mocked(afterRun).mock.calls[0]?.[1]).not.toHaveProperty("steered");
    });

    it("reads the steer rows with the same query the reply rows use", async () => {
        expect.assertions(1);

        const ctx = contextWith([STEER_ROW]);

        await recoverFinishedReply(ctx as never, { ...reply, steerRowIds: ["steer-row"] });

        expect(ctx.runQuery).toHaveBeenCalledWith(internal.agent.messages.getMessagesByIdsUnfiltered, { messageIds: ["steer-row"] });
    });
});
