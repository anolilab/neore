/**
 * Reference-media finalize (`lib/reference-media-upload.ts`): the bytes that
 * arrived under the caller's staging key are checked, hashed as a stream,
 * stored content-addressed as a multipart upload, and the staging object is
 * deleted. Storage is an in-memory fake; the `chatFiles` writes run against
 * the harness. Node has no `crypto.DigestStream`, so a shim stands in for it.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { CHAT_UPLOAD_CONTENT_MISMATCH, CHAT_UPLOAD_EXPIRED, CHAT_UPLOAD_TOO_LARGE, CHAT_UPLOAD_UNSUPPORTED_TYPE } from "./chat-upload-codes";
import { finalizeStagedUpload } from "./chat-upload";
import type { UploadPurpose } from "./chat-upload-staging";
import { stagingKeyFor } from "./chat-upload-staging";
import { findMpegFrame, finalizeStagedReferenceMedia, isMpegFrameHeader, mpegFrameOffset, referenceMediaMatches } from "./reference-media-upload";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const ALICE = "user-alice";
const BOB = "user-bob";
const UPLOAD = "abcdefghijklmnopqrstu";
const MB = 1024 * 1024;
const MP4_HEAD = [0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom")];
const PDF = new TextEncoder().encode("%PDF-1.7\nhello\n");

type Harness = ReturnType<typeof lunoraTest>;
type StoredObject = { bytes: Uint8Array; contentType?: string; customMetadata?: Record<string, string>; uploaded: Date };

let harness: Harness;
let objects: Map<string, StoredObject>;
let multipartCount: number;

/**
 * The part of `DigestStream` the code under test uses: a writable whose
 * `digest` is the SHA-256 of what was written. A getter, because the code reads
 * it only after the stream has been written and closed.
 */
const DigestStreamShim = function (algorithm: string) {
    const chunks: Uint8Array[] = [];
    const stream = new WritableStream<Uint8Array>({
        write(chunk) {
            chunks.push(chunk);
        },
    });

    Object.defineProperty(stream, "digest", {
        get() {
            const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
            let offset = 0;

            for (const chunk of chunks) {
                all.set(chunk, offset);
                offset += chunk.byteLength;
            }

            return crypto.subtle.digest(algorithm, all);
        },
    });

    return stream;
};

const sliceOf = (bytes: Uint8Array, range?: { length: number; offset: number }) => (range ? bytes.subarray(range.offset, range.offset + range.length) : bytes);

const storage = () => {
    const parts = new Map<string, Map<number, Uint8Array>>();

    return {
        createMultipartUpload: vi.fn(async (key: string, options?: { contentType?: string }) => {
            multipartCount += 1;
            const id = `mp-${String(multipartCount)}`;

            parts.set(id, new Map());

            return {
                abort: vi.fn(async () => {
                    parts.delete(id);
                }),
                complete: vi.fn(async (uploaded: { partNumber: number }[]) => {
                    const chunks = uploaded.map(({ partNumber }) => parts.get(id)!.get(partNumber)!);
                    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
                    let offset = 0;

                    for (const chunk of chunks) {
                        bytes.set(chunk, offset);
                        offset += chunk.byteLength;
                    }

                    parts.delete(id);
                    objects.set(key, { bytes, contentType: options?.contentType, uploaded: new Date() });

                    return { key };
                }),
                uploadPart: vi.fn(async (partNumber: number, value: ArrayBuffer | Uint8Array) => {
                    parts.get(id)!.set(partNumber, new Uint8Array(value as ArrayBuffer));

                    return { etag: `part-${String(partNumber)}`, partNumber };
                }),
            };
        }),
        delete: vi.fn(async (key: string) => {
            objects.delete(key);
        }),
        download: vi.fn(async (key: string, options?: { range?: { length: number; offset: number } }) => {
            const object = objects.get(key);

            return object
                ? {
                      body: new Response(sliceOf(object.bytes, options?.range) as BodyInit).body,
                      customMetadata: object.customMetadata,
                      httpMetadata: { contentType: object.contentType },
                      size: object.bytes.byteLength,
                  }
                : null;
        }),
        getMetadata: vi.fn(async (key: string) => {
            const object = objects.get(key);

            return object
                ? {
                      contentType: object.contentType,
                      customMetadata: object.customMetadata,
                      key,
                      size: object.bytes.byteLength,
                      uploaded: object.uploaded.getTime(),
                  }
                : null;
        }),
        getSignedUrl: async (key: string) => `http://localhost:8788/${key}?sig=read`,
    };
};

/** An action context whose mutations run against the harness. */
const actionContext = () => {
    return {
        runAction: vi.fn(),
        runMutation: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runMutation(reference, args)),
        runQuery: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runQuery(reference, args)),
        scheduler: { runAfter: vi.fn(async () => "job") },
        storage: storage(),
    };
};

