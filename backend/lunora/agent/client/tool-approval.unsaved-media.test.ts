/**
 * An approved result's media is stored before its row is saved. When the save fails, the files that approval wrote are
 * taken back (row, grants, object) and the save's own error is what the caller sees; bytes that were already stored stay.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../../test/registered-api";
import browserTool from "../../chat/tools/browser";
import schema from "../../schema";
import { OBJECT_DELETE_RETRY_MS } from "../files";
import { deleteStoredObjects } from "./object-deletes";
import { MAX_FILE_SIZE, storeFile } from "./files";
import { approveToolCallFor } from "./tool-approval";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const OWNER = "user-owner";
/** A PNG's leading bytes padded past `MAX_FILE_SIZE`, so the screenshot moves to storage rather than staying inline. */
const SCREENSHOT_BYTES = new Uint8Array(MAX_FILE_SIZE + 1024);

SCREENSHOT_BYTES.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SCREENSHOT = Buffer.from(SCREENSHOT_BYTES).toString("base64");
const SCREENSHOT_KEY = /^agent-files\/[\da-f]{64}\/[\da-f-]{36}$/u;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let threadId: string;

/** An action context whose mutations run against the harness and whose storage is a stub. */
const actionContext = (deleteObject: (key: string) => Promise<void> = async () => undefined) => {
    return {
        runAction: vi.fn(),
        runMutation: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runMutation(reference, args)),
        runQuery: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runQuery(reference, args)),
        storage: {
            delete: vi.fn(deleteObject),
            getSignedUrl: async (key: string) => `https://signed.example/${key}?sig=x`,
            store: vi.fn(async () => undefined),
        },
    };
};

const chatFiles = async (): Promise<{ _id: string; storageId: string }[]> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.chatFiles.findMany({});

        return page;
    });

const grants = async (): Promise<unknown[]> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.chatFileAccess.findMany({});

        return page;
    });

const metadataRows = async (): Promise<{ fileId: string }[]> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.chatFileMetadata.findMany({});

        return page;
    });

const objectDeletes = async (): Promise<{ deleteAfter: number; storageId: string }[]> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.chatFileObjectDeletes.findMany({});

        return page;
    });

/** A storage stub that keeps what it is given, so a test can see which bytes survived. */
const keepObjects = (context: ReturnType<typeof actionContext>): Map<string, Uint8Array> => {
    const objects = new Map<string, Uint8Array>();

    context.storage.store = vi.fn(async (key: string, bytes: ArrayBuffer) => {
        objects.set(key, new Uint8Array(bytes));
    }) as never;
    context.storage.delete = vi.fn(async (key: string) => {
        objects.delete(key);
    });

    return objects;
};

const chatFileIds = async (): Promise<string[]> => {
    const rows = await chatFiles();

    return rows.map((row) => row._id);
};

/** Approves a pending browser click whose result carries a screenshot, with a `saveMessage` that fails. */
const approveWithFailingSave = async (
    context: ReturnType<typeof actionContext>,
    saveError: Error,
    /** Runs inside the failing save: another reply working while this one's save is in flight. */
    duringSave: () => Promise<void> = async () => undefined,
) => {
    const callRow = {
        _creationTime: 11,
        _id: "m2",
        message: {
            content: [
                { input: { action: "click", selector: "#buy" }, toolCallId: "call-1", toolName: "browser", type: "tool-call" },
                { approvalId: "approval-1", toolCallId: "call-1", type: "tool-approval-request" },
            ],
            role: "assistant",
        },
        order: 1,
        status: "success",
        stepOrder: 1,
        threadId,
        tool: false,
    };
    const result = { screenshot: SCREENSHOT, screenshotFormat: "png", success: true, title: "Checkout", url: "https://shop.example.com/" };
    const agent = {
        getThreadMetadata: vi.fn(async () => {
            return { userId: OWNER };
        }),
        listMessages: vi.fn(async () => {
            return { continueCursor: null, isDone: true, page: [callRow] };
        }),
        options: { tools: { browser: { ...browserTool, execute: vi.fn(async () => result) } } },
        saveMessage: vi.fn(async () => {
            await duringSave();

            throw saveError;
        }),
        streamText: vi.fn(),
    };

    const outcome = approveToolCallFor(agent as never, context as never, { threadId, userId: OWNER }, { approvalId: "approval-1" });

    return { agent, outcome };
};

beforeAll(async () => {
    registerModule(registry, "agent_files", await import("../files"));
});

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { title: "T", userId: OWNER }));
});

afterEach(() => {
    harness.close();
    vi.restoreAllMocks();
});

