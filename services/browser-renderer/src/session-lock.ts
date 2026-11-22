/**
 * The hold on a browser session every isolate of the Worker sees: one Durable Object per Browser Rendering session id.
 * Several connections can share one session, so a call another isolate handles reaches the same page; a `/login` holds
 * its session alone (`exclusive`), and an `/action` holds it beside other actions (`shared`). Every hold has a lease, so
 * an isolate that dies cannot keep a session held, and is renewed while its call runs.
 *
 * A plain class with `fetch`, not one extending `DurableObject`: `cloudflare:workers` does not load outside the runtime,
 * where the unit tests import the Worker.
 */

import type { HoldAnswer, HoldKind, HoldRequest, SessionState } from "./session-holds";
import { holdsOf } from "./session-holds";

export type { HoldKind } from "./session-holds";

/**
 * The session's whole state, holds and retired flag together, in one key: one write stores both, so a crash between two
 * writes cannot drop a lapsed sign-in's hold without keeping the session retired. The flag, once set, is kept for good.
 */
const STATE_KEY = "state";

const isHoldRequest = (value: unknown): value is HoldRequest => {
    const { kind, leaseMs, op, token } = (value ?? {}) as { kind?: unknown; leaseMs?: unknown; op?: unknown; token?: unknown };

    if (typeof token !== "string" || token === "") {
        return false;
    }

    if (op === "release") {
        return true;
    }

    const isLease = typeof leaseMs === "number" && Number.isFinite(leaseMs) && leaseMs > 0;

    return op === "renew" ? isLease : op === "take" && isLease && (kind === "exclusive" || kind === "shared");
};

/** The Durable Object: one per session id (`idFromName`). Its holds are stored, so an eviction between two calls keeps them. */
export class SessionLock {
    readonly #state: Pick<DurableObjectState, "storage">;

    public constructor(state: Pick<DurableObjectState, "storage">) {
        this.#state = state;
    }

