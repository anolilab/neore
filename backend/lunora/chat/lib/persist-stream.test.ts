import { describe, expect, it, vi } from "vitest";

import { MAX_FLUSH_INTERVAL_MS, pipeToPersistentChunks, StreamFailedError } from "./persist-stream";

const streamOf = async function* (parts: { error?: unknown; text?: string; type: string }[]) {
    yield* parts;
};

const makeCtx = () => {
    const chunks: { final: boolean; reasoning?: string; text: string }[] = [];
    const runMutation = vi.fn(async (_reference: unknown, args: { final: boolean; reasoning?: string; text: string }) => {
        chunks.push({ final: args.final, reasoning: args.reasoning, text: args.text });

        return null;
    });

    return { chunks, ctx: { runMutation } as unknown as Parameters<typeof pipeToPersistentChunks>[0] };
};

describe(pipeToPersistentChunks, () => {
    it("flushes reasoning at its end and text at sentence delimiters", async () => {
        const { chunks, ctx } = makeCtx();

        const result = await pipeToPersistentChunks(
            ctx,
            "s1",
            streamOf([
                { text: "Think", type: "reasoning-delta" },
                { type: "reasoning-end" },
                { text: "Hi.", type: "text-delta" },
                { text: " tail", type: "text-delta" },
            ]),
        );

        expect(chunks).toStrictEqual([
            { final: false, reasoning: "Think", text: "" },
            { final: false, reasoning: undefined, text: "Hi." },
        ]);
        expect(result.pending).toStrictEqual({ reasoning: "", text: " tail" });
    });

    it("drains the stream, flushes partial text and throws on an error part", async () => {
        const { chunks, ctx } = makeCtx();
        let isDrained = false;

        const stream = (async function* erroringStream() {
            yield { text: "Partial", type: "text-delta" };
            yield { error: new Error("Rate limit exceeded"), type: "error" };
            yield { type: "finish" };
            isDrained = true;
        })();

        const promise = pipeToPersistentChunks(ctx, "s1", stream);

        await expect(promise).rejects.toBeInstanceOf(StreamFailedError);
        await expect(promise).rejects.toThrow("Rate limit exceeded");
        expect(isDrained).toBe(true);
        expect(chunks).toStrictEqual([{ final: false, reasoning: undefined, text: "Partial" }]);
    });

    it("carries a non-Error cause", async () => {
        const { ctx } = makeCtx();

        await expect(pipeToPersistentChunks(ctx, "s1", streamOf([{ error: { code: 500 }, type: "error" }]))).rejects.toThrow("Model stream failed");
    });

    it("writes the first delta at once, without waiting for a sentence to end", async () => {
        const { chunks, ctx } = makeCtx();

        const result = await pipeToPersistentChunks(
            ctx,
            "s1",
            streamOf([
                { text: "", type: "text-delta" },
                { text: "Once", type: "text-delta" },
                { text: " upon", type: "text-delta" },
                { text: " a time", type: "text-delta" },
            ]),
        );

        expect(chunks).toStrictEqual([{ final: false, reasoning: undefined, text: "Once" }]);
        expect(result.pending).toStrictEqual({ reasoning: "", text: " upon a time" });
    });

    it("writes a buffer older than the flush interval even with no delimiter in it", async () => {
        const { chunks, ctx } = makeCtx();
        let now = 1000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);

        const stream = (async function* codeStream() {
            yield { text: "const", type: "text-delta" };
            now += 10;
            yield { text: " a", type: "text-delta" };
            now += MAX_FLUSH_INTERVAL_MS;
            yield { text: " = 1", type: "text-delta" };
            now += 10;
            yield { text: "\n", type: "text-delta" };
        })();

        try {
            const result = await pipeToPersistentChunks(ctx, "s1", stream);

            expect(chunks).toStrictEqual([
                { final: false, reasoning: undefined, text: "const" },
                { final: false, reasoning: undefined, text: " a = 1" },
            ]);
            expect(result.pending).toStrictEqual({ reasoning: "", text: "\n" });
            expect(result.firstTokenTime).toBe(1000);
        } finally {
            clock.mockRestore();
        }
    });
});
