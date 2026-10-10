/**
 * `fetchWithTimeout` keeps a caller's `signal`: it used to replace it with its
 * own timeout controller, so a caller's deadline (or cancel) did nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "./utilities";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(fetchWithTimeout, () => {
    it("aborts through the caller's signal as well as its own timeout", async () => {
        let seen: AbortSignal | undefined;

        vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
            seen = init.signal ?? undefined;

            return new Response("ok");
        });

        const caller = new AbortController();

        await fetchWithTimeout("https://example.com/", { signal: caller.signal });

        expect(seen?.aborted).toBe(false);

        caller.abort();

        expect(seen?.aborted).toBe(true);
    });
});
