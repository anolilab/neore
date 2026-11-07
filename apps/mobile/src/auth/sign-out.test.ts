import { describe, expect, it, vi } from "vitest";

import { emptyCacheWhileSignedOut, RELEASE_PUSH_TIMEOUT_MS, signOutOnDevice } from "./sign-out";

const recorder = () => {
    const calls: string[] = [];
    const step = (name: string) => async () => {
        calls.push(name);
    };

    return { calls, step };
};

describe("signOutOnDevice", () => {
    it("empties the cache, then clears the stored sign-in, both before the server is asked anything", async () => {
        const { calls, step } = recorder();

        await signOutOnDevice({
            clearCache: step("clear"),
            dismissNotifications: step("dismiss"),
            forgetLastChat: step("forget"),
            releasePush: step("release"),
            revokeSession: async (token) => {
                calls.push(`revoke ${token}`);

                throw new TypeError("Network request failed");
            },
            takeCredential: async () => {
                calls.push("take");

                return "session-1";
            },
            warn: () => undefined,
        });

        expect(calls).toEqual(["clear", "forget", "take", "dismiss", "release", "revoke session-1"]);
    });

    it("has the credential the notification extension reads gone before push release or revoke even start", async () => {
        const keychain: { grant?: string } = { grant: "session-1" };
        const seen: (string | undefined)[] = [];

        await signOutOnDevice({
            forgetLastChat: async () => undefined,
            clearCache: async () => undefined,
            releasePush: async () => {
                seen.push(keychain.grant);
            },
            revokeSession: async () => {
                seen.push(keychain.grant);
            },
            takeCredential: async () => {
                const { grant } = keychain;

                keychain.grant = undefined;

                return grant;
            },
            warn: () => undefined,
        });

        expect(seen).toEqual([undefined, undefined]);
    });

    it("still clears the sign-in when the cache could not be emptied, and says so", async () => {
        const takeCredential = vi.fn(async () => undefined);
        const warn = vi.fn();

        await signOutOnDevice({
            forgetLastChat: async () => undefined,
            clearCache: async () => {
                throw new Error("disk I/O error");
            },
            revokeSession: vi.fn(),
            takeCredential,
            warn,
        });

        expect(takeCredential).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("Could not empty the offline cache.", expect.any(Error));
    });

    it("still clears the sign-in when the saved chat could not be forgotten, and says so", async () => {
        const takeCredential = vi.fn(async () => undefined);
        const warn = vi.fn();

        await signOutOnDevice({
            clearCache: async () => undefined,
            forgetLastChat: async () => {
                throw new Error("disk I/O error");
            },
            revokeSession: vi.fn(),
            takeCredential,
            warn,
        });

        expect(takeCredential).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("Could not forget the last viewed chat.", expect.any(Error));
    });

    it("revokes nothing when no session was stored, and warns when the stored one cannot be cleared", async () => {
        const revokeSession = vi.fn(async () => undefined);
        const warn = vi.fn();

        await signOutOnDevice({
            forgetLastChat: async () => undefined,
            clearCache: async () => undefined,
            revokeSession,
            takeCredential: async () => {
                throw new Error("keychain locked");
            },
            warn,
        });

        expect(revokeSession).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("Could not clear the stored sign-in.", expect.any(Error));
    });
});

describe("signOutOnDevice releasing push", () => {
    it("signs out anyway when the release fails or never answers", async () => {
        vi.useFakeTimers();

        try {
            const revokeSession = vi.fn(async () => undefined);
            const warn = vi.fn();
            const signingOut = signOutOnDevice({
                forgetLastChat: async () => undefined,
                clearCache: async () => undefined,
                releasePush: async () => await new Promise<void>(() => {}),
                revokeSession,
                takeCredential: async () => "session-1",
                warn,
            });

            await vi.advanceTimersByTimeAsync(RELEASE_PUSH_TIMEOUT_MS);
            await signingOut;

            expect(revokeSession).toHaveBeenCalledWith("session-1");
            expect(warn).toHaveBeenCalledWith("Could not stop notifications for this phone.", expect.any(Error));
        } finally {
            vi.useRealTimers();
        }
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

    it("asks to forget the saved chat before the cache wipe ends, so a chat saved by a quick sign-in is queued after it", async () => {
        const calls: string[] = [];

        await emptyCacheWhileSignedOut({
            clearCache: async () => {
                calls.push("wipe started");
                await new Promise((resolve) => {
                    setTimeout(resolve, 0);
                });
                calls.push("wipe ended");
            },
            forgetLastChat: async () => {
                calls.push("forget");
            },
            warn: vi.fn(),
        });

        expect(calls).toEqual(["wipe started", "forget", "wipe ended"]);
    });

    it("only warns when the saved chat cannot be forgotten", async () => {
        const error = new Error("keychain locked");
        const warn = vi.fn();

        await expect(
            emptyCacheWhileSignedOut({
                clearCache: async () => undefined,
                forgetLastChat: async () => {
                    throw error;
                },
                warn,
            }),
        ).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith("Could not forget the last viewed chat.", error);
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
