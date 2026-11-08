import { afterEach, describe, expect, it, vi } from "vitest";

import { clearGuestTokenMemory, forgetGuestToken, guestTokenFor } from "./guest-token";

const TOKEN_SHAPE = /^[0-9a-f]{64}$/u;
const LINK = "cd".repeat(32);

afterEach(() => {
    globalThis.localStorage.clear();
    clearGuestTokenMemory();
    vi.restoreAllMocks();
});

describe(guestTokenFor, () => {
    it("makes 32 random bytes per link and keeps them in storage, under a digest of the link token", async () => {
        const random = vi.spyOn(globalThis.crypto, "getRandomValues");
        const first = await guestTokenFor(LINK, { create: true });

        expect(first).toMatch(TOKEN_SHAPE);
        expect(random).toHaveBeenCalledWith(expect.objectContaining({ length: 32 }));
        expect(await guestTokenFor("another-link", { create: true })).not.toBe(first);

        // Read back from storage alone, as a reload does: the same link keeps its token, so a retry carries it.
        clearGuestTokenMemory();
        expect(await guestTokenFor(LINK)).toBe(first);
        // The link token itself is stored nowhere.
        expect(JSON.stringify({ ...globalThis.localStorage })).not.toContain(LINK);
    });

    it("makes none without being asked, and forgets the token of a link that ended", async () => {
        expect(await guestTokenFor(LINK)).toBeUndefined();

        await guestTokenFor(LINK, { create: true });
        await forgetGuestToken(LINK);
        clearGuestTokenMemory();

        expect(await guestTokenFor(LINK)).toBeUndefined();
    });
});
