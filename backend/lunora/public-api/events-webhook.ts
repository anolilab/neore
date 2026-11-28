/**
 * Webhook delivery for the Events extension (SEP-3415, "Webhook-Based Delivery"), part 2a: the request checks, the subscription
 * key and its derived `id`, the `whsec_` secret rule, the TTL grant and the callback host rule. Pure, so the dispatcher, the
 * store and the tests share one definition.
 *
 * Spec compliance, part 2a: `events/subscribe` and `events/unsubscribe` (the key, the idempotent upsert, the refresh and the
 * TTL grant, expiry, the cursor and `truncated`, and the InvalidParams / NotFound / Forbidden / ResourceExhausted answers).
 * Not here yet, part 2b: the endpoint verification handshake, signed deliveries, `gap` and `terminated` envelopes, retries,
 * and `deliveryStatus`. Until 2b, no request leaves the Worker for a callback URL: a subscription is stored and waits.
 *
 * Residual DNS-rebinding window (also in the PR body): the callback host is resolved at subscribe time (`events-webhook-address.ts`),
 * which is an early refusal only. A delivery (part 2b, #917) connects to the address it checks at connect time (`lib/egress.ts`),
 * so no delivery connects to the subscribe-time answer. `postCheckedHttps` reads no reply, so the verification's echoed challenge
 * needs the reply read, which part 2b's request function does.
 */
import { base64ToBytes, bytesToBase64, sha256Hex } from "../lib/crypto";
import { type EventArguments, findEvent, parseEventArguments } from "./events-catalog";

export const WEBHOOK_SECRET_PREFIX = "whsec_";
const SECRET_MIN_BYTES = 24;
const SECRET_MAX_BYTES = 64;

/** Bounds on a granted TTL. The floor keeps a client from refreshing on every tick; the cap keeps a subscription's life in days. */
export const MIN_TTL_MS = 60_000;
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** Granted when the client omits `ttlMs`. An explicit `null` gets the cap: part 2a grants no no-expiry subscription. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Live subscriptions one account may hold. */
export const MAX_SUBSCRIPTIONS = 100;
/** Hosts one account may approve. */
export const MAX_APPROVED_HOSTS = 50;

/** The most hosts the owner's list shows: a merge of guests can leave more than the add cap holds (`auth/event-webhook-hosts.ts`). */
export const MAX_LISTED_APPROVED_HOSTS = 500;

const MAX_URL_LENGTH = 2048;
const MAX_HOST_LENGTH = 253;

export const INVALID_PARAMS = -32_602;
export const NOT_FOUND = -32_023;
export const FORBIDDEN = -32_024;
export const RESOURCE_EXHAUSTED = -32_025;
export const UNSUPPORTED = -32_026;
export const CALLBACK_ENDPOINT_ERROR = -32_027;

/** A refusal the dispatcher answers as a JSON-RPC error: the code, the message, and the typed `data` the spec asks for. */
export class EventsWebhookError extends Error {
    readonly code: number;

    readonly data: Record<string, unknown> | undefined;

    constructor(code: number, message: string, data?: Record<string, unknown>) {
        super(message);
        this.name = "EventsWebhookError";
        this.code = code;
        this.data = data;
    }
}

export type Parsed<T> = { ok: true; value: T } | { code: number; data?: Record<string, unknown>; message: string; ok: false };

const refuse = (code: number, message: string, data?: Record<string, unknown>): { code: number; data?: Record<string, unknown>; message: string; ok: false } =>
    data === undefined ? { code, message, ok: false } : { code, data, message, ok: false };

/**
 * The Standard Webhooks secret: `whsec_` followed by the base64 of 24 to 64 random bytes. The encoding must be the canonical
 * one (no whitespace, no other alphabet, padding as encoded), so two spellings of one secret cannot both be accepted.
 */
const SECRET_BODY = /^[\d+/A-Z]+={0,2}$/i;

export const isWebhookSecret = (value: unknown): value is string => {
    if (typeof value !== "string" || !value.startsWith(WEBHOOK_SECRET_PREFIX)) {
        return false;
    }

    const encoded = value.slice(WEBHOOK_SECRET_PREFIX.length);

    if (!SECRET_BODY.test(encoded) || encoded.length % 4 !== 0) {
        return false;
    }

    let bytes: Uint8Array;

    try {
        bytes = base64ToBytes(encoded);
    } catch {
        return false;
    }

    return bytes.length >= SECRET_MIN_BYTES && bytes.length <= SECRET_MAX_BYTES && bytesToBase64(bytes) === encoded;
};

