import { describe, expect, it } from "vitest";

import { toStorageRef } from "../lib/storage-ref";
import { copyStoredObjects, rewriteStorageKeys } from "./fork-copy";

const ORIGIN = "http://localhost:8788";

/** An in-memory bucket with the `download`/`store` shape `ctx.storage` has. */
const createBucket = (objects: Record<string, { bytes: string; contentType?: string }>) => {
    const stored = new Map(Object.entries(objects));

    return {
        download: async (key: string) => {
            const object = stored.get(key);

            if (!object) {
                return null;
            }

            const bytes = new TextEncoder().encode(object.bytes);

            return { body: new Response(bytes).body, httpMetadata: { contentType: object.contentType }, size: bytes.byteLength };
        },
        store: async (key: string, body: ArrayBuffer, options?: { contentType?: string }) => {
            stored.set(key, { bytes: new TextDecoder().decode(body), contentType: options?.contentType });
        },
        stored,
    };
};

describe(copyStoredObjects, () => {
    it("copies the bytes and content type to the new key and leaves the source in place", async () => {
        const bucket = createBucket({ author: { bytes: "png-bytes", contentType: "image/png" } });

        await expect(copyStoredObjects(bucket, [{ from: "author", to: "forker" }])).resolves.toStrictEqual(["forker"]);
        expect(bucket.stored.get("forker")).toStrictEqual({ bytes: "png-bytes", contentType: "image/png" });
        expect(bucket.stored.get("author")).toStrictEqual({ bytes: "png-bytes", contentType: "image/png" });
    });

    it("skips an object that is gone and still copies the rest", async () => {
        const bucket = createBucket({ kept: { bytes: "b" } });

        await expect(
            copyStoredObjects(bucket, [
                { from: "deleted", to: "copy-1" },
                { from: "kept", to: "copy-2" },
            ]),
        ).resolves.toStrictEqual(["copy-2"]);
        expect(bucket.stored.has("copy-1")).toBe(false);
    });
});

describe("a copy that fails for a reason other than a missing object", () => {
    it("copies the rest, then throws so the scheduler retries the job", async () => {
        const bucket = createBucket({ "good-1": { bytes: "a" }, "good-2": { bytes: "b" } });
        const flaky = {
            ...bucket,
            download: async (key: string) => {
                if (key === "broken") {
                    throw new Error("R2 503");
                }

                return await bucket.download(key);
            },
        };

        await expect(
            copyStoredObjects(flaky, [
                { from: "broken", to: "copy-broken" },
                { from: "good-1", to: "copy-1" },
                { from: "good-2", to: "copy-2" },
            ]),
        ).rejects.toThrow(/1 vault object\(s\) failed to copy/u);
        expect(bucket.stored.has("copy-1")).toBe(true);
        expect(bucket.stored.has("copy-2")).toBe(true);
    });
});

describe(rewriteStorageKeys, () => {
    it("points URL-named fields at the copy, as a reference or as a signed URL, and leaves text alone", () => {
        const copies = new Map([["author-key", "forker-key"]]);
        const value = {
            content: toStorageRef("author-key"),
            nodes: [
                {
                    data: {
                        imageUrl: `${ORIGIN}/author-key?exp=1&method=GET&bucket=default&sig=x`,
                        imageUrls: [toStorageRef("author-key")],
                        maskUrl: toStorageRef("other"),
                    },
                },
            ],
        };

        expect(rewriteStorageKeys(value, copies, [ORIGIN])).toStrictEqual({
            // A text field is user-authored: never rewritten.
            content: toStorageRef("author-key"),
            nodes: [{ data: { imageUrl: toStorageRef("forker-key"), imageUrls: [toStorageRef("forker-key")], maskUrl: toStorageRef("other") } }],
        });
    });
});
