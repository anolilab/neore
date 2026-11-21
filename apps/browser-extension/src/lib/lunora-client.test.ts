import type { wireLiveSocket } from "@neore/client-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLunoraClient } from "./lunora-client";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createLunoraClient", () => {
    it("signs the live-query socket in with a ticket minted for the bearer, without cookies", async () => {
        const wire = vi.fn<typeof wireLiveSocket>(() => () => undefined);
        const client = createLunoraClient("https://api.example.test", wire);
        const [wired, mint] = wire.mock.calls[0] ?? [];

        expect(wired).toBe(client);

        const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ticket: "t1" }));

        vi.stubGlobal("fetch", fetchMock);

        await expect(mint?.("jwt")).resolves.toBe("t1");

        const [url, init] = fetchMock.mock.calls[0] ?? [];

        expect(String(url)).toBe("https://api.example.test/_lunora/ws-ticket");
        expect(init?.credentials).toBe("omit");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer jwt");
    });
});