/** The raw key bytes of a secret `isWebhookSecret` accepted: the HMAC key of the Standard Webhooks signature. */
export const webhookSecretBytes = (secret: string): Uint8Array => base64ToBytes(secret.slice(WEBHOOK_SECRET_PREFIX.length));

const HOST_NAME = /^(?=.{1,253}$)[\da-z](?:[\da-z-]{0,61}[\da-z])?(?:\.[\da-z](?:[\da-z-]{0,61}[\da-z])?)+$/;
const DOTTED_NUMBERS = /^[\d.]+$/;

/**
 * A host name in the form the allowlist stores it: lowercase, dotted, with no scheme, port, path or literal address. `null`
 * for anything else, so `localhost`, `10.0.0.1` and `[::1]` are never an approvable host.
 */
export const normalizeApprovedHost = (value: string): string | null => {
    const host = value.trim().toLowerCase();

    if (host.length > MAX_HOST_LENGTH || DOTTED_NUMBERS.test(host) || !HOST_NAME.test(host)) {
        return null;
    }

    return host;
};

interface CallbackUrl {
    host: string;
    href: string;
}

/** `delivery.url`: https, no credentials, the default port, and a host name rather than an address. */
const parseCallbackUrl = (value: unknown): Parsed<CallbackUrl> => {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
        return refuse(INVALID_PARAMS, "`delivery.url` must be an https URL.");
    }

    let parsed: URL;

    try {
        parsed = new URL(value);
    } catch {
        return refuse(INVALID_PARAMS, "`delivery.url` must be an absolute https URL.");
    }

    // The stored URL is the canonical one: percent-encoding can grow a short raw value past the limit.
    if (parsed.href.length > MAX_URL_LENGTH) {
        return refuse(INVALID_PARAMS, "`delivery.url` must be an https URL.");
    }

    if (parsed.protocol !== "https:") {
        return refuse(INVALID_PARAMS, "`delivery.url` must use https.");
    }

    if (parsed.username !== "" || parsed.password !== "") {
        return refuse(INVALID_PARAMS, "`delivery.url` must not carry credentials.");
    }

    // A fragment is never sent, so two URLs that differ only in it would be two subscriptions to one callback; an empty one ("#") leaves no hash.
    if (value.includes("#")) {
        return refuse(INVALID_PARAMS, "`delivery.url` must not carry a fragment.");
    }

    if (parsed.port !== "") {
        return refuse(INVALID_PARAMS, "`delivery.url` must use the default https port.");
    }

    const host = normalizeApprovedHost(parsed.hostname);

    if (host === null) {
        return refuse(INVALID_PARAMS, "`delivery.url` must name a host, not a literal address.");
    }

    return { ok: true, value: { host, href: parsed.href } };
};

/**
 * The argument part of the subscription key, as canonical text: `{}` when no argument is set. `EventArguments` has one field
 * today; a new field must be added here too, or two subscriptions that differ only in it would share a key.
 */
export const argumentsKeyOf = (scope: EventArguments): string => (scope.threadId === undefined ? "{}" : JSON.stringify({ threadId: scope.threadId }));

interface EventReference {
    argumentsKey: string;
    name: string;
}

/** `name` and `arguments`: the event must be in the catalog (NotFound), and its arguments must match the schema (InvalidParams). */
const parseEventReference = (fields: Record<string, unknown>): Parsed<EventReference> => {
    const { arguments: args, name } = fields;

    if (typeof name !== "string") {
        return refuse(INVALID_PARAMS, "`name` must be the event's name.");
    }

    if (!findEvent(name)) {
        return refuse(NOT_FOUND, `Unknown event: ${name}`, { kind: "event" });
    }

    const scope = parseEventArguments(args);

    if (scope === null) {
        return refuse(INVALID_PARAMS, "`arguments` do not match the event's inputSchema.");
    }

    return { ok: true, value: { argumentsKey: argumentsKeyOf(scope), name } };
};

/** `delivery.mode` must be `webhook`. Another string names a mode this event does not offer (Unsupported); anything else is malformed. */
const checkDeliveryMode = (delivery: Record<string, unknown>): Parsed<true> => {
    if (delivery["mode"] === "webhook") {
        return { ok: true, value: true };
    }

    if (typeof delivery["mode"] === "string") {
        return refuse(UNSUPPORTED, "This delivery mode is not offered for this event.", { feature: "deliveryMode", value: delivery["mode"] });
    }

    return refuse(INVALID_PARAMS, '`delivery.mode` must be "webhook".');
};

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The TTL grant: the suggestion clamped into [MIN, MAX]; absent is the default, and `null` (asking for no expiry) is the cap. */
export const grantTtlMs = (suggested: number | null | undefined): number => {
    if (suggested === undefined) {
        return DEFAULT_TTL_MS;
    }

    if (suggested === null) {
        return MAX_TTL_MS;
    }

    return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, suggested));
};

