/**
 * A steered reply: the texts the run took are remembered by `createRunSteering` and joined to the
 * prompt that memory extraction reads, so a correction sent mid-reply is not lost.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { afterRun, createRunSteering } from "./agent-run";

describe(createRunSteering, () => {
    it("records the text of each delivered steer, and nothing for a delivery that took none", async () => {
        const deliveries = [{ messageId: "m1", text: "actually, I'm vegetarian" }, null, { messageId: "m2", text: "and no nuts" }];
        const ctx = { runMutation: vi.fn(async () => deliveries.shift() ?? null) };
        const steering = createRunSteering(ctx as never, { streamId: "s", threadId: "t", userId: "u" });

        await steering.takeSteer({ pendingMessageId: "p1" } as never);
        await steering.takeSteer({ pendingMessageId: "p2" } as never);
        await steering.takeSteer({ pendingMessageId: "p3" } as never);

        expect(steering.steeredTexts()).toStrictEqual(["actually, I'm vegetarian", "and no nuts"]);
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
            savedMessages: [{ _id: "r1", message: { content: "Here is a plan.", role: "assistant" }, order: 1, stepOrder: 1 }] as never,
            steeredTexts: ["actually, I'm vegetarian"],
            summarizeThread: false,
            threadId: "thread-1",
            timingStart: Date.now(),
            userId: "user-1",
        });

        const extraction = runAfter.mock.calls.find((call) => (call as unknown[])[1] === internal.memory.extract.extractMemories);

        expect((extraction as unknown[] | undefined)?.[2]).toMatchObject({
            steeredFrom: "Plan my dinner".length + 2,
            userMessage: "Plan my dinner\n\nactually, I'm vegetarian",
        });
    });
});
