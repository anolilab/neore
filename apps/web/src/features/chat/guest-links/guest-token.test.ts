import { afterEach, describe, expect, it, vi } from "vitest";

import { clearGuestTokenMemory, forgetGuestToken, guestTokenFor, keepGuestToken, rereadGuestToken } from "./guest-token";

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

    it("keeps the token a post was accepted with over one another tab wrote, and reads storage again after a refusal", async () => {
        const accepted = await guestTokenFor(LINK, { create: true });
        // Another tab of this browser makes its own token for the same link and writes it over this one.
        const key = Object.keys(globalThis.localStorage)[0] ?? "";

        globalThis.localStorage.setItem(key, "ef".repeat(32));
        await keepGuestToken(LINK, accepted ?? "");
        clearGuestTokenMemory();
        expect(await guestTokenFor(LINK)).toBe(accepted);

        // The other tab, refused, still holds its own token in memory; it drops that copy and takes the accepted one from storage.
        await keepGuestToken(LINK, "ef".repeat(32));
        globalThis.localStorage.setItem(key, accepted ?? "");
        expect(await guestTokenFor(LINK)).toBe("ef".repeat(32));
        await rereadGuestToken(LINK);
        expect(await guestTokenFor(LINK)).toBe(accepted);
    });

    it("makes none without being asked, and forgets the token of a link that ended", async () => {
        expect(await guestTokenFor(LINK)).toBeUndefined();

        await guestTokenFor(LINK, { create: true });
        await forgetGuestToken(LINK);
        clearGuestTokenMemory();

        expect(await guestTokenFor(LINK)).toBeUndefined();
    });
});
