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
 * property of the key rather than a row to look up. Reference media (a purpose
 * other than chat) sits one segment deeper, `uploads/<userId>/reference-media/<uploadId>`,
 * so each finalize addresses only its own purpose's objects. The upload route names the
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

/**
 * The invariant every key in this module rests on: a user id is ONE non-empty
 * path segment, with no `/`. {@link purposeOfStagingKey} reads the purpose from
 * the segment count, and a key with an extra slash in the id would otherwise
 * name another user's prefix. An id that breaks it is a bug, so it throws here
 * rather than being spelled into a key.
 */
export const assertKeySafeUserId = (userId: string): void => {
    if (userId === "" || userId.includes("/")) {
        throw new Error("A staging key's user id must be a non-empty path segment without '/'");
    }
};

/** The prefix one user's staging objects live under. */
export const stagingPrefixFor = (userId: string): string => {
    assertKeySafeUserId(userId);

    return `${STAGING_PREFIX}${userId}/`;
};

/** The prefix one user's resumable-upload state lives under. */
export const uploadStatePrefixFor = (userId: string): string => {
    assertKeySafeUserId(userId);

    return `${UPLOAD_STATE_PREFIX}${userId}/`;
};

/**
 * What an upload is for. Chat is the default and what every object without a
 * stamp is. `reference-media` is a workflow's video and audio (`document-limits.ts`).
 */
export type UploadPurpose = "chat" | "reference-media";

/** The R2 custom-metadata key every staged object is stamped with. Absent means chat (objects from before the stamp). */
export const PURPOSE_METADATA_KEY = "purpose";

/** The key segment a purpose's objects live under. Chat has none: its keys are the historical `uploads/<userId>/<uploadId>`. */
const PURPOSE_SEGMENT: Readonly<Record<Exclude<UploadPurpose, "chat">, string>> = { "reference-media": "reference-media" };

/**
 * The staging key of `uploadId` for `userId` and `purpose` — always spelled
 * from a server-trusted identity and purpose. A purpose gets its own segment,
 * so a chat finalize cannot even name another purpose's object.
 */
export const stagingKeyFor = (userId: string, uploadId: string, purpose: UploadPurpose = "chat"): string =>
    purpose === "chat" ? `${stagingPrefixFor(userId)}${uploadId}` : `${stagingPrefixFor(userId)}${PURPOSE_SEGMENT[purpose]}/${uploadId}`;

/** The purpose a staging key was minted for, read from its shape. Anything that is not a purpose's segment is chat. */
export const purposeOfStagingKey = (key: string): UploadPurpose => {
    const rest = key.startsWith(STAGING_PREFIX) ? key.slice(STAGING_PREFIX.length).split("/") : [];

    return rest.length === 3 && rest[1] === PURPOSE_SEGMENT["reference-media"] ? "reference-media" : "chat";
};

/** Whether an object's custom metadata stamps it with `purpose`. No stamp is chat, which is what objects written before the stamp are. */
export const stagedPurposeIs = (customMetadata: Record<string, string> | undefined, purpose: UploadPurpose): boolean =>
    (customMetadata?.[PURPOSE_METADATA_KEY] ?? "chat") === purpose;

/** Whether `uploadId` is shaped like one the upload route generates — nothing that could climb out of a prefix. */
export const isUploadId = (uploadId: string): boolean => UPLOAD_ID.test(uploadId);
