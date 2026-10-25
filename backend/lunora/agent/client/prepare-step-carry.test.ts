/**
 * `stream-text.ts` delivers a steered message by returning it in a step's
 * `prepareStep` `messages` override and relies on the AI SDK carrying that
 * override into every later step. This pins that, so an SDK that rebuilt each
 * step from the initial prompt would fail here instead of silently making the
 * model forget the steer after one step.
 */
import { stepCountIs, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { scriptedModel, textStep, toolCallStep } from "../../chat/group/test-models";

describe("prepareStep messages override", () => {
    it("reaches the steps after the one it was returned for", async () => {
        const prompts: string[][] = [];
        const model = scriptedModel([toolCallStep("look", "c1"), toolCallStep("look", "c2"), textStep("done")]);
        const steer = { content: "go left instead", role: "user" as const };

        const result = streamText({
            messages: [{ content: "hi", role: "user" }],
            model,
            prepareStep: ({ messages, stepNumber }) => {
                prompts.push(messages.map((message) => (typeof message.content === "string" ? message.content : message.role)));

                return stepNumber === 1 ? { messages: [...messages, steer] } : undefined;
            },
            stopWhen: stepCountIs(5),
            tools: { look: tool({ description: "look", execute: async () => "ok", inputSchema: z.object({}) }) },
        });

        await result.consumeStream();

        expect(prompts).toHaveLength(3);
        expect(prompts[0]).not.toContain("go left instead");
        // The step after delivery, and the one after that, both still hold it.
        expect(prompts[2]).toContain("go left instead");
        expect(model.doStreamCalls).toHaveLength(3);
        expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain("go left instead");
    });
});
