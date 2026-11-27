/**
 * An approved browser call's result reaches the model through its tool's `toModelOutput`, which names a saved screenshot by its
 * signed URL. In local dev that URL is localhost, which no provider can load: its bytes are inlined instead.
 */
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inlineToolResultImages, isLocalOrigin, SCREENSHOT_UNAVAILABLE_NOTE } from "./files";

const toolMessage = (urls: string[]): ModelMessage => {
    return {
        content: [
            {
                output: {
                    type: "content",
                    value: [
                        ...urls.map((url) => {
                            return { type: "image-url" as const, url };
                        }),
                        { text: "page: Example", type: "text" as const },
                    ],
                },
                toolCallId: "call-1",
                toolName: "browser",
                type: "tool-result",
            },
        ],
        role: "tool",
    };
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(inlineToolResultImages, () => {
    it("inlines a localhost screenshot URL as image data, and leaves a reachable URL and the text as they are", async () => {
        const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg; q=1" }, status: 200 }));

        vi.stubGlobal("fetch", fetchMock);

        const [message] = await inlineToolResultImages([toolMessage(["http://localhost:8788/storage/shot?sig=a", "https://cdn.example.com/shot.png"])]);

        expect(message).toStrictEqual({
            content: [
                {
                    output: {
                        type: "content",
                        value: [
                            { data: "AQID", mediaType: "image/jpeg", type: "image-data" },
                            { type: "image-url", url: "https://cdn.example.com/shot.png" },
                            { text: "page: Example", type: "text" },
                        ],
                    },
                    toolCallId: "call-1",
                    toolName: "browser",
                    type: "tool-result",
                },
            ],
            role: "tool",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("inlines a screenshot URL on IPv6 or any IPv4 loopback address, and fetches no other address", async () => {
        const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" }, status: 200 }));

        vi.stubGlobal("fetch", fetchMock);

        const loopback = ["http://[::1]:8788/storage/shot?sig=a", "http://127.0.0.2:8788/storage/shot", "http://127.1:8788/storage/shot"];
        const elsewhere = ["http://[::2]:8788/storage/shot", "https://128.0.0.1/storage/shot", "https://127.0.0.1.example.com/storage/shot"];
        const [message] = await inlineToolResultImages([toolMessage([...loopback, ...elsewhere])]);
        const { value } = (message as { content: { output: { value: { type: string }[] } }[] }).content[0]!.output;

        expect(value.map((item) => item.type)).toStrictEqual(["image-data", "image-data", "image-data", "image-url", "image-url", "image-url", "text"]);
        expect(fetchMock).toHaveBeenCalledTimes(loopback.length);
    });

    it("fetches nothing for messages that are not tool results", async () => {
        const fetchMock = vi.fn();

        vi.stubGlobal("fetch", fetchMock);

        const messages: ModelMessage[] = [{ content: "hello", role: "user" }, toolMessage(["https://cdn.example.com/shot.png"])];

        await expect(inlineToolResultImages(messages)).resolves.toStrictEqual(messages);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("replaces a screenshot it cannot load (expired, or storage down) with a note, and still inlines the others", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);

            if (url.includes("expired")) {
                return new Response("expired", { status: 403, statusText: "Forbidden" });
            }

            if (url.includes("down")) {
                throw new TypeError("fetch failed");
            }

            return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" }, status: 200 });
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        vi.stubGlobal("fetch", fetchMock);

        const [message] = await inlineToolResultImages([
            toolMessage(["http://localhost:8788/storage/expired", "http://localhost:8788/storage/down", "http://localhost:8788/storage/ok"]),
        ]);
        const { value } = (message as { content: { output: { value: unknown[] } }[] }).content[0]!.output;

        expect(value).toStrictEqual([
            { text: SCREENSHOT_UNAVAILABLE_NOTE, type: "text" },
            { text: SCREENSHOT_UNAVAILABLE_NOTE, type: "text" },
            { data: "AQID", mediaType: "image/png", type: "image-data" },
            { text: "page: Example", type: "text" },
        ]);
        expect(warn).toHaveBeenCalledTimes(2);

        warn.mockRestore();
    });
});

describe(isLocalOrigin, () => {
    it("takes an IPv6 loopback origin, `URL` writing its host in brackets, as local dev", () => {
        expect(isLocalOrigin("http://[::1]:8788")).toBe(true);
        expect(isLocalOrigin("http://[0:0:0:0:0:0:0:1]:8788")).toBe(true);
    });

    it("takes localhost and every IPv4 loopback address as local dev, and nothing else", () => {
        expect(isLocalOrigin("http://localhost:5173")).toBe(true);
        expect(isLocalOrigin("http://127.0.0.1:8788")).toBe(true);
        expect(isLocalOrigin("http://127.0.1.1:8788")).toBe(true);
        expect(isLocalOrigin("https://neore.example.com")).toBe(false);
        expect(isLocalOrigin("http://[::2]:8788")).toBe(false);
        expect(isLocalOrigin("https://127.0.0.1.example.com")).toBe(false);
        expect(isLocalOrigin(undefined)).toBe(false);
        expect(isLocalOrigin("not a url")).toBe(false);
    });
});
