/**
 * A steered reply: the texts the run took are remembered by `createRunSteering` and joined to the
 * prompt that memory extraction reads, so a correction sent mid-reply is not lost.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { afterRun, createRunSteering } from "./agent-run";

describe(createRunSteering, () => {
    it("records the text of each delivered steer, and nothing for a delivery that took none", async () => {
        const deliveries = [
            { messageId: "m1", text: "actually, I'm vegetarian" },
            null,
            // Two steers joined in one delivery stay two, each with its own send time.
            {
                messageId: "m2",
                parts: [
                    { sentAt: 2, text: "and no nuts" },
                    { sentAt: 3, text: "I fly tomorrow" },
                ],
                text: "and no nuts\n\nI fly tomorrow",
            },
        ];
        const ctx = { runMutation: vi.fn(async () => deliveries.shift() ?? null) };
        const steering = createRunSteering(ctx as never, { streamId: "s", threadId: "t", userId: "u" });

        await steering.takeSteer({ pendingMessageId: "p1" } as never);
        await steering.takeSteer({ pendingMessageId: "p2" } as never);
        await steering.takeSteer({ pendingMessageId: "p3" } as never);

        expect(steering.steeredTexts()).toStrictEqual(["actually, I'm vegetarian", "and no nuts", "I fly tomorrow"]);
        // When the user sent each, not when the run took it; an untimed one falls back to the delivery.
        expect(steering.steeredAt().slice(1)).toStrictEqual([2, 3]);
    });
});

describe("restart markers owed to the stream pipe", () => {
    it("owes one per delivery, even when several land before the pipe reads the next step", async () => {
        const deliveries = [{ messageId: "m1", text: "one" }, null, { messageId: "m2", text: "two" }];
        const ctx = { runMutation: vi.fn(async () => deliveries.shift() ?? null) };
        const steering = createRunSteering(ctx as never, { streamId: "s", threadId: "t", userId: "u" });

        await steering.takeSteer({ pendingMessageId: "p1" } as never);
        await steering.takeSteer({ pendingMessageId: "p2" } as never);
        await steering.takeSteer({ pendingMessageId: "p3" } as never);

        expect([steering.steeredBefore(), steering.steeredBefore(), steering.steeredBefore()]).toStrictEqual([true, true, false]);
    });
});

describe(afterRun, () => {
    it("extracts memory from the prompt together with what was steered in", () => {
        const runAfter = vi.fn(async () => "job");
        const ctx = { runMutation: vi.fn(async () => null), scheduler: { runAfter } };

        afterRun(ctx as never, {
            extractMemory: true,
            firstTokenTime: undefined,
            prompt: "Plan my dinner",
            promptAt: Date.UTC(2026, 10, 17, 23, 58),
            savedMessages: [{ _id: "r1", message: { content: "Here is a plan.", role: "assistant" }, order: 1, stepOrder: 1 }] as never,
            steeredAt: [Date.UTC(2026, 10, 17, 23, 59), Date.UTC(2026, 10, 18, 0, 3)],
            steeredTexts: ["actually, I'm vegetarian", "I fly tomorrow"],
            summarizeThread: false,
            threadId: "thread-1",
            timingStart: Date.now(),
            userId: "user-1",
        });

        const extraction = runAfter.mock.calls.find((call) => (call as unknown[])[1] === internal.memory.extract.extractMemories);

        expect((extraction as unknown[] | undefined)?.[2]).toMatchObject({
            // Relative dates are read against when the user asked, not when a reply that crossed midnight ended.
            messageAt: Date.UTC(2026, 10, 17, 23, 58),
            steeredAt: Date.UTC(2026, 10, 18, 0, 3),
            steeredFrom: "Plan my dinner".length + 2,
            // A steer sent after midnight says so, and only that one: "tomorrow" in it is the 19th.
            userMessage: "Plan my dinner\n\nactually, I'm vegetarian\n\n[sent on 2026-11-18] I fly tomorrow",
        });
    });
});
