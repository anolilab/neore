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

/** Settles when `signal` aborts (at once if it already has); never, without a signal. */
const untilAborted = async (signal: AbortSignal | undefined): Promise<void> => {
    if (!signal || signal.aborted) {
        return;
    }

    await new Promise<void>((resolve) => {
        signal.addEventListener(
            "abort",
            () => {
                resolve();
            },
            { once: true },
        );
    });
};

/**
 * A reply cut off mid-generation: `onText` runs, then `text` streams and the model waits for the
 * call's abort signal (what a long generation does) before it ends. The first write is thus already refused.
 */
export const stalledModel = (text: string, onText: () => Promise<void>) =>
    new MockLanguageModelV3({
        doStream: async ({ abortSignal }) => {
            const stream = new ReadableStream<LanguageModelV3StreamPart>({
                async start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] });
                    controller.enqueue({ id: "t", type: "text-start" });

                    await onText();

                    controller.enqueue({ delta: text, id: "t", type: "text-delta" });

                    await untilAborted(abortSignal);

                    controller.enqueue(finish("stop"));
                    controller.close();
                },
            });

            return { stream };
        },
    });

/**
 * A step whose text lands on both sides of a stop: `first` is written, `beforeStop` runs, then `after` is
 * streamed (still owed, unwritten) and the step finishes, as a model does when its last chunk follows a stop.
 */
export const stoppedStep = (first: string, after: string, beforeStop: () => Promise<void>) =>
    new MockLanguageModelV3({
        doStream: async () => {
            const stream = new ReadableStream<LanguageModelV3StreamPart>({
                async start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] });
                    controller.enqueue({ id: "t", type: "text-start" });
                    controller.enqueue({ delta: first, id: "t", type: "text-delta" });

                    await beforeStop();

                    controller.enqueue({ delta: after, id: "t", type: "text-delta" });
                    controller.enqueue({ id: "t", type: "text-end" });
                    controller.enqueue(finish("stop"));
                    controller.close();
                },
            });

            return { stream };
        },
    });

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
