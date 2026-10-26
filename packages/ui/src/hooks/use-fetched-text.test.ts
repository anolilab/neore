import { afterEach, describe, expect, it, vi } from "vitest";

import { dataUrlResponse, loadResource, MAX_FETCHED_TEXT_BYTES, readTextWithin } from "./use-fetched-text";

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

describe(dataUrlResponse, () => {
    it("decodes a base64 data URL without fetch", async () => {
        const payload = btoa("a,b\n1,2\n");
        const response = dataUrlResponse(`data:text/csv;charset=utf-8;base64,${payload}`);

        expect(response.headers.get("content-type")).toBe("text/csv");
        await expect(readTextWithin(response, 100)).resolves.toBe("a,b\n1,2\n");
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
