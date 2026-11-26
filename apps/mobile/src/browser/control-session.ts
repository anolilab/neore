/**
 * The phone's hold on the thread browser's control lease, outside React: take it, renew it while the screen is open,
 * and give it back when the screen goes. Nothing is queued: a renewal or hand back that cannot go out now is dropped,
 * and the server ends a lease nobody renews after one lease interval.
 */
import type { BrowserLease } from "@neore/client-runtime";
import { CONTROL_KEEP_INTERVAL_MS, CONTROL_LEASE_MS, controlRefusalText, leaseHolder } from "@neore/client-runtime";

import { withCatch } from "@/lib/guarded";
import { settleQuietly } from "@/offline/quietly";

import type { NavigateAnswer, TakeAnswer } from "./browser-api";

export interface ControlApi {
    handBack: (claim: string, reason: "handed_back" | "left") => Promise<boolean>;
    keep: (claim: string) => Promise<{ until: number } | null>;
    navigate: (claim: string, url: string) => Promise<NavigateAnswer>;
    take: (renews?: string) => Promise<TakeAnswer>;
}

export type ControlState
    = | { claim: string; claimId: string; kind: "holding"; until: number }
        | { kind: "idle"; message?: string }
        | { kind: "taking" };

export const CONTROL_ENDED = "Your control of the browser ended. The agent may use it again.";
export const CONTROL_ELSEWHERE = "You took control in another window, so this phone no longer has it.";
export const CONTROL_OFFLINE = "You are offline, so this phone gave up control. The agent may use the browser again within two minutes.";
export const CONTROL_FAILED = "Taking control did not work. Try again.";

export interface ControlSession {
    navigate: (url: string) => Promise<string | undefined>;
    /** The live status's lease at the server's clock `now`: the phone stops when it is no longer this claim's. */
    noteLease: (lease: BrowserLease | undefined, now: number) => void;
    /** Hand back: `handed_back` from the button, `left` when the screen goes. */
    release: (reason: "handed_back" | "left") => void;
    state: () => ControlState;
    /** The phone went offline: stop at once, and let the server end the lease after its interval. */
    suspend: () => void;
    take: () => Promise<void>;
}

/**
 * The claim this phone last held, per account and thread, kept across screens: a screen opened again takes back its
 * own lease (`renews`), which a lease left after going offline or a lost hand back still is, instead of being refused
 * it as another window's.
 */
const heldClaims = new Map<string, string>();

export const rememberedClaim = (key: string): string | undefined => heldClaims.get(key);

/** The phone's own name for its view of a thread's browser, per account and thread, sent with every take. */
const viewNames = new Map<string, string>();

export const viewNameFor = (key: string, create: () => string): string => {
    const known = viewNames.get(key);

    if (known !== undefined) {
        return known;
    }

    const name = create();

    viewNames.set(key, name);

    return name;
};

export const rememberClaim = (key: string, claim: string): void => {
    heldClaims.set(key, claim);
};

/** Forgets `claim` once it was handed back, unless a newer claim was remembered since. */
export const forgetClaim = (key: string, claim: string): void => {
    if (heldClaims.get(key) === claim) {
        heldClaims.delete(key);
    }
};

