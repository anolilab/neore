import { createInMemoryPersistence, createInMemoryQueryCache, LunoraClient } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthTokenSync, keepAuthToken, MIN_REFRESH_DELAY_MS } from "./auth-token-sync";

/** An unsigned JWT for `sub` that expires at `exp` (seconds); only its payload is read. */
const jwt = (exp: number, sub = "user-1"): string => `h.${btoa(JSON.stringify({ exp, sub })).replaceAll("=", "")}.s`;

beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
    vi.useRealTimers();
});

describe(keepAuthToken, () => {
    it("installs every refreshed token under the grant's user id, so a refresh keeps the offline queue", async () => {
        const setAuthToken = vi.fn();
        const first = jwt(600);
        const second = jwt(1200);
        const getToken = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);

        const stop = keepAuthToken({ setAuthToken }, getToken);

        await vi.advanceTimersByTimeAsync(0);
        expect(setAuthToken).toHaveBeenLastCalledWith(first, "user-1");

        // The refresh runs a minute before `exp`.
        await vi.advanceTimersByTimeAsync(540_000);
        expect(getToken).toHaveBeenLastCalledWith({ force: true });
        expect(setAuthToken).toHaveBeenLastCalledWith(second, "user-1");

        // The stop leaves the bearer: the next session decides (`createAuthTokenSync`).
        stop();
        expect(setAuthToken).toHaveBeenLastCalledWith(second, "user-1");
    });

    it("installs another account's token under that account, so the client reads it as a switch", async () => {
        const setAuthToken = vi.fn();
        const other = jwt(600, "user-2");

        keepAuthToken({ setAuthToken }, async () => other);
        await vi.advanceTimersByTimeAsync(0);

        expect(setAuthToken.mock.calls).toEqual([[other, "user-2"]]);
    });

    it("keys a token with no subject on its own hash, never on the previous user or on nobody", async () => {
        const client = new LunoraClient({ fetch: async () => Response.json({ value: null }), persistence: false, queryCache: false, url: "https://api.test" });

        client.setAuthToken(jwt(600), "user-1");
        keepAuthToken(client, async () => "opaque");
        await vi.advanceTimersByTimeAsync(0);

        expect(client.getAuthToken()).toBe("opaque");
        expect(client.currentIdentity()).not.toBeNull();
        expect(client.currentIdentity()).not.toBe("subj:user-1");

        client.close();
    });

    it("on a switch from another panel, drops the old account's queued writes and cached reads instead of holding them", async () => {
        const sent: string[] = [];
        // The server is out of reach until the switch, so user-1's write stays queued.
        let online = false;
        const persistence = createInMemoryPersistence();
        const queryCache = createInMemoryQueryCache();

        await persistence.append({ args: {}, functionPath: "notes:add", id: "queued-by-user-1", identity: "subj:user-1" });
        await queryCache.put("notes:list", { identity: "subj:user-1", ts: 0, value: ["user-1's note"] });

        const client = new LunoraClient({
            fetch: async (_input, init) => {
                sent.push(`${new Headers(init?.headers).get("authorization") ?? ""} ${String(init?.body)}`);

                if (!online) {
                    throw new TypeError("Failed to fetch");
                }

                return Response.json({ value: null });
            },
            persistence,
            queryCache,
            url: "https://api.test",
        });
        // The loop for user-1 gets user-2's token: the panel's grant changed under it.
        const getToken = vi.fn().mockResolvedValueOnce(jwt(600)).mockResolvedValueOnce(jwt(1200, "user-2"));

        keepAuthToken(client, getToken);
        await vi.advanceTimersByTimeAsync(0);
        expect(client.currentIdentity()).toBe("subj:user-1");
        expect(client.syncStatus().pendingWrites).toBe(1);

        await vi.advanceTimersByTimeAsync(539_000);
        expect(client.syncStatus().pendingWrites).toBe(1);
        expect(await queryCache.load()).toHaveLength(1);
        // The server is back when the refresh hands over user-2's token.
        online = true;
        await vi.advanceTimersByTimeAsync(1000);

        expect(client.currentIdentity()).toBe("subj:user-2");
        // Settled, not held: a held write would wait for a session read, and still count.
        expect(client.replayIdentityVerdict("subj:user-1").verdict).toBe("mismatch");
        expect(client.syncStatus().pendingWrites).toBe(0);
        expect(await persistence.load()).toEqual([]);
        expect(await queryCache.load()).toEqual([]);
        expect(sent.filter((request) => request.startsWith(`Bearer ${jwt(1200, "user-2")}`) && request.includes("notes:add"))).toEqual([]);

        client.close();
    });

    it("keeps the bearer it holds when a refresh gets no token, and tries again", async () => {
        const setAuthToken = vi.fn();
        const held = jwt(600);
        const getToken = vi.fn().mockResolvedValueOnce(held).mockResolvedValueOnce(null).mockResolvedValueOnce(jwt(1200));

        keepAuthToken({ setAuthToken }, getToken);

        await vi.advanceTimersByTimeAsync(540_000);
        expect(getToken).toHaveBeenCalledTimes(2);
        expect(setAuthToken.mock.calls).toEqual([[held, "user-1"]]);

        await vi.advanceTimersByTimeAsync(MIN_REFRESH_DELAY_MS);
        expect(setAuthToken).toHaveBeenLastCalledWith(jwt(1200), "user-1");
    });

    it("installs nothing that answers after the stop", async () => {
        const setAuthToken = vi.fn();
        const stop = keepAuthToken({ setAuthToken }, async () => jwt(600));

        stop();
        await vi.advanceTimersByTimeAsync(0);

        expect(setAuthToken).not.toHaveBeenCalled();
    });
});

