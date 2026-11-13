import { describe, expect, it, vi } from "vitest";

import { createAuthEpoch } from "./session-state";
import { emptyCacheWhileSignedOut, RELEASE_PUSH_TIMEOUT_MS, runSignOut, signOutOnDevice } from "./sign-out";

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

    it("releases the phone's push token after the local wipe and before the revoke, while the sign-in still works", async () => {
        const calls: string[] = [];
        const step = (name: string) => async () => {
            calls.push(name);
        };

        await signOutOnDevice({
            clearCache: step("clear"),
            forgetLastChat: step("forget"),
            releasePush: step("release"),
            revokeGrant: step("revoke"),
            warn: () => undefined,
        });

        expect(calls).toEqual(["clear", "forget", "release", "revoke"]);
    });

    it("signs out anyway when the release fails or never answers", async () => {
        vi.useFakeTimers();

        try {
            const revokeGrant = vi.fn(async () => undefined);
            const warn = vi.fn();
            const signingOut = signOutOnDevice({
                clearCache: async () => undefined,
                forgetLastChat: async () => undefined,
                releasePush: async () => await new Promise<void>(() => {}),
                revokeGrant,
                warn,
            });

            await vi.advanceTimersByTimeAsync(RELEASE_PUSH_TIMEOUT_MS);
            await signingOut;

            expect(revokeGrant).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith("Could not stop notifications for this phone.", expect.any(Error));
        } finally {
            vi.useRealTimers();
        }
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

describe(runSignOut, () => {
    it("stales a mint still out before the teardown's first await, so it applies nothing while the cache is emptied", async () => {
        const epoch = createAuthEpoch();
        const isStale = epoch.start();
        let staleDuringTeardown: boolean | undefined;
        const finish = vi.fn();

        await runSignOut({
            endMints: () => epoch.close(),
            finish,
            teardown: async () => {
                // The mint answers while the teardown still waits on the cache and the server.
                staleDuringTeardown = isStale();
                await Promise.resolve();
            },
        });

        expect(staleDuringTeardown).toBe(true);
        expect(finish).toHaveBeenCalledOnce();
    });

    it("also stales a mint started during the teardown, and finishes when the teardown fails", async () => {
        const epoch = createAuthEpoch();
        let isStale: (() => boolean) | undefined;
        const finish = vi.fn();

        await expect(
            runSignOut({
                endMints: () => epoch.close(),
                finish,
                teardown: async () => {
                    isStale = epoch.start();

                    throw new Error("the revoke failed");
                },
            }),
        ).rejects.toThrow("the revoke failed");

        expect(isStale?.()).toBe(true);
        expect(finish).toHaveBeenCalledOnce();
    });

    it("applies nothing from a mint a refresh timer begins while the teardown still runs, until the next sign-in", async () => {
        const epoch = createAuthEpoch();
        let staleDuringTeardown: boolean | undefined;
        let begunDuringTeardown: (() => boolean) | undefined;

        await runSignOut({
            endMints: () => epoch.close(),
            finish: () => {},
            teardown: async () => {
                // The refresh timer fires after the epoch ended, and its mint answers before the teardown is done.
                begunDuringTeardown = epoch.start();
                staleDuringTeardown = begunDuringTeardown();
                await Promise.resolve();
            },
        });

        expect(staleDuringTeardown).toBe(true);

        // The next sign-in reopens the epoch; a mint from the sign-out still applies nothing, a new one applies.
        epoch.open();
        expect(begunDuringTeardown?.()).toBe(true);
        expect(epoch.start()()).toBe(false);
    });
});
