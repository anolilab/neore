/**
 * An in-memory R2 bucket as far as `@lunora/storage/upload`'s provider uses it: conditional puts, prefix listing
 * and multipart with R2's equal-part rule. Shared by the upload route's suites.
 */
import { createHash } from "node:crypto";

import type { R2UploadBucket } from "@lunora/storage/upload";

const MB = 1024 * 1024;

type Stored = { bytes: Uint8Array; contentType?: string; customMetadata?: Record<string, string>; etag: string; uploaded: Date };
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
export const fakeBucket = () => {
    const objects = new Map<string, Stored>();
    const uploads = new Map<string, { contentType?: string; customMetadata?: Record<string, string>; key: string; parts: Map<number, Uint8Array> }>();
    let counter = 0;

    const store = (key: string, bytes: Uint8Array, contentType?: string, customMetadata?: Record<string, string>) => {
        const object = { bytes, contentType, customMetadata, etag: createHash("sha256").update(bytes).digest("hex"), uploaded: new Date() };

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

                return store(key, bytes, upload.contentType, upload.customMetadata);
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
        createMultipartUpload: async (key: string, options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }) => {
            counter += 1;
            uploads.set(`mp-${String(counter)}`, {
                contentType: options?.httpMetadata?.contentType,
                customMetadata: options?.customMetadata,
                key,
                parts: new Map(),
            });

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
        put: async (
            key: string,
            value: unknown,
            options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string }; onlyIf?: Condition },
        ) => {
            if (options?.onlyIf !== undefined && !meets(options.onlyIf, objects.get(key)?.etag)) {
                return null;
            }

            return store(key, await toBytes(value), options?.httpMetadata?.contentType, options?.customMetadata);
        },
        resumeMultipartUpload: (key: string, uploadId: string) => multipart(key, uploadId),
    };

    return { bucket: bucket as unknown as R2UploadBucket, objects };
};
