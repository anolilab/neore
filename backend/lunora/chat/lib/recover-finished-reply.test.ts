/**
 * A recovered reply writes its memory under the thread's bot only when the replying user owns that bot, as a live run does
 * (`getBotForRun` in `agent-run.ts`). A collaborator's recovered turn must not be scoped to the owner's bot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { afterRun } from "./agent-run";
import { recoverFinishedReply } from "./recover-finished-reply";

vi.mock("./agent-run", () => {
    return { afterRun: vi.fn(), mayExtractMemory: () => true, stampSavedToolCalls: vi.fn() };
});
vi.mock("../../lib/cross-shard", () => {
    return {
        callOnShard: async () => {
            return { memoryEnabled: true };
        },
    };
});

const reply = { goal: false, messageId: "m1", replyRowIds: ["r1"], threadId: "t1", userId: "collaborator", userPrompt: "hi" };

const contextWithBot = (bot: unknown) => {
    const runQuery = async (ref: unknown) => {
        if (ref === internal.agent.messages.getMessagesByIdsUnfiltered) {
            return [{ _id: "r1" }];
        }

        if (ref === internal.agent.threads.getThreadInternal) {
            return { _id: "t1" };
        }

        if (ref === internal.chat.functions.getThreadSettings) {
            return { botId: "bot-of-owner" };
        }

        if (ref === internal.bots.functions.getBotForRun) {
            return bot;
        }

        return null;
    };

    return {
        runMutation: async () => undefined,
        runQuery,
        scheduler: { runAfter: async () => undefined },
    };
};

beforeEach(() => {
    vi.mocked(afterRun).mockClear();
});

describe("recoverFinishedReply bot scope", () => {
    it("does not scope a collaborator's recovered memory to a bot they do not own", async () => {
        await recoverFinishedReply(contextWithBot(null) as never, reply);

        expect(vi.mocked(afterRun).mock.calls[0]?.[1]).not.toHaveProperty("botId");
    });

    it("scopes the recovered memory to the bot when the replying user owns it", async () => {
        await recoverFinishedReply(contextWithBot({ computerEnabled: false, instructions: "", model: "m", name: "Chef" }) as never, reply);

        expect(vi.mocked(afterRun).mock.calls[0]?.[1]).toMatchObject({ botId: "bot-of-owner" });
    });
});
