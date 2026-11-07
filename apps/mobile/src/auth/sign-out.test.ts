import { describe, expect, it, vi } from "vitest";

import { emptyCacheWhileSignedOut, signOutOnDevice } from "./sign-out";

describe("signOutOnDevice", () => {
    it("empties the cache before it asks the server, so a request that fails or hangs cannot leave chats behind", async () => {
        const calls: string[] = [];

        await signOutOnDevice({
            clearCache: async () => {
                calls.push("clear");
            },
            forgetLastChat: async () => {
                calls.push("forget");
            },
            revokeGrant: async () => {
                calls.push("revoke");

                throw new TypeError("Network request failed");
            },
            warn: () => undefined,
        });

        expect(calls).toEqual(["clear", "forget", "revoke"]);
    });

    it("still asks the server when the cache could not be emptied, and says so", async () => {
        const revokeGrant = vi.fn(async () => undefined);
        const warn = vi.fn();

        await signOutOnDevice({
            clearCache: async () => {
                throw new Error("disk I/O error");
            },
            forgetLastChat: async () => undefined,
            revokeGrant,
            warn,
        });

        expect(revokeGrant).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("Could not empty the offline cache.", expect.any(Error));
    });

    it("still asks the server when the saved chat could not be forgotten, and says so", async () => {
        const revokeGrant = vi.fn(async () => undefined);
        const warn = vi.fn();

        await signOutOnDevice({
            clearCache: async () => undefined,
            forgetLastChat: async () => {
                throw new Error("keychain locked");
            },
            revokeGrant,
            warn,
        });

        expect(revokeGrant).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("Could not forget the last viewed chat.", expect.any(Error));
    });
});

describe("emptyCacheWhileSignedOut", () => {
    it("empties the cache and forgets the saved chat whenever nobody is signed in, so an ended session leaves neither", async () => {
        const clearCache = vi.fn(async () => undefined);
        const forgetLastChat = vi.fn(async () => undefined);

        await emptyCacheWhileSignedOut({ clearCache, forgetLastChat, warn: vi.fn() });

        expect(clearCache).toHaveBeenCalledTimes(1);
        expect(forgetLastChat).toHaveBeenCalledTimes(1);
    });

    it("still forgets the saved chat when the cache cannot be emptied", async () => {
        const forgetLastChat = vi.fn(async () => undefined);

        await emptyCacheWhileSignedOut({
            clearCache: async () => {
                throw new Error("disk I/O error");
            },
            forgetLastChat,
            warn: vi.fn(),
        });

        expect(forgetLastChat).toHaveBeenCalledTimes(1);
    });

    it("only warns when the cache cannot be emptied", async () => {
        const warn = vi.fn();

        await expect(
            emptyCacheWhileSignedOut({
                clearCache: async () => {
                    throw new Error("disk I/O error");
                },
                forgetLastChat: async () => undefined,
                warn,
            }),
        ).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
