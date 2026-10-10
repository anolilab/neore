/**
 * Staging keys for browser uploads.
 *
 * Every upload — a chat attachment, a vault or knowledge-base file, a chat
 * import — reaches R2 the same way: the browser sends the bytes over TUS to the
 * upload route (`lib/upload-route.ts`), which writes them to a STAGING key, and
 * a finalize step (`file.ts#finalizeChatUpload`, `vault/functions.ts#saveVaultFile`,
 * `chat-import/functions.ts#startImportJob`) takes the object from there.
 *
 * The key carries its owner — `uploads/<userId>/<uploadId>` — so ownership is a
 * property of the key rather than a row to look up. The upload route names the
 * object from the CALLER's identity and the id `@visulima/storage` generates,
 * never from anything the client sends, and the client only ever hands back the
 * `uploadId`; a finalize rebuilds the key from the caller's identity, so it can
 * only ever address the caller's own prefix.
 *
 * The resumable upload's own state (progress, buffered segments) lives under
 * {@link uploadStatePrefixFor}, also per user: a `PATCH`/`HEAD` naming another
 * user's upload id finds no state and answers 404.
 *
 * Objects never finalized are deleted by a per-key reap the upload route
 * schedules when an upload is created ({@link STAGING_TTL_MS}) and, as a
 * backstop, by the shard housekeeping sweep (`file.ts#sweepStagedChatUploads`),
 * which also clears abandoned upload state.
 */

/** Every staging object lives under this prefix, and nothing else does. */
export const STAGING_PREFIX = "uploads/";

/** Resumable-upload state, per user. Never a staging key: no upload is named under it. */
export const UPLOAD_STATE_PREFIX = "upload-state/";

/**
 * How long a staging object may wait for its finalize before it is reaped, and
 * how long an upload's state may sit untouched before the purge drops it.
 */
export const STAGING_TTL_MS = 60 * 60 * 1000;

/** `@visulima/storage`'s generated ids: nanoid's 21 URL-safe characters. */
const UPLOAD_ID = /^[\w-]{21}$/u;

/** The prefix one user's staging objects live under. */
export const stagingPrefixFor = (userId: string): string => `${STAGING_PREFIX}${userId}/`;

/** The prefix one user's resumable-upload state lives under. */
export const uploadStatePrefixFor = (userId: string): string => `${UPLOAD_STATE_PREFIX}${userId}/`;

/** The staging key of `uploadId` for `userId` — always spelled from a server-trusted identity. */
export const stagingKeyFor = (userId: string, uploadId: string): string => `${stagingPrefixFor(userId)}${uploadId}`;

/** Whether `uploadId` is shaped like one the upload route generates — nothing that could climb out of a prefix. */
export const isUploadId = (uploadId: string): boolean => UPLOAD_ID.test(uploadId);
