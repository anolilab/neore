/**
 * `Idempotency-Key` support for POST routes.
 *
 * A retried POST carrying the same key and the same request replays the first
 * response instead of running again — so a CLI that times out mid-`chat` and
 * retries does not start a second generation or bill twice. Reusing a key for a
 * DIFFERENT request is a client bug and answers `idempotency_conflict`.
 *
 * Records live in the existing `actionCache` table (already swept by the cron
 * in `crons.ts`) under their own family name, scoped by API key id so two keys
 * can never replay each other's responses.
 *
 * Not a lock: two truly concurrent first attempts can both miss and both run,
 * because D1 gives the check-then-write no atomicity. The `pending` marker
 * narrows that window to the time between the read and the write; what it
 * reliably stops is the common case — a retry while the first attempt is still
 * running answers `idempotency_in_progress` rather than running twice.
 */
import { PublicApiError } from "./errors";
import { sha256Hex } from "../lib/crypto";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

export const IDEMPOTENCY_FAMILY = "publicApi/idempotency";

/** How long a completed response is replayable. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a `pending` marker blocks a retry. Longer than any blocking route may run. */
export const IDEMPOTENCY_PENDING_TTL_MS = 10 * 60 * 1000;

/** 1-255 characters of printable ASCII without spaces: `!` (0x21) through `~` (0x7E). */
const isValidKey = (value: string): boolean =>
    value.length > 0 && value.length <= 255 && [...value].every((char) => (char.codePointAt(0) ?? 0) >= 0x21 && (char.codePointAt(0) ?? 0) <= 0x7e);

export type IdempotencyRecord =
    { fingerprint: string; state: "pending" } | { body: string; contentType: string; fingerprint: string; state: "done"; status: number };

export type IdempotencyDecision =
    { kind: "conflict" } | { kind: "in_progress" } | { kind: "proceed" } | { kind: "replay"; record: Extract<IdempotencyRecord, { state: "done" }> };

/** Validate the header. `undefined` = not sent (the route runs normally). */
export const parseIdempotencyKey = (raw: string | null | undefined): string | undefined => {
    if (raw === null || raw === undefined) {
        return undefined;
    }

    if (!isValidKey(raw)) {
        throw new PublicApiError("invalid_request", `\`${IDEMPOTENCY_HEADER}\` must be 1-255 printable ASCII characters.`);
    }

    return raw;
};

export const decideIdempotency = (stored: unknown, fingerprint: string): IdempotencyDecision => {
    if (!stored || typeof stored !== "object") {
        return { kind: "proceed" };
    }

    const record = stored as Partial<IdempotencyRecord>;

    if (record.fingerprint !== fingerprint) {
        return { kind: "conflict" };
    }

    if (record.state === "pending") {
        return { kind: "in_progress" };
    }

    if (record.state === "done" && typeof (record as { status?: unknown }).status === "number") {
        return { kind: "replay", record: record as Extract<IdempotencyRecord, { state: "done" }> };
    }

    return { kind: "proceed" };
};

/** What makes two requests "the same": method, path + query, and the exact body bytes. */
export const requestFingerprint = async (method: string, pathAndQuery: string, body: string): Promise<string> =>
    await sha256Hex(`${method}\n${pathAndQuery}\n${body}`);

/** The storage key. Hashed so the caller's key never lands in the table verbatim. */
export const idempotencyStorageKey = async (apiKeyId: string, idempotencyKey: string): Promise<string> =>
    await sha256Hex(`${IDEMPOTENCY_FAMILY}\u{0}${apiKeyId}\u{0}${idempotencyKey}`);

export interface IdempotencyStore {
    get: (key: string) => Promise<unknown>;
    put: (key: string, value: IdempotencyRecord, ttlMs: number) => Promise<void>;
    remove: (key: string) => Promise<void>;
}

/**
 * Run `handler` under idempotency. Responses with a 5xx status are NOT stored —
 * the marker is removed so the client's retry runs for real.
 */
export const withIdempotency = async (
    store: IdempotencyStore,
    options: { apiKeyId: string; body: string; idempotencyKey: string; method: string; pathAndQuery: string },
    handler: () => Promise<Response>,
): Promise<Response> => {
    const storageKey = await idempotencyStorageKey(options.apiKeyId, options.idempotencyKey);
    const fingerprint = await requestFingerprint(options.method, options.pathAndQuery, options.body);
    const decision = decideIdempotency(await store.get(storageKey), fingerprint);

    if (decision.kind === "conflict") {
        throw new PublicApiError("idempotency_conflict", `This \`${IDEMPOTENCY_HEADER}\` was already used for a different request.`);
    }

    if (decision.kind === "in_progress") {
        throw new PublicApiError("idempotency_in_progress", "A request with this idempotency key is still being processed. Retry shortly.");
    }

    if (decision.kind === "replay") {
        return new Response(decision.record.body, {
            headers: { "Content-Type": decision.record.contentType, "Idempotent-Replayed": "true" },
            status: decision.record.status,
        });
    }

    await store.put(storageKey, { fingerprint, state: "pending" }, IDEMPOTENCY_PENDING_TTL_MS);

    let response: Response;

    try {
        response = await handler();
    } catch (error) {
        await store.remove(storageKey);

        throw error;
    }

    // Streaming bodies cannot be replayed; only buffered JSON is stored.
    const contentType = response.headers.get("Content-Type") ?? "";

    if (response.status >= 500 || !contentType.includes("application/json")) {
        await store.remove(storageKey);

        return response;
    }

    const body = await response.text();

    await store.put(storageKey, { body, contentType, fingerprint, state: "done", status: response.status }, IDEMPOTENCY_TTL_MS);

    return new Response(body, { headers: response.headers, status: response.status });
};