export const createControlSession = ({
    api,
    deviceNow = Date.now,
    every = (ms, run) => {
        const timer = setInterval(run, ms);

        return () => clearInterval(timer);
    },
    lastClaim: initialClaim,
    onChange,
    onClaim = () => {},
    onReleased = () => {},
}: {
    api: ControlApi;
    /** This device's clock, for when the lease ends unless renewed. */
    deviceNow?: () => number;
    every?: (ms: number, run: () => void) => () => void;
    /** The claim this phone last held on the thread, kept across screens: see {@link rememberClaim}. */
    lastClaim?: string;
    onChange: (state: ControlState) => void;
    /** A claim taken. */
    onClaim?: (claim: string) => void;
    /** A claim handed back: only that claim is forgotten, never a newer one taken since. */
    onReleased?: (claim: string) => void;
}): ControlSession => {
    let state: ControlState = { kind: "idle" };
    let stopKeeping: (() => void) | undefined;
    /** The last claim this phone held, so taking control again is its own renewal and never `held` from itself. */
    let lastClaim = initialClaim;
    /** Counts takes: an answer to one that was left (released, suspended, or followed by another) holds nothing. */
    let attempt = 0;

    /**
     * When the lease ends on this device's clock unless a renewal lands: a lease that runs out writes nothing, so no
     * status comes to say so while renewals keep failing.
     */
    let endsAt = 0;

    const set = (next: ControlState): void => {
        state = next;
        onChange(next);
    };
    const stop = (message?: string): void => {
        stopKeeping?.();
        stopKeeping = undefined;
        set(message === undefined ? { kind: "idle" } : { kind: "idle", message });
    };
    const keep = async (claim: string): Promise<void> => {
        const answer = await withCatch(async () => await api.keep(claim), () => "failed" as const);

        // A renewal that did not go out changes nothing: the next one tries again, or the lease ends on the server.
        if (answer === "failed" || state.kind !== "holding" || state.claim !== claim) {
            return;
        }

        if (answer === null) {
            stop(CONTROL_ENDED);

            return;
        }

        endsAt = deviceNow() + CONTROL_LEASE_MS;
        set({ ...state, until: answer.until });
    };

    return {
        navigate: async (url) => {
            if (state.kind !== "holding") {
                return CONTROL_ENDED;
            }

            const { claim } = state;
            const answer = await withCatch(async () => await api.navigate(claim, url), () => undefined);

            if (answer === undefined) {
                return "The page could not be opened. Try again.";
            }

            if (answer.status === "refused") {
                return answer.error;
            }

            return answer.status === "closed" ? "The browser closed while the page loaded." : undefined;
        },
        noteLease: (lease, now) => {
            // Only a status from after the lease was written can name this claim; an older one says nothing about it.
            if (state.kind !== "holding" || now < state.until - CONTROL_LEASE_MS) {
                return;
            }

            const holder = leaseHolder(lease, state.claimId, now);

            if (holder !== "mine") {
                stop(holder === "other-view" ? CONTROL_ELSEWHERE : CONTROL_ENDED);
            }
        },
        release: (reason) => {
            if (state.kind === "taking") {
                attempt += 1;
                stop();

                return;
            }

            if (state.kind !== "holding") {
                return;
            }

            const { claim } = state;

            stop();
            settleQuietly(async () => {
                if (await api.handBack(claim, reason)) {
                    onReleased(claim);
                }
            });
        },
        state: () => state,
        suspend: () => {
            if (state.kind === "taking") {
                attempt += 1;
            }

            if (state.kind !== "idle") {
                stop(CONTROL_OFFLINE);
            }
        },
        take: async () => {
            if (state.kind !== "idle") {
                return;
            }

            attempt += 1;

            const mine = attempt;

            set({ kind: "taking" });

            const answer = await withCatch(async () => await api.take(lastClaim), () => undefined);

            if (mine !== attempt) {
                // Suspended or left meanwhile: a claim that came back anyway is given back at once.
                // Remembered first: a hand back that cannot go out (offline) leaves a lease the next take must name.
                if (answer?.status === "ok") {
                    const { claim } = answer;

                    lastClaim = claim;
                    onClaim(claim);
                    settleQuietly(async () => {
                        if (await api.handBack(claim, "left")) {
                            onReleased(claim);
                        }
                    });
                }

                return;
            }

            if (answer === undefined) {
                set({ kind: "idle", message: CONTROL_FAILED });

                return;
            }

            if (answer.status !== "ok") {
                set({ kind: "idle", message: controlRefusalText(answer.status) });

                return;
            }

            lastClaim = answer.claim;
            onClaim(answer.claim);
            set({ claim: answer.claim, claimId: answer.claimId, kind: "holding", until: answer.until });
            endsAt = deviceNow() + CONTROL_LEASE_MS;
            stopKeeping = every(CONTROL_KEEP_INTERVAL_MS, () => {
                if (state.kind !== "holding") {
                    return;
                }

                // No renewal landed for a whole lease: it has ended on the server, so the phone stops showing it.
                if (deviceNow() >= endsAt) {
                    stop(CONTROL_ENDED);

                    return;
                }

                settleQuietly(keep(state.claim));
            });
        },
    };
};