    public async fetch(request: Request): Promise<Response> {
        const asked: unknown = await request.json().catch(() => null);

        if (!isHoldRequest(asked)) {
            return Response.json({ error: "Invalid hold request" }, { status: 400 });
        }

        // Read, changed and written with no other I/O between: the object's input gate keeps another call out meanwhile.
        const holds = holdsOf(await this.#state.storage.get<SessionState>(STATE_KEY));
        // Taken once the read is done: a Worker's clock moves only across I/O, so a time from before the read could judge
        // an exclusive hold that lapsed during it as still in force, and release it without retiring the session.
        const now = Date.now();
        let answer: HoldAnswer;

        switch (asked.op) {
            case "release": {
                answer = holds.release(asked.token, now);
                break;
            }

            case "renew": {
                answer = holds.renew(asked.token, asked.leaseMs, now);
                break;
            }

            default: {
                answer = holds.take(asked.token, asked.kind, asked.leaseMs, now);
            }
        }

        const left = holds.state(now);

        await (left === undefined ? this.#state.storage.delete(STATE_KEY) : this.#state.storage.put(STATE_KEY, left));

        return Response.json(answer);
    }
}

// ─── The Worker's side ──────────────────────────────────────────────────────────

/** How long one call to a session's lock may take: past it, the lock counts as out of reach. */
export const LOCK_CALL_MS = 3000;

/** A hold's lease, renewed every `RENEW_EVERY_MS` while its call runs. */
export const LEASE_MS = 30_000;

const RENEW_EVERY_MS = 5000;

/**
 * A hold not confirmed renewed by this long before its lease could lapse counts as lost: what its call guards is given
 * up then (a `/login` closes its browser), while no other call can have taken the session yet. It covers the renewal's
 * own time and the clocks of two machines.
 */
const LOST_MARGIN_MS = 10_000;

/** `promise`, or `fallback` once `ms` passed. */
const within = async <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<T>((resolve) => {
                timer = setTimeout(resolve, Math.max(0, ms), fallback);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

/** What a call holds a session by. */
export interface SessionHold {
    /** Whether it may have lapsed: it is then no proof that no other call used the session. */
    isLost: () => boolean;
    /** Stops renewing it and keeps it for `ms` from now (a session whose close is not confirmed); `release` may still end it sooner. */
    linger: (ms: number) => Promise<void>;
    /** Has `onLost` run, once, as soon as the hold may lapse. */
    onLost: (onLost: () => void) => void;
    /** Ends it, within `ms`: whether it was in force all along, up to the release, as the lock answers it; one it does not answer in time is judged by the last lease it confirmed. */
    release: (ms?: number) => Promise<boolean>;

    /**
     * Sends the release again until the lock answers one, while the last lease it confirmed runs: a sign-in's hold that
     * lapses retires its session, so a release whose answer was lost must not leave it to lapse. Ends at once when the
     * lock already answered one.
     */
    settle: () => Promise<void>;
}

/** The wait before a release is sent again, doubled each time. */
const RESEND_FIRST_MS = 250;

/** Asks the lock of `sessionId`; `null` when it does not answer within `LOCK_CALL_MS`. */
const ask = async (namespace: DurableObjectNamespace, sessionId: string, request: HoldRequest, ms = LOCK_CALL_MS): Promise<HoldAnswer | null> => {
    const asking = (async () => {
        const response = await namespace.get(namespace.idFromName(sessionId)).fetch("https://session-lock/", {
            body: JSON.stringify(request),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        return response.ok ? ((await response.json()) as HoldAnswer) : null;
    })().catch(() => null);

    return within(asking, ms, null);
};

/**
 * Takes a `kind` hold on `sessionId` and renews it until it is released: the hold, `busy` with the kind of hold that
 * refused it, `retired` for a session refused for good, or `unreachable` when the lock did not answer in time (a take
 * whose answer was lost is released too).
 */
export const holdSession = async (
    namespace: DurableObjectNamespace,
    sessionId: string,
    kind: HoldKind,
    {
        keep,
        now = Date.now,
        takeMs = LOCK_CALL_MS,
    }: {
        /** Given the release of a take that did not answer, to run on past the caller's answer (`waitUntil`). */
        keep?: (work: Promise<unknown>) => void;
        now?: () => number;
        /** How long the take may wait for the lock, at most `LOCK_CALL_MS`: a caller's deadline may leave it less. */
        takeMs?: number;
    } = {},
): Promise<"retired" | "unreachable" | SessionHold | { busy: HoldKind }> => {
    const token = crypto.randomUUID();
    const sentAt = now();
    const taken = takeMs > 0 ? await ask(namespace, sessionId, { kind, leaseMs: LEASE_MS, op: "take", token }, Math.min(takeMs, LOCK_CALL_MS)) : null;

    if (!taken) {
        // Never rejects; not awaited, so the refusal is not held up by a lock that does not answer. The lock keeps the
        // token as released, so the take, should it arrive after this, holds nothing. Kept past the answer: a release
        // cut off with the request would leave a late take to lapse, and an exclusive one to retire the session.
        const releasing = ask(namespace, sessionId, { op: "release", token }).catch(() => undefined);

        keep?.(releasing);

        return "unreachable";
    }

    if (taken.retired) {
        return "retired";
    }

    if (!taken.held) {
        return { busy: taken.busy ?? "exclusive" };
    }

    // The lock set the lease on its own clock, after this was sent: it runs at least this long.
    let confirmedUntil = sentAt + LEASE_MS;
    let isLost = false;
    let isRenewing = false;
    let isReleased = false;
    const lostListeners: (() => void)[] = [];
    const lose = (): void => {
        if (isLost) {
            return;
        }

        isLost = true;
        clearInterval(timer);

        const listeners = [...lostListeners];

        lostListeners.length = 0;

        for (const listener of listeners) {
            listener();
        }
    };
    const timer = setInterval(() => {
        if (now() >= confirmedUntil - LOST_MARGIN_MS) {
            lose();

            return;
        }

        if (isRenewing) {
            return;
        }

        isRenewing = true;

        const renewedAt = now();

        ask(namespace, sessionId, { leaseMs: LEASE_MS, op: "renew", token })
            .then((answer) => {
                if (answer?.held === false) {
                    lose();
                } else if (answer?.held) {
                    // The lock keeps the later end of a hold (`SessionHolds.renew`): so does this, so a periodic renewal that
                    // answers after a linger's longer lease never pulls the release's retries back short of the hold.
                    confirmedUntil = Math.max(confirmedUntil, renewedAt + LEASE_MS);
                }

                return answer;
            })
            .finally(() => {
                isRenewing = false;
            })
            .catch(() => undefined);
    }, RENEW_EVERY_MS);

    return {
        isLost: () => isLost,
        linger: async (ms) => {
            clearInterval(timer);

            const askedAt = now();
            const answer = await ask(namespace, sessionId, { leaseMs: ms, op: "renew", token });

            if (answer?.held) {
                confirmedUntil = Math.max(confirmedUntil, askedAt + ms);
            }
        },
        onLost: (listener) => {
            if (isLost) {
                listener();
            } else {
                lostListeners.push(listener);
            }
        },
        release: async (ms = LOCK_CALL_MS) => {
            clearInterval(timer);

            const wasLost = isLost;
            // Read before the release is sent: while it holds, no other call can have taken the session up to now.
            const wasIntact = !wasLost && now() < confirmedUntil - LOST_MARGIN_MS;
            const released = await ask(namespace, sessionId, { op: "release", token }, ms);

            isReleased ||= released !== null;

            // No answer in time: the last confirmed lease decides. A lock that answers decides by its own word.
            return released === null ? wasIntact : !wasLost && released.held;
        },
        settle: async () => {
            clearInterval(timer);

            let wait = RESEND_FIRST_MS;

            while (!isReleased && now() < confirmedUntil) {
                // A release the lock already took answers again: it only says the hold is gone.
                isReleased = (await ask(namespace, sessionId, { op: "release", token }, Math.min(LOCK_CALL_MS, confirmedUntil - now()))) !== null;

                if (!isReleased) {
                    const pause = Math.max(0, Math.min(wait, confirmedUntil - now()));

                    await new Promise((resolve) => {
                        setTimeout(resolve, pause);
                    });
                    wait *= 2;
                }
            }
        },
    };
};
