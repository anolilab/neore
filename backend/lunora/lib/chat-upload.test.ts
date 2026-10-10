/**
 * Staged uploads (`lib/chat-upload.ts`): finalize trusts only what is in
 * storage, only under the caller's own prefix, and dedupes a chat attachment
 * into the content-addressed `chatFiles` with a grant for the caller. How the
 * bytes arrive is `upload-route.test.ts`. Storage is an in-memory fake; the
 * `chatFiles` / `chatFileAccess` writes run against the harness.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internal } from "../_generated/internal";
import schema from "../schema";
import { CHAT_UPLOAD_CONTENT_MISMATCH, CHAT_UPLOAD_EXPIRED, CHAT_UPLOAD_TOO_LARGE } from "./chat-upload-codes";
import { finalizeStagedUpload, purgeStagedUploads, takeStagedUpload } from "./chat-upload";
import { STAGING_TTL_MS, stagingKeyFor, uploadStatePrefixFor } from "./chat-upload-staging";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const ALICE = "user-alice";
const BOB = "user-bob";
const MB = 1024 * 1024;
const PDF = new TextEncoder().encode("%PDF-1.7\nhello pdf body\n%%EOF");
const CANONICAL_KEY = /^agent-files\/[\da-f]{64}$/u;
const byString = (a: string, b: string): number => a.localeCompare(b);

type Harness = ReturnType<typeof lunoraTest>;
type StoredObject = { bytes: Uint8Array; contentType?: string; uploaded: Date };

let harness: Harness;
let objects: Map<string, StoredObject>;

const storage = () => {
    return {
        delete: vi.fn(async (key: string) => {
            objects.delete(key);
        }),
        download: async (key: string) => {
            const object = objects.get(key);

            return object
                ? { body: new Response(object.bytes as BodyInit).body, httpMetadata: { contentType: object.contentType }, size: object.bytes.byteLength }
                : null;
        },
        getSignedUrl: async (key: string) => `http://localhost:8788/${key}?sig=read`,
        list: async (prefix?: string) => {
            return {
                objects: [...objects]
                    .filter(([key]) => key.startsWith(prefix ?? ""))
                    .map(([key, object]) => {
                        return { etag: "etag", key, size: object.bytes.byteLength, uploaded: object.uploaded };
                    }),
                truncated: false,
            };
        },
        store: vi.fn(async (key: string, body: ArrayBuffer, options?: { contentType?: string }) => {
            objects.set(key, { bytes: new Uint8Array(body), contentType: options?.contentType, uploaded: new Date() });

            return { etag: "etag", key };
        }),
    };
};

/** An action context whose mutations and queries run against the harness. */
const actionContext = () => {
    return {
        runAction: vi.fn(),
        runMutation: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runMutation(reference, args)),
        runQuery: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runQuery(reference, args)),
        scheduler: { runAfter: vi.fn(async () => "job") },
        storage: storage(),
    };
};

/** What a finished upload through `lib/upload-route.ts` leaves behind. */
const stage = (userId: string, uploadId: string, bytes: Uint8Array, contentType = "application/pdf"): string => {
    const key = stagingKeyFor(userId, uploadId);

    objects.set(key, { bytes, contentType, uploaded: new Date() });

    return key;
};

const codeOf = async (pending: Promise<unknown>): Promise<unknown> => {
    try {
        await pending;
    } catch (error) {
        return (error as { data?: { code?: unknown } }).data?.code;
    }

    throw new Error("expected a rejection");
};

const finalize = async (ctx: ReturnType<typeof actionContext>, userId: string, uploadId: string, filename = "doc.pdf") =>
    await finalizeStagedUpload(ctx as never, userId, { filename, uploadId });

