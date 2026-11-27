/**
 * Deleting several messages that share one file releases one reference each.
 * `changeRefcount` is read-modify-write on `chatFiles`, so deleting them in
 * parallel read the same count N times and wrote one decrement: the file was
 * never reaped.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { newChatFileKey } from "../lib/chat-file-key";
import { deleteStoredObjects } from "./client/object-deletes";
import {
    addFile,
    addFileHandler,
    changeRefcount,
    deleteFiles,
    discardUnsavedFiles,
    OBJECT_DELETE_RETRY_MS,
    retryObjectDeletes,
    STORE_INTENT_MS,
    useExistingFile,
} from "./files";
import { deleteByIds } from "./messages";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const OWNER = "user-owner";
const MESSAGES = 3;

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "agent_files", await import("./files"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const refcountOf = async (fileId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const file = await ctx.db.chatFiles.findFirst({ where: { _id: fileId } });

        return file.refcount;
    });

describe("deleteByIds", () => {
    it("releases one file reference per deleted message", async () => {
        const { fileId } = (await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(addFile, { filename: "a.png", hash: "h1", mediaType: "image/png", storageId: "agent-files/h1", userId: OWNER }),
        )) as { fileId: string };

        const messageIds = await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { model: "m", status: "active", title: "t", userId: OWNER });
            const ids: string[] = [];

            for (let index = 0; index < MESSAGES; index += 1) {
                await changeRefcount(ctx, [], [fileId] as never);
                ids.push(
                    await ctx.db.insert("messages", {
                        fileIds: [fileId],
                        message: { content: "see file", role: "user" },
                        order: index,
                        status: "success",
                        stepOrder: 0,
                        text: "see file",
                        threadId,
                        tool: false,
                        userId: OWNER,
                    }),
                );
            }

            return ids;
        });
        const before = await refcountOf(fileId);

        expect(before).toBeGreaterThanOrEqual(MESSAGES);

        await harness.run(async (ctx: any) => await ctx.runMutation(deleteByIds, { messageIds }));

        expect(await refcountOf(fileId)).toBe(before - MESSAGES);
    });
});

describe("discardUnsavedFiles", () => {
    const store = async (userId: string) =>
        (await harness.run(
            async (ctx: any) => await ctx.runMutation(addFile, { filename: "a.png", hash: "h2", mediaType: "image/png", storageId: "agent-files/h2", userId }),
        )) as { created: boolean; fileId: string };

    it("keeps a row a racing store reused, with that store's grant and object", async () => {
        const first = await store(OWNER);
        const racing = await store("user-other");

        expect(racing).toStrictEqual({ ...first, created: false });

        const keys = await harness.run(async (ctx: any) => await ctx.runMutation(discardUnsavedFiles, { fileIds: [first.fileId] }));
        const rows = await harness.run(async (ctx: any) => {
            const { page: files } = await ctx.db.chatFiles.findMany({});
            const { page: grants } = await ctx.db.chatFileAccess.findMany({});

            return { files: files.map((file: { _id: string }) => file._id), grantees: grants.map((grant: { userId: string }) => grant.userId) };
        });

        expect(keys).toStrictEqual([]);
        expect(rows.files).toStrictEqual([first.fileId]);
        expect(rows.grantees).toContain("user-other");
    });

    it("keeps a row another store reuses while the rollback is deciding, with that store's grant", async () => {
        const first = await store(OWNER);
        let reused: { fileId: string } | null | undefined;

        await harness.run(async (ctx: any) => {
            const findMany = ctx.db.chatFileAccess.findMany.bind(ctx.db.chatFileAccess);

            // Another reply finds the row and hands it out again between the rollback's check and its deletes.
            vi.spyOn(ctx.db.chatFileAccess, "findMany").mockImplementation(async (options: any) => {
                if (reused === undefined) {
                    reused = await (useExistingFile as any).handler(ctx, { filename: "a.png", hash: "h2", userId: "user-other" });
                }

                return await findMany(options);
            });

            await (discardUnsavedFiles as any).handler(ctx, { fileIds: [first.fileId] });
        });

        const rows = await harness.run(async (ctx: any) => {
            const { page: files } = await ctx.db.chatFiles.findMany({});
            const { page: access } = await ctx.db.chatFileAccess.findMany({});

            return { files: files.map((file: { _id: string }) => file._id), grants: access.map((grant: { fileId: string; userId: string }) => grant) };
        });

        // Either the reuse landed first (the row stays with its grant) or it found the row going and handed nothing out.
        if (reused) {
            expect(rows.files).toContain(reused.fileId);
            expect(rows.grants).toContainEqual(expect.objectContaining({ fileId: reused.fileId, userId: "user-other" }));
        } else {
            expect(reused).toBeNull();
            expect(rows.files).toStrictEqual([]);
        }
    });
});

const HASH = "a".repeat(64);
const RECORD_GONE = /record is gone/u;
const OWN_BYTES = /own bytes/u;
const UPLOAD_TAKEN = /record is gone|took too long/u;

const storageIdsOf = (rows: { storageId: string }[]): string[] => rows.map((row) => row.storageId);

const objectDeletes = async (): Promise<{ _id: string; deleteAfter: number; storageId: string }[]> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.chatFileObjectDeletes.findMany({});

        return page;
    });

const chatFileRows = async (): Promise<{ _id: string; storageId: string }[]> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.chatFiles.findMany({});

        return page;
    });

/** A store as `storeFile` makes it: the key recorded by `useExistingFile`, then (the upload) the row by `addFile`. */
const storeUnique = async (filename: string, userId = OWNER) => {
    const storageId = newChatFileKey(HASH);
    const reused = await harness.run(async (ctx: any) => await ctx.runMutation(useExistingFile, { filename, hash: HASH, uploadKey: storageId, userId }));

    expect(reused).toBeNull();

    return { storageId };
};

