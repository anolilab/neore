/**
 * Outbound run webhooks: the secret, the signature, the URL rules and the event
 * envelope. Pure on purpose, so the delivery code and its tests share one
 * definition.
 *
 * The signature is the inbound trigger scheme (`triggers/http.ts`) turned
 * around, so a receiver verifies it with the code it already has for trigger
 * webhooks:
 *   X-Neore-Timestamp: <unix seconds>
 *   X-Signature-256:   sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *
 * The secret is never logged and never returned by a read.
 */
import { bytesToBase64, hmacSha256Hex } from "../lib/crypto";
import { isSafeUrl } from "../chat/tools/utilities";

export const RUN_WEBHOOK_SECRET_PREFIX = "whsec_";

/** The longest URL a user may save; longer ones are refused before the parser runs. */
export const MAX_RUN_WEBHOOK_URL_LENGTH = 2048;

/** The one event type part 1 sends. Run events (`run.completed`) join it in part 2. */
export const RUN_WEBHOOK_TEST_EVENT = "webhook.test";

export interface RunWebhookEvent {
    /** The event's own id. It is the same on every redelivery of this event, so a receiver can drop a repeat. */
    createdAt: number;
    data: Record<string, unknown>;
    id: string;
    type: string;
}

/** A new secret: 32 random bytes, base64url, behind a prefix so a leaked one is easy to spot in logs and scanners. */
export const generateRunWebhookSecret = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    // Base64 pads only at the end, so dropping every "=" leaves the same text as dropping the padding.
    const encoded = bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

    return `${RUN_WEBHOOK_SECRET_PREFIX}${encoded}`;
};

/**
 * Why a URL cannot be the target of a run webhook, or `null` when it can.
 *
 * Only https, no credentials in the URL, and no literal private, loopback,
 * link-local or reserved address (`isSafeUrl`). That check reads the host as
 * written: the Worker cannot resolve names, so a public name that resolves into
 * a private range is not caught here. Delivery never follows redirects, so a
 * redirect cannot move the request to another host.
 */
export const runWebhookUrlProblem = (value: string): string | null => {
    if (value.length > MAX_RUN_WEBHOOK_URL_LENGTH) {
        return "The URL is too long.";
    }

    let parsed: URL;

    try {
        parsed = new URL(value);
    } catch {
        return "Enter a full URL that starts with https://.";
    }

    if (parsed.protocol !== "https:") {
        return "The URL must use https://.";
    }

    if (parsed.username !== "" || parsed.password !== "") {
        return "The URL must not contain a username or password.";
    }

    if (!isSafeUrl(value)) {
        return "The URL points at a private, local or reserved address.";
    }

    return null;
};

/** The two headers that carry the signature, for a body sent at `timestampSeconds`. */
export const signRunWebhook = async (secret: string, body: string, timestampSeconds: number): Promise<Record<string, string>> => {
    const signature = await hmacSha256Hex(secret, `${timestampSeconds}.${body}`);

    return {
        "X-Neore-Timestamp": String(timestampSeconds),
        "X-Signature-256": `sha256=${signature}`,
    };
};

export const buildRunWebhookEvent = (type: string, data: Record<string, unknown>, createdAt: number, id: string = crypto.randomUUID()): RunWebhookEvent => {
    return { createdAt, data, id, type };
};

/** The event a "Send test" delivers. It names no run, so it carries no user content. */
export const buildTestEvent = (now: number): RunWebhookEvent =>
    buildRunWebhookEvent(RUN_WEBHOOK_TEST_EVENT, { message: "This is a test delivery from Neore." }, now);
