import { describe, expect, it, vi } from "vitest";

import type { KeychainWriteOps } from "./shared-keychain";
import { createKeychainWriteOps, GRANT_ACCESSIBILITY_MARKER, untilItWorks, upgradeGrantInPlace, writeIfDifferent } from "./shared-keychain";

const KEY = "neore.mobile.grant";
const GRANT = "{\"token\":\"session-1\"}";

/** A keychain: `items` by key, and every write in order. It has no delete: the write path must never need one. */
const keychain = (initial: Record<string, string>) => {
    const items = { ...initial };
    const writes: string[] = [];
    const ops: KeychainWriteOps = {
        read: vi.fn(async (key: string) => items[key] ?? null),
        writeInPlace: vi.fn(async (key: string, value: string) => {
            writes.push(`${key}=${value}`);
            items[key] = value;
        }),
    };

    return { items, ops, writes };
};

describe("upgradeGrantInPlace", () => {
    it("rewrites a grant from before this build over itself, once, so the sign-in is never missing", async () => {
        const { items, ops, writes } = keychain({ [KEY]: GRANT });

        expect(await upgradeGrantInPlace(KEY, ops)).toBe(true);
        expect(writes).toEqual([`${KEY}=${GRANT}`, `${GRANT_ACCESSIBILITY_MARKER}=1`]);
        // At every step the grant is readable: there is no delete in between.
        expect(items[KEY]).toBe(GRANT);
    });

    it("writes nothing on later launches", async () => {
        const { ops, writes } = keychain({ [GRANT_ACCESSIBILITY_MARKER]: "1", [KEY]: GRANT });

        expect(await upgradeGrantInPlace(KEY, ops)).toBe(false);
        expect(writes).toEqual([]);
    });

    it("only sets the marker when nobody is signed in: a later sign-in writes the grant readable already", async () => {
        const { ops, writes } = keychain({});

        expect(await upgradeGrantInPlace(KEY, ops)).toBe(false);
        expect(writes).toEqual([`${GRANT_ACCESSIBILITY_MARKER}=1`]);
    });
});

describe("writeIfDifferent", () => {
    it("writes only when the stored value differs", async () => {
        const { ops, writes } = keychain({ "neore.mobile.lunora-url": "https://api.neore.chat" });

        expect(await writeIfDifferent("neore.mobile.lunora-url", "https://api.neore.chat", ops)).toBe(false);
        expect(await writeIfDifferent("neore.mobile.lunora-url", "https://api.staging.neore.chat", ops)).toBe(true);
        expect(writes).toEqual(["neore.mobile.lunora-url=https://api.staging.neore.chat"]);
    });
});

describe("createKeychainWriteOps", () => {
    it("gives every write the after-first-unlock accessibility, which is what changes an existing item's in place", async () => {
        const setItem = vi.fn(async () => undefined);
        const ops = createKeychainWriteOps({ accessible: "AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY", getItem: async () => null, setItem });

        await ops.writeInPlace(KEY, GRANT);

        expect(setItem).toHaveBeenCalledWith(KEY, GRANT, { keychainAccessible: "AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY" });
    });
});

describe("untilItWorks", () => {
    it("tries a failed upgrade again on the next use instead of waiting for a restart, and stops once it worked", async () => {
        const step = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("errSecInteractionNotAllowed")).mockResolvedValue(undefined);
        const ensure = untilItWorks(step);

        await expect(ensure()).rejects.toThrow("errSecInteractionNotAllowed");
        await ensure();
        await ensure();

        expect(step).toHaveBeenCalledTimes(2);
    });

    it("shares one attempt between callers at the same time", async () => {
        const step = vi.fn(async () => undefined);
        const ensure = untilItWorks(step);

        await Promise.all([ensure(), ensure(), ensure()]);

        expect(step).toHaveBeenCalledTimes(1);
    });
});
