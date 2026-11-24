import { describe, expect, it, vi } from "vitest";

import { classifyLocalError } from "./local-errors";
import { LOCAL_IDLE_TIMEOUT_MS, LOCAL_REASONING_LIMIT_CHARS, LOCAL_REPEAT_LIMIT } from "./reply-guard";
import type { RunLocalTurnOptions } from "./run-local-turn";
import { buildLocalHistory, runLocalTurn } from "./run-local-turn";

const BASE = ["http", "//localhost:11434/v1"].join(":");

/** One SSE `data:` frame carrying a chat-completion delta. */
const frame = (delta: { content?: string; reasoning?: string }) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

/** Sends the frames, then stays open until the caller aborts — how a model that has stopped talking looks. */
const holdingFetch =
    (frames: string[]) =>
    async (_url: string, init?: RequestInit): Promise<Response> => {
        const encoder = new TextEncoder();

        return new Response(
            new ReadableStream({
                start(controller) {
                    for (const part of frames) {
                        controller.enqueue(encoder.encode(part));
                    }

                    init?.signal?.addEventListener("abort", () => {
                        controller.error(new DOMException("aborted", "AbortError"));
                    });
                },
            }),
        );
    };

const sseResponse = (parts: string[], tail: "done" | "error" = "done") => {
    const encoder = new TextEncoder();

    return new Response(
        new ReadableStream({
            start(controller) {
                for (const content of parts) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
                }

                if (tail === "error") {
                    controller.enqueue(encoder.encode('data: {"error":{"message":"out of memory"}}\n\n'));
                } else {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }

                controller.close();
            },
        }),
    );
};

const setup = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, overrides: Partial<RunLocalTurnOptions> = {}) => {
    const save = vi.fn(async () => {
        return { threadId: "thread-1" };
    });
    const updates: string[] = [];
    const options: RunLocalTurnOptions = {
        baseUrl: BASE,
        // No network probing in unit tests.
        diagnose: async (error) => classifyLocalError(error, { endpointUrl: BASE, pageProtocol: "https:" }),
        fetchImpl: fetchImpl as never,
        history: [],
        modelId: "llama3.2:3b",
        onUpdate: (text) => {
            updates.push(text);
        },
        prompt: "hi",
        save,
        signal: new AbortController().signal,
        ...overrides,
    };

    return { options, save, updates };
};

