import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";

import { INTERRUPTED_TOOL_CALL_ERROR, repairUIMessageChunks, updateFromUIMessageChunks } from "./deltas";
import type { UIMessage } from "./ui-messages";

const blank = (): UIMessage =>
    ({
        _creationTime: 0,
        id: "stream:s1",
        key: "t-0-0",
        order: 0,
        parts: [],
        role: "assistant",
        status: "streaming",
        stepOrder: 0,
        text: "",
    }) as UIMessage;

const rebuild = async (chunks: UIMessageChunk[], isTerminal: boolean) => updateFromUIMessageChunks(blank(), repairUIMessageChunks(chunks, { isTerminal }));

const TEXT: UIMessageChunk[] = [
    { type: "start" },
    { type: "start-step" },
    { id: "x", type: "text-start" },
    { delta: "Looking that up", id: "x", type: "text-delta" },
    { id: "x", type: "text-end" },
];

describe(repairUIMessageChunks, () => {
    it("keeps a live, partial tool call as input-streaming", async () => {
        expect.assertions(2);

        const message = await rebuild(
            [
                ...TEXT,
                { toolCallId: "t1", toolName: "search", type: "tool-input-start" },
                { inputTextDelta: '{"q":"he', toolCallId: "t1", type: "tool-input-delta" },
            ],
            false,
        );

        expect(message.text).toBe("Looking that up");
        expect(message.parts.at(-1)).toMatchObject({ input: { q: "he" }, state: "input-streaming", toolCallId: "t1", type: "tool-search" });
    });

    it("closes a partial tool call as an error once the stream is over", async () => {
        expect.assertions(1);

        const message = await rebuild(
            [
                ...TEXT,
                { toolCallId: "t1", toolName: "search", type: "tool-input-start" },
                { inputTextDelta: '{"q":"he', toolCallId: "t1", type: "tool-input-delta" },
            ],
            true,
        );

        expect(message.parts.at(-1)).toMatchObject({ errorText: INTERRUPTED_TOOL_CALL_ERROR, state: "output-error", toolCallId: "t1", type: "tool-search" });
    });

    it("does not lose the whole message to a delta whose tool-input-start is missing", async () => {
        expect.assertions(3);

        const chunks: UIMessageChunk[] = [...TEXT, { inputTextDelta: "{", toolCallId: "orphan", type: "tool-input-delta" }];

        // The unrepaired stream is what used to fail.
        await expect(updateFromUIMessageChunks(blank(), chunks)).rejects.toThrow("tool-input-delta");

        const message = await rebuild(chunks, true);

        expect(message.text).toBe("Looking that up");
        expect(message.parts.some((p) => "toolCallId" in p)).toBe(false);
    });

    it("drops outputs, approvals and text deltas that refer to nothing", async () => {
        expect.assertions(1);

        const repaired = repairUIMessageChunks(
            [
                { type: "start" },
                { output: 1, toolCallId: "gone", type: "tool-output-available" },
                { errorText: "x", toolCallId: "gone", type: "tool-output-error" },
                { toolCallId: "gone", type: "tool-output-denied" },
                { approvalId: "a1", toolCallId: "gone", type: "tool-approval-request" },
                { delta: "stray", id: "never-started", type: "text-delta" },
                { id: "never-started", type: "reasoning-end" },
            ],
            { isTerminal: true },
        );

        expect(repaired).toStrictEqual([{ type: "start" }]);
    });

    it("leaves a complete tool call untouched", async () => {
        expect.assertions(2);

        const chunks: UIMessageChunk[] = [
            ...TEXT,
            { toolCallId: "t1", toolName: "search", type: "tool-input-start" },
            { inputTextDelta: '{"q":"hello"}', toolCallId: "t1", type: "tool-input-delta" },
            { input: { q: "hello" }, toolCallId: "t1", toolName: "search", type: "tool-input-available" },
            { output: "ok", toolCallId: "t1", type: "tool-output-available" },
        ];

        expect(repairUIMessageChunks(chunks, { isTerminal: true })).toStrictEqual(chunks);

        const message = await rebuild(chunks, true);

        expect(message.parts.at(-1)).toMatchObject({ output: "ok", state: "output-available" });
    });
});
