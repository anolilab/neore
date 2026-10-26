import { afterEach, describe, expect, it, vi } from "vitest";

import { dataUrlResponse, loadResource, MAX_FETCHED_TEXT_BYTES, readTextWithin } from "./use-fetched-text";

const encoder = new TextEncoder();

const LARGER_THAN_100 = /larger than 100 bytes/u;
const LARGER_THAN_25 = /larger than 25 bytes/u;
const LARGER_THAN_3 = /larger than 3 bytes/u;
const LARGER_THAN_7 = /larger than 7 bytes/u;

/** `text` (BMP characters only, where a code point is a code unit) as UTF-16 in the given byte order, after `mark`. */
const utf16 = (text: string, order: "be" | "le", mark: number[]): Uint8Array<ArrayBuffer> => {
    const bytes = [...mark];

    for (let index = 0; index < text.length; index += 1) {
        const unit = text.codePointAt(index) ?? 0;
        const high = unit >> 8;
        const low = unit & 0xff;

        bytes.push(...(order === "le" ? [low, high] : [high, low]));
    }

    return new Uint8Array(bytes);
};

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

    it("decodes a UTF-16LE body from its byte-order mark, without the mark", async () => {
        const response = streamed([utf16("a,é\n€,2\n", "le", [0xff, 0xfe])]);

        await expect(readTextWithin(response, 100)).resolves.toBe("a,é\n€,2\n");
    });

    it("decodes a UTF-16BE body from its byte-order mark, without the mark", async () => {
        const response = streamed([utf16("a,é\n€,2\n", "be", [0xfe, 0xff])]);

        await expect(readTextWithin(response, 100)).resolves.toBe("a,é\n€,2\n");
    });

    it("decides the encoding even when the first chunk is one byte, and across a split code unit", async () => {
        const bytes = utf16("a€b", "le", [0xff, 0xfe]);

        // Chunks of 1, 2, 1 and 4 bytes: the mark is split, and so is the "a" code unit.
        const response = streamed([bytes.slice(0, 1), bytes.slice(1, 3), bytes.slice(3, 4), bytes.slice(4)]);

        await expect(readTextWithin(response, 100)).resolves.toBe("a€b");
    });

    it("decodes a UTF-16 body that has no stream", async () => {
        const response = new Response(utf16("a€b", "le", [0xff, 0xfe]));

        Object.defineProperty(response, "body", { value: null });

        await expect(readTextWithin(response, 100)).resolves.toBe("a€b");
    });

    it("decodes a UTF-8 body with a byte-order mark, without the mark", async () => {
        const body = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("a€b")]);
        const response = streamed([body]);

        await expect(readTextWithin(response, 100)).resolves.toBe("a€b");
    });

    it("reads a one-byte body as UTF-8", async () => {
        const response = streamed([new Uint8Array([0x61])]);

        await expect(readTextWithin(response, 100)).resolves.toBe("a");
    });

    it("counts the bytes of a UTF-16 body against the budget", async () => {
        // 2 bytes of mark + 2 per character: 8 bytes for "abc", over a budget of 7, though "abc" is 3 characters.
        const body = utf16("abc", "le", [0xff, 0xfe]);

        await expect(readTextWithin(streamed([body]), 7)).rejects.toThrow(LARGER_THAN_7);
        await expect(readTextWithin(streamed([body]), 8)).resolves.toBe("abc");
    });

    it("reads an empty body", async () => {
        await expect(readTextWithin(new Response(""), 10)).resolves.toBe("");
    });

    it("is 1 MB for a preview", () => {
        expect(MAX_FETCHED_TEXT_BYTES).toBe(1_000_000);
    });
});

