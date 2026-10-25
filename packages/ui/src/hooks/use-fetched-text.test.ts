import { describe, expect, it } from "vitest";

import { MAX_FETCHED_TEXT_BYTES, readTextWithin } from "./use-fetched-text";

const encoder = new TextEncoder();

const LARGER_THAN_100 = /larger than 100 bytes/u;
const LARGER_THAN_25 = /larger than 25 bytes/u;
const LARGER_THAN_3 = /larger than 3 bytes/u;

/** A body that arrives in the given chunks, with no Content-Length, like a chunked response. */
const streamed = (chunks: Uint8Array[], headers?: HeadersInit): Response =>
    new Response(
        new ReadableStream({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(chunk);
                }

                controller.close();
            },
        }),
        { headers },
    );

describe(readTextWithin, () => {
    it("reads a body within the budget", async () => {
        await expect(readTextWithin(new Response("a,b\n1,2\n"), 100)).resolves.toBe("a,b\n1,2\n");
    });

    it("accepts a body exactly at the budget", async () => {
        const response = streamed([encoder.encode("12345")]);

        await expect(readTextWithin(response, 5)).resolves.toBe("12345");
    });

    it("refuses on a declared Content-Length over the budget without reading the body", async () => {
        const response = new Response("tiny", { headers: { "content-length": "101" } });

        await expect(readTextWithin(response, 100)).rejects.toThrow(LARGER_THAN_100);
    });

    it("refuses a body with no Content-Length once the bytes read pass the budget, and stops reading", async () => {
        let pulled = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                controller.enqueue(encoder.encode("x".repeat(10)));
            },
        });

        await expect(readTextWithin(new Response(body), 25)).rejects.toThrow(LARGER_THAN_25);
        // Three chunks pass the budget; a runaway body would pull far more.
        expect(pulled).toBeLessThan(10);
    });

    it("counts bytes, not characters", async () => {
        // "é" is two bytes in UTF-8.
        const response = streamed([encoder.encode("éé")]);

        await expect(readTextWithin(response, 3)).rejects.toThrow(LARGER_THAN_3);
    });

    it("keeps a multi-byte character that is split across chunks", async () => {
        const bytes = encoder.encode("a€b");

        const response = streamed([bytes.slice(0, 2), bytes.slice(2)]);

        await expect(readTextWithin(response, 100)).resolves.toBe("a€b");
    });

    it("reads an empty body", async () => {
        await expect(readTextWithin(new Response(""), 10)).resolves.toBe("");
    });

    it("is 1 MB for a preview", () => {
        expect(MAX_FETCHED_TEXT_BYTES).toBe(1_000_000);
    });
});
