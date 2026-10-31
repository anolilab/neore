/**
 * The upload route (`lib/upload-route.ts`) driven over TUS, end to end through
 * `@lunora/storage/upload`'s real handler and R2 binding provider, against an
 * in-memory bucket with R2's conditional puts and multipart rules.
 */
import type { R2UploadBucket } from "@lunora/storage/upload";
import { R2_PART_SIZE } from "@lunora/storage/upload";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { fakeBucket } from "../../test/fake-upload-bucket";
import { stagingKeyFor, stagingPrefixFor, uploadStatePrefixFor } from "./chat-upload-staging";
import { finalizeStagedReferenceMedia } from "./reference-media-upload";
import { handleUploadRequest, refuseDeclaredPurpose, UPLOAD_PATH } from "./upload-route";

const ORIGIN = "http://localhost:8788";
const ALICE = "user-alice";
const BOB = "user-bob";
const MB = 1024 * 1024;
const PDF_HEAD = new TextEncoder().encode("%PDF-1.7\n");

const contextFor = (userId: string | undefined, admitted = true) => {
    const runAfter = vi.fn(async () => "job");
    const runMutation = vi.fn(async () => {
        return { ok: admitted, retryAfter: admitted ? undefined : 4500 };
    });

    return {
        context: {
            auth: { userId },
            forShard: () => {
                return { runAction: vi.fn(), runMutation, runQuery: vi.fn() };
            },
            scheduler: { runAfter },
        },
        runAfter,
        runMutation,
    };
};

const metadata = (entries: Record<string, string>): string =>
    Object.entries(entries)
        .map(([key, value]) => `${key} ${btoa(value)}`)
        .join(",");

const send = async (bucket: R2UploadBucket, userId: string | undefined, request: Request, admitted = true) => {
    const { context } = contextFor(userId, admitted);

    return await handleUploadRequest(context as never, request, bucket);
};

const statusOf = async (bucket: R2UploadBucket, userId: string | undefined, request: Request, admitted = true): Promise<number> => {
    const response = await send(bucket, userId, request, admitted);

    return response.status;
};

const create = (size: number, type: string) =>
    new Request(`${ORIGIN}${UPLOAD_PATH}`, {
        headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(size), "Upload-Metadata": metadata({ filename: "doc", filetype: type }) },
        method: "POST",
    });

const patch = (url: string, offset: number, chunk: Uint8Array) =>
    new Request(url, {
        body: chunk,
        headers: { "Content-Type": "application/offset+octet-stream", "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset) },
        method: "PATCH",
    });

/** Upload `bytes` the way the browser's TUS client does: create, then PATCH in 5 MiB chunks. */
const upload = async (bucket: R2UploadBucket, userId: string, bytes: Uint8Array, type = "application/pdf") => {
    const created = await send(bucket, userId, create(bytes.byteLength, type));

    expect(created.status).toBe(201);

    const location = created.headers.get("Location")!;

    for (let offset = 0; offset < bytes.byteLength; offset += 5 * MB) {
        const response = await send(bucket, userId, patch(location, offset, bytes.subarray(offset, offset + 5 * MB)));

        expect(response.status).toBe(204);
    }

    return location.split("/").pop()!;
};

const pdf = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);

    bytes.set(PDF_HEAD);

    return bytes;
};

const createFor = (size: number, type: string, purpose?: string) =>
    new Request(`${ORIGIN}${UPLOAD_PATH}${purpose === undefined ? "" : `?purpose=${purpose}`}`, {
        headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(size), "Upload-Metadata": metadata({ filename: "clip", filetype: type }) },
        method: "POST",
    });

