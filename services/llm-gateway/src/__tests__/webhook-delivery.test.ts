/**
 * Unit tests for lib/webhook-delivery.ts
 *
 * Covers:
 *   - deliverEvent: signing, payload delivery, event filtering, status tracking
 *   - buildEvent: correct event shape
 *   - HMAC signature verification
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildEvent, deliverEvent } from "../lib/webhook-delivery.js";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Mock D1 database
// ---------------------------------------------------------------------------

interface WebhookRow {
    events: string;
    id: string;
    secret: string;
    url: string;
}

function createMockDatabase(webhooks: WebhookRow[] = []) {
    let lastUpdateArgs: unknown[] = [];

    return {
        _getLastUpdateArgs: () => lastUpdateArgs,
        prepare: (sql: string) => {
            return {
                bind: (...args: unknown[]) => {
                    if (sql.includes("UPDATE webhooks")) {
                        lastUpdateArgs = args;
                    }

                    return {
                        all: async <T>() => {
                            return { results: webhooks as unknown as T[] };
                        },
                        first: async <T>() => (webhooks[0] as unknown as T) ?? null,
                        run: async () => {
                            return { meta: { changes: 1 } };
                        },
                    };
                },
            };
        },
    } as unknown as D1Database & { _getLastUpdateArgs: () => unknown[] };
}

// ---------------------------------------------------------------------------
// Tests: buildEvent
// ---------------------------------------------------------------------------

describe("buildEvent", () => {
    it("creates an event with expected shape", () => {
        const event = buildEvent("completion", "user-123", { cost: 100 });

        expect(event.type).toBe("completion");
        expect(event.userId).toBe("user-123");
        expect(event.data).toEqual({ cost: 100 });
        expect(typeof event.id).toBe("string");
        expect(typeof event.timestamp).toBe("number");
        expect(event.orgId).toBeUndefined();
    });

    it("includes orgId when provided", () => {
        const event = buildEvent("provider_error", "user-456", {}, "org-789");

        expect(event.orgId).toBe("org-789");
    });
});

// ---------------------------------------------------------------------------
// Tests: deliverEvent
// ---------------------------------------------------------------------------

describe("deliverEvent", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("delivers to a matching webhook with 200 response", async () => {
        mockFetch.mockResolvedValueOnce({ status: 200 });

        const database = createMockDatabase([{ events: '["completion"]', id: "wh-1", secret: "mysecret", url: "https://example.com/hook" }]);

        const event = buildEvent("completion", "user-123", { cost: 100 });

        await deliverEvent(database, event);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];

        expect(url).toBe("https://example.com/hook");
        expect(init.method).toBe("POST");
        expect((init.headers as Record<string, string>)["X-Gateway-Event"]).toBe("completion");
        expect((init.headers as Record<string, string>)["X-Gateway-Signature"]).toBeDefined();
    });

    it("does NOT deliver when webhook is not subscribed to the event type", async () => {
        const database = createMockDatabase([{ events: '["provider_error"]', id: "wh-2", secret: "secret", url: "https://example.com/hook" }]);

        const event = buildEvent("completion", "user-123", {});

        await deliverEvent(database, event);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does NOT call fetch when no webhooks are registered", async () => {
        const database = createMockDatabase([]);

        const event = buildEvent("completion", "user-123", {});

        await deliverEvent(database, event);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("HMAC signature matches expected value", async () => {
        mockFetch.mockResolvedValueOnce({ status: 200 });

        const secret = "test-signing-secret";
        const database = createMockDatabase([{ events: '["completion"]', id: "wh-3", secret, url: "https://example.com/hook" }]);

        const event = buildEvent("completion", "user-123", { amount: 42 });

        await deliverEvent(database, event);

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const signature = (init.headers as Record<string, string>)["X-Gateway-Signature"];
        const body = init.body as string;

        // Verify signature
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
        const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
        const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

        expect(signature).toBe(expected);
    });

    it("includes correct headers on delivery", async () => {
        mockFetch.mockResolvedValueOnce({ status: 200 });

        const database = createMockDatabase([{ events: '["budget_exceeded"]', id: "wh-4", secret: "s", url: "https://example.com/hook" }]);

        const event = buildEvent("budget_exceeded", "user-123", {});

        await deliverEvent(database, event);

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;

        expect(headers["Content-Type"]).toBe("application/json");
        expect(headers["X-Gateway-Event"]).toBe("budget_exceeded");
        expect(headers["X-Gateway-Delivery"]).toBeDefined();
        expect(headers["X-Gateway-Signature"]).toBeDefined();
    });

    it("continues delivering to next webhook when fetch fails", async () => {
        mockFetch.mockRejectedValueOnce(new Error("Network error")).mockResolvedValueOnce({ status: 200 });

        const database = createMockDatabase([
            { events: '["completion"]', id: "wh-5", secret: "s1", url: "https://hook1.invalid/" },
            { events: '["completion"]', id: "wh-6", secret: "s2", url: "https://hook2.example.com/" },
        ]);

        const event = buildEvent("completion", "user-123", {});

        // Should not throw even when first fetch fails
        await expect(deliverEvent(database, event)).resolves.not.toThrow();
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("delivers to multiple webhooks subscribed to the same event", async () => {
        mockFetch.mockResolvedValue({ status: 200 });

        const database = createMockDatabase([
            { events: '["completion"]', id: "wh-7", secret: "s1", url: "https://hook1.example.com/" },
            { events: '["completion", "provider_error"]', id: "wh-8", secret: "s2", url: "https://hook2.example.com/" },
        ]);

        const event = buildEvent("completion", "user-123", {});

        await deliverEvent(database, event);

        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});
