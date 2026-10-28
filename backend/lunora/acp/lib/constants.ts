/**
 * Host-run turns (`plans/acp-agent-host.md`). The desktop (`apps/desktop/src/acp/ingest.ts`) keeps its own
 * copies of the sizes and the post interval; the backend re-applies them and never trusts the host's count.
 */

/** One signed post, body and all. The route refuses more before parsing it. */
export const MAX_INGEST_BYTES = 256 * 1024;

/** Events in one post: the host batches a quarter second of output, so this is far above any real batch. */
export const MAX_EVENTS_PER_POST = 500;

/** The reply written when a turn ends. The host caps its own transcript at the same length. */
export const MAX_HOST_REPLY_CHARS = 256_000;

/**
 * The reaper window: a host stream with no post for this long is set to `timeout` and its host is sent
 * `acp_cancel`. The host posts a keepalive every 30 s while a turn runs (`KEEPALIVE_MS` in `apps/desktop/src/acp/turn-channel.ts`), so a long silent
 * tool call keeps its stream.
 */
export const HOST_STREAM_IDLE_MS = 3 * 60_000;

/**
 * A stream waiting on a permission answer is not silent, so the reaper skips it (`acp/lib/reap.ts`). A turn
 * older than this is timed out whatever it is waiting on, so a host that never returns cannot hold one forever.
 */
export const HOST_TURN_MAX_MS = 6 * 60 * 60_000;

/** Unauthenticated posts one address may make a minute, before any database is touched. */
export const INGEST_FLOOD_LIMIT_PER_MINUTE = 1200;

/** `lastEventAt` on a session moves at most this often, so a live session list is not re-run per post. */
export const SESSION_TOUCH_MS = 30_000;

// ─── Files a host agent writes (plans/acp-agent-host.md §4.8) ──────────────────────────────────────────────────
//
// PROVISIONAL, NOT MEASURED. The plan sets the cap and the types from a sample of real agent output before S8
// starts; none could be taken when this was written. They are chosen to sit inside what a chat attachment may be
// (`lib/document-limits.ts`: images 20 MB) and to cover what an agent plausibly leaves in a folder: a chart, a
// screenshot, a report. Change them here and in `packages/device-core/src/media.rs`, which holds the same numbers
// (`media-limits.test.ts` fails when the two disagree), once a sample exists.

/** An image up to this size is shown in the message; a larger one is offered as a file with its size. */
export const HOST_MEDIA_MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/** A file above this is not uploaded: the reply names it and says how large it is. */
export const HOST_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/**
 * What the device upload route accepts. A strict subset of the chat allowlist: no SVG, HTML, script, stylesheet or
 * XML, which a browser would run. The desktop decides the same list from a file's bytes and name (`media.rs`).
 */
export const HOST_MEDIA_MIME_TYPES: ReadonlyArray<string> = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
    "text/plain",
    "text/markdown",
    "application/json",
];

/** The types a message shows as an image. */
export const HOST_MEDIA_IMAGE_MIME_TYPES: ReadonlyArray<string> = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The device upload route (`acp/upload-http.ts`). */
export const HOST_UPLOAD_PATH = "/hosts/uploads";

/** The largest `PATCH` body the device upload route buffers (the desktop sends 5 MiB chunks, TUS's usual size). */
export const HOST_UPLOAD_MAX_CHUNK_BYTES = 5 * 1024 * 1024;

/** Request headers of the device upload route: the signed payload (base64url JSON) and its signature (hex). */
export const HOST_UPLOAD_PAYLOAD_HEADER = "neore-device-request";
export const HOST_UPLOAD_SIGNATURE_HEADER = "neore-device-signature";

/** Media events one post may carry: a reply refers to a handful of files, and each is uploaded before the post. */
export const MAX_MEDIA_PER_TURN = 8;