describe(dataUrlResponse, () => {
    it("decodes a base64 data URL without fetch", async () => {
        const payload = btoa("a,b\n1,2\n");
        const response = dataUrlResponse(`data:text/csv;charset=utf-8;base64,${payload}`);

        expect(response.headers.get("content-type")).toBe("text/csv");
        await expect(readTextWithin(response, 100)).resolves.toBe("a,b\n1,2\n");
    });

    it("decodes a base64 data URL that carries UTF-16LE text, from its byte-order mark", async () => {
        const bytes = utf16("a,€\n1,2\n", "le", [0xff, 0xfe]);
        const binary = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
        const response = dataUrlResponse(`data:text/csv;base64,${btoa(binary)}`);

        await expect(readTextWithin(response, 100)).resolves.toBe("a,€\n1,2\n");
    });

    it("refuses an oversized base64 payload before decoding it", () => {
        expect(() => dataUrlResponse(`data:text/plain;base64,${"A".repeat(MAX_FETCHED_TEXT_BYTES * 2)}`)).toThrow();
    });

    it("decodes percent-encoded text whose escaped form is longer than the limit", async () => {
        const text = "é".repeat(170_000);
        const response = dataUrlResponse(`data:text/plain,${encodeURIComponent(text)}`);

        await expect(readTextWithin(response, MAX_FETCHED_TEXT_BYTES)).resolves.toBe(text);
    });

    it("decodes a percent-encoded data URL, UTF-8 included", async () => {
        const response = dataUrlResponse(`data:text/plain,${encodeURIComponent("a€b\nc,d")}`);

        await expect(readTextWithin(response, 100)).resolves.toBe("a€b\nc,d");
    });

    it("applies the byte budget to the decoded bytes", async () => {
        const base64 = dataUrlResponse(`data:text/plain;base64,${btoa("x".repeat(26))}`);
        const percent = dataUrlResponse(`data:text/plain,${"x".repeat(26)}`);

        await expect(readTextWithin(base64, 25)).rejects.toThrow(LARGER_THAN_25);
        await expect(readTextWithin(percent, 25)).rejects.toThrow(LARGER_THAN_25);

        const atLimit = dataUrlResponse(`data:text/plain,${"x".repeat(25)}`);

        await expect(readTextWithin(atLimit, 25)).resolves.toHaveLength(25);
    });

    it("throws on a malformed payload so the preview shows its error state", () => {
        expect(() => dataUrlResponse("data:text/plain")).toThrow(Error);
        expect(() => dataUrlResponse("data:text/plain;base64,@@@")).toThrow(Error);
    });
});

describe(loadResource, () => {
    const APP = "https://app.example";
    const BACKEND = "https://api.example";
    const readText = async (response: Response): Promise<string> => await response.text();

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const run = async (url: string, fetchSpy: ReturnType<typeof vi.fn>) => {
        vi.stubGlobal("location", { origin: APP });
        vi.stubGlobal("fetch", fetchSpy);

        return await loadResource(url, readText, new AbortController().signal, [BACKEND]);
    };

    it("refuses redirects on a fetched URL, so a redirect cannot reach another host", async () => {
        const fetchSpy = vi.fn(async () => new Response("a,b"));

        await run(`${BACKEND}/files/a.csv`, fetchSpy);

        expect(fetchSpy).toHaveBeenCalledWith(`${BACKEND}/files/a.csv`, expect.objectContaining({ redirect: "error" }));
    });

    it("decodes an uppercase DATA: URL locally, without fetch", async () => {
        const fetchSpy = vi.fn();

        await expect(run("DATA:text/plain,hello", fetchSpy)).resolves.toStrictEqual({ status: "ready", value: "hello" });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("does not fetch a foreign origin, a loopback service or another scheme", async () => {
        const fetchSpy = vi.fn();

        for (const url of ["https://evil.example/a.csv", "http://localhost:11434/api/tags", "ftp://api.example/a.csv", "https://api.example.evil.test/a"]) {
            await expect(run(url, fetchSpy)).resolves.toStrictEqual({ status: "error" });
        }

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("fetches the backend origin and the page's own origin", async () => {
        const fetchSpy = vi.fn(async () => new Response("ok"));

        await expect(run(`${BACKEND}/files/a.csv?sig=1`, fetchSpy)).resolves.toStrictEqual({ status: "ready", value: "ok" });
        await expect(run(`${APP}/a.csv`, fetchSpy)).resolves.toStrictEqual({ status: "ready", value: "ok" });
        await expect(run("/a.csv", fetchSpy)).resolves.toStrictEqual({ status: "ready", value: "ok" });
        expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("reads a data: URL without fetching", async () => {
        const fetchSpy = vi.fn();

        await expect(run("data:text/plain,hello", fetchSpy)).resolves.toStrictEqual({ status: "ready", value: "hello" });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
