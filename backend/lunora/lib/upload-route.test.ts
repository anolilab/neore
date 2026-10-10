/**
 * The upload route (`lib/upload-route.ts`) driven over TUS, end to end through
 * `@lunora/storage/upload`'s real handler and R2 binding provider, against an
 * in-memory bucket with R2's conditional puts and multipart rules.
 */
import { createHash } from "node:crypto";

import type { R2UploadBucket } from "@lunora/storage/upload";
import { R2_PART_SIZE } from "@lunora/storage/upload";
import { describe, expect, it, vi } from "vitest";

import { stagingPrefixFor, uploadStatePrefixFor } from "./chat-upload-staging";
import { handleUploadRequest, UPLOAD_PATH } from "./upload-route";

const ORIGIN = "http://localhost:8788";
const ALICE = "user-alice";
const BOB = "user-bob";
const MB = 1024 * 1024;
const PDF_HEAD = new TextEncoder().encode("%PDF-1.7\n");

type Stored = { bytes: Uint8Array; contentType?: string; etag: string; uploaded: Date };
type Condition = { etagDoesNotMatch?: string; etagMatches?: string };

const toBytes = async (value: unknown): Promise<Uint8Array> => {
    if (typeof value === "string") {
        return new TextEncoder().encode(value);
    }

    if (value instanceof Uint8Array) {
        return new Uint8Array(value);
    }

    return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
};

/** An R2 binding as far as the provider uses it: conditional puts, prefix listing, and multipart with R2's equal-part rule. */
const fakeBucket = () => {
    const objects = new Map<string, Stored>();
    const uploads = new Map<string, { contentType?: string; key: string; parts: Map<number, Uint8Array> }>();
    let counter = 0;

    const store = (key: string, bytes: Uint8Array, contentType?: string) => {
        const object = { bytes, contentType, etag: createHash("sha256").update(bytes).digest("hex"), uploaded: new Date() };

        objects.set(key, object);

        return { etag: object.etag, httpMetadata: { contentType }, key, size: bytes.byteLength, uploaded: object.uploaded };
    };

    const meets = (condition: Condition, etag: string | undefined): boolean => {
        const matches = (expected: string) => etag !== undefined && (expected === "*" || expected === etag);

        return (
            (condition.etagMatches === undefined || matches(condition.etagMatches)) &&
            (condition.etagDoesNotMatch === undefined || !matches(condition.etagDoesNotMatch))
        );
    };

    const multipart = (key: string, uploadId: string) => {
        return {
            abort: async () => {
                uploads.delete(uploadId);
            },
            complete: async (parts: { etag: string; partNumber: number }[]) => {
                const upload = uploads.get(uploadId)!;
                const chunks = parts.map(({ partNumber }) => upload.parts.get(partNumber)!);

                if (chunks.slice(0, -1).some((chunk) => chunk.byteLength !== chunks[0]!.byteLength || chunk.byteLength < 5 * MB)) {
                    throw new Error("InvalidPart");
                }

                const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
                let offset = 0;

                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }

                uploads.delete(uploadId);

                return store(key, bytes, upload.contentType);
            },
            key,
            uploadId,
            uploadPart: async (partNumber: number, value: unknown) => {
                uploads.get(uploadId)!.parts.set(partNumber, await toBytes(value));

                return { etag: `part-${String(partNumber)}`, partNumber };
            },
        };
    };

    const bucket = {
        createMultipartUpload: async (key: string, options?: { httpMetadata?: { contentType?: string } }) => {
            counter += 1;
            uploads.set(`mp-${String(counter)}`, { contentType: options?.httpMetadata?.contentType, key, parts: new Map() });

            return multipart(key, `mp-${String(counter)}`);
        },
        delete: async (keys: string | string[]) => {
            const list = typeof keys === "string" ? [keys] : keys;

            for (const key of list) {
                objects.delete(key);
            }
        },
        get: async (key: string) => {
            const object = objects.get(key);

            return object
                ? {
                      arrayBuffer: async () => new Uint8Array(object.bytes).buffer,
                      body: new Blob([new Uint8Array(object.bytes)]).stream(),
                      etag: object.etag,
                      httpMetadata: { contentType: object.contentType },
                      key,
                      size: object.bytes.byteLength,
                      text: async () => new TextDecoder().decode(object.bytes),
                      uploaded: object.uploaded,
                  }
                : null;
        },
        list: async (options?: { prefix?: string }) => {
            return {
                delimitedPrefixes: [],
                objects: [...objects]
                    .filter(([key]) => key.startsWith(options?.prefix ?? ""))
                    .map(([key, object]) => {
                        return { etag: object.etag, key, size: object.bytes.byteLength, uploaded: object.uploaded };
                    }),
                truncated: false,
            };
        },
        put: async (key: string, value: unknown, options?: { httpMetadata?: { contentType?: string }; onlyIf?: Condition }) => {
            if (options?.onlyIf !== undefined && !meets(options.onlyIf, objects.get(key)?.etag)) {
                return null;
            }

            return store(key, await toBytes(value), options?.httpMetadata?.contentType);
        },
        resumeMultipartUpload: (key: string, uploadId: string) => multipart(key, uploadId),
    };

    return { bucket: bucket as unknown as R2UploadBucket, objects };
};

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
});