export interface SubscribeRequest extends EventReference {
    /** The client's last persisted cursor, or `null` for "start from now". Decoded by the router, which holds the cursor secret. */
    cursor: string | null;
    grantedTtlMs: number;
    host: string;
    /** Milliseconds: replay older than `now - maxAgeMs` is skipped. `null` when the client set none. */
    maxAgeMs: number | null;
    secret: string;
    url: string;
}

/** `events/subscribe`'s params, checked in the spec's order. Every refusal is a JSON-RPC error the dispatcher can answer as is. */
export const parseSubscribeParams = (raw: unknown): Parsed<SubscribeRequest> => {
    const fields = objectOf(raw) ?? {};
    const reference = parseEventReference(fields);

    if (!reference.ok) {
        return reference;
    }

    const delivery = objectOf(fields["delivery"]);

    if (delivery === undefined) {
        return refuse(INVALID_PARAMS, "`delivery` is required.");
    }

    const mode = checkDeliveryMode(delivery);

    if (!mode.ok) {
        return mode;
    }

    const url = parseCallbackUrl(delivery["url"]);

    if (!url.ok) {
        return url;
    }

    if (!isWebhookSecret(delivery["secret"])) {
        return refuse(INVALID_PARAMS, "`delivery.secret` must be `whsec_` followed by base64 of 24 to 64 random bytes.");
    }

    const { cursor, maxAgeMs, ttlMs } = fields;

    if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
        return refuse(INVALID_PARAMS, "`cursor` must be a string or null.");
    }

    if (maxAgeMs !== undefined && (typeof maxAgeMs !== "number" || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0)) {
        return refuse(INVALID_PARAMS, "`maxAgeMs` must be a non-negative integer.");
    }

    if (ttlMs !== undefined && ttlMs !== null && (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs < 0)) {
        return refuse(INVALID_PARAMS, "`ttlMs` must be a non-negative integer, or null for no expiry.");
    }

    return {
        ok: true,
        value: {
            argumentsKey: reference.value.argumentsKey,
            cursor: typeof cursor === "string" ? cursor : null,
            grantedTtlMs: grantTtlMs(ttlMs as number | null | undefined),
            host: url.value.host,
            maxAgeMs: typeof maxAgeMs === "number" ? maxAgeMs : null,
            name: reference.value.name,
            secret: delivery["secret"] as string,
            url: url.value.href,
        },
    };
};

export interface UnsubscribeRequest extends EventReference {
    url: string;
}

/** `events/unsubscribe`'s params: the same key as subscribe, without the secret or the TTL. */
export const parseUnsubscribeParams = (raw: unknown): Parsed<UnsubscribeRequest> => {
    const fields = objectOf(raw) ?? {};
    const reference = parseEventReference(fields);

    if (!reference.ok) {
        return reference;
    }

    const delivery = objectOf(fields["delivery"]);

    if (delivery === undefined) {
        return refuse(INVALID_PARAMS, "`delivery` is required.");
    }

    if (delivery["mode"] !== undefined) {
        const mode = checkDeliveryMode(delivery);

        if (!mode.ok) {
            return mode;
        }
    }

    const url = parseCallbackUrl(delivery["url"]);

    if (!url.ok) {
        return url;
    }

    return { ok: true, value: { argumentsKey: reference.value.argumentsKey, name: reference.value.name, url: url.value.href } };
};

/**
 * The subscription key's hash: `(principal, delivery.url, name, arguments)` in canonical form. The principal is the API key id,
 * so one key's subscriptions are its own. The secret is not in the key: a rotation is an update, not a new subscription.
 */
export const subscriptionKeyHash = async (principal: string, url: string, name: string, argumentsKey: string): Promise<string> =>
    await sha256Hex(JSON.stringify([principal, url, name, argumentsKey]));

/** The derived `id` the spec returns and `X-MCP-Subscription-Id` carries: a routing handle, not a capability. */
export const subscriptionIdOf = (keyHash: string): string => `sub_${keyHash.slice(0, 16)}`;

/** The `events/subscribe` answer, before the dispatcher adds `resultType`. */
export interface SubscribeResult {
    cursor: string;
    id: string;
    refreshBefore: string | null;
    truncated: boolean;
}
