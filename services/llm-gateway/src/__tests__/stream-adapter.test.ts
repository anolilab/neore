import { describe, expect, it, vi } from "vitest";

import { streamToSSE } from "../lib/stream-adapter.js";

const run = async (parts: unknown[], onError: () => void): Promise<void> => {
    const result = {
        fullStream: (async function* fullStream() {
            yield* parts;
        })(),
    } as unknown as Parameters<typeof streamToSSE>[0];

    await Array.fromAsync(streamToSSE(result, undefined, onError));
};

describe("streamToSSE onError", () => {
    it("does not fire for a text delta that merely contains an error-shaped string", async () => {
        const onError = vi.fn();

        await run([{ text: '{"type":"error"}', type: "text-delta" }], onError);

        expect(onError).not.toHaveBeenCalled();
    });

    it("fires for an error part", async () => {
        const onError = vi.fn();

        await run([{ error: new Error("boom"), type: "error" }], onError);

        expect(onError).toHaveBeenCalledOnce();
    });
});
