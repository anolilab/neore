/**
 * A live-query upgrade whose ticket's session cannot be read must answer a
 * retryable 503 — never reach the runtime, which would open the socket
 * anonymously. The ticket check is routed in the Worker's own `fetch`, ahead of
 * `app.fetch`, so the runtime's error mapping never sees its throw.
 *
 * The app builder, the router and the ticket check are stubbed: this pins the
 * wiring, not the redeem (`lunora/lib/ws-ticket.test.ts` covers that).
 */
import { describe, expect, it, vi } from "vitest";

import server from "./server";

const { fakeApp } = vi.hoisted(() => {
    return { fakeApp: { fetch: vi.fn(async () => new Response(null, { status: 204 })), scheduled: vi.fn(async () => {}), ShardDO: vi.fn() } };
});

vi.mock("../lunora/http.js", () => {
    return { default: {}, getAllowedOrigins: () => () => null };
});
vi.mock("../lunora/auth.js", () => {
    return {
        buildAuth: () => {
            return { api: {} };
        },
    };
});
vi.mock("@lunora/auth", () => {
    return { d1Executor: () => {}, handleAuthRequest: async () => undefined };
});
vi.mock("../lunora/public-api/identity.js", () => {
    return { isPublicApiPath: () => false, resolveApiKeyIdentity: async () => null };
});
vi.mock("../lunora/_generated/workflows.js", () => {
    return {};
});
vi.mock("../lunora/auth/lib/ensure-global-tables.js", () => {
    return { ensureGlobalTables: async () => {} };
});
vi.mock("../lunora/lib/ws-ticket.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../lunora/lib/ws-ticket.js")>();

    return {
        ...original,
        resolveWsTicketIdentity: async () => {
            throw new original.WsTicketUnavailableError();
        },
    };
});

vi.mock("../lunora/_generated/app.js", () => {
    const builder: Record<string, unknown> = new Proxy(
        {},
        {
            get: (_target, key) => (key === "build" ? () => fakeApp : () => builder),
        },
    );

    return { defineApp: () => builder };
});

describe("the Worker's live-query upgrade", () => {
    it("answers 503 and never reaches the runtime when the ticket's session cannot be read", async () => {
        const worker = server as unknown as { fetch: (request: Request, env: unknown, context: unknown) => Promise<Response> };
        const upgrade = new Request("http://x/_lunora/ws?token=ticket", { headers: { Upgrade: "websocket" } });

        const response = await worker.fetch(upgrade, { DB: {} }, { passThroughOnException: () => {}, waitUntil: () => {} });

        expect(response.status).toBe(503);
        expect(fakeApp.fetch).not.toHaveBeenCalled();
    });
});
