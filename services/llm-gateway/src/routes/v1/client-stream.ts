/**
 * Client-Facing SSE Relay Endpoint
 *
 * POST /v1/stream
 * Body: { streamToken: string, lastChunkIndex?: number, resumable?: boolean }
 * Auth: HMAC stream token (no headers needed)
 * Response: Streaming NDJSON (same format as the backend's /chat/sse)
 *
 * The gateway validates the stream token, then polls the backend for new chunks
 * and relays them to the client in real-time.
 *
 * ## Resume
 *
 * Every chunk poll is a subrequest of THIS invocation, and Workers cap those
 * (50 per invocation on the Free plan) — a long reply used to run past the cap.
 * A client that sends `resumable: true` gets at most {@link MAX_BACKEND_POLLS}
 * polls per request; then the stream ends with
 * `{"type":"resume","lastChunkIndex":n}` as its last line, and the client asks
 * again with that `lastChunkIndex` — `n` counts every chunk relayed so far, so
 * nothing is sent twice or skipped. A client that does not opt in is relayed
 * as before, uncapped, because it would read the marker as the end of the
 * reply.
 */
import { OpenAPIHono } from "@hono/zod-openapi";

import type { HonoEnv } from "../../env.js";
import { canonicalPathAndQuery } from "../../lib/canonical-query.js";
import { verifyStreamToken } from "../../lib/stream-token.js";

