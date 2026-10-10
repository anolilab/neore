/**
 * The Worker entry must hand cron fires to the app. It once exported only
 * `fetch`, so in a deployed Worker no cron ever reached `LUNORA_CRONS` — every
 * periodic job silently never ran. `wrangler dev` does not fire crons unasked,
 * which is why nothing noticed.
 *
 * The app builder and the router are stubbed: this pins the wiring, not the
 * runtime's dispatch (which `lunora/lib/cron-schedule.test.ts` covers from the
 * tick down).
 */
import { describe, expect, it, vi } from "vitest";

// Static, not `await import()` inside the test: loading the entry's module graph
// counted against the 5s test timeout and blew it under the full parallel run.
// The `vi.mock` calls below are hoisted above this import either way.
import server from "./server";

const { fakeApp } = vi.hoisted(() => {
    return { fakeApp: { fetch: vi.fn(), scheduled: vi.fn(async () => {}), ShardDO: vi.fn() } };
});

// The entry's other imports pull in the whole router; only its wiring is under test.
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
vi.mock("../lunora/public-api/identity.js", () => {
    return { isPublicApiPath: () => false, resolveApiKeyIdentity: async () => null };
});
// Re-exported for wrangler; `@lunora/workflow/do` imports `cloudflare:workers` from a package the test alias does not reach.
vi.mock("../lunora/_generated/workflows.js", () => {
    return {};
});
vi.mock("../lunora/auth/lib/ensure-global-tables.js", () => {
    return { ensureGlobalTables: async () => {} };
});

vi.mock("../lunora/_generated/app.js", () => {
    // Every builder method returns the builder; `build()` returns the fake app.
    const builder: Record<string, unknown> = new Proxy(
        {},
        {
            get: (_target, key) => (key === "build" ? () => fakeApp : () => builder),
        },
    );

    return { defineApp: () => builder };
});

describe("the Worker's scheduled handler", () => {
    it("dispatches every cron fire to the app", async () => {
        const worker = server as { scheduled?: (...args: unknown[]) => Promise<void> };
        const controller = { cron: "*/1 * * * *", noRetry: () => {}, scheduledTime: 0 };
        const env = { DB: {} };
        const context = { passThroughOnException: () => {}, waitUntil: () => {} };

        expect(typeof worker.scheduled).toBe("function");

        await worker.scheduled?.(controller, env, context);

        expect(fakeApp.scheduled).toHaveBeenCalledWith(controller, env, context);
    });
});
