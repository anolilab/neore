import { describe, expect, it, vi } from "vitest";

import { emptyCacheWhileSignedOut, RELEASE_PUSH_TIMEOUT_MS, signOutOnDevice } from "./sign-out";
import { StoredGrantNotClearedError } from "./stored-grant-error";

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
            revokeSession: async () => {
                calls.push("revoke");

                throw new TypeError("Network request failed");
            },
            takeCredential: async () => {
                calls.push("take");

                return "session-1";
            },
            warn: () => undefined,
        });

        expect(calls).toEqual(["clear", "forget", "take", "revoke"]);
    });

    it("clears the stored session before it releases the push token or revokes, so nothing on the phone can sign in as them", async () => {
        const calls: string[] = [];
        const step = (name: string) => async () => {
            calls.push(name);
        };

        await signOutOnDevice({
            clearCache: step("clear"),
            forgetLastChat: step("forget"),
            releasePush: step("release"),
            revokeSession: async (token) => {
                calls.push(`revoke ${token}`);
            },
            takeCredential: async () => {
                calls.push("take");

                return "session-1";
            },
            warn: () => undefined,
        });

        expect(calls).toEqual(["clear", "forget", "take", "release", "revoke session-1"]);
    });

    it("revokes the token the failed clear carries, so a grant left in the keychain stops working", async () => {
        const revokeSession = vi.fn(async () => undefined);
        const warn = vi.fn();
        const keychain = new Error("keychain locked");

        await signOutOnDevice({
            clearCache: async () => undefined,
            forgetLastChat: async () => undefined,
            revokeSession,
            takeCredential: async () => {
                throw new StoredGrantNotClearedError("session-1", keychain);
            },
            warn,
        });

        expect(revokeSession).toHaveBeenCalledWith("session-1");
        // The warning gets the keychain failure itself, never the error that carries the session token.
        expect(warn).toHaveBeenCalledWith("Could not clear the stored sign-in.", keychain);
    });

    it("warns that the revoke was refused, without the token, and still finishes sign-out", async () => {
        const warn = vi.fn();
        const refused = new Error("Could not revoke the session (500).");

        await signOutOnDevice({
            clearCache: async () => undefined,
            forgetLastChat: async () => undefined,
            revokeSession: async () => {
                throw refused;
            },
            takeCredential: async () => "session-1",
            warn,
        });

        expect(warn).toHaveBeenCalledWith("Could not revoke the session on the server.", refused);
    });

    it("sends no revoke when no session was stored", async () => {
        const revokeSession = vi.fn(async () => undefined);

        await signOutOnDevice({
            clearCache: async () => undefined,
            forgetLastChat: async () => undefined,
            revokeSession,
            takeCredential: async () => undefined,
            warn: vi.fn(),
        });

        expect(revokeSession).not.toHaveBeenCalled();
    });

    it("signs out anyway when the release fails or never answers", async () => {
        vi.useFakeTimers();

        try {
            const revokeSession = vi.fn(async () => undefined);
            const warn = vi.fn();
            const signingOut = signOutOnDevice({
                clearCache: async () => undefined,
                forgetLastChat: async () => undefined,
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

    it("still asks the server when the cache could not be emptied, and says so", async () => {
        const revokeSession = vi.fn(async () => undefined);
        const warn = vi.fn();

        await signOutOnDevice({
            clearCache: async () => {
                throw new Error("disk I/O error");
            },
            forgetLastChat: async () => undefined,
            revokeSession,
            takeCredential: async () => "session-1",
            warn,
        });

        expect(revokeSession).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("Could not empty the offline cache.", expect.any(Error));
    });

    it("still asks the server when the saved chat could not be forgotten, and says so", async () => {
        const revokeSession = vi.fn(async () => undefined);
        const warn = vi.fn();

        await signOutOnDevice({
            clearCache: async () => undefined,
            forgetLastChat: async () => {
                throw new Error("keychain locked");
            },
            revokeSession,
            takeCredential: async () => "session-1",
            warn,
        });

        expect(revokeSession).toHaveBeenCalledTimes(1);
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
