/**
 * The pipe and `stopWhenStopped` against the real AI SDK `streamText`: a stop found while a tool step is quiet
 * ends the run with one model call and hands the tool an aborted signal; one that landed during a tool step
 * keeps the next model call from starting.
 */
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { isStepCount, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isStreamWriteRefused, pipeToPersistentChunks, stopWhenStopped } from "./persist-stream";

const usage = {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
    outputTokens: { reasoning: 0, text: 1, total: 1 },
};

const toolStep = (): LanguageModelV3StreamPart[] => [
    { type: "stream-start", warnings: [] },
    { input: "{}", toolCallId: "call-1", toolName: "slow", type: "tool-call" },
    { finishReason: { raw: "tool-calls", unified: "tool-calls" }, type: "finish", usage },
];

const textStep = (): LanguageModelV3StreamPart[] => [
    { type: "stream-start", warnings: [] },
    { id: "t", type: "text-start" },
    { delta: "Done.", id: "t", type: "text-delta" },
    { id: "t", type: "text-end" },
    { finishReason: { raw: "stop", unified: "stop" }, type: "finish", usage },
];

const modelOf = (calls: { count: number }) =>
    new MockLanguageModelV3({
        doStream: async () => {
            calls.count += 1;

            const parts = calls.count === 1 ? toolStep() : textStep();

            return {
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                    start(controller) {
                        for (const part of parts) {
                            controller.enqueue(part);
                        }

                        controller.close();
                    },
                }),
            };
        },
    });

describe("pipeToPersistentChunks against streamText", () => {
    it("a stop during a tool that waits on its signal ends the run with one model call, and the tool sees the abort", async () => {
        const calls = { count: 0 };
        const seen = { aborted: false };
        const stop = new AbortController();
        const status = { current: "streaming" };
        const result = streamText({
            abortSignal: stop.signal,
            model: modelOf(calls),
            prompt: "go",
            stopWhen: isStepCount(5),
            tools: {
                slow: tool({
                    description: "waits for its signal",
                    execute: async (_input, { abortSignal }) => {
                        await new Promise<void>((resolve) => {
                            abortSignal?.addEventListener("abort", () => resolve(), { once: true });
                        });
                        seen.aborted = abortSignal?.aborted ?? false;

                        return "late";
                    },
                    inputSchema: z.object({}),
                }),
            },
        });
        const ctx = { runMutation: async () => undefined, runQuery: async () => status.current };

        setTimeout(() => {
            status.current = "done";
        }, 30);

        const error = await pipeToPersistentChunks(ctx as never, "stream-1", result.fullStream, { stopPollMs: 10 }).catch((error_: unknown) => error_);

        expect(isStreamWriteRefused(error)).toBe(true);

        stop.abort();
        await result.consumeStream();

        expect(calls.count).toBe(1);
        expect(seen.aborted).toBe(true);
    });

    it("a stop that landed during a tool step keeps the next model call from starting", async () => {
        const calls = { count: 0 };
        const status = { current: "streaming" };
        const ctx = { runMutation: async () => undefined, runQuery: async () => status.current };
        const result = streamText({
            model: modelOf(calls),
            prompt: "go",
            stopWhen: stopWhenStopped(ctx as never, "stream-1", 5),
            tools: {
                slow: tool({
                    description: "ends after the stop landed",
                    execute: async () => {
                        status.current = "done";

                        return "ok";
                    },
                    inputSchema: z.object({}),
                }),
            },
        });

        await pipeToPersistentChunks(ctx as never, "stream-1", result.fullStream);

        expect(calls.count).toBe(1);
    });

    it("without a stop the run continues to its next model call", async () => {
        const calls = { count: 0 };
        const ctx = { runMutation: async () => undefined, runQuery: async () => "streaming" };
        const result = streamText({
            model: modelOf(calls),
            prompt: "go",
            stopWhen: stopWhenStopped(ctx as never, "stream-1", 5),
            tools: { slow: tool({ description: "fast", execute: async () => "ok", inputSchema: z.object({}) }) },
        });

        await pipeToPersistentChunks(ctx as never, "stream-1", result.fullStream);

        expect(calls.count).toBe(2);
    });
});