describe(createAuthTokenSync, () => {
    it("swaps a new grant's bearer in for the same user without clearing it, so the offline queue stays", async () => {
        const setAuthToken = vi.fn();
        const first = jwt(600);
        const second = jwt(1200);
        const getToken = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const sync = createAuthTokenSync({ setAuthToken }, getToken);

        const stop = sync.start("user-1");

        await vi.advanceTimersByTimeAsync(0);
        stop();
        sync.start("user-1");
        await vi.advanceTimersByTimeAsync(0);

        expect(setAuthToken.mock.calls).toEqual([
            [first, "user-1"],
            [second, "user-1"],
        ]);
    });

    it("clears the bearer before another account's loop starts, and on sign-out", async () => {
        const setAuthToken = vi.fn();
        const sync = createAuthTokenSync({ setAuthToken }, async () => jwt(600, "user-2"));

        sync.start("user-1")();
        expect(setAuthToken.mock.calls).toEqual([]);

        sync.start("user-2");
        expect(setAuthToken.mock.calls).toEqual([[null]]);
        await vi.advanceTimersByTimeAsync(0);
        expect(setAuthToken).toHaveBeenLastCalledWith(jwt(600, "user-2"), "user-2");

        sync.signOut();
        expect(setAuthToken).toHaveBeenLastCalledWith(null);
    });

    it("keeps the bearer a loop installed for another account when that account's own session starts", async () => {
        const setAuthToken = vi.fn();
        const sync = createAuthTokenSync({ setAuthToken }, async () => jwt(600, "user-2"));

        // Another panel signed user-2 in before this panel's session for user-1 was torn down.
        const stop = sync.start("user-1");

        await vi.advanceTimersByTimeAsync(0);
        stop();
        sync.start("user-2");

        expect(setAuthToken).not.toHaveBeenCalledWith(null);
    });

    it("stops the running loop on sign-out, so a refresh never reinstalls the bearer while the grant is still stored", async () => {
        const setAuthToken = vi.fn();
        const getToken = vi.fn(async () => jwt(600));
        const sync = createAuthTokenSync({ setAuthToken }, getToken);

        sync.start("user-1");
        await vi.advanceTimersByTimeAsync(0);
        sync.signOut();
        await vi.advanceTimersByTimeAsync(600_000);

        expect(getToken).toHaveBeenCalledTimes(1);
        expect(setAuthToken).toHaveBeenLastCalledWith(null);
    });

    it("suspends without clearing the bearer, then clears it on finish", async () => {
        const setAuthToken = vi.fn();
        const getToken = vi.fn(async () => jwt(600));
        const sync = createAuthTokenSync({ setAuthToken }, getToken);

        sync.start("user-1");
        await vi.advanceTimersByTimeAsync(0);

        const suspended = sync.suspend();

        await vi.advanceTimersByTimeAsync(600_000);
        expect(getToken).toHaveBeenCalledTimes(1);
        expect(setAuthToken).not.toHaveBeenCalledWith(null);

        suspended.finish();
        expect(setAuthToken).toHaveBeenLastCalledWith(null);
    });

    it("restarts the loop for the same user on restore, keeping the bearer", async () => {
        const setAuthToken = vi.fn();
        const getToken = vi.fn(async () => jwt(600));
        const sync = createAuthTokenSync({ setAuthToken }, getToken);

        const stop = sync.start("user-1");

        await vi.advanceTimersByTimeAsync(0);
        sync.suspend().restore();
        await vi.advanceTimersByTimeAsync(0);

        expect(getToken).toHaveBeenCalledTimes(2);
        expect(setAuthToken).not.toHaveBeenCalledWith(null);
        expect(setAuthToken).toHaveBeenLastCalledWith(jwt(600), "user-1");

        // The session's own stop still ends the restored loop.
        stop();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(getToken).toHaveBeenCalledTimes(2);
    });

    it("does nothing on finish or restore once another session has started", async () => {
        const setAuthToken = vi.fn();
        const getToken = vi.fn(async () => jwt(600, "user-2"));
        const sync = createAuthTokenSync({ setAuthToken }, getToken);

        sync.start("user-1");
        await vi.advanceTimersByTimeAsync(0);

        const suspended = sync.suspend();

        sync.start("user-2");
        await vi.advanceTimersByTimeAsync(0);
        setAuthToken.mockClear();
        getToken.mockClear();

        suspended.finish();
        suspended.restore();
        await vi.advanceTimersByTimeAsync(0);

        expect(setAuthToken).not.toHaveBeenCalled();
        expect(getToken).not.toHaveBeenCalled();
    });
});
