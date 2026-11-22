/** The holds on one browser session and the rules they follow (`session-lock.ts` keeps them in a Durable Object). */

export type HoldKind = "exclusive" | "shared";

export interface Hold {
    /** Set by a renewal that arms it (`SessionHold.arm`): its call may have started on the session's page. */
    armed?: true;
    expiresAt: number;
    kind: HoldKind;
}

/** What a call asks of a session's holds; `token` is the caller's, so a release reaches its hold even when the answer to the take was lost. */
export type HoldRequest =
    /** `notAfter`: the lock's clock past which the take is refused, holding nothing (its caller has given up on it). */
    | { kind: HoldKind; leaseMs: number; notAfter?: number; op: "take"; token: string }
    /** `arm`: the caller is about to start on the session's page, so a lapse of this hold from now on retires it. */
    | { arm?: true; leaseMs: number; op: "renew"; token: string }
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
    /** Tokens released, with when each record ends (`SessionHolds.release`). */
    cancelled?: [string, number][];
    /** Until when an exclusive take is refused after a shared hold lapsed (`SessionHolds.drainUntil`). */
    drainUntil?: number;
    holds: [string, Hold][];
    retired?: true;
    /** Until when the retired flag is kept (`RETIRED_KEEP_MS`). */
    retiredUntil?: number;
}

/** The longest lease a call may ask for: past it, a hold of an isolate that died outlasts any reason to keep it. */
export const MAX_LEASE_MS = 10 * 60_000;

/**
 * How long past a shared hold's lapse an exclusive one stays refused: an action gives its browser up well before its
 * lease could lapse (`session-lock.ts`), and this covers one whose isolate was slow to notice.
 */
export const SHARED_DRAIN_MS = 30_000;

/**
 * How long a retired session stays refused, from the lapse that retired it: past the longest its browser can still be
 * open (Browser Rendering's keep-alive is at most ten minutes, and a close still under way holds it at most a lease
 * more), so a record is not kept for every session for good.
 */
export const RETIRED_KEEP_MS = 60 * 60_000;

/** The holds of one session, and the rules they follow; time is passed in so the tests can move it. */
export class SessionHolds {
    readonly #holds: Map<string, Hold>;

    #isRetired: boolean;

    #retiredUntil: number;

    #drainUntil: number;

    /** Released tokens, until when each is kept: a take that arrives after its own release creates no hold. */
    readonly #cancelled: Map<string, number>;

    public constructor(
        holds: Iterable<[string, Hold]> = [],
        isRetired = false,
        drainUntil = 0,
        cancelled: Iterable<[string, number]> = [],
        retiredUntil = isRetired ? Number.MAX_SAFE_INTEGER : 0,
    ) {
        this.#holds = new Map(holds);
        this.#isRetired = isRetired;
        this.#retiredUntil = retiredUntil;
        this.#drainUntil = drainUntil;
        this.#cancelled = new Map(cancelled);
    }

    /** The released tokens still kept at `now`. */
    #cancelledAt(now: number): [string, number][] {
        for (const [token, until] of this.#cancelled) {
            if (until <= now) {
                this.#cancelled.delete(token);
            }
        }

        return [...this.#cancelled];
    }

    /** Drops each hold lapsed at `now`: an exclusive one retires the session, a shared one starts a drain. */
    #dropLapsed(now: number): void {
        for (const [token, hold] of this.#holds) {
            if (hold.expiresAt > now) {
                continue;
            }

            this.#holds.delete(token);

            if (hold.kind === "exclusive") {
                // Never armed: its call never started on the page (it starts only once an arm was answered), so the page
                // holds nothing of it. An armed one may have typed the password: the session is refused from now on.
                if (!hold.armed) {
                    continue;
                }

                this.#isRetired = true;
                this.#retiredUntil = Math.max(this.#retiredUntil, hold.expiresAt + RETIRED_KEEP_MS);
            } else {
                // Lapsed, not released: its action may not have stopped yet.
                this.#drainUntil = Math.max(this.#drainUntil, hold.expiresAt + SHARED_DRAIN_MS);
            }
        }
    }

    /** Whether the session is retired at `now`: a flag whose time has run out is dropped. */
    #retiredAt(now: number): boolean {
        if (this.#isRetired && this.#retiredUntil <= now) {
            this.#isRetired = false;
            this.#retiredUntil = 0;
        }

        return this.#isRetired;
    }

    /** What to store at `now`, in one write: a lapse and the retired flag it sets go together; `undefined` when nothing is left to keep. */
    public state(now: number): SessionState | undefined {
        const holds = this.entries(now);
        const drainUntil = this.#drainUntil > now ? this.#drainUntil : undefined;
        const cancelled = this.#cancelledAt(now);
        const isRetired = this.#retiredAt(now);

        if (drainUntil === undefined && !isRetired && holds.length === 0 && cancelled.length === 0) {
            return undefined;
        }

        return {
            ...(cancelled.length > 0 && { cancelled }),
            holds,
            ...(drainUntil !== undefined && { drainUntil }),
            ...(isRetired && { retired: true as const, retiredUntil: this.#retiredUntil }),
        };
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
     * The same token asking again (its first answer lost) renews the hold it has. A token already released is refused,
     * and holds nothing: its take arrived after the release its caller sent when the take went unanswered.
     */
    public take(token: string, kind: HoldKind, leaseMs: number, now: number): HoldAnswer {
        // First: a lapse it drops may retire the session.
        this.#dropLapsed(now);

        if (this.#retiredAt(now)) {
            return { held: false, retired: true };
        }

        if (this.#cancelledAt(now).some(([cancelled]) => cancelled === token)) {
            return { held: false };
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

    /**
     * A hold in force runs on for `leaseMs` from `now`, or keeps the later end it already has: a renewal that arrives
     * late, after a longer one, never shortens the hold. A lapsed one is not brought back.
     */
    public renew(token: string, leaseMs: number, now: number, isArming = false): HoldAnswer {
        const hold = new Map(this.entries(now)).get(token);

        if (!hold) {
            return { held: false };
        }

        this.#holds.set(token, {
            ...hold,
            ...(isArming && { armed: true as const }),
            expiresAt: Math.max(hold.expiresAt, now + Math.min(leaseMs, MAX_LEASE_MS)),
        });

        return { held: true };
    }

    /**
     * Ends the hold; `held` says whether it was still in force. The token is kept as released for `MAX_LEASE_MS`, the
     * longest a hold of it could run, so a take of it that the release overtook holds nothing.
     */
    public release(token: string, now: number): HoldAnswer {
        const held = this.entries(now).some(([candidate]) => candidate === token);

        this.#holds.delete(token);
        this.#cancelled.set(token, now + MAX_LEASE_MS);

        return { held };
    }
}

/** The holds of a stored state. */
export const holdsOf = (state: SessionState | undefined): SessionHolds =>
    new SessionHolds(state?.holds ?? [], state?.retired === true, state?.drainUntil ?? 0, state?.cancelled ?? [], state?.retiredUntil);

/** When a stored state next changes on its own (a hold lapses, a drain, a record or the retired flag runs out). */
export const nextChangeOf = (state: SessionState): number =>
    Math.min(
        ...state.holds.map(([, hold]) => hold.expiresAt),
        ...(state.cancelled ?? []).map(([, until]) => until),
        state.drainUntil ?? Infinity,
        state.retiredUntil ?? Infinity,
    );
