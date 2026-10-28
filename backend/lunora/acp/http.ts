/**
 * `POST /hosts/ingest` — where a paired computer's main process posts a coding agent's turn output
 * (plans/acp-agent-host.md §4.2). Body `{ payload, signature }`; the payload is a JSON string signed with the
 * device secret under the `turn` domain (`devices/lib/signing.ts`):
 *
 *   { v: 1, kind: "turn", deviceId, issuedAt, sessionId, threadId?, turnId?, firstSeq?, events: [...] }
 *
 * No `threadId` = a session-level post (`session_open`, which makes the host thread). Otherwise a turn post: the
 * event at index `i` takes `seq = firstSeq + i`.
 *
 * The checks, in the order that keeps a forged post from costing anything:
 * 1. an in-isolate per-address counter and a body cap, before anything is parsed or any database is touched;
 * 2. the device's owner, from the `.global()` `shardRoutes` row `device:<id>` (cached per isolate: a revoke
 *    deletes the row, but the next step is what actually refuses a revoked device);
 * 3. on that owner's shard, the device is loaded and the signature and freshness are checked;
 * 4. only then the per-device rate limit (inside `applyHostEvents`, so a bad post never moves it), the owner
 *    comparisons and the claim by `(turnId, seq)`.
 *
 * Every authentication failure is the same 401. The action never touches `ctx.db`.
 */
import type { HttpActionCtx, Infer } from "lunorash/server";

import { internal } from "../_generated/internal";
import { isDeviceSignature } from "../devices/lib/signing";
import { vCapabilityReport } from "../lib/capability-report";
import { inShard } from "../lib/http-shard";
import { threadShardFor } from "../lib/thread-shard";
import { MAX_LENGTH } from "../lib/validators";
import { MAX_EVENTS_PER_POST, MAX_INGEST_BYTES, INGEST_FLOOD_LIMIT_PER_MINUTE } from "./lib/constants";
import { vHostEvent } from "./validators";

const json = (body: unknown, status: number): Response => Response.json(body, { status });

const unauthorized = (): Response => json({ error: "unauthorized" }, 401);

// ─── 1. flood guard and body cap ───────────────────────────────────────────────

const MINUTE_MS = 60_000;
const MAX_TRACKED_ADDRESSES = 10_000;
const floodWindows = new Map<string, { count: number; startedAt: number }>();

/** An in-isolate counter, not a mutation: every unauthenticated post would otherwise serialise on `__root__`. */
export const floodAllowed = (address: string, now: number): boolean => {
    const window = floodWindows.get(address);

    if (window === undefined || now - window.startedAt >= MINUTE_MS) {
        if (floodWindows.size >= MAX_TRACKED_ADDRESSES) {
            floodWindows.clear();
        }

        floodWindows.set(address, { count: 1, startedAt: now });

        return true;
    }

    window.count += 1;

    return window.count <= INGEST_FLOOD_LIMIT_PER_MINUTE;
};

export const resetFloodGuard = (): void => floodWindows.clear();

/** The body as text, or null past `maxBytes`. Counted while reading: `Content-Length` is only the sender's word. */
export const readCappedBody = async (request: Request, maxBytes: number): Promise<string | null> => {
    const declared = Number(request.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > maxBytes) {
        await request.body?.cancel();

        return null;
    }

    const reader = request.body?.getReader();

    if (!reader) {
        return "";
    }

    const parts: Uint8Array[] = [];
    let total = 0;

    for (;;) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        total += value.byteLength;

        if (total > maxBytes) {
            await reader.cancel();

            return null;
        }

        parts.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }

    return new TextDecoder().decode(bytes);
};

// ─── 2. the device's owner ─────────────────────────────────────────────────────

const OWNER_TTL_MS = 60_000;
const MAX_CACHED_DEVICES = 2000;
const ownerCache = new Map<string, { expiresAt: number; ownerId: string }>();

export const resetOwnerCache = (): void => ownerCache.clear();

const deviceOwner = async (context: HttpActionCtx, deviceId: string, now: number): Promise<string | null> => {
    const hit = ownerCache.get(deviceId);

    if (hit !== undefined && hit.expiresAt > now) {
        return hit.ownerId;
    }

    const ownerId = await context.runQuery(internal.lib.shard_routes.getRouteOwner, { kind: "device", value: deviceId });

    if (ownerId === null) {
        return null;
    }

    if (ownerCache.size >= MAX_CACHED_DEVICES) {
        ownerCache.clear();
    }

    ownerCache.set(deviceId, { expiresAt: now + OWNER_TTL_MS, ownerId });

    return ownerId;
};

// ─── the post ──────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
};

/** The field as a string, `undefined` when absent, `null` when it is something else. */
const optionalString = (value: unknown): string | undefined | null => {
    if (value === undefined) {
        return undefined;
    }

    return typeof value === "string" ? value : null;
};

