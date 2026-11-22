/** The holds on one browser session and the rules they follow (`session-lock.ts` keeps them in a Durable Object). */

export type HoldKind = "exclusive" | "shared";

export interface Hold {
    expiresAt: number;
    kind: HoldKind;
}

/** What a call asks of a session's holds; `token` is the caller's, so a release reaches its hold even when the answer to the take was lost. */
export type HoldRequest =
    | { kind: HoldKind; leaseMs: number; op: "take"; token: string }
    | { leaseMs: number; op: "renew"; token: string }
    | { op: "release"; token: string };

/** `held`: the hold is the caller's, unlapsed (a renew or release of a lapsed or unknown one says `false`); `busy`: the take was refused, and why. */
export interface HoldAnswer {
    busy?: HoldKind;
    held: boolean;
}

/** The longest lease a call may ask for: past it, a hold of an isolate that died outlasts any reason to keep it. */
export const MAX_LEASE_MS = 10 * 60_000;

/** The holds of one session, and the rules they follow; time is passed in so the tests can move it. */
export class SessionHolds {
    readonly #holds: Map<string, Hold>;

    #isRetired: boolean;

    public constructor(holds: Iterable<[string, Hold]> = [], isRetired = false) {
        this.#holds = new Map(holds);
        this.#isRetired = isRetired;
    }

    /**
     * Whether the session is refused to every call from now on: an exclusive hold lapsed instead of being released, so
     * the sign-in that had it ended without confirming its page clean or its browser closed (its isolate died, or its
     * close never ended). Browser Rendering keeps such a browser open past the lease, with the answer to the sign-in on it.
     */
    public get isRetired(): boolean {
        return this.#isRetired;
    }

    /** The holds still in force at `now`, a lapsed one dropped. */
    public entries(now: number): [string, Hold][] {
        for (const [token, hold] of this.#holds) {
            if (hold.expiresAt > now) {
                continue;
            }

            this.#holds.delete(token);
            this.#isRetired ||= hold.kind === "exclusive";
        }

        return [...this.#holds];
    }

    /**
     * An exclusive hold is refused while any other hold is in force, and a shared one while an exclusive one is; both
     * are refused on a retired session (`isRetired`), as if an exclusive hold were in force. The same
     * token asking again (its first answer lost) renews the hold it has.
     */
    public take(token: string, kind: HoldKind, leaseMs: number, now: number): HoldAnswer {
        const others = this.entries(now).filter(([held]) => held !== token);
        const exclusive = others.some(([, hold]) => hold.kind === "exclusive");

        if (exclusive || this.#isRetired) {
            return { busy: "exclusive", held: false };
        }

        if (kind === "exclusive" && others.length > 0) {
            return { busy: "shared", held: false };
        }

        this.#holds.set(token, { expiresAt: now + Math.min(leaseMs, MAX_LEASE_MS), kind });

        return { held: true };
    }

    /** A hold in force runs on for `leaseMs` from `now`; a lapsed one is not brought back. */
    public renew(token: string, leaseMs: number, now: number): HoldAnswer {
        const hold = new Map(this.entries(now)).get(token);

        if (!hold) {
            return { held: false };
        }

        this.#holds.set(token, { ...hold, expiresAt: now + Math.min(leaseMs, MAX_LEASE_MS) });

        return { held: true };
    }

    /** Ends the hold; `held` says whether it was still in force. */
    public release(token: string, now: number): HoldAnswer {
        const held = this.entries(now).some(([candidate]) => candidate === token);

        this.#holds.delete(token);

        return { held };
    }
}
