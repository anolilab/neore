/**
 * Webhook event delivery.
 *
 * Signs event payloads with HMAC-SHA256 and delivers them to registered endpoints.
 * Delivery is non-blocking (use `ctx.waitUntil`). No retries in v1.
 *
 * Signature: HMAC-SHA256(JSON.stringify(event), webhook.secret)
 * Headers:
 *   X-Gateway-Signature: &lt;hex>
 *   X-Gateway-Event:     &lt;event-type>
 *   X-Gateway-Delivery:  &lt;delivery-uuid>
 */

import type { JSONObject } from "@ai-sdk/provider";

export type WebhookEventType = "completion" | "budget_exceeded" | "guardrail_triggered" | "provider_error";

export interface GatewayEvent {
    data: JSONObject;
    id: string;
    orgId?: string;
    timestamp: number;
    type: WebhookEventType;
    userId: string;
}

export interface WebhookRow {
    createdAt: number;
    events: string; // JSON array of WebhookEventType
    id: string;
    isActive: boolean;
    lastDeliveryAt?: number;
    lastDeliveryStatus?: number;
    orgId?: string;
    secret: string;
    url: string;
    userId: string;
}

/**
 * Deliver a gateway event to all matching registered webhooks.
 *
 * Looks up active webhooks subscribed to the event type, signs the payload,
 * and POSTs to each endpoint. Updates delivery status in D1 non-blocking.
 * @param db D1 database handle.
 * @param event Event to deliver.
 * @param timeout Fetch timeout in milliseconds (default: 5000).
 */
export const deliverEvent = async (db: D1Database, event: GatewayEvent, timeout = 5000): Promise<void> => {
    // Query active webhooks for this user/event
    const rows = await db
        .prepare("SELECT id, url, secret, events FROM webhooks WHERE user_id = ? AND is_active = 1")
        .bind(event.userId)
        .all<{ events: string; id: string; secret: string; url: string }>();

    if (!rows.results?.length) return;

    const payload = JSON.stringify(event);
    const deliveryId = crypto.randomUUID();

    for (const row of rows.results) {
        // Check if this webhook subscribes to this event type
        let subscribedEvents: string[];

        try {
            subscribedEvents = JSON.parse(row.events) as string[];
        } catch {
            continue;
        }

        if (!subscribedEvents.includes(event.type)) continue;

        // Sign the payload
        const signature = await hmacSha256Hex(row.secret, payload);
        const deliveryAt = Date.now();
        let status = 0;

        // Validate URL: only https, no private/internal hosts. Re-validate
        // at delivery time (not just at registration) so a registered URL
        // resolving to a private host now is still rejected.
        const urlError = validateWebhookUrl(row.url);

        if (!urlError) {
            try {
                const resp = await fetchWithTimeout(
                    row.url,
                    {
                        body: payload,
                        headers: {
                            "Content-Type": "application/json",
                            "X-Gateway-Delivery": deliveryId,
                            "X-Gateway-Event": event.type,
                            "X-Gateway-Signature": signature,
                        },
                        method: "POST",
                        // Refuse 3xx — otherwise an attacker can register a public
                        // URL that 30x-redirects to an internal host and the worker
                        // will follow it.
                        redirect: "manual",
                    },
                    timeout,
                );

                status = resp.status;
            } catch {
                status = 0; // Network error or timeout
            }
        }

        // Update delivery status in D1 (best-effort, non-blocking)
        db.prepare("UPDATE webhooks SET last_delivery_at = ?, last_delivery_status = ? WHERE id = ?")
            .bind(deliveryAt, status, row.id)
            .run()
            .catch(() => {
                // Non-critical — don't fail if D1 update fails
            });
    }
};

/**
 * Build a gateway event object.
 */
