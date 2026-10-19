/**
 * Context compression. Whatever it cuts, the array sent to the model must stay a
 * well-formed conversation: every tool result follows its call, no two messages
 * of one role sit side by side, the system messages and the latest user turn
 * survive, and media parts pass through untouched.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";

import { applyLateCompression, compressContextMessages, estimateTokens } from "./auto-continue";
import { buildRunStreamArgs } from "./agent-run";

/** Model context window used by the tests: small, so modest messages trip the threshold. */
const LIMIT = 1000;
const BIG = "x".repeat(2000);

const system = (text: string) => ({ content: text, role: "system" }) as ModelMessage;
const user = (text: string) => ({ content: text, role: "user" }) as ModelMessage;
const answer = (text: string) => ({ content: [{ text, type: "text" }], role: "assistant" }) as ModelMessage;
const call = (id: string) => ({ content: [{ input: { q: id }, toolCallId: id, toolName: "search", type: "tool-call" }], role: "assistant" }) as ModelMessage;
const result = (id: string, value = BIG) =>
    ({
        content: [{ output: { type: "text", value }, toolCallId: id, toolName: "search", type: "tool-result" }],
        role: "tool",
    }) as ModelMessage;

/** `turns` user turns, each running `steps` tool calls before its answer. */
const thread = (turns: number, steps: number, bigText = BIG): ModelMessage[] => {
    const messages: ModelMessage[] = [system("You are helpful.")];
    let n = 0;

    for (let t = 0; t < turns; t += 1) {
        messages.push(user(`question ${t}`));

        for (let s = 0; s < steps; s += 1) {
            n += 1;
            messages.push(call(`c${n}`), result(`c${n}`, bigText));
        }

        messages.push(answer(`answer ${t} ${bigText}`));
    }

    return messages;
};

/** Asserts the invariants compression must hold, against the input it was given. */
const assertWellFormed = (input: ModelMessage[], output: ModelMessage[]) => {
    expect(output.filter((m) => m.role === "system")).toEqual(input.filter((m) => m.role === "system"));

    const conversation = output.filter((m) => m.role !== "system");

    for (let i = 0; i < conversation.length; i += 1) {
        const message = conversation[i]!;

        if (i > 0) {
            // Providers reject two messages of one role in a row.
            expect(message.role).not.toBe(conversation[i - 1]!.role);
        }

        if (message.role === "tool") {
            // A result is only ever preceded by the call it answers.
            expect(conversation[i - 1]?.role).toBe("assistant");
        }

        if (message.role === "assistant" && Array.isArray(message.content)) {
            const parts = message.content as { toolCallId?: string; type: string }[];
            const ids = parts.filter((p) => p.type === "tool-call").map((p) => p.toolCallId);

            if (ids.length > 0) {
                const next = conversation[i + 1];

                expect(next?.role).toBe("tool");
                expect((next!.content as { toolCallId: string }[]).map((p) => p.toolCallId)).toEqual(expect.arrayContaining(ids));
            }
        }
    }

    const latestUser = input.findLast((m) => m.role === "user");

    if (latestUser) {
        expect(output).toContain(latestUser);
    }
};

describe("estimateTokens", () => {
    it("counts AI SDK 5+ tool-result output and tool-call input", () => {
        // Pre-v5 readers looked for `result` / `args` and counted these as ~2 characters.
        expect(estimateTokens([result("c1")])).toBeGreaterThanOrEqual(BIG.length / 4);
        expect(estimateTokens([call("c1")])).toBeGreaterThan(0);
    });

    it("counts reasoning text", () => {
        const reasoning = { content: [{ text: BIG, type: "reasoning" }], role: "assistant" } as ModelMessage;

        expect(estimateTokens([reasoning])).toBeGreaterThanOrEqual(BIG.length / 4);
    });
});

