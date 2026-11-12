import { describe, expect, it } from "vitest";

import type { SessionEvent, SessionState } from "./session-state";
import { INITIAL_SESSION, reduceSession } from "./session-state";

const USER = { email: "a@b.c", id: "u1", image: null, name: "A" };
const OTHER = { email: "x@y.z", id: "u2", image: null, name: "X" };

const run = (...events: SessionEvent[]): SessionState => {
    let state = INITIAL_SESSION;

    for (const event of events) {
        state = reduceSession(state, event);
    }

    return state;
};

describe(reduceSession, () => {
    it("signs a returning person in from the stored user before the mint answers, without a token and not offline", () => {
        expect(run({ type: "stored-user", user: USER })).toStrictEqual({
            hasToken: false,
            isConfirming: true,
            isStoredUserCurrent: true,
            status: "signed-in",
            user: USER,
        });
    });

    it("stays loading when nobody is stored, so the mint decides", () => {
        expect(run({ type: "stored-user", user: null })).toStrictEqual(INITIAL_SESSION);
    });

    it("confirms the optimistic start with the minted token", () => {
        expect(run({ type: "stored-user", user: USER }, { type: "token", user: USER })).toStrictEqual({
            hasToken: true,
            isConfirming: false,
            isStoredUserCurrent: false,
            status: "signed-in",
            user: USER,
        });
    });

    it("ends the optimistic start when the server answers no session (expired, revoked)", () => {
        expect(run({ type: "stored-user", user: USER }, { type: "signed-out" })).toStrictEqual({
            ...INITIAL_SESSION,
            isStoredUserCurrent: false,
            status: "signed-out",
        });
    });

    it("turns a mint with no answer into the offline state: still signed in, no token, no longer confirming", () => {
        expect(run({ type: "stored-user", user: USER }, { type: "unreachable", user: USER })).toStrictEqual({
            hasToken: false,
            isConfirming: false,
            isStoredUserCurrent: true,
            status: "signed-in",
            user: USER,
        });
    });

    it.each<[string, SessionEvent[]]>([
        ["a sign-out", [{ type: "signed-out" }]],
        ["a mint for another account", [{ type: "token", user: OTHER }]],
        // The browser sign-in of another account, whose mint is still out: the old account must not be painted meanwhile.
        ["the start of a sign-in", [{ type: "sign-in-started" }]],
    ])("ignores a stored read that lands after %s", (_name, before) => {
        const settled = run(...before);

        expect(reduceSession(settled, { type: "stored-user", user: USER })).toBe(settled);
    });

    it("keeps the held token when a later refresh gets no answer", () => {
        const state = run({ type: "token", user: USER }, { type: "unreachable", user: USER });

        expect(state.hasToken).toBe(true);
        expect(state.status).toBe("signed-in");
    });
});
