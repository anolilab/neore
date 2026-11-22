/**
 * The admin provider prompt-cache readings call the gateway with the caller's
 * user id. Lunora's `auth.getIdentity()` carries `userId` (and `sessionId`),
 * never `subject`, so the id must be read from `userId`.
 */
import { describe, expect, it } from "vitest";

import { getProviderCacheReadings } from "./gateway-client";

class FakeBinding {
    public readonly calls: string[] = [];

    public async fetch(this: FakeBinding | undefined, input: Request | string | URL): Promise<Response> {
        if (!(this instanceof FakeBinding)) {
            throw new TypeError("Illegal invocation");
        }

        this.calls.push(new Request(input).url);

        return Response.json({
            all: { cachedTokens: 0, promptTokens: 0, requests: 0 },
            days: 7,
            hours: [],
            models: [],
            pairs: 0,
            since: "2026-11-15T00:00:00.000Z",
        });
    }
}

const contextFor = (identity: { sessionId?: string; userId?: string } | null, gateway: FakeBinding) =>
    ({
        auth: { getIdentity: async () => identity },
        services: { llmGateway: gateway },
    }) as never;

describe("getProviderCacheReadings", () => {
    it("sends the signed-in admin's user id, read from the identity's userId", async () => {
        const gateway = new FakeBinding();

        const readings = await getProviderCacheReadings(contextFor({ sessionId: "session-1", userId: "admin-1" }, gateway), 7);

        expect(readings.days).toBe(7);
        expect(gateway.calls).toHaveLength(1);
        expect(new URL(gateway.calls[0] ?? "").searchParams.get("adminUserId")).toBe("admin-1");
        expect(new URL(gateway.calls[0] ?? "").searchParams.get("days")).toBe("7");
    });

    it("refuses without an identity, before calling the gateway", async () => {
        const gateway = new FakeBinding();

        await expect(getProviderCacheReadings(contextFor(null, gateway), 1)).rejects.toThrow("authenticated admin user");
        expect(gateway.calls).toHaveLength(0);
    });

    it("refuses an identity that carries no userId, before calling the gateway", async () => {
        const gateway = new FakeBinding();

        await expect(getProviderCacheReadings(contextFor({ sessionId: "session-1" }, gateway), 30)).rejects.toThrow("authenticated admin user");
        expect(gateway.calls).toHaveLength(0);
    });
});