beforeAll(async () => {
    registerModule(registry, "agent_files", await import("../agent/files"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    objects = new Map();
});

afterEach(() => {
    harness.close();
});

describe(finalizeStagedUpload, () => {
    const UPLOAD = "V1StGXR8_Z5jdHi6B-myT";

    it("stores the staged bytes content-addressed, grants the caller and deletes the staging object", async () => {
        const ctx = actionContext();
        const staged = stage(ALICE, UPLOAD, PDF);
        const { fileId, url } = await finalize(ctx, ALICE, UPLOAD);

        expect(objects.has(staged)).toBe(false);
        expect([...objects.keys()]).toStrictEqual([expect.stringMatching(CANONICAL_KEY)]);
        expect(url).toContain("agent-files/");

        const file = await ctx.runQuery(internal.agent.files.getFileForUser, { fileId, userId: ALICE });

        expect(file).toMatchObject({ filename: "doc.pdf", mediaType: "application/pdf" });
    });

    it("cannot reach another user's staged upload: it answers as expired and leaves it alone", async () => {
        const ctx = actionContext();
        const alices = stage(ALICE, UPLOAD, PDF);

        expect(await codeOf(finalize(ctx, BOB, UPLOAD))).toBe(CHAT_UPLOAD_EXPIRED);
        expect(objects.has(alices)).toBe(true);
        expect(ctx.storage.delete).not.toHaveBeenCalled();
    });

    it("refuses an upload id that is not one it minted, before touching storage", async () => {
        const ctx = actionContext();

        stage(ALICE, UPLOAD, PDF);

        for (const uploadId of [`../${BOB}/${UPLOAD}`, `${UPLOAD}/x`, "not-an-upload-id", ""]) {
            expect(await codeOf(finalize(ctx, ALICE, uploadId))).toBe(CHAT_UPLOAD_EXPIRED);
        }

        expect(ctx.storage.delete).not.toHaveBeenCalled();
    });

    it("answers a missing (expired, reaped or never uploaded) staging object as expired", async () => {
        expect(await codeOf(finalize(actionContext(), ALICE, UPLOAD))).toBe(CHAT_UPLOAD_EXPIRED);
    });

    it("rejects and deletes a staged object over the limit", async () => {
        const ctx = actionContext();
        const big = new Uint8Array(25 * MB + 1);

        big.set(PDF);

        const staged = stage(ALICE, UPLOAD, big);

        expect(await codeOf(finalize(ctx, ALICE, UPLOAD))).toBe(CHAT_UPLOAD_TOO_LARGE);
        expect(objects.has(staged)).toBe(false);
        expect(ctx.storage.store).not.toHaveBeenCalled();
    });

    it("rejects and deletes bytes that do not match the declared type", async () => {
        const ctx = actionContext();
        const staged = stage(ALICE, UPLOAD, new TextEncoder().encode("<html><script>alert(1)</script>"));

        expect(await codeOf(finalize(ctx, ALICE, UPLOAD))).toBe(CHAT_UPLOAD_CONTENT_MISMATCH);
        expect(objects.has(staged)).toBe(false);
    });

    it("rejects and deletes a staged type off the allowlist", async () => {
        const ctx = actionContext();
        const staged = stage(ALICE, UPLOAD, PDF, "text/x-shellscript");

        expect(await codeOf(finalize(ctx, ALICE, UPLOAD))).not.toBe(CHAT_UPLOAD_EXPIRED);
        expect(objects.has(staged)).toBe(false);
    });

    it("dedupes identical bytes into one existing chat file and grants the second uploader", async () => {
        const ctx = actionContext();
        const second = "Uakgb_J5m9g-0JDMbcJqL";

        stage(ALICE, UPLOAD, PDF);
        stage(BOB, second, PDF);

        const alices = await finalize(ctx, ALICE, UPLOAD);
        const bobs = await finalize(ctx, BOB, second);

        expect(bobs.fileId).toBe(alices.fileId);
        // One canonical object; both staging objects gone.
        expect([...objects.keys()]).toHaveLength(1);
        expect(ctx.storage.store).toHaveBeenCalledTimes(1);
        expect(await ctx.runQuery(internal.agent.files.getFileForUser, { fileId: bobs.fileId, userId: BOB })).not.toBeNull();
    });
});

describe(takeStagedUpload, () => {
    const UPLOAD = "V1StGXR8_Z5jdHi6B-myT";

    it("holds the bytes to the caller's own cap — the vault's 5 MB, not the chat's 25 MB", async () => {
        const ctx = actionContext();
        const big = new Uint8Array(5 * MB + 1);

        big.set(PDF);

        const staged = stage(ALICE, UPLOAD, big);
        const use = vi.fn();

        expect(await codeOf(takeStagedUpload(ctx as never, ALICE, UPLOAD, () => 5 * MB, use))).toBe(CHAT_UPLOAD_TOO_LARGE);
        expect(use).not.toHaveBeenCalled();
        expect(objects.has(staged)).toBe(false);
    });
});

describe(purgeStagedUploads, () => {
    it("deletes only the user's own staging objects and upload state older than the TTL", async () => {
        const now = Date.now();
        const old = new Date(now - STAGING_TTL_MS - 1000);
        const aliceState = `${uploadStatePrefixFor(ALICE)}abandoned.json`;
        const bobState = `${uploadStatePrefixFor(BOB)}abandoned.json`;

        objects.set(stagingKeyFor(ALICE, "a"), { bytes: PDF, uploaded: old });
        objects.set(stagingKeyFor(ALICE, "b"), { bytes: PDF, uploaded: new Date(now) });
        objects.set(stagingKeyFor(BOB, "c"), { bytes: PDF, uploaded: old });
        objects.set(aliceState, { bytes: PDF, uploaded: old });
        objects.set(bobState, { bytes: PDF, uploaded: old });
        objects.set("agent-files/abc", { bytes: PDF, uploaded: old });

        expect(await purgeStagedUploads(storage(), ALICE, now)).toBe(2);
        expect([...objects.keys()].toSorted(byString)).toStrictEqual(
            ["agent-files/abc", bobState, stagingKeyFor(ALICE, "b"), stagingKeyFor(BOB, "c")].toSorted(byString),
        );
    });
});