const addUnique = async (filename: string, storageId: string, userId = OWNER) =>
    (await harness.run(async (ctx: any) => await ctx.runMutation(addFile, { filename, hash: HASH, mediaType: "image/png", storageId, userId }))) as {
        created: boolean;
        discardedUpload: string | null;
        fileId: string;
        storageId: string;
    };

describe("per-upload storage keys", () => {
    it("records the key before the upload and drops the record once a row names it", async () => {
        const { storageId } = await storeUnique("a.png");

        expect(storageIdsOf(await objectDeletes())).toStrictEqual([storageId]);

        const added = await addUnique("a.png", storageId);

        expect(added).toMatchObject({ created: true, discardedUpload: null, storageId });
        expect(await objectDeletes()).toStrictEqual([]);
    });

    it("refuses a row for a per-upload key no store recorded, so no row can name a key whose delete may run", async () => {
        await expect(addUnique("a.png", newChatFileKey(HASH))).rejects.toThrow(RECORD_GONE);
        expect(await chatFileRows()).toStrictEqual([]);
    });

    it("refuses an upload key that names other bytes", async () => {
        await expect(
            harness.run(async (ctx: any) => await ctx.runMutation(useExistingFile, { hash: HASH, uploadKey: newChatFileKey("b".repeat(64)) })),
        ).rejects.toThrow(OWN_BYTES);
    });

    it("a store whose upload the sweep already took cannot write a row naming the deleted key", async () => {
        const { storageId } = await storeUnique("a.png");

        vi.useFakeTimers({ now: Date.now() + STORE_INTENT_MS + 1000, shouldAdvanceTime: true });

        try {
            const taken = await harness.run(async (ctx: any) => await ctx.runMutation(retryObjectDeletes, {}));

            expect(taken).toHaveLength(1);
            await expect(addUnique("a.png", storageId)).rejects.toThrow(UPLOAD_TAKEN);
            expect(await chatFileRows()).toStrictEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    /** `addFileHandler` over a database whose `chatFiles` insert fails, before or after the row lands; the error is caught in the run. */
    const addWithFailingInsert = async (storageId: string, landed: boolean): Promise<unknown> =>
        await harness.run(async (ctx: any) => {
            const db = new Proxy(ctx.db, {
                get(target, property) {
                    if (property === "insert") {
                        return async (table: string, row: unknown) => {
                            if (table !== "chatFiles") {
                                return await target.insert(table, row);
                            }

                            if (landed) {
                                await target.insert(table, row);
                            }

                            throw new Error("D1 unavailable");
                        };
                    }

                    const value = Reflect.get(target, property);

                    return typeof value === "function" ? value.bind(target) : value;
                },
            });

            return await addFileHandler({ db, now: ctx.now } as never, {
                filename: "a.png",
                hash: HASH,
                mediaType: "image/png",
                storageId,
                userId: OWNER,
            }).catch((error: unknown) => error);
        });

    it("a store whose row insert failed gives its upload record back, so the sweep deletes the object", async () => {
        const { storageId } = await storeUnique("a.png");
        const [recorded] = await objectDeletes();

        expect(await addWithFailingInsert(storageId, false)).toMatchObject({ message: "D1 unavailable" });
        expect(await chatFileRows()).toStrictEqual([]);
        expect(await objectDeletes()).toMatchObject([{ deleteAfter: recorded!.deleteAfter, storageId }]);

        vi.useFakeTimers({ now: Date.now() + STORE_INTENT_MS + 1000, shouldAdvanceTime: true });

        try {
            expect(await harness.run(async (ctx: any) => await ctx.runMutation(retryObjectDeletes, {}))).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a store whose row insert reported failure after landing keeps the object its row names", async () => {
        const { storageId } = await storeUnique("a.png");

        expect(await addWithFailingInsert(storageId, true)).toMatchObject({ message: "D1 unavailable" });
        expect(storageIdsOf(await chatFileRows())).toStrictEqual([storageId]);
        expect(await objectDeletes()).toStrictEqual([]);
    });

    it("a store that lost the race to another store's row deletes its own upload, never the row's", async () => {
        const first = await storeUnique("a.png");
        const second = await storeUnique("a.png", "user-other");
        const kept = await addUnique("a.png", first.storageId);
        const racing = await addUnique("a.png", second.storageId, "user-other");

        expect(racing).toMatchObject({ created: false, fileId: kept.fileId, storageId: first.storageId });
        expect(racing.discardedUpload).not.toBeNull();
        expect(storageIdsOf(await objectDeletes())).toStrictEqual([second.storageId]);
    });
});

describe("deleteFiles", () => {
    const legacyKey = `agent-files/${HASH}`;
    /** A row of {@link HASH} under the old shared key, as stored before per-upload keys. */
    const add = async (filename: string) =>
        (await harness.run(
            async (ctx: any) => await ctx.runMutation(addFile, { filename, hash: HASH, mediaType: "image/png", storageId: legacyKey, userId: OWNER }),
        )) as { fileId: string };

    it("deletes a per-upload key with its row, and never another row's key for the same bytes", async () => {
        const a = await storeUnique("a.png");
        const b = await storeUnique("b.png");
        const unused = await addUnique("a.png", a.storageId);

        await addUnique("b.png", b.storageId);

        const scheduled = await harness.run(async (ctx: any) => {
            const runAfter = vi.spyOn(ctx.scheduler, "runAfter");
            const deleted = await (deleteFiles as any).handler(ctx, { fileIds: [unused.fileId] });

            return { calls: runAfter.mock.calls.length, deleted };
        });

        expect(scheduled).toStrictEqual({ calls: 1, deleted: [unused.fileId] });
        expect(storageIdsOf(await objectDeletes())).toStrictEqual([a.storageId]);
        expect(storageIdsOf(await chatFileRows())).toStrictEqual([b.storageId]);
    });

    it("keeps an old shared key while another row names it, and deletes it with its last row", async () => {
        const first = await add("a.png");
        const last = await add("b.png");

        await harness.run(async (ctx: any) => await ctx.runMutation(deleteFiles, { fileIds: [first.fileId] }));

        expect(await objectDeletes()).toStrictEqual([]);

        await harness.run(async (ctx: any) => await ctx.runMutation(deleteFiles, { fileIds: [last.fileId] }));

        expect(storageIdsOf(await objectDeletes())).toStrictEqual([legacyKey]);
    });

    /** `count` rows of {@link HASH} under per-upload keys of their own, inserted directly: other names of the same bytes. */
    const seedOtherRows = async (count: number): Promise<void> => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < count; index += 1) {
                await ctx.db.insert("chatFiles", {
                    filename: `other-${index}.png`,
                    hash: HASH,
                    lastTouchedAt: Date.now(),
                    mediaType: "image/png",
                    refcount: 1,
                    storageId: newChatFileKey(HASH),
                });
            }
        });
    };

    it("keeps an old shared key a row names when more than a page of other rows have the same bytes", async () => {
        const doomed = await add("a.png");

        // The row still naming the key is written after 60 others of the same bytes, so a capped page of the hash misses it.
        await seedOtherRows(60);
        await add("b.png");

        await harness.run(async (ctx: any) => await ctx.runMutation(deleteFiles, { fileIds: [doomed.fileId] }));

        expect(await objectDeletes()).toStrictEqual([]);
    });

    it("deletes an old shared key with its last row whatever the number of other rows of the same bytes", async () => {
        // More rows of the hash than any bounded page walk reads: the old walk kept the key for good.
        await seedOtherRows(210);

        const last = await add("a.png");

        await harness.run(async (ctx: any) => await ctx.runMutation(deleteFiles, { fileIds: [last.fileId] }));

        expect(storageIdsOf(await objectDeletes())).toStrictEqual([legacyKey]);
    });

    it("keeps the record when the sweep's object delete never ran, and a later sweep deletes the object", async () => {
        const { storageId } = await storeUnique("a.png");
        const unused = await addUnique("a.png", storageId);

        // The scheduled delete (`deleteStoredObjectsJob`) dies: only the record is left of the key.
        await harness.run(async (ctx: any) => {
            vi.spyOn(ctx.scheduler, "runAfter").mockResolvedValue(undefined);
            await (deleteFiles as any).handler(ctx, { fileIds: [unused.fileId] });
        });

        expect(await chatFileRows()).toStrictEqual([]);
        expect(storageIdsOf(await objectDeletes())).toStrictEqual([storageId]);

        vi.useFakeTimers({ now: Date.now() + 2 * OBJECT_DELETE_RETRY_MS, shouldAdvanceTime: true });

        try {
            const retried = (await harness.run(async (ctx: any) => await ctx.runMutation(retryObjectDeletes, {}))) as string[];
            const deleted: string[] = [];

            await deleteStoredObjects(
                {
                    runMutation: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runMutation(reference, args)),
                    runQuery: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runQuery(reference, args)),
                    storage: {
                        delete: async (key: string) => {
                            deleted.push(key);
                        },
                    },
                } as never,
                retried as never,
            );

            expect(deleted).toStrictEqual([storageId]);
            expect(await objectDeletes()).toStrictEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("leaves the object another row for the same bytes names", async () => {
        const unused = (await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(addFile, { filename: "a.png", hash: "h3", mediaType: "image/png", storageId: "agent-files/h3", userId: OWNER }),
        )) as { fileId: string };

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(addFile, { filename: "b.png", hash: "h3", mediaType: "image/png", storageId: "agent-files/h3", userId: OWNER }),
        );

        const scheduled = await harness.run(async (ctx: any) => {
            const runAfter = vi.spyOn(ctx.scheduler, "runAfter");
            const deleted = await (deleteFiles as any).handler(ctx, { fileIds: [unused.fileId] });

            return { calls: runAfter.mock.calls.length, deleted };
        });

        expect(scheduled).toStrictEqual({ calls: 0, deleted: [unused.fileId] });
        expect(await objectDeletes()).toStrictEqual([]);
    });
});
