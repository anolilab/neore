/**
 * `data.code` values on the errors a chat attachment upload can fail with
 * (`file.ts#finalizeChatUpload`), so the composer can
 * word each one in the user's language instead of showing the server's English.
 *
 * No imports: the web app bundles this file (`@neore/backend/chat-upload-codes`).
 */

/** Larger than its kind allows. `data.maxBytes` carries the limit. */
export const CHAT_UPLOAD_TOO_LARGE = "CHAT_UPLOAD_TOO_LARGE";

/** A type the backend does not accept as an attachment. */
export const CHAT_UPLOAD_UNSUPPORTED_TYPE = "CHAT_UPLOAD_UNSUPPORTED_TYPE";

/** The staged object is gone: never uploaded, already finalized, or reaped after its TTL. */
export const CHAT_UPLOAD_EXPIRED = "CHAT_UPLOAD_EXPIRED";

/** The bytes do not look like the declared type (`lib/content-sniff.ts`). */
export const CHAT_UPLOAD_CONTENT_MISMATCH = "CHAT_UPLOAD_CONTENT_MISMATCH";
