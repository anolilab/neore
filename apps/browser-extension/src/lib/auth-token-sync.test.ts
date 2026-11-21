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

        const stop = keepAuthToken({ setAuthToken }, "user-1", getToken);

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

    it("asserts no subject for another account's token, so the client reads it as a switch", async () => {
        const setAuthToken = vi.fn();
        const other = jwt(600, "user-2");

        keepAuthToken({ setAuthToken }, "user-1", async () => other);
        await vi.advanceTimersByTimeAsync(0);

        expect(setAuthToken.mock.calls).toEqual([[other]]);
    });

    it("keeps the bearer it holds when a refresh gets no token, and tries again", async () => {
        const setAuthToken = vi.fn();
        const held = jwt(600);
        const getToken = vi.fn().mockResolvedValueOnce(held).mockResolvedValueOnce(null).mockResolvedValueOnce(jwt(1200));

        keepAuthToken({ setAuthToken }, "user-1", getToken);

        await vi.advanceTimersByTimeAsync(540_000);
        expect(getToken).toHaveBeenCalledTimes(2);
        expect(setAuthToken.mock.calls).toEqual([[held, "user-1"]]);

        await vi.advanceTimersByTimeAsync(MIN_REFRESH_DELAY_MS);
        expect(setAuthToken).toHaveBeenLastCalledWith(jwt(1200), "user-1");
    });

    it("installs nothing that answers after the stop", async () => {
        const setAuthToken = vi.fn();
        const stop = keepAuthToken({ setAuthToken }, "user-1", async () => jwt(600));

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
});
