/**
 * Device execution limits. The device (`packages/device-core/src/`)
 * enforces its own copies of the size caps; the backend re-applies them and
 * never trusts the device's own count.
 */

/** A device is online while its last heartbeat is younger than this (the page beats every 30 s). */
export const DEVICE_ONLINE_WINDOW_MS = 75_000;

/** A call nobody claimed within this is "device offline". */
export const DEVICE_CLAIM_WINDOW_MS = 20_000;

/**
 * `acp_*` calls (a coding agent's start, send, cancel and permission answers) are not device tools: they have
 * their own claim window and their own open-call budget, so a stuck send never blocks the cancel.
 */
export const ACP_CLAIM_WINDOW_MS = 60_000;
export const MAX_OPEN_ACP_CALLS_PER_DEVICE = 3;
/** `acp_cancel` is counted apart: Stop must go out however many sends and answers are waiting. */
export const MAX_OPEN_ACP_CANCELS_PER_DEVICE = 3;

/**
 * A claimed `acp_*` call is a lease: not completed within this, it goes back to `pending` and can be claimed
 * again until its deadline (plans/acp-agent-host.md §4.1). The desktop writes its receipt within a second or two
 * of the claim, so this covers a relay or main process that died in between. A guess, not a measurement: the
 * latency it should be set from is the S4 throttling record (`plans/acp-s4-throttling.md`).
 */
export const ACP_CLAIM_LEASE_MS = 30_000;

/** Offers a manifest may carry; the desktop sends at most the same number. */
export const MAX_MANIFEST_OFFERS = 50;

/** Approval wait + run, from creation. Also the envelope's `expiresAt`. */
export const DEVICE_CALL_DEADLINE_MS = 5 * 60_000;

/** Open (`pending` + `claimed`) calls one device may hold; a looping model cannot stack prompts. */
export const MAX_OPEN_CALLS_PER_DEVICE = 3;

/** Device calls one tool-set build (one agent run) may make. */
export const MAX_DEVICE_CALLS_PER_RUN = 20;

/** Paired devices per user. */
export const MAX_DEVICES_PER_USER = 10;

/** Tool output kept and handed to the model. */
export const MAX_DEVICE_OUTPUT_BYTES = 64 * 1024;

/** A call's JSON input. */
export const MAX_DEVICE_INPUT_BYTES = 32 * 1024;

/** Manifest caps. */
export const MAX_MANIFEST_TOOLS = 64;
export const MAX_MANIFEST_DESCRIPTION_CHARS = 2000;
export const MAX_MANIFEST_SCHEMA_BYTES = 16 * 1024;
export const MAX_MANIFEST_BYTES = 256 * 1024;

/** A signed manifest or result older (or further ahead) than this is refused. */
export const DEVICE_SIGNATURE_WINDOW_MS = 10 * 60_000;

/** Audit rows older than this are pruned by the housekeeping sweep. */
export const DEVICE_CALL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Poll backoff while a tool waits for its call. */
export const DEVICE_POLL_INITIAL_MS = 250;
export const DEVICE_POLL_MAX_MS = 2000;
