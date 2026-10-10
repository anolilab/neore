/**
 * Scripted `LanguageModelV3` fakes for `run.test.ts`, on `ai/test`'s mock so
 * they speak the current provider protocol (V3 usage and finish-reason shapes).
 */
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

const USAGE = {
    inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 3, total: 3 },
    outputTokens: { reasoning: undefined, text: 5, total: 5 },
};

export type ScriptStep = LanguageModelV3StreamPart[];

const finish = (unified: "stop" | "tool-calls"): LanguageModelV3StreamPart =>
    ({ finishReason: { raw: unified, unified }, type: "finish", usage: USAGE }) as LanguageModelV3StreamPart;

export const textStep = (text: string): ScriptStep => [
    { type: "stream-start", warnings: [] },
    { id: "t", type: "text-start" },
    { delta: text, id: "t", type: "text-delta" },
    { id: "t", type: "text-end" },
    finish("stop"),
];

export const toolCallStep = (toolName: string, toolCallId: string): ScriptStep => [
    { type: "stream-start", warnings: [] },
    { input: "{}", toolCallId, toolName, type: "tool-call" },
    finish("tool-calls"),
];

/** Each `doStream` call plays the next step; the last one repeats. `onCall` runs before each. */
export const scriptedModel = (steps: ScriptStep[], onCall?: () => Promise<void>) => {
    let call = 0;

    return new MockLanguageModelV3({
        doStream: async () => {
            await onCall?.();

            const step = steps[Math.min(call, steps.length - 1)] ?? [];

            call += 1;

            return { stream: simulateReadableStream({ chunkDelayInMs: null, chunks: step, initialDelayInMs: null }) };
        },
    });
};

/** The supervisor's routing call (`generateText` with structured output). */
export const routerModel = (speakers: string[]) =>
    new MockLanguageModelV3({
        doGenerate: async () => {
            return {
                content: [{ text: JSON.stringify({ speakers }), type: "text" as const }],
                finishReason: { raw: "stop", unified: "stop" as const },
                usage: USAGE,
                warnings: [],
            };
        },
    });

/**
 * Routes each call to the participant whose instructions (`INSTR:<slug>`) are
 * in the system prompt, so one agent object serves whichever speaker it runs.
 */
export const dispatchingModel = (models: ReadonlyMap<string, MockLanguageModelV3>) =>
    new MockLanguageModelV3({
        doStream: async (options) => {
            const system = JSON.stringify(options.prompt.filter((message) => message.role === "system"));

            for (const [instructions, model] of models) {
                if (system.includes(instructions)) {
                    return await model.doStream(options);
                }
            }

            throw new Error(`test-models: no participant model matches the system prompt ${system.slice(0, 200)}`);
        },
    });