describe("approving a call whose save fails", () => {
    it("deletes the screenshot's file, grants and object it stored, and rethrows the save's error", async () => {
        const context = actionContext();
        const saveError = new Error("save refused");
        const { agent, outcome } = await approveWithFailingSave(context, saveError);

        await expect(outcome).rejects.toBe(saveError);

        // The screenshot was stored and offered to the save, then taken back.
        expect(context.storage.store).toHaveBeenCalledOnce();
        expect(agent.saveMessage).toHaveBeenCalledOnce();
        expect(await chatFiles()).toStrictEqual([]);
        expect(await grants()).toStrictEqual([]);
        // The export's view of the file goes too: an export must not list a screenshot that no longer exists.
        expect(await metadataRows()).toStrictEqual([]);
        expect(context.storage.delete).toHaveBeenCalledOnce();
        expect(context.storage.delete.mock.calls[0]?.[0]).toMatch(SCREENSHOT_KEY);
        expect(agent.streamText).not.toHaveBeenCalled();
    });

    it("keeps a file the screenshot's bytes reused", async () => {
        const context = actionContext();
        const { file } = await storeFile(context as never, new Blob([SCREENSHOT_BYTES], { type: "image/png" }), {
            threadId,
            userId: OWNER,
        });
        const { outcome } = await approveWithFailingSave(context, new Error("save refused"));

        await expect(outcome).rejects.toThrow("save refused");

        expect(await chatFileIds()).toStrictEqual([file.fileId]);
        expect(context.storage.delete).not.toHaveBeenCalled();
    });

    it("keeps the row, grant and object another reply reused while the save was in flight", async () => {
        const context = actionContext();
        const otherUser = "user-other";
        let reusedFileId: string | undefined;
        const { outcome } = await approveWithFailingSave(context, new Error("save refused"), async () => {
            // Another reply stores the same bytes: it reuses the row this approval created, and counts it only when it saves.
            const { created, file } = await storeFile(context as never, new Blob([SCREENSHOT_BYTES], { type: "image/png" }), {
                userId: otherUser,
            });

            expect(created).toBe(false);
            reusedFileId = file.fileId;
        });

        await expect(outcome).rejects.toThrow("save refused");

        expect(await chatFileIds()).toStrictEqual([reusedFileId]);
        expect(await grants()).toContainEqual(expect.objectContaining({ fileId: reusedFileId, userId: otherUser }));
        expect(await metadataRows()).toStrictEqual([expect.objectContaining({ fileId: reusedFileId })]);
        expect(context.storage.delete).not.toHaveBeenCalled();
    });

    it("deletes only its own object, never the object of another row for the same bytes", async () => {
        const context = actionContext();
        const objects = keepObjects(context);
        // The same bytes under a filename: its own row, and (stored by its own upload) its own key.
        const { file } = await storeFile(context as never, new Blob([SCREENSHOT_BYTES], { type: "image/png" }), {
            filename: "shot.png",
            userId: OWNER,
        });
        const { outcome } = await approveWithFailingSave(context, new Error("save refused"));

        await expect(outcome).rejects.toThrow("save refused");

        expect(await chatFileIds()).toStrictEqual([file.fileId]);
        expect(context.storage.delete).toHaveBeenCalledOnce();
        expect(context.storage.delete.mock.calls[0]?.[0]).not.toBe(file.storageId);
        expect(objects.get(file.storageId)).toStrictEqual(SCREENSHOT_BYTES);
        expect(await objectDeletes()).toStrictEqual([]);
    });

    it("keeps the bytes of a store of the same bytes that finishes while the rollback's delete is slow", async () => {
        const context = actionContext();
        const objects = keepObjects(context);
        let racing: Awaited<ReturnType<typeof storeFile>> | undefined;

        // The rollback's delete is slow: another reply stores the same bytes, row and upload, before it lands. No hold, no wait.
        context.storage.delete = vi.fn(async (key: string) => {
            racing = await storeFile(context as never, new Blob([SCREENSHOT_BYTES], { type: "image/png" }), { userId: "user-other" });
            objects.delete(key);
        });

        const { outcome } = await approveWithFailingSave(context, new Error("save refused"));

        await expect(outcome).rejects.toThrow("save refused");

        expect(racing?.created).toBe(true);
        expect(await chatFileIds()).toStrictEqual([racing?.file.fileId]);
        expect(context.storage.delete.mock.calls[0]?.[0]).not.toBe(racing?.file.storageId);
        expect(objects.get(racing!.file.storageId)).toStrictEqual(SCREENSHOT_BYTES);
        expect(context.storage.store).toHaveBeenCalledTimes(2);
    });

    it("still fails with the save's error when the cleanup fails", async () => {
        const context = actionContext(async () => {
            throw new Error("bucket unavailable");
        });
        const saveError = new Error("save refused");

        vi.spyOn(console, "error").mockImplementation(() => undefined);

        const { outcome } = await approveWithFailingSave(context, saveError);

        await expect(outcome).rejects.toBe(saveError);
        expect(context.storage.delete).toHaveBeenCalledOnce();
    });

    it("keeps the record of an object whose delete failed, and the sweep deletes the object later", async () => {
        let bucketUp = false;
        const context = actionContext(async () => {
            if (!bucketUp) {
                throw new Error("bucket unavailable");
            }
        });

        vi.spyOn(console, "error").mockImplementation(() => undefined);

        const { outcome } = await approveWithFailingSave(context, new Error("save refused"));

        await expect(outcome).rejects.toThrow("save refused");

        // The row is gone, so the record is the one trace of the key: it stays.
        const key = context.storage.delete.mock.calls[0]?.[0] as string;

        expect(await chatFiles()).toStrictEqual([]);
        const records = await objectDeletes();

        expect(records.map((record) => record.storageId)).toStrictEqual([key]);

        vi.useFakeTimers({ now: Date.now() + 2 * OBJECT_DELETE_RETRY_MS, shouldAdvanceTime: true });
        bucketUp = true;

        const retried = (await context.runMutation(registry.get("agent_files:retryObjectDeletes"), {})) as Parameters<typeof deleteStoredObjects>[1];

        expect(retried).toHaveLength(1);

        await deleteStoredObjects(context as never, retried);

        expect(context.storage.delete).toHaveBeenCalledTimes(2);
        expect(context.storage.delete.mock.calls[1]?.[0]).toBe(key);
        expect(await objectDeletes()).toStrictEqual([]);
        vi.useRealTimers();
    });

    it("keeps the bytes of a store of the same bytes made after a failed rollback delete, when the sweep deletes again", async () => {
        const context = actionContext();
        const objects = keepObjects(context);

        vi.spyOn(console, "error").mockImplementation(() => undefined);
        context.storage.delete = vi.fn(async () => {
            throw new Error("bucket unavailable");
        });

        const { outcome } = await approveWithFailingSave(context, new Error("save refused"));

        await expect(outcome).rejects.toThrow("save refused");

        const failedKey = context.storage.delete.mock.calls[0]?.[0] as string;

        // The same bytes are stored again before the sweep runs: a new row, under a key of its own.
        context.storage.delete = vi.fn(async (key: string) => {
            objects.delete(key);
        });

        const { file } = await storeFile(context as never, new Blob([SCREENSHOT_BYTES], { type: "image/png" }), { filename: "again.png", userId: OWNER });

        vi.useFakeTimers({ now: Date.now() + 2 * OBJECT_DELETE_RETRY_MS, shouldAdvanceTime: true });

        const retried = (await context.runMutation(registry.get("agent_files:retryObjectDeletes"), {})) as Parameters<typeof deleteStoredObjects>[1];

        await deleteStoredObjects(context as never, retried);

        expect(context.storage.delete.mock.calls.map(([key]) => key)).toStrictEqual([failedKey]);
        expect(objects.has(failedKey)).toBe(false);
        expect(objects.get(file.storageId)).toStrictEqual(SCREENSHOT_BYTES);
        expect(await chatFileIds()).toStrictEqual([file.fileId]);
        vi.useRealTimers();
    });
});

describe("storing a file whose upload fails", () => {
    it("writes no row naming the key, and the next store of the same bytes uploads them under a key of its own", async () => {
        const context = actionContext();
        const objects = keepObjects(context);
        const keep = context.storage.store;
        const blob = () => new Blob([SCREENSHOT_BYTES], { type: "image/png" });

        context.storage.store = vi.fn(async () => {
            throw new Error("bucket unavailable");
        }) as never;

        await expect(storeFile(context as never, blob(), { filename: "shot.png", userId: OWNER })).rejects.toThrow("bucket unavailable");

        // Only the upload record is left, which the sweep deletes the key by; no row hands the key out.
        const [record] = await objectDeletes();

        expect(await chatFiles()).toStrictEqual([]);
        expect(record?.storageId).toMatch(SCREENSHOT_KEY);

        context.storage.store = keep;

        const { created, file } = await storeFile(context as never, blob(), { filename: "shot.png", userId: OWNER });

        expect(created).toBe(true);
        expect(file.storageId).not.toBe(record?.storageId);
        expect(objects.get(file.storageId)).toStrictEqual(SCREENSHOT_BYTES);
        const rows = await chatFiles();

        expect(rows.map((row) => row.storageId)).toStrictEqual([file.storageId]);
    });
});