export const buildEvent = (type: WebhookEventType, userId: string, data: JSONObject, orgId?: string): GatewayEvent => {
    return {
        data,
        id: crypto.randomUUID(),
        orgId,
        timestamp: Date.now(),
        type,
        userId,
    };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Anchored, no `g` flag — safe to share across calls.
const DIGITS_RE = /^\d+$/;
const IPV6_LINK_LOCAL_RE = /^fe[89ab][0-9a-f]:/i;
const IPV6_ULA_RE = /^f[cd][0-9a-f]{2}:/i;
const IPV6_MULTICAST_RE = /^ff[0-9a-f]{2}:/i;
const IPV6_MAPPED_IPV4_RE = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;

/**
 * The same mapping, after `new URL()` has normalised it.
 *
 * `new URL("https://[::ffff:10.0.0.1]/")` reports its hostname as
 * `[::ffff:a00:1]` — the parser rewrites the dotted quad as two hextets — so the
 * dotted pattern above never matches a URL that came through the parser, and the
 * private-IPv4 check behind it was unreachable. `https://[::ffff:169.254.169.254]/`
 * reached cloud metadata.
 */
const IPV6_MAPPED_IPV4_HEX_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** The IPv4 address embedded in an IPv4-mapped IPv6 literal, in either spelling. */
const embeddedIPv4 = (literal: string): null | number => {
    const dotted = IPV6_MAPPED_IPV4_RE.exec(literal);

    if (dotted) {
        return ipv4ToInt(dotted[1]!);
    }

    const hex = IPV6_MAPPED_IPV4_HEX_RE.exec(literal);

    if (!hex) {
        return null;
    }

    return (((Number.parseInt(hex[1]!, 16) << 16) >>> 0) + Number.parseInt(hex[2]!, 16)) >>> 0;
};

const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const fetchWithTimeout = (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
};

const ipv4ToInt = (hostname: string): number | null => {
    const parts = hostname.split(".");

    if (parts.length !== 4) return null;

    let n = 0;

    for (const p of parts) {
        if (!DIGITS_RE.test(p)) return null;

        const v = Number(p);

        if (v < 0 || v > 255) return null;

        n = (n << 8) | v;
    }

    return n >>> 0;
};

const isPrivateIPv4 = (n: number): boolean => {
    const inRange = (cidrStart: number, prefix: number) => {
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;

        return (n & mask) === (cidrStart & mask);
    };

    return (
        inRange(0x00_00_00_00, 8) ||
        inRange(0x0a_00_00_00, 8) ||
        inRange(0x64_40_00_00, 10) ||
        inRange(0x7f_00_00_00, 8) ||
        inRange(0xa9_fe_00_00, 16) ||
        inRange(0xac_10_00_00, 12) ||
        inRange(0xc0_00_00_00, 24) ||
        inRange(0xc0_00_02_00, 24) ||
        inRange(0xc0_a8_00_00, 16) ||
        inRange(0xc6_33_64_00, 24) ||
        inRange(0xcb_00_71_00, 24) ||
        inRange(0xe0_00_00_00, 4) ||
        inRange(0xf0_00_00_00, 4)
    );
};

/**
 * Validate that a webhook URL is safe to deliver to: HTTPS only, no
 * private/loopback/link-local/ULA/IPv4-mapped IPv6 hosts, no localhost
 * aliases. Returns null when safe, an error string otherwise.
 */
export const validateWebhookUrl = (url: string): string | null => {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return "Invalid URL";
    }

    if (parsed.protocol !== "https:") {
        return "Webhook URLs must use https";
    }

    let hostname = parsed.hostname.toLowerCase();

    if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);

    const stripped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

    if (stripped === "localhost" || stripped.endsWith(".localhost")) {
        return "localhost URLs are not allowed";
    }

    if (stripped === "metadata.google.internal" || stripped === "instance-data") {
        return "Cloud metadata hosts are not allowed";
    }

    const v4 = ipv4ToInt(stripped);

    if (v4 !== null && isPrivateIPv4(v4)) {
        return `Private/reserved IP ${stripped} is not allowed`;
    }

    if (stripped.includes(":")) {
        // IPv6 literal — block loopback, link-local, ULA, multicast, IPv4-mapped private
        const lower = stripped;

        if (lower === "::1" || lower === "::") return "IPv6 loopback is not allowed";

        if (IPV6_LINK_LOCAL_RE.test(lower)) return "IPv6 link-local is not allowed";

        if (IPV6_ULA_RE.test(lower)) return "IPv6 ULA is not allowed";

        if (IPV6_MULTICAST_RE.test(lower)) return "IPv6 multicast is not allowed";

        // ::ffff:x.x.x.x mapped, in either the dotted or the parser-normalised
        // hextet spelling — extract the embedded v4 and apply the v4 rules.
        const m4 = embeddedIPv4(lower);

        if (m4 !== null && isPrivateIPv4(m4)) return "Mapped private IPv4 not allowed";
    }

    return null;
};
