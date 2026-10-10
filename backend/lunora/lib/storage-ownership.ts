/**
 * Which storage keys a user may have SIGNED for them out of data they wrote.
 *
 * Free-form JSON (a workflow graph, a node execution's input/output) is
 * user-controlled: any string can be sent in a URL-named field, including
 * `storage:<someone else's key>`. Signing that on read hands out a working
 * link to another user's object. So a key is only persisted, and only signed,
 * when the user can show a claim to it:
 *
 * - a vault `files` row with that key, owned by them; or
 * - a content-addressed chat file (`agent-files/<sha256>`) they hold a
 *   `chatFileAccess` grant for — written whenever they store (or re-store)
 *   the bytes, generated media included (`storeFile({ userId })`).
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { insertChatFileAccess } from "../agent/table-writes";
import { collectStrings } from "./storage-sign";

const CHAT_FILE_KEY = /^agent-files\/([\da-f]{64})$/u;

/** Rows scanned per hash: one per distinct filename the same bytes were stored under. */
const HASH_SCAN_LIMIT = 50;

type Database = Pick<QueryCtx, "db">["db"];

const ownsVaultKey = async (db: Database, userId: string, key: string): Promise<boolean> => {
    const rows = await db
        .query("files")
        .withIndex("by_key", (q) => q.eq("key", key))
        .take(HASH_SCAN_LIMIT);

    return rows.some((row) => row.userId === userId);
};

/** The `chatFiles` rows holding content-addressed `key` (one per filename it was stored under). */
const chatFilesForKey = async (db: Database, key: string) => {
    const hash = CHAT_FILE_KEY.exec(key)?.[1];

    if (!hash) {
        return [];
    }

    // `.global()`: the one content-addressed row set every user's files share.
    const { page: files } = await db.chatFiles.findMany({ limit: HASH_SCAN_LIMIT, where: { hash } });

    return files.filter((file) => file.storageId === key);
};

const hasGrant = async (db: Database, fileId: Id<"chatFiles">, userId: string): Promise<boolean> =>
    (await db.chatFileAccess.findFirst({ where: { fileId, userId } })) !== null;

const ownsChatFileKey = async (db: Database, userId: string, key: string): Promise<boolean> => {
    const files = await chatFilesForKey(db, key);

    for (const file of files) {
        if (await hasGrant(db, file._id as Id<"chatFiles">, userId)) {
            return true;
        }
    }

    return false;
};

export const ownsStorageKey = async (db: Database, userId: string, key: string): Promise<boolean> =>
    (await ownsChatFileKey(db, userId, key)) || (await ownsVaultKey(db, userId, key));

/** The content-addressed chat-file keys among `keys` that `userId` holds a grant for: two reads. */
const ownedChatFileKeys = async (db: Database, userId: string, keys: string[]): Promise<Set<string>> => {
    const owned = new Set<string>();
    const hashes = [...new Set(keys.map((key) => CHAT_FILE_KEY.exec(key)?.[1]).filter((hash): hash is string => hash !== undefined))];

    if (hashes.length === 0) {
        return owned;
    }

    const { page: candidates } = await db.chatFiles.findMany({ limit: HASH_SCAN_LIMIT * hashes.length, where: { hash: { in: hashes } } });
    const files = candidates.filter((file) => keys.includes(file.storageId));

    if (files.length === 0) {
        return owned;
    }

    const { page: grants } = await db.chatFileAccess.findMany({ where: { fileId: { in: files.map((file) => file._id as Id<"chatFiles">) }, userId } });
    const granted = new Set(grants.map((grant) => grant.fileId as string));

    for (const file of files) {
        if (granted.has(file._id as string)) {
            owned.add(file.storageId);
        }
    }

    return owned;
};

/** A content-addressed chat-file key anywhere in a string: a `storage:` ref, a signed URL, or inside serialized JSON. */
const CHAT_FILE_KEY_IN_TEXT = /agent-files\/[\da-f]{64}/gu;

/**
 * The ids of the chat files `value` mentions (at any depth, in any string)
 * that `userId` holds a grant for. A tool result carries the media its tool
 * stored only as a reference; `addMessagesHandler` puts these ids on the
 * message's `fileIds`, so the file is counted while the message exists and
 * released when it is deleted. Only granted files count: a reference to
 * someone else's bytes in a tool's output attaches nothing.
 */
export const ownedChatFileIdsIn = async (db: Database, userId: string, value: unknown): Promise<Id<"chatFiles">[]> => {
    const keys = [...new Set(collectStrings(value).flatMap((text) => text.match(CHAT_FILE_KEY_IN_TEXT) ?? []))];
    const hashes = keys.map((key) => CHAT_FILE_KEY.exec(key)?.[1]).filter((hash): hash is string => hash !== undefined);

    if (hashes.length === 0) {
        return [];
    }

    const { page: candidates } = await db.chatFiles.findMany({ limit: HASH_SCAN_LIMIT * hashes.length, where: { hash: { in: hashes } } });
    const files = candidates.filter((file) => keys.includes(file.storageId));

    if (files.length === 0) {
        return [];
    }

    const { page: grants } = await db.chatFileAccess.findMany({ where: { fileId: { in: files.map((file) => file._id as Id<"chatFiles">) }, userId } });

    return [...new Set(grants.map((grant) => grant.fileId as Id<"chatFiles">))];
};

/**
 * The subset of `keys` that `userId` owns — {@link ownsStorageKey} for a whole
 * page at once. Signing a page of messages calls this, and `chatFiles` /
 * `chatFileAccess` are `.global()`: key by key it was up to three D1 round
 * trips per key, the grant checks one after another. Here it is at most three
 * reads for the lot (chat files, their grants, vault rows).
 */
export const ownedStorageKeys = async (db: Database, userId: string, keys: Iterable<string>): Promise<Set<string>> => {
    const unique = [...new Set(keys)];
    const owned = await ownedChatFileKeys(db, userId, unique);
    const rest = unique.filter((key) => !owned.has(key));

    if (rest.length > 0) {
        const { page: vaultRows } = await db.files.findMany({ limit: HASH_SCAN_LIMIT * rest.length, where: { key: { in: rest } } });

        for (const row of vaultRows) {
            if (row.userId === userId && row.key !== undefined) {
                owned.add(row.key);
            }
        }
    }

    return owned;
};

/**
 * Hand `toUserId` the chat files among `keys` that `fromUserId` owns — for a
 * copy of `fromUserId`'s data that `toUserId` may make (a fork of a public
 * workflow). Only keys the SOURCE owner owns are granted, so a reference they
 * planted to someone else's storage is not laundered through the copy. Vault
 * keys cannot be granted (a vault file has one owner); a fork copies those
 * instead (`vault/fork-copy.ts`). Returns the chat-file keys granted.
 */
export const grantOwnedChatFiles = async (db: MutationCtx["db"], fromUserId: string, toUserId: string, keys: Iterable<string>): Promise<Set<string>> => {
    const granted = new Set<string>();
    const uniqueKeys = new Set(keys);

    for (const key of uniqueKeys) {
        const files = await chatFilesForKey(db, key);
        let sourceOwns = false;

        for (const file of files) {
            if (await hasGrant(db, file._id as Id<"chatFiles">, fromUserId)) {
                sourceOwns = true;
                break;
            }
        }

        if (!sourceOwns) {
            continue;
        }

        const [file] = files;

        if (file && !(await hasGrant(db, file._id as Id<"chatFiles">, toUserId))) {
            await insertChatFileAccess(db, file._id as Id<"chatFiles">, toUserId);
        }

        granted.add(key);
    }

    return granted;
};
