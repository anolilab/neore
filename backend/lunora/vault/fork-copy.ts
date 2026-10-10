/**
 * Vault images in a forked workflow: the forker gets their OWN copy.
 *
 * A chat file (`agent-files/<sha256>`) is content-addressed and shared, so a
 * fork grants it (`grantOwnedChatFiles`). A vault `files` row has exactly one
 * owner and no grant table, so the other two options were a new read-grant
 * mechanism for vault keys or a copy. A copy wins:
 *
 * - It is what a fork already is. The graph itself is copied, not shared; the
 *   images it names follow the same rule, and the forker's copy survives the
 *   author later deleting the file or their account.
 * - No new authorization surface. The copy is an ordinary `files` row owned by
 *   the forker, so `ownsVaultKey` — the one rule every read and write of a
 *   workflow graph already goes through — accepts it unchanged. A grant table
 *   would have to be consulted, and cleaned up, everywhere that rule is.
 * - The author's key never reaches the fork, so nothing the forker does (delete,
 *   move, re-publish) can touch the author's object.
 *
 * The row is written in the fork's own transaction; the bytes follow in
 * {@link copyVaultObjects}, because mutations get a read-only `ctx.storage` (see
 * `storage-cleanup.ts`). Until it lands the image reads as missing, which is
 * also what a failed copy leaves.
 *
 * Only a vault file the AUTHOR owns is copied. A key they planted to someone
 * else's file is left alone and stripped by `ownedStorageRefsInUrlFields`.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { storageLogger } from "../lib/logger";
import { mapStrings, isUrlFieldName } from "../lib/storage-sign";
import type { StorageReader } from "../lib/storage-read";
import { MAX_STORED_READ_BYTES, readStoredObject } from "../lib/storage-read";
import { issuedStorageOrigins, storageKeyOf, toStorageRef } from "../lib/storage-ref";

/** Most vault images one fork may copy. Images past the cap are stripped, as any unowned reference is. */
export const MAX_VAULT_COPIES_PER_FORK = 50;

/** Rows read per requested key: the owner's row is among them when the key is a vault key. */
const ROWS_PER_KEY = 50;

/** One object to copy: the author's key and the forker's fresh one. */
interface VaultObjectCopy {
    from: string;
    to: string;
}

/**
 * The fields of an author's vault row a fork copies. The validator is the one
 * declaration; the type is derived from it.
 */
export const vVaultRowToCopy = v.object({
    isGenerated: v.optional(v.boolean()),
    key: v.string(),
    name: v.string(),
    nsfwScores: v.optional(v.object({ drawing: v.number(), hentai: v.number(), neutral: v.number(), porn: v.number(), sexy: v.number() })),
    nsfwStatus: v.optional(v.union(v.literal("pending"), v.literal("checking"), v.literal("safe"), v.literal("blocked"), v.literal("failed"))),
    size: v.number(),
    type: v.string(),
});

export type VaultRowToCopy = Infer<typeof vVaultRowToCopy>;

/**
 * The vault rows among `keys` that `ownerId` owns and that may be copied: an image
 * with no check status, or one that passed. A pending, checking, blocked or failed
 * image is not copied, so its reference is stripped from the fork: a copy would
 * keep the status it had, and the verdict never reaches the copy. Runs on the OWNER's shard, where their
 * `files` rows live (docs/plans/per-user-sharding.md). One read for the whole set.
 */
export const findOwnedVaultRows = async (db: QueryCtx["db"], ownerId: string, keys: Iterable<string>): Promise<VaultRowToCopy[]> => {
    const uniqueKeys = [...new Set(keys)];

    if (uniqueKeys.length === 0) {
        return [];
    }

    const { page } = await db.files.findMany({ limit: uniqueKeys.length * ROWS_PER_KEY, where: { key: { in: uniqueKeys } } });
    const bySource = new Map<string, VaultRowToCopy>();

    for (const row of page) {
        if (row.userId === ownerId && (row.nsfwStatus === undefined || row.nsfwStatus === "safe") && row.key !== undefined && !bySource.has(row.key)) {
            bySource.set(row.key, {
                isGenerated: row.isGenerated,
                key: row.key,
                name: row.name,
                nsfwScores: row.nsfwScores,
                nsfwStatus: row.nsfwStatus,
                size: row.size,
                type: row.type,
            });
        }
    }

    return [...bySource.values()].slice(0, MAX_VAULT_COPIES_PER_FORK);
};

