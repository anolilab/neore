/**
 * `securityMiddleware` forces `Cache-Control: no-store` on every response
 * EXCEPT one whose handler granted an explicit lifetime — without that
 * exception it silently overrode the public model catalog and the private
 * rendered-media responses, and every app load re-downloaded the catalog.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { HonoEnv } from "../env.js";
import { isCacheableByHandler, securityMiddleware } from "../middleware/security.js";

const appWith = (cacheControl: string | undefined) => {
    const app = new Hono<HonoEnv>();

    app.use("*", securityMiddleware);
    app.get("/", (c) => c.json({ ok: true }, 200, cacheControl ? { "Cache-Control": cacheControl } : {}));

    return app;
};

describe(isCacheableByHandler, () => {
    it.each([
        ["public, max-age=300, stale-while-revalidate=3600", true],
        ["private, max-age=3600", true],
        ["no-cache", false],
        ["no-store", false],
        ["max-age=60, no-store", false],
        [null, false],
    ])("%s → %s", (value, expected) => {
        expect(isCacheableByHandler(value)).toBe(expected);
    });
});

describe("securityMiddleware Cache-Control", () => {
    it("keeps a handler-set lifetime", async () => {
        const response = await appWith("public, max-age=300, stale-while-revalidate=3600").request("/");

        expect(response.headers.get("Cache-Control")).toBe("public, max-age=300, stale-while-revalidate=3600");
    });

    it("defaults to no-store, and overrides a lifetime-less no-cache", async () => {
        const unset = await appWith(undefined).request("/");
        const noCache = await appWith("no-cache").request("/");

        expect(unset.headers.get("Cache-Control")).toBe("no-store");
        expect(noCache.headers.get("Cache-Control")).toBe("no-store");
    });
});