describe(runLocalTurn, () => {
    it("streams, then saves the complete turn", async () => {
        expect.assertions(3);

        const { options, save, updates } = setup(async () => sseResponse(["Hel", "lo"]));

        await expect(runLocalTurn(options)).resolves.toStrictEqual({ outcome: "complete", saved: true, threadId: "thread-1" });
        expect(updates).toStrictEqual(["Hel", "Hello"]);
        expect(save).toHaveBeenCalledWith({ outcome: "complete", prompt: "hi", reasoning: "", reply: "Hello" });
    });

    it("saves nothing when the server was never reached, so the prompt can go back to the composer", async () => {
        expect.assertions(2);

        const { options, save } = setup(async () => {
            throw new TypeError("Failed to fetch");
        });

        await expect(runLocalTurn(options)).resolves.toStrictEqual({ error: { kind: "unreachable" }, saved: false });
        expect(save).not.toHaveBeenCalled();
    });

    it("keeps the partial reply and records the error when the stream fails midway", async () => {
        expect.assertions(2);

        const { options, save } = setup(async () => sseResponse(["partial"], "error"));
        const result = await runLocalTurn(options);

        expect(result).toMatchObject({ error: { kind: "stream" }, outcome: "failed", saved: true });
        expect(save).toHaveBeenCalledWith({ error: "out of memory", outcome: "failed", prompt: "hi", reasoning: "", reply: "partial" });
    });

    it("saves a localized sentence, not a bare code, when a failed reply has no server detail", async () => {
        expect.assertions(1);

        // Pulled, not started: erroring a stream in `start` would discard the partial chunk before it is read.
        const encoder = new TextEncoder();
        const partial = encoder.encode(frame({ content: "partial" }));
        let sent = false;
        const failing = new ReadableStream({
            pull(controller) {
                if (!sent) {
                    sent = true;
                    controller.enqueue(partial);

                    return;
                }

                controller.error(new TypeError("Failed to fetch"));
            },
        });
        const { options, save } = setup(async () => new Response(failing), { describeError: (info) => `described ${info.kind}` });

        await runLocalTurn(options);

        expect(save).toHaveBeenCalledWith({ error: "described unreachable", outcome: "failed", prompt: "hi", reasoning: "", reply: "partial" });
    });

    it("saves what arrived before a stop, and nothing for a stop before the first token", async () => {
        expect.assertions(3);

        const controller = new AbortController();
        const encoder = new TextEncoder();
        // A stream that sends one token, then hangs until aborted.
        const hanging = async () =>
            new Response(
                new ReadableStream({
                    start(streamController) {
                        streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "half" } }] })}\n\n`));
                        controller.signal.addEventListener("abort", () => streamController.error(new DOMException("aborted", "AbortError")));
                    },
                }),
            );
        const stopped = setup(hanging, { onUpdate: () => controller.abort(), signal: controller.signal });

        await expect(runLocalTurn(stopped.options)).resolves.toMatchObject({ outcome: "aborted", saved: true });
        expect(stopped.save).toHaveBeenCalledWith({ outcome: "aborted", prompt: "hi", reasoning: "", reply: "half" });

        const early = setup(async () => {
            throw new DOMException("aborted", "AbortError");
        });

        await expect(runLocalTurn(early.options)).resolves.toStrictEqual({ error: { kind: "aborted" }, saved: false });
    });

    it("sends the prior conversation and the system prompt ahead of the new prompt", async () => {
        expect.assertions(1);

        const fetchImpl = vi.fn(async () => sseResponse(["ok"]));
        const { options } = setup(fetchImpl, {
            history: [
                { role: "user", text: "first" },
                { role: "assistant", text: "reply" },
            ],
            systemPrompt: "Be brief.",
        });

        await runLocalTurn(options);

        const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];

        expect(JSON.parse(init.body as string).messages).toStrictEqual([
            { content: "Be brief.", role: "system" },
            { content: "first", role: "user" },
            { content: "reply", role: "assistant" },
            { content: "hi", role: "user" },
        ]);
    });
});

describe("reply guard stops", () => {
    it("stops a reply that repeats one line, keeps the text before the stop, and saves the cause", async () => {
        expect.assertions(2);

        const line = "I will try the same thing again.\n";
        const { options, save } = setup(holdingFetch(Array.from({ length: LOCAL_REPEAT_LIMIT + 2 }, () => frame({ content: line }))));

        await expect(runLocalTurn(options)).resolves.toStrictEqual({ error: { kind: "repeat-loop" }, outcome: "failed", saved: true, threadId: "thread-1" });
        expect(save).toHaveBeenCalledWith({ error: "repeat-loop", outcome: "failed", prompt: "hi", reasoning: "", reply: line.repeat(LOCAL_REPEAT_LIMIT) });
    });

    it("does not save text that arrives in the same chunk after the repeat", async () => {
        expect.assertions(2);

        const line = "I will try the same thing again.\n";
        const chunk = frame({ content: `${line.repeat(LOCAL_REPEAT_LIMIT)}after the loop` });
        const { options, save } = setup(holdingFetch([chunk]));

        await expect(runLocalTurn(options)).resolves.toMatchObject({ error: { kind: "repeat-loop" }, outcome: "failed" });
        expect(save).toHaveBeenCalledWith({ error: "repeat-loop", outcome: "failed", prompt: "hi", reasoning: "", reply: line.repeat(LOCAL_REPEAT_LIMIT) });
    });

    it("does not start the idle clock until the server has answered", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        try {
            const open = holdingFetch([]);
            let answer: () => void = () => undefined;
            const { options, save } = setup(
                (url, init) =>
                    new Promise<Response>((resolve) => {
                        answer = () => {
                            resolve(open(url, init));
                        };
                    }),
            );
            const pending = runLocalTurn(options);

            await vi.advanceTimersByTimeAsync(LOCAL_IDLE_TIMEOUT_MS * 2);
            expect(save).not.toHaveBeenCalled();

            answer();
            await vi.advanceTimersByTimeAsync(LOCAL_IDLE_TIMEOUT_MS);

            await expect(pending).resolves.toMatchObject({ error: { kind: "idle" } });
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops a reply that sends nothing for the idle limit, even before the first token", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        try {
            const { options, save } = setup(holdingFetch([]));
            const pending = runLocalTurn(options);

            await vi.advanceTimersByTimeAsync(LOCAL_IDLE_TIMEOUT_MS);

            await expect(pending).resolves.toStrictEqual({ error: { kind: "idle" }, outcome: "failed", saved: true, threadId: "thread-1" });
            expect(save).toHaveBeenCalledWith({ error: "idle", outcome: "failed", prompt: "hi", reasoning: "", reply: "" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops a reply whose reasoning passes its limit", async () => {
        expect.assertions(2);

        const atLimit = "r".repeat(LOCAL_REASONING_LIMIT_CHARS);
        const frames = [frame({ reasoning: atLimit }), frame({ reasoning: "rr" })];
        const { options, save } = setup(holdingFetch(frames));

        await expect(runLocalTurn(options)).resolves.toMatchObject({ error: { kind: "reasoning-limit" }, outcome: "failed", saved: true });
        // The "rr" past the limit is not kept: the saved reasoning stays at the limit.
        expect(save).toHaveBeenCalledWith({ error: "reasoning-limit", outcome: "failed", prompt: "hi", reasoning: atLimit, reply: "" });
    });

    it("stops a reply whose last repeat has no newline when the stream ends", async () => {
        expect.assertions(2);

        const line = "I will try the same thing again.";
        const reply = `${`${line}\n`.repeat(LOCAL_REPEAT_LIMIT - 1)}${line}`;
        const { options, save } = setup(async () => sseResponse([`${line}\n`.repeat(LOCAL_REPEAT_LIMIT - 1), line]));

        await expect(runLocalTurn(options)).resolves.toMatchObject({ error: { kind: "repeat-loop" }, outcome: "failed", saved: true });
        expect(save).toHaveBeenCalledWith({ error: "repeat-loop", outcome: "failed", prompt: "hi", reasoning: "", reply });
    });
});

describe(buildLocalHistory, () => {
    it("keeps only user/assistant text and the most recent turns", () => {
        expect.assertions(1);
        expect(
            buildLocalHistory(
                [
                    { role: "user", text: "one" },
                    { role: "tool", text: "ignored" },
                    { role: "assistant", text: " ".repeat(3) },
                    { role: "assistant", text: "two" },
                    { role: "user", text: "three" },
                ],
                undefined,
                2,
            ),
        ).toStrictEqual([
            { content: "two", role: "assistant" },
            { content: "three", role: "user" },
        ]);
    });
});
