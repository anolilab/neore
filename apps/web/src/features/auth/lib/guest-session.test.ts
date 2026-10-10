import { afterEach, describe, expect, it, vi } from "vitest";

import { trackCredentialRequest } from "@/lib/auth/sign-in-lock";

import {
    adoptSessionToken,
    ALREADY_ANONYMOUS_CODE,
    ensureGuestSession,
    GuestSessionUnknownError,
    isAlreadyAnonymousError,
    nextAdoptionDelay,
    resetAdoptionBackoff,
} from "./guest-session";

/** A fake auth client whose session appears once `signIn.anonymous` has answered. */
const fakeClient = (options: { signedIn?: boolean } = {}) => {
    const state = { user: options.signedIn ? { id: "real" } : undefined };
    const anonymous = vi.fn(async () => {
        // Answer on a later tick, like a real request.
        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });
        state.user = { id: "guest" };
    });

    return {
        anonymous,
        client: {
            getSession: vi.fn(async () => {
                return { data: state.user ? { user: state.user } : null };
            }),
            signIn: { anonymous },
        },
    };
};

describe("ensureGuestSession", () => {
    it("mints ONE guest when two callers race (StrictMode's double effect)", async () => {
        const { anonymous, client } = fakeClient();

        const outcomes = await Promise.all([ensureGuestSession(client), ensureGuestSession(client)]);

        expect(anonymous).toHaveBeenCalledTimes(1);
        expect(outcomes).toStrictEqual(["created", "created"]);
    });

    it("is a no-op once a session exists, so a later remount mints nothing", async () => {
        const { anonymous, client } = fakeClient();

        await ensureGuestSession(client);

        await expect(ensureGuestSession(client)).resolves.toBe("existing");
        expect(anonymous).toHaveBeenCalledTimes(1);
    });

    it("never mints a guest over a real session", async () => {
        const { anonymous, client } = fakeClient({ signedIn: true });

        await expect(ensureGuestSession(client)).resolves.toBe("existing");
        expect(anonymous).not.toHaveBeenCalled();
    });

    it("waits for a credential sign-in on the wire, then sees its session", async () => {
        const { anonymous, client } = fakeClient();
        const state = { done: false };

        const passwordSignIn = trackCredentialRequest(
            new Promise<void>((resolve) => {
                setTimeout(() => {
                    state.done = true;
                    resolve();
                }, 10);
            }),
        );

        client.getSession.mockImplementation(async () => {
            return { data: state.done ? { user: { id: "real" } } : null };
        });

        const outcome = await ensureGuestSession(client);

        await passwordSignIn;

        expect(outcome).toBe("existing");
        expect(anonymous).not.toHaveBeenCalled();
    });

    it("clears the slot after a failure so the next attempt can retry", async () => {
        const { anonymous, client } = fakeClient();

        anonymous.mockRejectedValueOnce(new Error("network"));

        await expect(ensureGuestSession(client)).rejects.toThrow("network");
        await expect(ensureGuestSession(client)).resolves.toBe("created");
        expect(anonymous).toHaveBeenCalledTimes(2);
    });
});

/** What better-fetch throws (with `throw: true`) for better-auth's "already a guest" 400. */
const alreadyAnonymousError = (): Error =>
    Object.assign(new Error("Bad Request"), {
        error: { code: ALREADY_ANONYMOUS_CODE, message: "Anonymous users cannot sign in again anonymously" },
        status: 400,
        statusText: "Bad Request",
    });

describe("ensureGuestSession recovery", () => {
    it("sends ONE network sign-in when the trigger fires twice concurrently, even if the session read lags", async () => {
        const { anonymous, client } = fakeClient();

        // A slow `/get-session`, so the second trigger lands while the first
        // attempt is still reading — the window both effect runs passed through.
        client.getSession.mockImplementation(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 5);
            });

            return { data: null };
        });

        const first = ensureGuestSession(client);
        const second = ensureGuestSession(client);

        await expect(Promise.all([first, second])).resolves.toStrictEqual(["created", "created"]);
        expect(anonymous).toHaveBeenCalledTimes(1);
    });

    it("treats better-auth's 400 'already signed in anonymously' as the session it wanted", async () => {
        const { anonymous, client } = fakeClient();

        anonymous.mockRejectedValueOnce(alreadyAnonymousError());

        await expect(ensureGuestSession(client)).resolves.toBe("existing");
        expect(anonymous).toHaveBeenCalledTimes(1);
    });

    it("still rejects any other sign-in failure", async () => {
        const { anonymous, client } = fakeClient();

        anonymous.mockRejectedValueOnce(Object.assign(new Error("Too Many Requests"), { error: { code: "RATE_LIMITED" }, status: 429 }));

        await expect(ensureGuestSession(client)).rejects.toThrow("Too Many Requests");
    });

    it("never mints when the session read FAILED — unknown is not 'nobody'", async () => {
        const { anonymous, client } = fakeClient();

        client.getSession.mockResolvedValueOnce({ data: null, error: { status: 503, statusText: "Service Unavailable" } } as never);

        await expect(ensureGuestSession(client)).rejects.toBeInstanceOf(GuestSessionUnknownError);
        expect(anonymous).not.toHaveBeenCalled();

        // The next attempt reads cleanly and proceeds.
        await expect(ensureGuestSession(client)).resolves.toBe("created");
        expect(anonymous).toHaveBeenCalledTimes(1);
    });

    it("recognises the already-anonymous error by its code only", () => {
        expect(isAlreadyAnonymousError(alreadyAnonymousError())).toBe(true);
        expect(isAlreadyAnonymousError(new Error("Bad Request"))).toBe(false);
        expect(isAlreadyAnonymousError(undefined)).toBe(false);
    });
});

describe("adoptSessionToken", () => {
    const tokenClient = (initial: string | null) => {
        const state = { token: initial };
        const setAuthToken = vi.fn((token: string | null) => {
            state.token = token;
        });

        return { client: { getAuthToken: () => state.token, setAuthToken }, setAuthToken, state };
    };

    it("hands a new token straight to the client", async () => {
        const { client, setAuthToken } = tokenClient(null);

        await adoptSessionToken(client, async () => "jwt-1");

        expect(setAuthToken.mock.calls).toStrictEqual([["jwt-1"]]);
    });

    it("clears then re-sets an UNCHANGED token, so the identity is probed again", async () => {
        const { client, setAuthToken, state } = tokenClient("jwt-1");

        await adoptSessionToken(client, async () => "jwt-1");

        expect(setAuthToken.mock.calls).toStrictEqual([[null], ["jwt-1"]]);
        expect(state.token).toBe("jwt-1");
    });

    it("throws when there is no token to adopt, and leaves the client alone", async () => {
        const { client, setAuthToken } = tokenClient("jwt-1");

        await expect(adoptSessionToken(client, async () => null)).rejects.toThrow("No RPC token");
        expect(setAuthToken).not.toHaveBeenCalled();
    });
});

describe("nextAdoptionDelay", () => {
    afterEach(() => {
        resetAdoptionBackoff();
    });

    it("backs off across laps, caps, and resets after a quiet spell", () => {
        const delays = [0, 1, 2, 3, 4, 5, 6].map(() => nextAdoptionDelay(1000));

        expect(delays).toStrictEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
        expect(nextAdoptionDelay(1000 + 30_000 + 61_000)).toBe(1000);
    });
});
