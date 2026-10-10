import { describe, expect, it, vi } from "vitest";

import { classifyLocalError } from "./local-errors";
import type { RunLocalTurnOptions } from "./run-local-turn";
import { buildLocalHistory, runLocalTurn } from "./run-local-turn";

const BASE = ["http", "//localhost:11434/v1"].join(":");

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

const setup = (fetchImpl: () => Promise<Response>, overrides: Partial<RunLocalTurnOptions> = {}) => {
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