/**
 * What a finished reference upload leaves at its staging key: `stamp` is the
 * `purpose` the object carries (`undefined` for an unstamped object), and
 * `purpose` picks the key it sits under.
 */
const stage = (
    userId: string,
    bytes: Uint8Array,
    contentType: string,
    { purpose = "reference-media", stamp = "reference-media", uploadId = UPLOAD }: { purpose?: UploadPurpose; stamp?: string | null; uploadId?: string } = {},
): string => {
    const key = stagingKeyFor(userId, uploadId, purpose);

    objects.set(key, { bytes, contentType, customMetadata: stamp === null ? undefined : { purpose: stamp }, uploaded: new Date() });

    return key;
};

/** The leading bytes of an MP4 whose major brand is `brand`. */
const mp4Head = (brand: string): Uint8Array => new Uint8Array([0, 0, 0, 0x18, ...ascii("ftyp"), ...ascii(brand), 0, 0, 0, 0]);

const mp4 = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);

    bytes.set(MP4_HEAD);

    return bytes;
};

const codeOf = async (pending: Promise<unknown>): Promise<unknown> => {
    try {
        await pending;
    } catch (error) {
        return (error as { data?: { code?: unknown } }).data?.code;
    }

    throw new Error("expected a rejection");
};

const finalize = async (ctx: ReturnType<typeof actionContext>, userId: string, uploadId = UPLOAD) =>
    await finalizeStagedReferenceMedia(ctx as never, userId, { filename: "clip.mp4", uploadId });

const ascii = (text: string): number[] => [...text].map((character) => character.codePointAt(0) ?? 0);

beforeAll(async () => {
    registerModule(registry, "agent_files", await import("../agent/files"));
    Object.defineProperty(crypto, "DigestStream", { configurable: true, value: DigestStreamShim });
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    objects = new Map();
    multipartCount = 0;
});

afterEach(() => {
    harness.close();
});

describe(referenceMediaMatches, () => {
    it("accepts the MP4 and QuickTime brands it knows, and refuses the rest", () => {
        for (const brand of ["isom", "iso2", "iso3", "iso8", "avc1", "mp42", "mp71", "M4V ", "M4VP", "MSNV", "dash", "3gp4", "3gp5"]) {
            expect(referenceMediaMatches(mp4Head(brand), "video/mp4")).toBe(true);
        }

        for (const brand of ["heic", "heix", "hevc", "mif1", "msf1", "avif", "avis", "M4A ", "qt  "]) {
            expect(referenceMediaMatches(mp4Head(brand), "video/mp4")).toBe(false);
        }

        // The brands a real camera or encoder writes that the list did not name before: ISO 9, Sony XAVC, Adobe F4V, 3GPP 6, 3GPP2 and mobile MP4.
        for (const brand of ["iso7", "iso9", "XAVC", "f4v ", "3gp6", "3g2a", "3g2b", "3g2c", "mmp4"]) {
            expect(referenceMediaMatches(mp4Head(brand), "video/mp4")).toBe(true);
        }

        // Not a prefix match: `f4v` without its padding space is not the F4V brand (the brand is four bytes, so the head pads it with NUL).
        expect(referenceMediaMatches(mp4Head("f4v"), "video/mp4")).toBe(false);
        expect(referenceMediaMatches(mp4Head("iso1"), "video/mp4")).toBe(false);

        expect(referenceMediaMatches(mp4Head("qt  "), "video/quicktime")).toBe(true);
        expect(referenceMediaMatches(mp4Head("isom"), "video/quicktime")).toBe(false);
        expect(referenceMediaMatches(new Uint8Array([0, 0, 0, 0x18, ...ascii("moov"), ...ascii("qt  ")]), "video/quicktime")).toBe(false);
        expect(referenceMediaMatches(PDF, "video/mp4")).toBe(false);
        expect(referenceMediaMatches(new Uint8Array(0), "video/mp4")).toBe(false);
    });

    it("accepts a WAV by its RIFF/WAVE form and refuses other RIFF files", () => {
        const wav = new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]);

        expect(referenceMediaMatches(wav, "audio/wav")).toBe(true);
        expect(referenceMediaMatches(wav, "audio/x-wav")).toBe(true);
        expect(referenceMediaMatches(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("AVI ")]), "audio/wav")).toBe(false);
    });

    it("accepts an MP3 only with a valid MPEG frame header where its frame starts", () => {
        const layerThree = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
        const id3 = new Uint8Array([...ascii("ID3"), 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5, ...layerThree]);

        expect(referenceMediaMatches(layerThree, "audio/mpeg", layerThree)).toBe(true);
        expect(mpegFrameOffset(id3)).toBe(15);
        expect(referenceMediaMatches(id3, "audio/mpeg", layerThree)).toBe(true);
        expect(referenceMediaMatches(id3, "audio/mpeg")).toBe(false);
        expect(referenceMediaMatches(new Uint8Array([0xff, 0xe0, 0, 0]), "audio/mpeg", new Uint8Array([0xff, 0xe0, 0, 0]))).toBe(false);
    });
});

