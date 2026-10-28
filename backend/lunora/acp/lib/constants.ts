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

/**
 * A session the backend started (`acp_start`) is `starting` until the computer's agent opens it. The computer
 * accepts the command when it has it, well before the agent has started; an agent that then fails to start has no
 * other way to say so, so a session still `starting` this long after its command was accepted ends.
 */
export const START_GRACE_MS = 2 * 60_000;
