import { describe, expect, it, vi } from "vitest";

import type { StorageReader } from "./storage-read";
import { ATTACHMENT_URL_TTL_SECONDS, readStoredObject, readStoredText, signedReadUrl } from "./storage-read";

const streamOf = (text: string) => new Response(text).body!;

const readerWith = (objects: Record<string, { contentType?: string; text: string }>) => {
    const cancelled: string[] = [];
    const reader: StorageReader = {
        download: vi.fn(async (key: string) => {
            const object = objects[key];

            if (!object) {
                return null;
            }

            const body = streamOf(object.text);
            const originalCancel = body.cancel.bind(body);

            body.cancel = async (reason?: unknown) => {
                cancelled.push(key);

                await originalCancel(reason);
            };

            return { body, httpMetadata: { contentType: object.contentType }, size: new TextEncoder().encode(object.text).byteLength };
        }),
    };

    return { cancelled, reader };
};

describe("server-side storage reads", () => {
    it("reads bytes and text through the binding, with the stored content type", async () => {
        const { reader } = readerWith({ "k/a.txt": { contentType: "text/plain", text: "héllo" } });

        const object = await readStoredObject(reader, "k/a.txt", { maxBytes: 100 });

        expect(new TextDecoder().decode(object.bytes)).toBe("héllo");
        expect(object.contentType).toBe("text/plain");
        expect(await readStoredText(reader, "k/a.txt", { maxBytes: 100 })).toBe("héllo");
    });

    it("answers NOT_FOUND for a missing object", async () => {
        const { reader } = readerWith({});

        await expect(readStoredObject(reader, "missing", { maxBytes: 100 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses an oversized object before reading it, and releases the body", async () => {
        const { cancelled, reader } = readerWith({ big: { text: "x".repeat(200) } });

        await expect(readStoredObject(reader, "big", { maxBytes: 100 })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
        expect(cancelled).toEqual(["big"]);
    });

    it("fails loudly without a storage binding", async () => {
        await expect(readStoredObject(undefined, "k", { maxBytes: 1 })).rejects.toMatchObject({ code: "INTERNAL" });
    });

    it("signs third-party URLs as short-lived GETs", async () => {
        const getSignedUrl = vi.fn(async () => "https://backend.test/k?sig=1");

        expect(await signedReadUrl({ getSignedUrl }, "agent-files/abc")).toBe("https://backend.test/k?sig=1");
        expect(getSignedUrl).toHaveBeenCalledWith("agent-files/abc", { expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS });
    });
});