describe(findMpegFrame, () => {
    it("returns the index of the first valid frame header, or -1", () => {
        expect(findMpegFrame(new Uint8Array([0, 0, 0xff, 0xfb, 0x90, 0x00]))).toBe(2);
        expect(findMpegFrame(new Uint8Array([0, 0, 0xff, 0xe0, 0, 0]))).toBe(-1);
        expect(findMpegFrame(new Uint8Array([0xff, 0xfb]))).toBe(-1);
    });
});

describe(isMpegFrameHeader, () => {
    it("refuses the reserved and bad values, and anything not Layer III", () => {
        expect(isMpegFrameHeader(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe(true);
        expect(isMpegFrameHeader(new Uint8Array([0xff, 0xf3, 0x90, 0x00]))).toBe(true); // MPEG-2 Layer III
        expect(isMpegFrameHeader(new Uint8Array([0xff, 0xe8, 0x90, 0x00]))).toBe(false); // reserved version
        expect(isMpegFrameHeader(new Uint8Array([0xff, 0xf8, 0x90, 0x00]))).toBe(false); // reserved layer
        expect(isMpegFrameHeader(new Uint8Array([0xff, 0xfb, 0xf0, 0x00]))).toBe(false); // bad bitrate
        expect(isMpegFrameHeader(new Uint8Array([0xff, 0xfb, 0x0c, 0x00]))).toBe(false); // reserved sample rate
        expect(isMpegFrameHeader(new Uint8Array([0xff, 0xfb]))).toBe(false);
    });
});

describe(finalizeStagedReferenceMedia, () => {
    it("stores a small clip content-addressed with a grant, and deletes the staging object", async () => {
        const ctx = actionContext();
        const bytes = mp4(64);
        const key = stage(ALICE, bytes, "video/mp4");
        const result = await finalize(ctx, ALICE);
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

        expect(result.fileId).toBeTypeOf("string");
        expect(result.url).toContain("sig=read");
        expect(objects.get(`agent-files/${hash}`)?.bytes).toStrictEqual(bytes);
        expect(objects.get(`agent-files/${hash}`)?.contentType).toBe("video/mp4");
        expect(objects.has(key)).toBe(false);
    });

    it("streams a file over one part through a multipart upload, and only completes it when the bytes match", async () => {
        const ctx = actionContext();
        const bytes = mp4(12 * MB);
        const key = stage(ALICE, bytes, "video/mp4");

        await finalize(ctx, ALICE);

        expect(ctx.storage.createMultipartUpload).toHaveBeenCalledTimes(1);
        const upload = await ctx.storage.createMultipartUpload.mock.results[0]!.value;

        expect(upload.uploadPart).toHaveBeenCalledTimes(3);
        expect(upload.complete).toHaveBeenCalledTimes(1);
        expect(upload.abort).not.toHaveBeenCalled();
        const stored = [...objects].find(([name]) => name.startsWith("agent-files/"));

        // A byte-wise compare: `toStrictEqual` over 12 MB takes seconds.
        expect(stored && Buffer.from(stored[1].bytes).equals(Buffer.from(bytes))).toBe(true);
        expect(objects.has(key)).toBe(false);
    });

    it("reuses the stored bytes for a second user with the same file, without writing them again", async () => {
        const bytes = mp4(64);
        const ctx = actionContext();

        stage(ALICE, bytes, "video/mp4");
        await finalize(ctx, ALICE);
        stage(BOB, bytes, "video/mp4", { uploadId: "bcdefghijklmnopqrstuv" });
        await finalize(ctx, BOB, "bcdefghijklmnopqrstuv");

        // Only Alice's finalize wrote; Bob's hit the existing row and key.
        expect(ctx.storage.createMultipartUpload).toHaveBeenCalledTimes(1);
        expect(objects.size).toBe(1);
        expect(objects.has(stagingKeyFor(BOB, "bcdefghijklmnopqrstuv", "reference-media"))).toBe(false);
    });

    it("refuses bytes that do not look like the stored type, and deletes them", async () => {
        const ctx = actionContext();
        const key = stage(ALICE, PDF, "video/mp4");

        expect(await codeOf(finalize(ctx, ALICE))).toBe(CHAT_UPLOAD_CONTENT_MISMATCH);
        expect(objects.has(key)).toBe(false);
    });

    it("refuses a clip whose stored size is over its cap, before reading any of it", async () => {
        const ctx = actionContext();
        const key = stage(ALICE, new Uint8Array(16 * MB), "audio/mpeg");

        expect(await codeOf(finalize(ctx, ALICE))).toBe(CHAT_UPLOAD_TOO_LARGE);
        expect(ctx.storage.download).not.toHaveBeenCalled();
        expect(objects.has(key)).toBe(false);
    });

    it("refuses a type that is not reference media", async () => {
        const ctx = actionContext();
        const key = stage(ALICE, PDF, "application/pdf");

        expect(await codeOf(finalize(ctx, ALICE))).toBe(CHAT_UPLOAD_UNSUPPORTED_TYPE);
        expect(objects.has(key)).toBe(false);
    });

    it("answers an upload another user made, or none, as expired", async () => {
        const ctx = actionContext();

        stage(ALICE, mp4(64), "video/mp4");

        expect(await codeOf(finalize(ctx, BOB))).toBe(CHAT_UPLOAD_EXPIRED);
        expect(await codeOf(finalize(ctx, ALICE, "not-an-upload-id"))).toBe(CHAT_UPLOAD_EXPIRED);
        expect(objects.has(stagingKeyFor(ALICE, UPLOAD, "reference-media"))).toBe(true);
    });

    it("refuses an object stamped for chat, or unstamped, at the reference-media key", async () => {
        const ctx = actionContext();
        const chatStamped = stage(ALICE, mp4(64), "video/mp4", { stamp: "chat" });

        expect(await codeOf(finalize(ctx, ALICE))).toBe(CHAT_UPLOAD_UNSUPPORTED_TYPE);
        expect(objects.has(chatStamped)).toBe(false);

        const unstamped = stage(ALICE, mp4(64), "video/mp4", { stamp: null });

        expect(await codeOf(finalize(ctx, ALICE))).toBe(CHAT_UPLOAD_UNSUPPORTED_TYPE);
        expect(objects.has(unstamped)).toBe(false);
        expect(ctx.storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it("never reads a chat finalize's object: a reference-stamped object at the chat key is refused and deleted", async () => {
        const ctx = actionContext();
        const key = stage(ALICE, mp4(64), "video/mp4", { purpose: "chat" });

        expect(await codeOf(finalizeStagedUpload(ctx as never, ALICE, { filename: "clip.mp4", uploadId: UPLOAD }))).toBe(CHAT_UPLOAD_UNSUPPORTED_TYPE);
        expect(objects.has(key)).toBe(false);
    });

    it("finds an MP3 frame past zero padding after the tag, and refuses one beyond the scan window", async () => {
        const ctx = actionContext();
        const frame = [0xff, 0xfb, 0x90, 0x00];
        const tag = [...ascii("ID3"), 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5];
        const padded = new Uint8Array([...tag, ...new Uint8Array(100), ...frame, ...new Uint8Array(4000)]);
        const far = new Uint8Array([...tag, ...new Uint8Array(5000), ...frame, ...new Uint8Array(4000)]);
        const nearId = "ccccccccccccccccccccc";
        const farId = "ddddddddddddddddddddd";

        stage(ALICE, padded, "audio/mpeg", { uploadId: nearId });
        await expect(finalize(ctx, ALICE, nearId)).resolves.toHaveProperty("fileId");

        stage(ALICE, far, "audio/mpeg", { uploadId: farId });
        expect(await codeOf(finalize(ctx, ALICE, farId))).toBe(CHAT_UPLOAD_CONTENT_MISMATCH);
    });

    it("stores an MP3 whose ID3 tag leads to a valid frame, and refuses one whose frame is not valid", async () => {
        const ctx = actionContext();
        const frame = [0xff, 0xfb, 0x90, 0x00];
        const good = new Uint8Array([...ascii("ID3"), 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5, ...frame, ...new Uint8Array(4000)]);
        const bad = new Uint8Array([...ascii("ID3"), 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5, 0xff, 0xe0, 0, 0, ...new Uint8Array(4000)]);
        const goodId = "aaaaaaaaaaaaaaaaaaaaa";
        const badId = "bbbbbbbbbbbbbbbbbbbbb";

        stage(ALICE, good, "audio/mpeg", { uploadId: goodId });
        await expect(finalize(ctx, ALICE, goodId)).resolves.toHaveProperty("fileId");

        stage(ALICE, bad, "audio/mpeg", { uploadId: badId });
        expect(await codeOf(finalize(ctx, ALICE, badId))).toBe(CHAT_UPLOAD_CONTENT_MISMATCH);
    });
});