/**
 * A `session_open` whose capability report does not validate keeps the session: the report is stored as "all
 * unknown" (every control hidden) and the failure is logged, instead of the whole post being refused.
 */
const withValidReport = (raw: unknown, now: number): unknown => {
    if (!isRecord(raw) || raw.kind !== "session_open" || raw.capabilities === undefined || vCapabilityReport.safeParse(raw.capabilities).ok) {
        return raw;
    }

    console.warn("[acp] a host sent a capability report that does not validate; stored as all unknown");

    return { ...raw, capabilities: { groups: {}, reportedAt: now, version: 1 } };
};

interface Post {
    events: Infer<typeof vHostEvent>[];
    firstSeq: number | undefined;
    sessionId: string;
    threadId: string | undefined;
    turnId: string | undefined;
}

/** The signed payload's fields, or null when they are not the shape of a post. */
const readPost = (payload: Record<string, unknown>, now: number): Post | null => {
    const threadId = optionalString(payload.threadId);
    const turnId = optionalString(payload.turnId);
    const { firstSeq } = payload;

    if (
        typeof payload.sessionId !== "string" ||
        payload.sessionId.length > MAX_LENGTH.id ||
        threadId === null ||
        turnId === null ||
        (threadId?.length ?? 0) > MAX_LENGTH.id ||
        (turnId?.length ?? 0) > MAX_LENGTH.id ||
        (firstSeq !== undefined && typeof firstSeq !== "number") ||
        !Array.isArray(payload.events) ||
        payload.events.length > MAX_EVENTS_PER_POST
    ) {
        return null;
    }

    const events: Post["events"] = [];

    for (const raw of payload.events) {
        const parsed = vHostEvent.safeParse(withValidReport(raw, now));

        if (!parsed.ok) {
            return null;
        }

        events.push(parsed.value);
    }

    return { events, firstSeq, sessionId: payload.sessionId, threadId, turnId };
};

const handleOnShard = async (context: HttpActionCtx, ownerId: string, deviceId: string, payload: string, signature: string): Promise<Response> => {
    // The route said whose device this is; the shard's own device row must agree.
    const verified = await context.runQuery(internal.acp.ingest.verifyHostPost, { deviceId, now: Date.now(), payload, signature });

    if (verified?.userId !== ownerId) {
        return unauthorized();
    }

    const post = readPost(parseJson(payload) as Record<string, unknown>, Date.now());

    if (!post) {
        return json({ error: "malformed" }, 400);
    }

    // A host-run thread is never shared, so it lives on its owner's shard: anything else is refused.
    if (post.threadId !== undefined && (await threadShardFor(context, ownerId, post.threadId)) !== ownerId) {
        return json({ error: "refused" }, 403);
    }

    const result = await context.runMutation(internal.acp.ingest.applyHostEvents, {
        deviceId,
        events: post.events,
        sessionId: post.sessionId,
        ...(post.firstSeq !== undefined && { firstSeq: post.firstSeq }),
        ...(post.threadId !== undefined && { threadId: post.threadId }),
        ...(post.turnId !== undefined && { turnId: post.turnId }),
    });

    switch (result.outcome) {
        case "applied": {
            return json({ ended: result.ended, next: result.next, ...(result.threadId !== undefined && { threadId: result.threadId }) }, 200);
        }
        case "gap": {
            return json({ error: "gap", next: result.next }, 409);
        }
        case "limited": {
            return json({ error: "rate_limited" }, 429);
        }
        default: {
            return json({ error: "refused" }, 403);
        }
    }
};

export const hostIngestHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    const now = Date.now();

    if (!floodAllowed(request.headers.get("cf-connecting-ip") ?? "unknown", now)) {
        return json({ error: "rate_limited" }, 429);
    }

    const text = await readCappedBody(request, MAX_INGEST_BYTES);

    if (text === null) {
        return json({ error: "too_large" }, 413);
    }

    const body = parseJson(text);
    const payload = isRecord(body) ? body.payload : undefined;
    const signature = isRecord(body) ? body.signature : undefined;

    // A signature that is not 64 hex characters can belong to no device: refused before any lookup, so its
    // answer cannot tell whether the device exists (and never reaches a validator that would throw).
    if (typeof payload !== "string" || typeof signature !== "string" || !isDeviceSignature(signature)) {
        return unauthorized();
    }

    const claimed = parseJson(payload);
    const deviceId = isRecord(claimed) ? claimed.deviceId : undefined;

    if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > MAX_LENGTH.id) {
        return unauthorized();
    }

    const ownerId = await deviceOwner(context, deviceId, now);

    if (ownerId === null) {
        return unauthorized();
    }

    return await inShard(context, ownerId, async (shardContext) => await handleOnShard(shardContext, ownerId, deviceId, payload, signature));
};