/**
 * Insert a `files` row for `toUserId` under a fresh key for each source row and
 * return `authorKey → forkerKey`. Runs on the FORKER's shard.
 */
export const insertVaultCopies = async (
    db: MutationCtx["db"],
    sources: ReadonlyArray<VaultRowToCopy>,
    toUserId: string,
    now: number = Date.now(),
): Promise<Map<string, string>> => {
    const copies = new Map<string, string>();

    for (const source of sources) {
        const copyKey = crypto.randomUUID();

        // Not the chat, folder or project: those are the author's. The verdict is
        // carried over: only a copy of an image that passed the check is made.
        await db.insert("files", {
            createdAt: now,
            isGenerated: source.isGenerated,
            key: copyKey,
            name: source.name,
            nsfwScores: source.nsfwScores,
            nsfwStatus: source.nsfwStatus,
            size: source.size,
            type: source.type,
            updatedAt: now,
            userId: toUserId,
        });

        copies.set(source.key, copyKey);
    }

    return copies;
};

/** `value` with every URL-named field naming a key in `copies` pointed at its copy instead. */
export const rewriteStorageKeys = <T>(value: T, copies: ReadonlyMap<string, string>, origins: ReadonlyArray<string> = issuedStorageOrigins()): T => {
    if (copies.size === 0) {
        return value;
    }

    return mapStrings(
        value,
        (text) => {
            const key = storageKeyOf(text, origins);
            const copy = key === null ? undefined : copies.get(key);

            return copy === undefined ? text : toStorageRef(copy);
        },
        isUrlFieldName,
    ) as T;
};

/** Copy the bytes once the calling mutation commits. Empty input schedules nothing. */
export const scheduleVaultObjectCopies = async (context: Pick<MutationCtx, "scheduler">, copies: ReadonlyMap<string, string>): Promise<void> => {
    if (copies.size === 0) {
        return;
    }

    await context.scheduler.runAfter(0, internal.vault.fork_copy.copyVaultObjects, {
        copies: [...copies].map(([from, to]) => {
            return { from, to };
        }),
    });
};

/** The slice of `ctx.storage` a copy needs. */
export interface CopyStorage extends StorageReader {
    store: (key: string, body: ArrayBuffer, options?: { contentType?: string }) => Promise<unknown>;
}

/**
 * Copy each object's bytes and content type to its new key, and return the keys
 * copied. A source the author deleted after the fork is logged and skipped; any
 * other failure is rethrown after the rest are copied, so the scheduler retries
 * the job. A copy that lands again overwrites the same key, so a retry is safe.
 */
export const copyStoredObjects = async (storage: CopyStorage, copies: ReadonlyArray<VaultObjectCopy>): Promise<string[]> => {
    const copied: string[] = [];
    const failed: string[] = [];

    for (const { from, to } of copies) {
        try {
            const { bytes, contentType } = await readStoredObject(storage, from, { maxBytes: MAX_STORED_READ_BYTES });

            await storage.store(to, bytes, contentType ? { contentType } : undefined);
            copied.push(to);
        } catch (error) {
            if (isMissingObject(error)) {
                storageLogger.warn(`Vault object ${from} is gone; the workflow fork keeps no copy of it`, error);
            } else {
                storageLogger.error(`Failed to copy vault object ${from} for a workflow fork`, error);
                failed.push(from);
            }
        }
    }

    if (failed.length > 0) {
        throw new Error(`${failed.length} vault object(s) failed to copy for a workflow fork; the job will be retried`);
    }

    return copied;
};

/** `readStoredObject` reports a key that is not there as `NOT_FOUND`. */
const isMissingObject = (error: unknown): boolean => error instanceof LunoraError && error.code === "NOT_FOUND";

export const copyVaultObjects = internalAction
    .input({ copies: v.array(v.object({ from: v.string(), to: v.string() })) })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        await copyStoredObjects(ctx.storage, args.copies);

        return null;
    });