const mp4 = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);

    bytes.set([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom")]);

    return bytes;
};

describe(handleUploadRequest, () => {
    it("stores a document over 16 MiB under the caller's staging prefix, with its type, and schedules its reap", async () => {
        const { bucket, objects } = fakeBucket();
        const bytes = pdf(17 * MB);
        const { context, runAfter } = contextFor(ALICE);
        const created = await handleUploadRequest(context as never, create(bytes.byteLength, "application/pdf"), bucket);
        const location = created.headers.get("Location")!;
        const uploadId = location.split("/").pop()!;
        const key = `${stagingPrefixFor(ALICE)}${uploadId}`;

        expect(runAfter).toHaveBeenCalledWith(expect.any(Number), expect.anything(), { keys: [key] });

        for (let offset = 0; offset < bytes.byteLength; offset += 5 * MB) {
            expect(await statusOf(bucket, ALICE, patch(location, offset, bytes.subarray(offset, offset + 5 * MB)))).toBe(204);
        }

        expect(R2_PART_SIZE).toBeLessThan(bytes.byteLength);
        expect(objects.get(key)?.bytes.byteLength).toBe(bytes.byteLength);
        expect(objects.get(key)?.contentType).toBe("application/pdf");
        // Everything else written lives under the caller's own state prefix.
        expect([...objects.keys()].filter((name) => name !== key).every((name) => name.startsWith(uploadStatePrefixFor(ALICE)))).toBe(true);
    });

    it("refuses a declared size over the declared type's chat limit before storing anything", async () => {
        const { bucket, objects } = fakeBucket();

        expect(await statusOf(bucket, ALICE, create(25 * MB + 1, "application/pdf"))).toBe(413);
        expect(await statusOf(bucket, ALICE, create(20 * MB + 1, "image/png"))).toBe(413);
        expect(objects.size).toBe(0);
    });

    it("refuses a type off the allowlist", async () => {
        const { bucket, objects } = fakeBucket();

        expect(await statusOf(bucket, ALICE, create(10, "application/x-msdownload"))).toBe(415);
        expect(await statusOf(bucket, ALICE, create(10, "video/mp4"))).toBe(415);
        expect(objects.size).toBe(0);
    });

    it("never lets another user resume, read the offset of, or cancel an upload", async () => {
        const { bucket } = fakeBucket();
        const created = await send(bucket, ALICE, create(10, "application/pdf"));
        const location = created.headers.get("Location")!;
        const head = new Request(location, { headers: { "Tus-Resumable": "1.0.0" }, method: "HEAD" });
        const cancel = new Request(location, { headers: { "Tus-Resumable": "1.0.0" }, method: "DELETE" });

        expect(await statusOf(bucket, BOB, patch(location, 0, pdf(10)))).toBe(404);
        expect(await statusOf(bucket, BOB, head)).toBe(404);
        expect(await statusOf(bucket, BOB, cancel)).toBe(404);
        expect(await statusOf(bucket, ALICE, head.clone())).toBe(200);
    });

    it("names the object from the caller and the generated id, whatever the client sends", async () => {
        const { bucket, objects } = fakeBucket();
        const request = new Request(`${ORIGIN}${UPLOAD_PATH}`, {
            headers: {
                "Tus-Resumable": "1.0.0",
                "Upload-Length": "10",
                "Upload-Metadata": metadata({ filename: `../../${BOB}/x`, filetype: "application/pdf", id: "chosen", name: `uploads/${BOB}/chosen` }),
            },
            method: "POST",
        });
        const created = await send(bucket, ALICE, request);
        const location = created.headers.get("Location")!;

        await send(bucket, ALICE, patch(location, 0, pdf(10)));

        expect([...objects.keys()].filter((key) => key.startsWith("uploads/"))).toStrictEqual([`${stagingPrefixFor(ALICE)}${location.split("/").pop()!}`]);
    });

    it("answers 401 without an identity, 429 with Retry-After past the rate limit, and 405 to a read", async () => {
        const { bucket, objects } = fakeBucket();
        const id = await upload(bucket, ALICE, pdf(10));
        const limited = await send(bucket, ALICE, create(10, "application/pdf"), false);

        expect(await statusOf(bucket, undefined, create(10, "application/pdf"))).toBe(401);
        expect(limited.status).toBe(429);
        expect(limited.headers.get("Retry-After")).toBe("5");
        expect(limited.headers.get("Tus-Resumable")).toBe("1.0.0");
        expect(await statusOf(bucket, ALICE, new Request(`${ORIGIN}${UPLOAD_PATH}/${id}`))).toBe(405);
        expect([...objects.keys()].filter((key) => key.startsWith("uploads/"))).toHaveLength(1);
    });

    describe("purpose", () => {
        it("admits reference video and audio under reference-media, and refuses the same types under chat with 415", async () => {
            const { bucket } = fakeBucket();

            expect(await statusOf(bucket, ALICE, createFor(10, "video/mp4", "reference-media"))).toBe(201);
            expect(await statusOf(bucket, ALICE, createFor(10, "audio/mpeg", "reference-media"))).toBe(201);
            expect(await statusOf(bucket, ALICE, createFor(10, "video/mp4"))).toBe(415);
            expect(await statusOf(bucket, ALICE, createFor(10, "audio/mpeg", "chat"))).toBe(415);
        });

        it("caps reference creates by their own limits, and refuses non-reference types under reference-media", async () => {
            const { bucket } = fakeBucket();

            expect(await statusOf(bucket, ALICE, createFor(50 * MB + 1, "video/mp4", "reference-media"))).toBe(413);
            expect(await statusOf(bucket, ALICE, createFor(15 * MB + 1, "audio/wav", "reference-media"))).toBe(413);
            expect(await statusOf(bucket, ALICE, createFor(10, "application/pdf", "reference-media"))).toBe(415);
        });

        it("stamps a chat object chat and keeps it under the chat key", async () => {
            const { bucket, objects } = fakeBucket();
            const id = await upload(bucket, ALICE, pdf(10));

            expect(objects.get(stagingKeyFor(ALICE, id))?.customMetadata).toStrictEqual({ purpose: "chat" });
        });

        it("refuses a purpose on the public API's route, and names none otherwise", () => {
            expect(refuseDeclaredPurpose(new Request(`${ORIGIN}/api/v1/uploads?purpose=reference-media`, { method: "POST" }))?.status).toBe(400);
            expect(refuseDeclaredPurpose(new Request(`${ORIGIN}/api/v1/uploads?purpose=chat`, { method: "POST" }))?.status).toBe(400);
            expect(refuseDeclaredPurpose(new Request(`${ORIGIN}/api/v1/uploads`, { method: "POST" }))).toBeUndefined();
        });

        it("refuses a purpose it does not name, before storing anything", async () => {
            const { bucket, objects } = fakeBucket();

            expect(await statusOf(bucket, ALICE, createFor(10, "video/mp4", "everything"))).toBe(400);
            expect(objects.size).toBe(0);
        });

        it("carries a reference video through its PATCHes, which name no purpose", async () => {
            const { bucket, objects } = fakeBucket();
            const bytes = mp4(12 * MB);
            const created = await send(bucket, ALICE, createFor(bytes.byteLength, "video/mp4", "reference-media"));
            const location = created.headers.get("Location")!;

            for (let offset = 0; offset < bytes.byteLength; offset += 5 * MB) {
                expect(await statusOf(bucket, ALICE, patch(location, offset, bytes.subarray(offset, offset + 5 * MB)))).toBe(204);
            }

            // `Location` may carry the create's query; the object is named by the id alone.
            const id = location.split("/").pop()!.split("?", 1)[0]!;

            // The object sits under the reference-media key, stamped with its purpose.
            expect(objects.get(stagingKeyFor(ALICE, id, "reference-media"))?.contentType).toBe("video/mp4");
            expect(objects.get(stagingKeyFor(ALICE, id, "reference-media"))?.customMetadata).toStrictEqual({ purpose: "reference-media" });
        });
    });
});

/** `DigestStream` as the finalize reads it: a writable whose `digest` is the SHA-256 of what was written. Node has none. */
const digestStreamShim = function (algorithm: string) {
    const chunks: Uint8Array[] = [];
    const stream = new WritableStream<Uint8Array>({
        write(chunk) {
            chunks.push(chunk);
        },
    });

    Object.defineProperty(stream, "digest", {
        get: async () => crypto.subtle.digest(algorithm, Buffer.concat(chunks)),
    });

    return stream;
};

/** The storage calls finalize makes, over the same fake bucket the TUS chunks were written to. */
const finalizeContext = (
    bucket: R2UploadBucket,
    objects: Map<string, { bytes: Uint8Array; contentType?: string; customMetadata?: Record<string, string> }>,
) => {
    const r2 = bucket as unknown as { createMultipartUpload: (key: string, options: object) => Promise<unknown> };
    const storage = {
        createMultipartUpload: async (key: string, options: { contentType?: string }) =>
            await r2.createMultipartUpload(key, { httpMetadata: { contentType: options.contentType } }),
        delete: async (key: string) => {
            objects.delete(key);
        },
        download: async (key: string, options?: { range?: { length: number; offset: number } }) => {
            const object = objects.get(key);

            if (!object) {
                return null;
            }

            const { length = object.bytes.byteLength, offset = 0 } = options?.range ?? {};

            return { body: new Blob([object.bytes.slice(offset, offset + length)]).stream() };
        },
        getMetadata: async (key: string) => {
            const object = objects.get(key);

            return object && { contentType: object.contentType, customMetadata: object.customMetadata, size: object.bytes.byteLength };
        },
        getSignedUrl: async (key: string) => `https://files.example/${key}`,
    };
    const runMutation = vi.fn(async (reference: unknown) =>
        reference === internal.agent.files.useExistingFile ? null : { fileId: "file-1", storageId: "agent-files/stored" },
    );

    return { runMutation, storage };
};

describe("a reference-media upload, from its create to finalize", () => {
    beforeAll(() => {
        Object.defineProperty(crypto, "DigestStream", { configurable: true, value: digestStreamShim });
    });

    it.each([
        ["one PATCH", 64 * 1024],
        ["a multipart upload, past one 5 MiB part", 6 * MB],
    ])("writes %s under the reference-media key, and finalize takes that object", async (_, size) => {
        const { bucket, objects } = fakeBucket();
        const bytes = mp4(size);
        const created = await send(bucket, ALICE, createFor(bytes.byteLength, "video/mp4", "reference-media"));

        expect(created.status).toBe(201);

        const location = created.headers.get("Location")!;
        // The continuations name the upload by id alone, and carry no purpose.
        const uploadId = location.split("/").pop()!.split("?", 1)[0]!;
        const key = stagingKeyFor(ALICE, uploadId, "reference-media");

        for (let offset = 0; offset < bytes.byteLength; offset += 5 * MB) {
            expect(await statusOf(bucket, ALICE, patch(location, offset, bytes.subarray(offset, offset + 5 * MB)))).toBe(204);

            const head = await send(bucket, ALICE, new Request(location, { headers: { "Tus-Resumable": "1.0.0" }, method: "HEAD" }));

            expect(head.headers.get("Upload-Offset")).toBe(String(Math.min(offset + 5 * MB, bytes.byteLength)));
        }

        expect(objects.get(key)?.customMetadata).toStrictEqual({ purpose: "reference-media" });
        expect(objects.has(`${stagingPrefixFor(ALICE)}${uploadId}`)).toBe(false);

        const finalized = await finalizeStagedReferenceMedia(finalizeContext(bucket, objects) as never, ALICE, { filename: "clip.mp4", uploadId });

        expect(finalized.fileId).toBe("file-1");
        expect(objects.has(key)).toBe(false);
    });

    it("deletes a part-written reference-media upload by the id its create named, and leaves no object or state under it", async () => {
        const { bucket, objects } = fakeBucket();
        const bytes = mp4(6 * MB);
        const created = await send(bucket, ALICE, createFor(bytes.byteLength, "video/mp4", "reference-media"));
        const location = created.headers.get("Location")!;
        const uploadId = location.split("/").pop()!.split("?", 1)[0]!;

        expect(await statusOf(bucket, ALICE, patch(location, 0, bytes.subarray(0, 5 * MB)))).toBe(204);
        expect(await statusOf(bucket, ALICE, new Request(location, { headers: { "Tus-Resumable": "1.0.0" }, method: "DELETE" }))).toBe(204);

        expect(objects.has(stagingKeyFor(ALICE, uploadId, "reference-media"))).toBe(false);
        expect(objects.has(`${stagingPrefixFor(ALICE)}${uploadId}`)).toBe(false);
        expect([...objects.keys()].filter((key) => key.startsWith(uploadStatePrefixFor(ALICE)))).toStrictEqual([]);
    });
});
