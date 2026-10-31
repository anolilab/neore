import { describe, expect, it, vi } from "vitest";

import { signOutOnDevice } from "./sign-out";

describe("signOutOnDevice", () => {
    it("empties the cache before it asks the server, so a request that fails or hangs cannot leave chats behind", async () => {
        const calls: string[] = [];

        await signOutOnDevice({
            clearCache: async () => {
                calls.push("clear");
            },
            revokeGrant: async () => {
                calls.push("revoke");

                throw new TypeError("Network request failed");
            },
            warn: () => undefined,
        });

        expect(calls).toEqual(["clear", "revoke"]);
    });

    it("still asks the server when the cache could not be emptied, and says so", async () => {
        const revokeGrant = vi.fn(async () => undefined);
        const warn = vi.fn();

        await signOutOnDevice({
            clearCache: async () => {
                throw new Error("disk I/O error");
            },
            revokeGrant,
            warn,
        });

        expect(revokeGrant).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("Could not empty the offline cache.", expect.any(Error));
    });
});
