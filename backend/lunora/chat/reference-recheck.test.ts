import { describe, expect, it } from "vitest";

import type { StorageReader } from "../lib/storage-read";
import { referenceBytesForProvider } from "./reference-recheck";

const PNG = new Uint8Array([137, 80, 78, 71, 255]);
const SIGNED_URL = "https://files.example.test/k1?exp=2000000000&method=GET&bucket=b&sig=abc";

const PNG_DATA_URI = /^data:image\/png;base64,/u;

const storageWith = (objects: Record<string, { bytes: Uint8Array; contentType: string }>): StorageReader => {
    return {
        download: async (key) => {
            const object = objects[key];

            if (!object) {
                return null;
            }

            return { body: new Blob([object.bytes]).stream(), httpMetadata: { contentType: object.contentType }, size: object.bytes.byteLength };
        },
    };
};

describe("referenceBytesForProvider", () => {
    it("sends a file's bytes inline, never its signed URL", async () => {
        const storage = storageWith({ k1: { bytes: PNG, contentType: "image/png" } });

        const [copied] = await referenceBytesForProvider(storage, [SIGNED_URL], ["k1"]);

        expect(copied).toBe(`data:image/png;base64,${btoa(String.fromCodePoint(...PNG))}`);
        expect(copied).not.toContain("sig=");
    });

    it("passes a document's inline content through, beside a copied file", async () => {
        const storage = storageWith({ k1: { bytes: PNG, contentType: "image/png" } });
        const doc = "data:image/png;base64,AAAA";

        const copied = await referenceBytesForProvider(storage, [doc, SIGNED_URL], ["", "k1"]);

        expect(copied[0]).toBe(doc);
        expect(copied[1]).toMatch(PNG_DATA_URI);
    });

    it("fails the job when a file's object is missing, rather than sending its URL", async () => {
        await expect(referenceBytesForProvider(storageWith({}), [SIGNED_URL], ["gone"])).rejects.toThrow();
    });

    it("refuses a stored object that is not an image", async () => {
        const storage = storageWith({ k1: { bytes: new Uint8Array([1, 2]), contentType: "text/html" } });

        await expect(referenceBytesForProvider(storage, [SIGNED_URL], ["k1"])).rejects.toThrow("not an image");
    });

    it("fails closed without storage", async () => {
        await expect(referenceBytesForProvider(undefined, [SIGNED_URL], ["k1"])).rejects.toThrow();
    });

    it("keeps the copy once the stored object is gone, as a grant revoked after the copy would leave it", async () => {
        const objects: Record<string, { bytes: Uint8Array; contentType: string }> = { k1: { bytes: PNG, contentType: "image/png" } };

        const [copied] = await referenceBytesForProvider(storageWith(objects), [SIGNED_URL], ["k1"]);

        delete objects["k1"];

        expect(copied).toBe(`data:image/png;base64,${btoa(String.fromCodePoint(...PNG))}`);
    });
});
