/**
 * The wire side of Events webhooks (SEP-3415, "Webhook event delivery", "Non-event webhook bodies" and "Webhook security"): the
 * Standard Webhooks signature, the headers, the four bodies, one POST, and the verification handshake.
 *
 * Every POST goes through the injected `CallbackRequest`. The live one (`events-webhook-request.ts`) is `requestCheckedHttps`
 * (`lib/egress.ts`): the callback's address is checked when the socket connects, so there is no window between a check and the
 * request. It never follows a redirect, and it has a deadline. Tests inject a fake and run without a network.
 */
import { bytesToBase64, hmacSha256, timingSafeEqual } from "../lib/crypto";
import { EgressError } from "../lib/egress";
import { webhookSecretBytes } from "./events-webhook";

export const DELIVERY_TIMEOUT_MS = 10_000;

export type PostOutcome = { category: string; kind: "delivered" } | { category: string; kind: "failed" } | { category: string; kind: "refused" };

/** The status and body of a callback's answer. A redirect is an answer like any other: it is never followed. */
export interface CallbackReply {
    body: string;
    status: number;
}

/**
 * One signed POST to a callback URL. A refused address, a timeout or a connection failure throws (an `EgressError` from the live
 * request); the caller classes it with `transportReasonOf`.
 */
export type CallbackRequest = (url: string, input: { body: string; headers: Record<string, string> }) => Promise<CallbackReply>;

/** A fresh message id: `msg_` plus 32 hex, or `msg_<type>_` plus the same for a control envelope. */
export const messageIdOf = (type?: string): string => {
    const random = crypto.randomUUID().replaceAll("-", "");

    return type === undefined ? `msg_${random}` : `msg_${type}_${random}`;
};

/** `HMAC-SHA256(secret, webhook-id + "." + webhook-timestamp + "." + body)` over the raw body bytes, as `v1,<base64>`. */
export const signWebhook = async (secret: string, id: string, timestampSeconds: number, body: string): Promise<string> => {
    const mac = await hmacSha256(webhookSecretBytes(secret), `${id}.${timestampSeconds}.${body}`);

    return `v1,${bytesToBase64(mac)}`;
};

/** The headers a delivery carries. The timestamp and the signature are taken at the moment of this attempt. */
export const webhookHeaders = async (input: {
    body: string;
    id: string;
    secret: string;
    subscriptionId: string;
    timestampSeconds: number;
}): Promise<Record<string, string>> => {
    return {
        "content-type": "application/json",
        "webhook-id": input.id,
        "webhook-signature": await signWebhook(input.secret, input.id, input.timestampSeconds, input.body),
        "webhook-timestamp": String(input.timestampSeconds),
        "X-MCP-Subscription-Id": input.subscriptionId,
    };
};

export const eventBody = (event: { cursor: string; data: Record<string, unknown>; eventId: string; name: string; timestamp: number }): string =>
    JSON.stringify({
        cursor: event.cursor,
        data: event.data,
        eventId: event.eventId,
        name: event.name,
        timestamp: new Date(event.timestamp).toISOString(),
    });

export const gapBody = (cursor: string): string => JSON.stringify({ cursor, type: "gap" });

export const terminatedBody = (reason: string): string =>
    JSON.stringify({ error: { code: -32_024, data: { reason }, message: "Forbidden" }, type: "terminated" });

export const verificationBody = (challenge: string): string => JSON.stringify({ challenge, type: "verification" });

/** Why a POST did not get an answer. The two address reasons are refusals: the callback is not one to call. */
export type TransportReason = "address_not_public" | "connection_refused" | "timeout" | "unsupported_target";

export const transportReasonOf = (error: unknown): TransportReason => {
    if (error instanceof EgressError) {
        switch (error.code) {
            case "blocked_address": {
                return "address_not_public";
            }
            case "timeout": {
                return "timeout";
            }
            case "unsupported_target": {
                return "unsupported_target";
            }
            default: {
                return "connection_refused";
            }
        }
    }

    return "connection_refused";
};

/**
 * One POST. A 2xx is delivered. A 3xx, `410` (gone) and `413` (too large) are refused: the spec makes them non-retryable. Any
 * other answer, and a transport failure, is failed and may be retried. A refused address is refused, not retried.
 */
export const postOnce = async (url: string, headers: Record<string, string>, body: string, request: CallbackRequest): Promise<PostOutcome> => {
    let reply: CallbackReply;

    try {
        reply = await request(url, { body, headers });
    } catch (error) {
        const reason = transportReasonOf(error);

        return reason === "address_not_public" || reason === "unsupported_target"
            ? { category: reason, kind: "refused" }
            : { category: reason, kind: "failed" };
    }

    const { status } = reply;

    if (status >= 200 && status < 300) {
        return { category: "", kind: "delivered" };
    }

    if (status >= 300 && status < 400) {
        return { category: "redirect", kind: "refused" };
    }

    if (status === 410) {
        return { category: "gone", kind: "refused" };
    }

    if (status === 413) {
        return { category: "payload_too_large", kind: "refused" };
    }

    return { category: status >= 500 ? "http_5xx" : "http_4xx", kind: "failed" };
};

export type VerificationOutcome = { ok: true } | { ok: false; reason: "challenge_failed" | TransportReason };

/**
 * The verification handshake: a signed `verification` envelope with a fresh single-use nonce. The endpoint proves intent by echoing
 * the nonce in a 2xx body, compared in constant time. Anything else is `challenge_failed`; a transport failure keeps its reason.
 */
export const verifyCallback = async (input: {
    id: string;
    now: number;
    request: CallbackRequest;
    secret: string;
    subscriptionId: string;
    url: string;
}): Promise<VerificationOutcome> => {
    const challenge = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
    const body = verificationBody(challenge);
    const headers = await webhookHeaders({
        body,
        id: messageIdOf("verification"),
        secret: input.secret,
        subscriptionId: input.subscriptionId,
        timestampSeconds: Math.floor(input.now / 1000),
    });
    let reply: CallbackReply;

    try {
        reply = await input.request(input.url, { body, headers });
    } catch (error) {
        return { ok: false, reason: transportReasonOf(error) };
    }

    if (reply.status < 200 || reply.status >= 300) {
        return { ok: false, reason: "challenge_failed" };
    }

    try {
        const parsed = JSON.parse(reply.body) as { challenge?: unknown };

        return typeof parsed.challenge === "string" && timingSafeEqual(parsed.challenge, challenge) ? { ok: true } : { ok: false, reason: "challenge_failed" };
    } catch {
        return { ok: false, reason: "challenge_failed" };
    }
};
