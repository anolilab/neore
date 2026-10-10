import { describe, expect, it } from "vitest";

import { applyDefaultCacheControl } from "./cache-headers";

const apply = (init: Record<string, string>, handlerType: "router" | "serverFn"): string | null => {
    const headers = new Headers(init);

    applyDefaultCacheControl(headers, handlerType);

    return headers.get("Cache-Control");
};

describe(applyDefaultCacheControl, () => {
    it("makes SSR documents revalidate, without `no-store`, which would opt them out of the bfcache", () => {
        expect(apply({ "Content-Type": "text/html; charset=utf-8" }, "router")).toBe("private, no-cache");
    });

    it("never lets a server-function response be stored — some return session tokens over GET", () => {
        expect(apply({ "Content-Type": "application/json" }, "serverFn")).toBe("private, no-store");
    });

    it("keeps a header the route or handler already set", () => {
        expect(apply({ "Cache-Control": "public, max-age=3600", "Content-Type": "text/plain" }, "router")).toBe("public, max-age=3600");
        expect(apply({ "Cache-Control": "no-cache", "Content-Type": "text/html" }, "router")).toBe("no-cache");
    });

    it("leaves non-HTML router responses (API routes) alone", () => {
        expect(apply({ "Content-Type": "application/json" }, "router")).toBeNull();
    });
});
