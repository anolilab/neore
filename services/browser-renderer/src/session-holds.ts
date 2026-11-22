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

/**
 * `held`: the hold is the caller's, unlapsed (a renew or release of a lapsed or unknown one says `false`); `busy`: the
 * take was refused for now, and why; `retired`: it was refused for good (`SessionHolds.isRetired`).
 */
export interface HoldAnswer {
    busy?: HoldKind;
    held: boolean;
    retired?: true;
}

/** What a session's lock stores, in one value, so no write of it lands half. */
export interface SessionState {
    /** Until when an exclusive take is refused after a shared hold lapsed (`SessionHolds.drainUntil`). */
    drainUntil?: number;
    holds: [string, Hold][];
    retired?: true;
}

/** The longest lease a call may ask for: past it, a hold of an isolate that died outlasts any reason to keep it. */
export const MAX_LEASE_MS = 10 * 60_000;

/**
 * How long past a shared hold's lapse an exclusive one stays refused: an action gives its browser up well before its
 * lease could lapse (`session-lock.ts`), and this covers one whose isolate was slow to notice.
 */
export const SHARED_DRAIN_MS = 30_000;

/** The holds of one session, and the rules they follow; time is passed in so the tests can move it. */
export class SessionHolds {
    readonly #holds: Map<string, Hold>;

    #isRetired: boolean;

    #drainUntil: number;

    public constructor(holds: Iterable<[string, Hold]> = [], isRetired = false, drainUntil = 0) {
        this.#holds = new Map(holds);
        this.#isRetired = isRetired;
        this.#drainUntil = drainUntil;
    }

    /** Drops each hold lapsed at `now`: an exclusive one retires the session, a shared one starts a drain. */
    #dropLapsed(now: number): void {
        for (const [token, hold] of this.#holds) {
            if (hold.expiresAt > now) {
                continue;
            }

            this.#holds.delete(token);
            this.#isRetired ||= hold.kind === "exclusive";

            if (hold.kind === "shared") {
                // Lapsed, not released: its action may not have stopped yet.
                this.#drainUntil = Math.max(this.#drainUntil, hold.expiresAt + SHARED_DRAIN_MS);
            }
        }
    }

    /** What to store at `now`, in one write: a lapse and the retired flag it sets go together; `undefined` when nothing is left to keep. */
    public state(now: number): SessionState | undefined {
        const holds = this.entries(now);
        const drainUntil = this.#drainUntil > now ? this.#drainUntil : undefined;

        if (drainUntil === undefined && !this.#isRetired && holds.length === 0) {
            return undefined;
        }

        return { holds, ...(drainUntil !== undefined && { drainUntil }), ...(this.#isRetired && { retired: true as const }) };
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
        this.#dropLapsed(now);

        return [...this.#holds];
    }

    /**
     * An exclusive hold is refused while any other hold is in force, or for `SHARED_DRAIN_MS` after a shared one
     * lapsed, and a shared one while an exclusive one is; both are refused for good on a retired session (`isRetired`).
     * The same token asking again (its first answer lost) renews the hold it has.
     */
    public take(token: string, kind: HoldKind, leaseMs: number, now: number): HoldAnswer {
        // First: a lapse it drops may retire the session.
        this.#dropLapsed(now);

        if (this.#isRetired) {
            return { held: false, retired: true };
        }

        const others = this.entries(now).filter(([held]) => held !== token);

        if (others.some(([, hold]) => hold.kind === "exclusive")) {
            return { busy: "exclusive", held: false };
        }

        if (kind === "exclusive" && (others.length > 0 || now < this.#drainUntil)) {
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

/** The holds of a stored state. */
export const holdsOf = (state: SessionState | undefined): SessionHolds => new SessionHolds(state?.holds ?? [], state?.retired === true, state?.drainUntil ?? 0);