const sha256Hex = async (data: ArrayBuffer): Promise<string> => {
    const hash = await crypto.subtle.digest("SHA-256", data);

    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Sign a request to the Lunora backend using HMAC-SHA256. */
const signRequest = async (method: string, url: string, body: ArrayBuffer, secret: string): Promise<{ "X-Signature": string; "X-Timestamp": string }> => {
    const timestamp = Date.now().toString();
    // Include canonical query in the signed message so query parameters
    // are authenticated within the replay window (matches the backend signer
    // and gateway `verifyHmac`).
    const u = new URL(url);
    const pathAndQuery = canonicalPathAndQuery(u);
    const bodyHash = await sha256Hex(body);
    const message = `${method}\n${pathAndQuery}\n${timestamp}\n${bodyHash}`;
    const signature = await hmacSha256Hex(secret, message);

    return { "X-Signature": signature, "X-Timestamp": timestamp };
};

/**
 * How long the backend may hold one poll waiting for a chunk (`/chat/chunks`
 * long-poll). The backend clamps it to its own limit (about 2s: a bounded number
 * of re-reads, each a subrequest) and answers the moment a chunk or the end of
 * the stream is there, so the relay re-polls at once rather than sleeping — a
 * chunk reaches the client within the backend's read tick (~100ms, ~50ms on
 * average) instead of within a 100ms, or after five empty polls 500ms, sleep.
 * Kept far under {@link POLL_FETCH_TIMEOUT_MS}.
 */
export const LONG_POLL_WAIT_MS = 2000;

/**
 * Backend polls one resumable `/v1/stream` invocation makes before it hands the
 * client a resume marker. The relay makes no other subrequests, so this is the
 * invocation's whole count — under the Free plan's 50 with room to spare.
 */
export const MAX_BACKEND_POLLS = 40;

/** Base poll interval during active streaming — only against a backend that does not long-poll. */
const POLL_INTERVAL_FAST_MS = 100;
/** Backed-off poll interval when no new chunks arrive */
const POLL_INTERVAL_SLOW_MS = 500;
/** Number of empty polls before switching to slow interval */
const BACKOFF_THRESHOLD = 5;
/** Maximum time to keep polling before timing out */
const MAX_POLL_DURATION_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Deadline for ONE chunk poll. The loop's own `aborted` check cannot stop a poll
 * that hangs — without this a stalled backend held the relay open until the
 * 20-minute cap. Exported for the test.
 */
export const POLL_FETCH_TIMEOUT_MS = 15_000;

/** Terminal stream statuses */
const TERMINAL_STATUSES = new Set(["done", "error", "timeout"]);

/**
 * Resolve a CORS origin to echo back. Reflecting the request `Origin` while
 * also setting `Access-Control-Allow-Credentials: true` would let any site
 * read this stream from a logged-in user's browser, defeating the gateway's
 * allowlist. Only echo origins on the configured allowlist; otherwise omit
 * the header (browser will block the response).
 */
const resolveStreamCorsOrigin = (allowedOriginsEnv: string | undefined, requestOrigin: string | undefined): string | null => {
    if (!requestOrigin) return null;

    const allowed = (allowedOriginsEnv ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);

    if (allowed.length === 0) return null;

    if (allowed.includes("*")) {
        // Wildcard with credentials is invalid per spec — fail closed.
        console.warn("[gateway:stream] ALLOWED_ORIGINS contains '*' but credentialed CORS requires specific origins; refusing to echo");

        return null;
    }

    return allowed.includes(requestOrigin) ? requestOrigin : null;
};

export const clientStreamRouter = new OpenAPIHono<HonoEnv>();

clientStreamRouter.post("/v1/stream", async (c) => {
    const signingSecret = c.env.SIGNING_SECRET;
    const lunoraUrl = c.env.LUNORA_URL;

    // Parse request body
    let body: { lastChunkIndex?: number; resumable?: boolean; streamToken: string };

    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { lastChunkIndex, resumable, streamToken } = body;

    if (!streamToken) {
        return c.json({ error: "Missing required parameter: streamToken" }, 400);
    }

    // Verify stream token
    let tokenPayload: { streamId: string; threadId: string; userId: string };

    try {
        tokenPayload = await verifyStreamToken(streamToken, signingSecret);
    } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Invalid stream token" }, 401);
    }

    // The token's `threadId` and `userId` ride along so the backend can find the
    // shard the stream lives on — the thread owner's (the caller's own, or the
    // owner who shared the thread). This request is signed, so the backend can
    // trust them as much as it trusts the token we just verified.
    const { streamId, threadId, userId } = tokenPayload;
    const encoder = new TextEncoder();
    const abortSignal = c.req.raw.signal;

    // Create a streaming response with iterative polling loop
    const stream = new ReadableStream({
        async start(controller) {
            let afterIndex = lastChunkIndex ?? 0;
            const startTime = Date.now();
            let emptyPollCount = 0;
            let polls = 0;

            while (Date.now() - startTime <= MAX_POLL_DURATION_MS) {
                // Out of subrequests for this invocation: hand the client its
                // position and let it continue in a fresh one.
                if (resumable === true && polls >= MAX_BACKEND_POLLS) {
                    try {
                        controller.enqueue(encoder.encode(`${JSON.stringify({ lastChunkIndex: afterIndex, type: "resume" })}\n`));
                        controller.close();
                    } catch {
                        /* the client already left */
                    }

                    return;
                }

                polls += 1;

                // Check if client disconnected
                if (abortSignal?.aborted) {
                    try {
                        controller.close();
                    } catch {
                        /* already closed */
                    }

                    return;
                }

                try {
                    // Build request to the backend chunk endpoint
                    const chunkUrl = `${lunoraUrl}/chat/chunks`;
                    const requestBody = JSON.stringify({ afterIndex, streamId, threadId, userId, waitMs: LONG_POLL_WAIT_MS });
                    const bodyBytes = encoder.encode(requestBody);
                    const sigHeaders = await signRequest("POST", chunkUrl, bodyBytes.buffer as ArrayBuffer, signingSecret);

                    const response = await fetch(chunkUrl, {
                        body: requestBody,
                        headers: {
                            "Content-Type": "application/json",
                            ...sigHeaders,
                        },
                        method: "POST",
                        // A deadline, and deliberately NOT the client's abort
                        // signal. A browser that navigates away mid-poll would
                        // abort this request after the backend accepted it, and
                        // the backend then writes its reply to a closed socket —
                        // miniflare's "Network connection lost.", fatal to the
                        // local dev backend on wrangler 4.124. One poll is short;
                        // the `aborted` check at the top of the loop stops the
                        // next. The deadline only fires on a poll that is already
                        // stuck, where that risk is the lesser one.
                        signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
                    });

                    if (!response.ok) {
                        await response.body?.cancel();

                        controller.enqueue(encoder.encode(`${JSON.stringify({ error: `Chunk fetch failed: ${response.status}` })}\n`));
                        controller.close();

                        return;
                    }

                    const data = (await response.json()) as {
                        chunks: { reasoning?: string; speaker?: { name: string; skillId: string }; text: string }[];
                        /** The backend held the poll until it had something (or its wait ran out). */
                        longPoll?: boolean;
                        status: string;
                        totalChunks: number;
                    };

                    // Write new chunks as NDJSON lines
                    for (const chunk of data.chunks) {
                        // `speaker` marks a group-chat participant starting to speak.
                        controller.enqueue(encoder.encode(`${JSON.stringify({ reasoning: chunk.reasoning, speaker: chunk.speaker, text: chunk.text })}\n`));
                    }

                    afterIndex += data.chunks.length;

                    // Check if stream is finished
                    if (TERMINAL_STATUSES.has(data.status)) {
                        controller.close();

                        return;
                    }

                    // The backend already waited for this answer: ask again at once.
                    if (data.longPoll) {
                        continue;
                    }

                    // An older backend answers every poll at once. Adaptive
                    // polling: fast when receiving chunks, slow when idle.
                    if (data.chunks.length > 0) {
                        emptyPollCount = 0;
                    } else {
                        emptyPollCount++;
                    }

                    const pollInterval = emptyPollCount >= BACKOFF_THRESHOLD ? POLL_INTERVAL_SLOW_MS : POLL_INTERVAL_FAST_MS;

                    await new Promise((resolve) => {
                        setTimeout(resolve, pollInterval);
                    });
                } catch {
                    // Abort signal or network error — close the stream
                    if (abortSignal?.aborted) {
                        try {
                            controller.close();
                        } catch {
                            /* already closed */
                        }

                        return;
                    }

                    try {
                        controller.enqueue(encoder.encode(`${JSON.stringify({ error: "Stream relay error" })}\n`));
                        controller.close();
                    } catch {
                        // Controller may already be closed
                    }

                    return;
                }
            }

            // Timeout reached
            try {
                controller.close();
            } catch {
                /* already closed */
            }
        },
    });

    const corsOrigin = resolveStreamCorsOrigin(c.env.ALLOWED_ORIGINS, c.req.header("Origin"));
    const responseHeaders: Record<string, string> = {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        Vary: "Origin",
    };

    // Only set credentialed CORS headers for allowlisted origins. Reflecting
    // arbitrary origins with credentials is a classic CSRF vector.
    if (corsOrigin) {
        responseHeaders["Access-Control-Allow-Origin"] = corsOrigin;
        responseHeaders["Access-Control-Allow-Credentials"] = "true";
    }

    return new Response(stream, { headers: responseHeaders });
});
