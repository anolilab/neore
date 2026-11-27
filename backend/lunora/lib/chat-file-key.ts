/**
 * Storage keys of chat files (`chatFiles.storageId`).
 *
 * Every upload writes its own key, `agent-files/<sha256>/<uuid>`, so a key is written once and named only by the row that
 * upload created (plus the stores that reused that row). Deleting a row's object therefore never races a store of the same
 * bytes: such a store writes a key of its own.
 *
 * Rows stored before that name the content-addressed key `agent-files/<sha256>`, which several rows may share: those are
 * deleted only once no row names them (`agent/files.ts#isStorageKeyNamed`). No new row is written with one.
 */

const HEX_64 = String.raw`[\da-f]{64}`;
const UUID = String.raw`[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}`;

/** Either form; the hash is group 1. */
const CHAT_FILE_KEY = new RegExp(`^agent-files/(${HEX_64})(?:/${UUID})?$`, "u");

/** Only the per-upload form. */
const UNIQUE_CHAT_FILE_KEY = new RegExp(`^agent-files/(${HEX_64})/${UUID}$`, "u");

/** A chat-file key of either form anywhere in a string: a `storage:` ref, a signed URL, or inside serialized JSON. */
export const CHAT_FILE_KEY_IN_TEXT = new RegExp(`agent-files/${HEX_64}(?:/${UUID})?`, "gu");

/** A fresh key for one upload of bytes `hash`. */
export const newChatFileKey = (hash: string): string => `agent-files/${hash}/${crypto.randomUUID()}`;

/** The content hash a chat-file key names, or `undefined` for a key that is not one. */
export const chatFileKeyHash = (key: string): string | undefined => CHAT_FILE_KEY.exec(key)?.[1];

/** Whether `key` is a per-upload key (written by one upload, never shared by rows it did not create or hand out). */
export const isUniqueChatFileKey = (key: string): boolean => UNIQUE_CHAT_FILE_KEY.test(key);

/** Whether `key` is a per-upload key for bytes `hash`. */
export const isUniqueChatFileKeyFor = (key: string, hash: string): boolean => UNIQUE_CHAT_FILE_KEY.exec(key)?.[1] === hash;