describe("compressContextMessages", () => {
    it("returns the same array when under the threshold", () => {
        const small = thread(1, 1, "short");

        expect(compressContextMessages(small, LIMIT)).toBe(small);
    });

    it("returns the same array when over the threshold but nothing can be cut or elided", () => {
        const single = [system("sys"), user("y".repeat(4000))];

        expect(compressContextMessages(single, LIMIT)).toBe(single);
    });

    it("cuts before a tool result's call rather than between them", () => {
        // Six kept messages from the end land on the result r1, which would orphan it.
        const messages = [
            system("sys"),
            user("q0"),
            answer(BIG),
            call("c1"),
            result("c1"),
            call("c2"),
            result("c2"),
            answer(BIG),
            user("latest"),
            answer("ok"),
        ];
        const output = compressContextMessages(messages, LIMIT);

        expect(output).not.toBe(messages);
        expect(output.filter((m) => m.role !== "system")[1]).toBe(messages[3]);
        assertWellFormed(messages, output);
    });

    it("cuts on an assistant message when the naive cut lands on a user message", () => {
        // Six from the end would start on the user message before the latest answer.
        const messages = [system("sys"), user(BIG), answer(BIG), user(BIG), answer(BIG), user(BIG), answer(BIG), user("latest"), answer(BIG)];
        const output = compressContextMessages(messages, LIMIT);

        expect(output).not.toBe(messages);
        assertWellFormed(messages, output);
    });

    it("keeps the latest user turn as the same object", () => {
        const latest = user("latest");
        const messages = [system("sys"), user(BIG), answer(BIG), call("c1"), result("c1"), answer(BIG), latest, call("c2"), result("c2")];
        // `latest` is at index 5 of the conversation; the naive cut lands on c1 (an assistant).
        const output = compressContextMessages(messages, LIMIT);

        expect(output).toContain(latest);
        assertWellFormed(messages, output);
    });

    it("keeps image and file parts in kept messages untouched", () => {
        const media = {
            content: [
                { text: "look", type: "text" },
                { image: "data:image/png;base64,AAAA", mediaType: "image/png", type: "image" },
                { data: "data:application/pdf;base64,BBBB", filename: "a.pdf", mediaType: "application/pdf", type: "file" },
            ],
            role: "user",
        } as unknown as ModelMessage;
        const messages = [system("sys"), user(BIG), answer(BIG), user(BIG), call("c1"), result("c1"), answer(BIG), media];
        const output = compressContextMessages(messages, LIMIT);

        expect(output).not.toBe(messages);
        expect(output).toContain(media);
        expect(output.at(-1)).toBe(media);
        assertWellFormed(messages, output);
    });

    it("elides older tool outputs of the current turn and keeps the final result", () => {
        const latest = user("latest");
        const messages = [system("sys"), latest, call("c1"), result("c1"), call("c2"), result("c2"), call("c3"), result("c3")];
        const output = compressContextMessages(messages, LIMIT);
        const elidedCall = output[2];
        const elided = output[3];
        const elidedSecond = output[5];
        const kept = output[7];

        expect(output).not.toBe(messages);
        expect(output).toContain(latest);
        expect(elided).toMatchObject({ content: [{ output: { type: "text", value: "[Tool output removed to fit the context window]" }, toolCallId: "c1" }] });
        expect(elidedSecond).toMatchObject({ content: [{ toolCallId: "c2" }] });
        expect(elidedCall).toBe(messages[2]);
        expect(kept).toBe(messages[7]);
        assertWellFormed(messages, output);
    });

    it("keeps the invariants across generated threads", () => {
        let compressedCount = 0;

        for (const turns of [1, 2, 3, 5, 8]) {
            for (const steps of [0, 1, 2, 4]) {
                const messages = thread(turns, steps);
                const output = compressContextMessages(messages, LIMIT);

                if (output !== messages) {
                    compressedCount += 1;
                }

                assertWellFormed(messages, output);
            }
        }

        expect(compressedCount).toBeGreaterThan(10);
    });
});

describe("applyLateCompression", () => {
    it("fits a single turn whose tool results pile up across steps", () => {
        // Ten steps of 40k-character results in one turn: the first-step check alone
        // would have counted them as ~2 characters each and sent all of it.
        const latest = user("latest");
        const messages = [system("sys"), latest];

        for (let i = 0; i < 10; i += 1) {
            messages.push(call(`c${i}`), result(`c${i}`, "y".repeat(40_000)));
        }

        const output = applyLateCompression(messages, "gpt-4o");

        expect(output).not.toBe(messages);
        expect(estimateTokens(output)).toBeLessThan(128_000 * 0.85);
        expect(output).toContain(latest);
        assertWellFormed(messages, output);
    });
});

describe("buildRunStreamArgs", () => {
    it("installs compression for every run, not only auto-continue ones", () => {
        const { prepareStep } = buildRunStreamArgs({ model: "gpt-4o", reasoningEffort: undefined }) as {
            prepareStep: (options: { messages: ModelMessage[] }) => { messages: ModelMessage[] } | undefined;
        };

        expect(prepareStep({ messages: [system("sys"), user("hi")] })).toBeUndefined();

        // ~300k tokens: over the 80% line of gpt-4o's 128k window.
        const big = thread(10, 2, "y".repeat(40_000));
        const stepped = prepareStep({ messages: big });

        expect(stepped?.messages.length).toBeLessThan(big.length);
        assertWellFormed(big, stepped!.messages);
    });
});
