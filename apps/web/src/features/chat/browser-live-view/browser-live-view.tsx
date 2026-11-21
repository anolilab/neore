/**
 * BrowserLiveView - while the agent has a cloud browser running for this thread, a card above the composer names the
 * page it is on and lets the person watch it live, read-only. Someone who may write in the thread can also take control:
 * their input then goes to the browser and the agent's browser actions wait, until they hand it back, leave the view,
 * or give no input for a while. The view URL is a short-lived credential: it is asked for only when the person opens
 * the view, kept in this component's state, and dropped when the view closes. The card leaves once the browser is gone
 * (closed, or idle past the provider's reap).
 */
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Globe, Loader2 } from "lucide-react";
import type { ChangeEvent, FC, FormEvent } from "react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { useImpersonating } from "@/features/admin/hooks/use-is-impersonating";
import { useAction, useCRPC } from "@/lib/lunora/crpc";

/**
 * How long a new view URL may take to connect (the backend's `LIVE_VIEW_CONNECT_DEADLINE_MS`). The answer's `connectBy`
 * is on the server's clock, so the card measures the same window on its own, from the moment it asked: never later
 * than the provider's deadline, whatever the two clocks say.
 */
const CONNECT_WINDOW_MS = 60_000;

/** The backend's `CONTROL_WARNING_MS`: how long before an idle hand back the card warns and offers to keep control. */
const CONTROL_WARNING_MS = 30_000;

/** Input renews control at most this often; the idle timeout (two minutes) is far longer. */
const RENEW_EVERY_MS = 30_000;

/**
 * How long past the lease's end, as the card last heard it (or past a page load's answer, if later), a renewal or status
 * read still out may take to answer before the card ends control anyway. A page load still out has no such limit: the
 * server holds the lease while it loads.
 */
const DECIDE_GRACE_MS = 15_000;

/** How long the card says a page is still loading: the load that timed out may hold the browser a little longer. */
const STILL_LOADING_MS = 15_000;

/** `navigateInControl`'s refusals the card tells apart; any other one is shown as it came. */
const STILL_LOADING = "The page you opened is still loading.";
const NOT_IN_CONTROL = "You do not have control of the browser.";

/** `size="sm"` is 24 px tall: on any touch pointer (also a touchscreen laptop driven by a trackpad) the card's buttons grow to 44 px. */
const TOUCH_TARGET = "any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11";

/** `watch`: the read-only view; `control`: the interactive one, while the person has control. */
type Mode = "control" | "watch";

/**
 * `opening` and `open` carry the attempt they belong to (only that attempt's answer may fill the view), the browser it
 * was asked for (a replaced browser asks again), and whether it is already the one automatic renewal of an expired URL.
 * `stale`: the answer came after its connect deadline (a sleeping tab), so its URL is never framed.
 */
type View =
    | { kind: "closed" }
    | { kind: "failed"; reason: FailureReason }
    | { attempt: number; browserId: string; kind: "opening"; mode: Mode; renewed: boolean }
    | { attempt: number; browserId: string; connectBy: number; connected: boolean; kind: "open"; mode: Mode; renewed: boolean; stale: boolean; url: string }
    /** Control was not given: an agent action still holds the browser (`busy`), or someone else has it (`taken`). */
    | { kind: "refused"; reason: "busy" | "taken" }
    | { kind: "unavailable" };

/** Why a request failed: the hourly limit is not fixed by asking again at once, and a refusal (`forbidden`) never is. */
type FailureReason = "forbidden" | "other" | "rate-limited";

const errorCodeOf = (error: unknown): unknown => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return code ?? data?.code;
};

/**
 * A failure the server gave no verdict on, worth sending again: no code (the request never got through), or a 5xx-class
 * status, which is also what Lunora gives an unreadable gateway answer (`INTERNAL`) and an offline write it refused to
 * queue (`OFFLINE_NOT_QUEUED`). A refusal (4xx) never changes by asking again.
 */
const isTransient = (error: unknown): boolean => {
    const { status } = (typeof error === "object" && error !== null ? error : {}) as { status?: unknown };

    return errorCodeOf(error) === undefined || (typeof status === "number" && status >= 500);
};

const failureReasonOf = (error: unknown): FailureReason => {
    const code = errorCodeOf(error);

    if (code === "FORBIDDEN") {
        return "forbidden";
    }

    return code === "TOO_MANY_REQUESTS" ? "rate-limited" : "other";
};

const CLOSED: View = { kind: "closed" };

/** The longest delay a browser timer keeps (2^31 − 1 ms, about 24.8 days); a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** True once `until` has passed; re-renders at that moment, so the card leaves without a new server answer. */
const usePassed = (until: number | undefined): boolean => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (until === undefined || until <= now) {
            return undefined;
        }

        // From the real time, not the last render's: a later `until` would otherwise fire late by the time between. A
        // far-off `until` waits in steps of the longest delay a timer keeps; each step re-arms for what is left.
        const delay = Math.min(Math.max(0, until - Date.now()) + 50, MAX_TIMER_DELAY_MS);
        const timer = setTimeout(() => setNow(Date.now()), delay);

        return () => clearTimeout(timer);
    }, [until, now]);

    return until !== undefined && until <= now;
};

type Asked = { attempt: number; browserId: string; connectBy: number; mode: Mode; renewed: boolean };

type NavigationAnswer = { error: string; status: "refused" } | { status: "closed" } | { status: "ok"; url?: string };

type Answer =
    | { status: "busy" | "controlled" | "ended" | "taken" | "unavailable" }
    | { claim?: string; connectBy: number; status: "ok"; until?: number; url: string };

/**
 * The claim this tab holds, on the server's clock. Its lease was written before `writtenBy` (when `takeControl`
 * answered), so only a status read from then on can have seen it: an older one says nothing about this claim. `until`:
 * when the lease ends unrenewed, as `takeControl` answered it, moved on by every `keepControl` that answered for it.
 * `confirmedUntil`: the end a status read made at the lease's end named, already on this device's clock.
 */
type Held = { claim: string; confirmedUntil?: number; until: number; writtenBy: number };

/**
 * What the view becomes after the person asked for it. `ended` reads as unavailable too: the browser may be gone before the
 * status read drops the card, or the provider may not see it at all, and either way the click must not do nothing.
 */
const viewFrom = (asked: Asked, result: Answer, now: number): View => {
    if (result.status === "ok") {
        return { ...asked, connected: false, kind: "open", stale: now >= asked.connectBy, url: result.url };
    }

    if (result.status === "busy") {
        return { kind: "refused", reason: "busy" };
    }

    if (result.status === "taken" || result.status === "controlled") {
        return { kind: "refused", reason: "taken" };
    }

    return { kind: "unavailable" };
};

/** The answer to `attempt`, applied only while the view still waits for that attempt. */
const answerFor =
    (attempt: number, next: View) =>
    (current: View): View =>
        current.kind === "opening" && current.attempt === attempt ? next : current;

/**
 * The frame of `attempt` loaded. Before its connect deadline that is taken as the view connecting, and the deadline no
 * longer matters. After it (a background tab holds the load back), the provider has refused the URL, and the frame is
 * its error page. The cross-origin page cannot be read, and browsers fire `load`, not `error`, for a failed page, so the
 * deadline is the only signal. Such a frame is no longer shown and takes the same single renewal as a URL that never
 * loaded.
 */
const loadedFor =
    (attempt: number, now: number) =>
    (current: View): View => {
        if (current.kind !== "open" || current.attempt !== attempt) {
            return current;
        }

        return now < current.connectBy ? { ...current, connected: true } : { ...current, stale: true };
    };

/** The view (or the request) is for a browser the thread no longer runs. */
const isForOtherBrowser = (view: View, browserId: string): boolean => (view.kind === "open" || view.kind === "opening") && view.browserId !== browserId;

const isControlView = (view: View): boolean => (view.kind === "open" || view.kind === "opening") && view.mode === "control";

/** How a request settled, without a rejection handler: the component itself keeps no `try`. */
type Settled<T> = { error: unknown; ok: false } | { ok: true; value: T };

const settle = async <T,>(request: Promise<T>): Promise<Settled<T>> => {
    try {
        return { ok: true, value: await request };
    } catch (error: unknown) {
        return { error, ok: false };
    }
};

type StatusRead = { canControl: boolean; control?: { byYou: boolean; until: number }; now: number } | null;

/** A person's lease as the status names it, on the server's clock; `byYou`: the caller holds it (from any of their tabs). */
type Control = { byYou: boolean; until: number };

type CardProps = {
    browserId: string;
    canControl: boolean;
    control: Control | undefined;
    currentUrl: string | undefined;

    /**
     * Until when (on this device's clock) the lease this tab holds keeps the browser alive, `Infinity` while the card
     * still waits on an answer that decides it, or `undefined` once it holds none: the status's `idleUntil` moves only
     * with a push, so the card must not be dropped (and its lease handed back) at an older end.
     */
    onHold: (until: number | undefined) => void;
    /** The status's clock: the server's time at the answer, and how far the server's clock is ahead of this device's. */
    statusClock: { now: number; skew: number };
    threadId: Id<"threads">;
};

/**
 * The card for one thread's browser. It unmounts when the browser stops, so its view and the view's credential go with it.
 *
 * Control is this tab's while it holds the `claim` of its last successful `takeControl` and the server says the caller
 * has a lease. The provider cannot revoke a connected view, so the card closes the interactive frame itself whenever
 * that claim stops counting: `keepControl` answers `null`, the person hands back, the lease ends or moves to another
 * browser, the person may no longer write, or a new `takeControl` answers that control is not theirs.
 */
const BrowserCard: FC<CardProps> = ({ browserId, canControl, control, currentUrl, onHold, statusClock, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const viewId = useId();
    const addressErrorId = useId();
    const impersonating = useImpersonating();
    const openLiveView = useAction(api.browser.live_view.openLiveView);
    const takeControl = useAction(api.browser.live_view.takeControl);
    const navigateInControl = useAction(api.browser.live_view.navigateInControl);
    // A one-off read, not the live one: a live key's refetch answers from the subscription's last push.
    const statusRead = crpc.browser.live_view.getThreadBrowser.queryOptions({ threadId }, { live: false });
    const readStatus = async (): Promise<StatusRead> =>
        typeof statusRead.queryFn === "function"
            ? await statusRead.queryFn({ queryKey: statusRead.queryKey })
            : await Promise.reject(new Error("No status read."));
    const keepControl = useMutation(crpc.browser.live_view.keepControl.mutationOptions());
    // A hand back that does not arrive leaves the agent waiting: it is sent again, with backoff, before the card gives up.
    // Only a request the server gave no verdict on is sent again.
    const resend = { networkMode: "always" as const, retry: (failures: number, error: unknown) => failures < 3 && isTransient(error) };
    // The person's own: refused offline, never queued for the reconnect (`onlineOnly`), so the card can say it did not
    // go through, and the person keeps control meanwhile.
    const handBack = useMutation({ ...crpc.browser.live_view.handBack.mutationOptions(undefined, { onlineOnly: true }), ...resend });
    // A view that went (or a lease nobody looks at): no one waits for the answer, so offline it is queued and ends the
    // lease on the reconnect, if its idle timeout has not already.
    const leaveLease = useMutation({ ...crpc.browser.live_view.handBack.mutationOptions(), ...resend });
    const [view, setView] = useState<View>(CLOSED);
    // State to render from, and a ref for answers that come back after the render that asked.
    const [lease, setLeaseState] = useState<Held | undefined>(undefined);
    const claimRef = useRef<string | undefined>(undefined);
    const claim = lease?.claim;
    /** The claim whose hand back the person asked for: it stays this tab's (and the view interactive) until it lands. */
    const [returning, setReturningState] = useState<string | undefined>(undefined);
    const returningRef = useRef<string | undefined>(undefined);
    /** The control request whose answer the card still wants; a lease answered to any other one is handed back at once. */
    const wantedControl = useRef<number | undefined>(undefined);

    /**
     * The page the person opened while in control: the shared status never names it (only the owner's history does). It
     * is shown until the status names another page (the agent moved on) or the browser changes.
     */
    const [opened, setOpened] = useState<{ browserId: string; over: string | undefined; url: string } | undefined>(undefined);
    const openedUrl = opened?.browserId === browserId && opened.over === currentUrl ? opened.url : undefined;
    /** Names what the notice is about: a hand back that answers after the person moved on says nothing. */
    const noticeTurn = useRef(0);
    const [notice, setNotice] = useState<string | undefined>(undefined);
    const [address, setAddress] = useState("");
    const [addressError, setAddressError] = useState<string | undefined>(undefined);
    const [navigating, setNavigating] = useState(false);
    const [stillLoading, setStillLoading] = useState(0);
    const attempts = useRef(0);
    /** Names the page being opened: an answer for an older one (control ended or moved on since) changes nothing. */
    const navigations = useRef(0);
    const lastRenewal = useRef(0);
    /** `keepControl` requests still out: each may have moved the lease on, so its end waits for their answers. */
    const [renewalsOut, setRenewalsOutState] = useState(0);
    const renewalsOutRef = useRef(0);
    /** A status read is checking, at the lease's end as the card heard it, whether the server still holds it. */
    const [checking, setChecking] = useState(false);
    /** When the last page load answered: the renewal it sends gets its own grace, though the lease's end passed during it. */
    const [loadedAt, setLoadedAt] = useState(0);
    const mounted = useRef(false);
    const frame = useRef<HTMLIFrameElement>(null);
    const leaving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const expanded = view.kind !== "closed";
    // Whether this tab's lease is still live, judged on the server's clock and moved onto this device's once per status
    // answer (`statusClock.skew`). Only a status read that can have seen the lease speaks for it: an older one may name
    // another person's lease, or this person's last one with its earlier end. Such a read that says the lease is not the
    // caller's ends it. Otherwise it lasts until the latest end anything has told the card of: the one `takeControl`
    // answered (so a status push that never comes does not hold the view open past the server's lease), a `keepControl`
    // answer, or a read that saw the lease. That end passing does not end control by itself: a renewal or a page load
    // still out may have moved the lease on, so the card waits for it, and then reads the status once before it ends it.
    const seen = lease !== undefined && statusClock.now >= lease.writtenBy;
    const refused = seen && (!canControl || control?.byYou !== true);
    const statusUntil = seen && control?.byYou === true ? control.until : 0;
    const leaseUntil = lease === undefined ? undefined : Math.max(lease.until - statusClock.skew, statusUntil - statusClock.skew, lease.confirmedUntil ?? 0);
    const leaseEnded = usePassed(leaseUntil);
    const graceOver = usePassed(leaseUntil === undefined ? undefined : Math.max(leaseUntil, loadedAt) + DECIDE_GRACE_MS);
    const youControl = lease !== undefined && !refused;
    // Another person's lease ends on the server's clock too; while this tab's claim is unseen, the status may be older.
    const otherEnded = usePassed(control?.byYou === false ? control.until - statusClock.skew : undefined);
    const controlledByOther = control?.byYou === false && !otherEnded && (lease === undefined || seen);
    const handingBack = returning !== undefined && returning === claim;
    // A renewal of the view is being minted under a new claim: a hand back now would name the claim it replaces, and the
    // lease would go on under the new one. Hand back waits for its answer (seconds).
    const renewingControl = view.kind === "opening" && view.mode === "control" && claim !== undefined;
    const warn = usePassed(youControl && leaseUntil !== undefined ? leaseUntil - CONTROL_WARNING_MS : undefined);
    const showStillLoading = !usePassed(stillLoading === 0 ? undefined : stillLoading) && stillLoading !== 0;
    const forbiddenText = impersonating ? t`Taking control is not available while impersonating.` : t`You may not take control of this browser.`;

    const setReturning = (next: string | undefined): void => {
        returningRef.current = next;
        setReturningState(next);
    };

    const setClaim = (next: Held | undefined): void => {
        // A page still loading under a lease that ended answers into nothing.
        if (next === undefined) {
            navigations.current += 1;
            setNavigating(false);
        }

        claimRef.current = next?.claim;
        setLeaseState(next);
        setReturning(undefined);
    };

    /**
     * The tab is leaving the lease it holds, if any (its view is gone or going): the claim goes at once, and the server
     * ends only the lease that claim names. A hand back that does not arrive leaves the lease to its idle timeout.
     */
    const giveBack = (): void => {
        const holding = claimRef.current;

        if (holding === undefined) {
            return;
        }

        setClaim(undefined);
        leaveLease.mutate({ claim: holding, reason: "left", threadId });
    };

    /**
     * This tab's control is over: the interactive frame goes, as the provider cannot revoke a connected view, and a
     * control request still out is no longer wanted (its lease is handed back when it answers).
     */
    const endControl = (message: string): void => {
        // A hand back still out says nothing over this.
        noticeTurn.current += 1;
        wantedControl.current = undefined;
        setClaim(undefined);
        setView((current) => (isControlView(current) ? CLOSED : current));
        setNotice(message);
    };

    /** The server refused this tab's control (an admin acting as the person): the view closes and the lease goes back. */
    const controlForbidden = (): void => {
        giveBack();
        endControl(forbiddenText);
    };

    /** `takeControl` answered: a renewal switches to the new claim only now; any other answer means control is not ours. */
    const tookControl = (attempt: number, result: Answer): void => {
        const current = mounted.current && attempts.current === attempt && wantedControl.current === attempt;

        if (result.status === "ok" && result.claim !== undefined && result.until !== undefined) {
            if (current) {
                setClaim({ claim: result.claim, until: result.until, writtenBy: result.connectBy - CONNECT_WINDOW_MS });
            } else {
                // Hidden (or gone) while it was asked for: the lease nobody looks at goes back at once.
                leaveLease.mutate({ claim: result.claim, reason: "left", threadId });
            }

            return;
        }

        // Also a renewal's: its URL never connected, so the lease it renews serves no view any more.
        if (current) {
            giveBack();
        }
    };

    const ask = (renewed: boolean, mode: Mode = "watch"): void => {
        attempts.current += 1;
        const asked: Asked = { attempt: attempts.current, browserId, connectBy: Date.now() + CONNECT_WINDOW_MS, mode, renewed };
        const answered = (result: Answer): ((current: View) => View) => answerFor(asked.attempt, viewFrom(asked, result, Date.now()));

        wantedControl.current = mode === "control" ? asked.attempt : undefined;
        setView({ attempt: asked.attempt, browserId, kind: "opening", mode, renewed });
        // Hidden again, or hidden and opened again, while it was asked for: that older answer (and its credential) is
        // dropped, whatever order the answers arrive in.
        void (mode === "control" ? takeControl({ threadId }) : openLiveView({ threadId }))
            .then((result: Answer) => {
                if (mode === "control") {
                    tookControl(asked.attempt, result);
                }

                return answered(result);
            })
            .then(setView)
            .catch((error: unknown) => setView(answerFor(asked.attempt, { kind: "failed", reason: failureReasonOf(error) })));
    };

    /** The hand back the person asked for landed (or the lease ended while it was out): the view turns read-only. */
    const returnedControl = (holding: string): void => {
        if (!mounted.current || claimRef.current !== holding) {
            return;
        }

        wantedControl.current = undefined;
        setClaim(undefined);
        ask(false);
    };

    // The lease ended on the server (idle, or the person may no longer write) while this tab still held its claim.
    const endLease = (): void => {
        const holding = claimRef.current;

        if (holding === undefined || isForOtherBrowser(view, browserId)) {
            return;
        }

        // The hand back the person asked for is what ended it.
        if (returningRef.current === holding) {
            returnedControl(holding);

            return;
        }

        giveBack();
        endControl(t`Control of the browser is back with the agent.`);
    };

    const setRenewalsOut = (change: number): void => {
        renewalsOutRef.current += change;
        setRenewalsOutState(renewalsOutRef.current);
    };

    /** What one `keepControl` answered for `held`. */
    const renewed = (held: string, outcome: Settled<{ until: number } | null>): void => {
        setRenewalsOut(-1);

        if (!outcome.ok) {
            if (failureReasonOf(outcome.error) === "forbidden" && claimRef.current === held) {
                controlForbidden();
            }

            return;
        }

        if (claimRef.current !== held || returningRef.current === held) {
            return;
        }

        const result = outcome.value;

        // Another of the person's tabs took control since, or control ended.
        if (result === null) {
            endControl(t`You no longer have control of the browser.`);

            return;
        }

        // The lease runs on from here, whether or not the status push of this write arrives.
        setLeaseState((current: Held | undefined) => (current?.claim === held ? { ...current, until: Math.max(current.until, result.until) } : current));
    };

    /** Input the card can see (a pointer on or focus into the view, typing a page address) starts the idle timeout again. */
    const renew = (force = false): void => {
        const held = claimRef.current;

        if (!youControl || held === undefined || returningRef.current === held || (!force && Date.now() - lastRenewal.current < RENEW_EVERY_MS)) {
            return;
        }

        lastRenewal.current = Date.now();
        setRenewalsOut(1);
        // Each request's own answer: `mutate`'s callbacks would fire for the newest request only, and an older one that
        // moved the lease on would go unheard.
        void settle(keepControl.mutateAsync({ claim: held, threadId })).then((outcome: Settled<{ until: number } | null>) => renewed(held, outcome));
    };

    const confirmed = (holding: string, outcome: Settled<StatusRead>): void => {
        setChecking(false);

        if (claimRef.current !== holding || returningRef.current === holding) {
            return;
        }

        const read = outcome.ok ? outcome.value : null;
        const named = read?.control;

        if (read?.canControl !== true || named?.byYou !== true || named.until <= read.now) {
            endLease();

            return;
        }

        // Onto this device's clock by how far the server's was ahead at this answer.
        const confirmedUntil = named.until - (read.now - Date.now());

        setLeaseState((current: Held | undefined) => (current?.claim === holding ? { ...current, confirmedUntil } : current));
    };

    /**
     * The lease's end as the card heard it passed, and no answer still out can move it: one status read (not the live
     * one, which answers from its last push) says whether the server still holds it. Only a read that names the
     * caller's lease running on keeps it.
     */
    const confirmLease = (holding: string): void => {
        setChecking(true);
        void settle(readStatus()).then((outcome: Settled<StatusRead>) => confirmed(holding, outcome));
    };

    const controlEnded = useEffectEvent((): void => {
        endLease();
    });

    const leaseExpired = useEffectEvent((): void => {
        const holding = claimRef.current;

        // A page still loading holds the lease on the server: its answer (and the renewal it sends) decides.
        if (holding === undefined || navigating) {
            return;
        }

        if (graceOver || returningRef.current === holding) {
            endLease();

            return;
        }

        if (renewalsOutRef.current === 0 && !checking) {
            confirmLease(holding);
        }
    });

    const leave = useEffectEvent((): void => {
        giveBack();
    });

    // The view closes too: a page restored from the back/forward cache must not wait on a view whose lease is gone. A
    // control request still out is no longer wanted: the lease it answers goes back at once. The hand back is a normal
    // mutation (the Lunora client has no keepalive send, and there is no HTTP route for it), so a page that unloads may
    // cut it off: the lease then ends on its idle timeout.
    const pageLeft = useEffectEvent((): void => {
        wantedControl.current = undefined;
        giveBack();
        setView((current) => (isControlView(current) ? CLOSED : current));
    });

    const focusEntered = useEffectEvent((): void => {
        if (document.activeElement === frame.current) {
            renew();
        }
    });

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
        };
    }, []);

    useEffect(() => {
        if (!youControl) {
            controlEnded();
        }
    }, [youControl]);

    // The end the card heard passed: re-decided whenever an answer that could move it comes in.
    useEffect(() => {
        if (youControl && leaseEnded) {
            leaseExpired();
        }
    }, [youControl, leaseEnded, graceOver, navigating, renewalsOut, checking]);

    // Until the lease is decided, the card (and its lease) stays, though the status's `idleUntil` passed.
    let holdUntil: number | undefined;

    if (youControl) {
        holdUntil = leaseEnded ? Infinity : leaseUntil;
    }

    useEffect(() => {
        onHold(holdUntil);
    }, [holdUntil, onHold]);

    useEffect(
        () => () => {
            onHold(undefined);
        },
        [onHold],
    );

    // While this tab holds a claim (also before the status says so) or asks for one: leaving the page, or the card
    // unmounting (the chat closed, the browser gone), hands it back; focus moving into the view counts as input.
    const holding = claim !== undefined;
    const engaged = holding || (view.kind === "opening" && view.mode === "control");

    useEffect(() => {
        if (!engaged) {
            return undefined;
        }

        // A remount at once (React's strict mode runs every effect twice) is not leaving: the hand back waits a tick.
        clearTimeout(leaving.current);
        globalThis.addEventListener("pagehide", pageLeft);
        window.addEventListener("blur", focusEntered);

        return () => {
            globalThis.removeEventListener("pagehide", pageLeft);
            window.removeEventListener("blur", focusEntered);
            leaving.current = setTimeout(leave, 0);
        };
    }, [engaged]);

    // A lease with no interactive view (it failed, was refused, or a read-only one replaced it) only holds the agent
    // off: it goes back at once, whatever path left it there.
    // A frame that loaded past its deadline (a sleeping tab) counts as a view: it is renewed under the same lease as soon as
    // the tab is shown, and a tab left hidden gives no input, so the idle timeout ends the lease.
    const withoutView = holding && !isControlView(view);
    const leaseWithoutView = useEffectEvent((): void => {
        giveBack();
    });

    useEffect(() => {
        if (withoutView) {
            leaseWithoutView();
        }
    }, [withoutView]);

    // A URL that did not connect in time is dead: ask once more, while someone looks (a hidden tab waits until shown).
    // Asking again and again would spend the hourly limit on a view that cannot connect.
    const renewIfExpired = useEffectEvent((attempt: number): void => {
        if (view.kind !== "open" || view.attempt !== attempt || view.connected || document.visibilityState !== "visible" || Date.now() < view.connectBy) {
            return;
        }

        if (view.renewed) {
            setView({ kind: "failed", reason: "other" });

            return;
        }

        ask(true, view.mode);
    });

    const pendingDeadline = view.kind === "open" && !view.connected ? view.connectBy : undefined;
    const pendingAttempt = view.kind === "open" ? view.attempt : undefined;

    useEffect(() => {
        if (pendingDeadline === undefined || pendingAttempt === undefined) {
            return undefined;
        }

        const check = (): void => renewIfExpired(pendingAttempt);
        // A little past the deadline: a timer may fire a moment early by `Date.now()`, and the check would then wait.
        const timer = setTimeout(check, Math.max(0, pendingDeadline - Date.now()) + 50);

        document.addEventListener("visibilitychange", check);

        return () => {
            clearTimeout(timer);
            document.removeEventListener("visibilitychange", check);
        };
    }, [pendingAttempt, pendingDeadline]);

    // The renderer replaced the browser: a read-only view asks for the new one. A replaced browser ends the lease, so
    // an interactive view closes and the person is offered control again.
    const browserReplaced = useEffectEvent((): void => {
        if (claimRef.current !== undefined || (isForOtherBrowser(view, browserId) && isControlView(view))) {
            endControl(t`The agent's browser was replaced, and control went back to the agent. You can take control again.`);

            return;
        }

        if (isForOtherBrowser(view, browserId)) {
            ask(false);
        }
    });

    useEffect(() => {
        browserReplaced();
    }, [browserId]);

    // Someone else took control and may type a password: an open view goes (the frame unmounts, ending its connection),
    // and a request still out is dropped. The provider cannot revoke a view, so the card must close it.
    const [closedForControl, setClosedForControl] = useState(controlledByOther);

    if (closedForControl !== controlledByOther) {
        setClosedForControl(controlledByOther);

        if (controlledByOther) {
            setView(CLOSED);
        }
    }

    // A control request still out is dropped with the view: its lease, if it gets one, goes back at once.
    useEffect(() => {
        if (controlledByOther) {
            wantedControl.current = undefined;
        }
    }, [controlledByOther]);

    const toggle = (): void => {
        noticeTurn.current += 1;
        setNotice(undefined);

        if (expanded) {
            // Hiding drops any answer still out, and the lease with the interactive view.
            attempts.current += 1;
            setView(CLOSED);
            giveBack();

            return;
        }

        ask(false);
    };

    /**
     * The person hands back: the claim stays this tab's, and the view interactive, until the hand back lands, as the
     * server's lease does. One that did not land leaves the person in control, and says so.
     */
    const handBackNow = (): void => {
        const handing = claimRef.current;

        if (renewingControl || handing === undefined || returningRef.current === handing) {
            return;
        }

        noticeTurn.current += 1;
        const turn = noticeTurn.current;
        const say = (message: string): void => {
            if (mounted.current && noticeTurn.current === turn) {
                setNotice(message);
            }
        };

        // `false`: the lease was no longer this claim's (another of the person's tabs took over, or it ran out).
        const handedBack = (claimed: string, ended: boolean): void => {
            returnedControl(claimed);
            say(ended ? t`You handed the browser back to the agent.` : t`You no longer have control of the browser.`);
        };

        setNotice(undefined);
        setReturning(handing);
        handBack
            .mutateAsync({ claim: handing, reason: "handed_back", threadId })
            .then((ended: boolean) => handedBack(handing, ended))
            .catch((error: unknown) => {
                // The lease ended (or this tab moved on) while the hand back was out.
                if (claimRef.current !== handing) {
                    return;
                }

                if (failureReasonOf(error) === "forbidden") {
                    endControl(forbiddenText);

                    return;
                }

                setReturning(undefined);
                say(t`The browser could not be handed back. The agent gets it back on its own after two minutes without input.`);
            });
    };

    /** What opening a page answered. A load grants a fresh idle window: the renewal it sends answers the lease's new end. */
    const navigated = (navigation: number, submitted: string, result: NavigationAnswer): void => {
        if (navigations.current !== navigation) {
            return;
        }

        setNavigating(false);
        setLoadedAt(Date.now());

        if (result.status === "ok") {
            // The load counts as input: renewing now learns the lease's new end, whether or not the status read says it.
            renew(true);
            // What the browser shows now (a redirect may have moved it on), in the header and the address field.
            const url = result.url ?? submitted;

            setOpened({ browserId, over: currentUrl, url });
            // Not over what the person typed while it loaded.
            setAddress((typed) => (typed.trim() === submitted ? url : typed));
        } else if (result.status === "closed") {
            endControl(t`The agent's browser closed while the page loaded.`);
        } else if (result.status === "refused" && result.error === NOT_IN_CONTROL) {
            endControl(t`You no longer have control of the browser.`);
        } else if (result.status === "refused" && result.error === STILL_LOADING) {
            setStillLoading(Date.now() + STILL_LOADING_MS);
        } else if (result.status === "refused") {
            setAddressError(t`That page could not be opened: ${result.error}`);
        }
    };

    const navigationFailed = (navigation: number, error: unknown): void => {
        if (navigations.current !== navigation) {
            return;
        }

        setNavigating(false);
        setLoadedAt(Date.now());

        if (failureReasonOf(error) === "forbidden") {
            controlForbidden();

            return;
        }

        setAddressError(t`That page could not be opened.`);
    };

    const go = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        const held = claimRef.current;

        if (held === undefined || navigating || returningRef.current === held) {
            return;
        }

        renew();
        setAddressError(undefined);
        // A page an earlier load left loading says so again only if this load answers the same.
        setStillLoading(0);
        setNavigating(true);
        navigations.current += 1;
        const navigation = navigations.current;

        // A page may take the renderer's whole hold (about 75 s) to load: nothing here gives up before the answer.
        const submitted = address.trim();

        void navigateInControl({ claim: held, threadId, url: submitted })
            .then((result) => navigated(navigation, submitted, result))
            .catch((error: unknown) => navigationFailed(navigation, error));
    };

    const framed =
        view.kind === "open" && !view.stale && !isForOtherBrowser(view, browserId) && !controlledByOther && (view.mode === "watch" || youControl)
            ? view
            : undefined;
    const inControlView = framed?.mode === "control";

    return (
        <section aria-labelledby={headingId} className="mb-2 rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/50">
            <div className="flex flex-wrap items-center gap-2">
                <Globe aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                    <h3 className="text-xs font-medium text-gray-700 dark:text-gray-300" id={headingId}>{t`Browser`}</h3>
                    <p className="text-muted-foreground truncate text-xs">{openedUrl ?? currentUrl ?? t`The agent is using a browser`}</p>
                    {controlledByOther && (
                        <p className="text-muted-foreground text-xs" role="status">
                            {t`Someone else has control of this browser.`}
                        </p>
                    )}
                </div>
                <Button
                    aria-controls={viewId}
                    aria-expanded={expanded}
                    className={TOUCH_TARGET}
                    disabled={controlledByOther}
                    onClick={toggle}
                    size="sm"
                    type="button"
                    variant="outline"
                >
                    {expanded ? t`Hide live view` : t`Watch live`}
                </Button>
                {youControl && (
                    <Button className={TOUCH_TARGET} disabled={handingBack || renewingControl} onClick={handBackNow} size="sm" type="button">
                        {handingBack && <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />}
                        {t`Hand back`}
                    </Button>
                )}
                {canControl && !youControl && !controlledByOther && (
                    <Button
                        aria-controls={viewId}
                        className={TOUCH_TARGET}
                        disabled={view.kind === "opening" && view.mode === "control"}
                        onClick={() => {
                            noticeTurn.current += 1;
                            setNotice(undefined);
                            setAddressError(undefined);
                            setAddress(currentUrl ?? "");
                            ask(false, "control");
                        }}
                        size="sm"
                        type="button"
                    >
                        {t`Take control`}
                    </Button>
                )}
            </div>
            {notice !== undefined && (
                <p className="text-muted-foreground mt-2 text-xs" role="status">
                    {notice}
                </p>
            )}
            {youControl && warn && !handingBack && (
                <div className="mt-2 flex items-center gap-2">
                    <p className="flex-1 text-xs" role="status">
                        {t`No input for a while: control goes back to the agent in under a minute.`}
                    </p>
                    <Button className={TOUCH_TARGET} onClick={() => renew(true)} size="sm" type="button" variant="outline">
                        {t`Keep control`}
                    </Button>
                </div>
            )}
            <div hidden={!expanded} id={viewId}>
                {(view.kind === "opening" || (view.kind === "open" && framed === undefined)) && (
                    <p className="text-muted-foreground mt-2 flex items-center gap-2 text-xs" role="status">
                        <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
                        {t`Opening the live view…`}
                    </p>
                )}
                {view.kind === "unavailable" && (
                    <p className="text-muted-foreground mt-2 text-xs" role="status">
                        {t`The live view is not available right now.`}
                    </p>
                )}
                {view.kind === "refused" && (
                    <p className="text-muted-foreground mt-2 text-xs" role="status">
                        {view.reason === "busy"
                            ? t`The agent is finishing a browser action, which can take over a minute. Try again shortly.`
                            : t`Someone else has control of this browser.`}
                    </p>
                )}
                {view.kind === "failed" && (
                    <div className="mt-2 flex items-center gap-2">
                        <p className="text-destructive flex-1 text-xs" role="alert">
                            {view.reason === "forbidden" && forbiddenText}
                            {view.reason === "rate-limited" && t`Too many live views were opened. Try again later.`}
                            {view.reason === "other" && t`The live view could not be opened.`}
                        </p>
                        {view.reason === "other" && (
                            <Button className={TOUCH_TARGET} onClick={() => ask(false)} size="sm" type="button" variant="outline">
                                {t`Try again`}
                            </Button>
                        )}
                    </div>
                )}
                {inControlView && (
                    <form className="mt-2 flex items-center gap-2" onSubmit={go}>
                        <Input
                            aria-describedby={addressError === undefined ? undefined : addressErrorId}
                            aria-invalid={addressError !== undefined}
                            aria-label={t`Page address`}
                            // `className` sizes the wrapper: the field itself fills it, so all of a 44 px touch target focuses it.
                            className="h-8 flex-1 text-xs *:data-[slot=input]:h-full any-pointer-coarse:h-11"
                            inputMode="url"
                            onChange={(event: ChangeEvent<HTMLInputElement>) => {
                                renew();
                                setAddress(event.target.value);
                            }}
                            placeholder="https://"
                            required
                            type="url"
                            value={address}
                        />
                        <Button className={TOUCH_TARGET} disabled={navigating || handingBack} size="sm" type="submit" variant="outline">
                            {navigating && <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />}
                            {t`Go`}
                        </Button>
                    </form>
                )}
                {inControlView && navigating && (
                    <p className="text-muted-foreground mt-1 text-xs" role="status">
                        {t`Opening the page. This can take up to a minute.`}
                    </p>
                )}
                {inControlView && showStillLoading && (
                    <p className="text-muted-foreground mt-1 text-xs" role="status">
                        {t`The page you opened is still loading.`}
                    </p>
                )}
                {inControlView && addressError !== undefined && (
                    <p className="text-destructive mt-1 text-xs" id={addressErrorId} role="alert">
                        {addressError}
                    </p>
                )}
                {inControlView && (
                    <p className="text-muted-foreground mt-1 text-xs">{t`Your clicks, typing and scrolling in the view go to the browser. The agent waits until you hand it back.`}</p>
                )}
                {framed !== undefined && (
                    // Read-only unless the person took control: then their input reaches the page and the agent waits.
                    <iframe
                        className="ph-no-capture mt-2 aspect-video w-full rounded-md border border-gray-200 bg-white dark:border-gray-700"
                        key={framed.attempt}
                        onLoad={() => setView(loadedFor(framed.attempt, Date.now()))}
                        onPointerDown={() => renew()}
                        onPointerEnter={() => renew()}
                        ref={frame}
                        referrerPolicy="no-referrer"
                        sandbox="allow-scripts allow-same-origin"
                        src={framed.url}
                        title={inControlView ? t`Live view of the agent's browser (you have control)` : t`Live view of the agent's browser (read-only)`}
                    />
                )}
            </div>
        </section>
    );
};

const BrowserLiveView: FC<{ threadId: Id<"threads"> | undefined }> = ({ threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const status = useQuery(crpc.browser.live_view.getThreadBrowser.queryOptions(threadId ? { threadId } : skipToken));
    const browser = status.data;
    // The answer's deadlines are on the server's clock: each is moved onto this device's clock by how far the server's
    // was ahead when the answer came (late by the answer's way here, so a deadline is never taken as passed early). When
    // it came is kept per answer (`now` names it): a live query's refetch hands back the same push with a later
    // `dataUpdatedAt`, which would move every deadline later and bring back a card whose grant has ended.
    const [received, setReceived] = useState<{ at: number; now: number } | undefined>(undefined);

    if (browser && received?.now !== browser.now) {
        setReceived({ at: status.dataUpdatedAt, now: browser.now });
    }

    const receivedAt = browser && received?.now === browser.now ? received.at : status.dataUpdatedAt;
    const skew = browser ? browser.now - receivedAt : 0;
    const local = (at: number | undefined): number | undefined => (at === undefined ? undefined : at - skew);
    // The card's own lease keeps the browser alive past an `idleUntil` whose push has not come yet.
    const [hold, setHold] = useState<number | undefined>(undefined);
    const idle = usePassed(browser ? Math.max(local(browser.idleUntil) ?? 0, hold ?? 0) : undefined);
    // A grantee's grant ended: nothing re-runs the live query when only the clock moves, so the card goes at once and the
    // status is asked again; the server answers nothing after the grant's end.
    const accessEnded = usePassed(local(browser?.accessUntil));
    const refetchStatus = useEffectEvent((): void => {
        status.refetch().catch(() => undefined);
    });

    useEffect(() => {
        if (accessEnded) {
            refetchStatus();
        }
    }, [accessEnded]);

    // The status could not be read: a running browser must not look like no browser, so the card says so and can ask again.
    // This holds after an earlier answer too: the cached browser may be one the person can no longer see, so its page and
    // any open view go (the frame unmounts, ending the connection). `isError` follows the query client's retry policy: a
    // network failure is retried with backoff before the card changes, an error the backend answered with is not.
    if (threadId !== undefined && status.isError) {
        return (
            <section aria-labelledby={headingId} className="mb-2 rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/50">
                <div className="flex items-center gap-2">
                    <Globe aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                        <h3 className="text-xs font-medium text-gray-700 dark:text-gray-300" id={headingId}>{t`Browser`}</h3>
                        <p className="text-destructive text-xs" role="alert">
                            {t`Whether the agent is using a browser could not be checked.`}
                        </p>
                    </div>
                    <Button
                        className={TOUCH_TARGET}
                        disabled={status.isFetching}
                        onClick={() => {
                            status.refetch().catch(() => undefined);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                    >
                        {t`Try again`}
                    </Button>
                </div>
            </section>
        );
    }

    if (threadId === undefined || browser === undefined || browser === null || idle || accessEnded) {
        return null;
    }

    return (
        <BrowserCard
            browserId={browser.browserId}
            canControl={browser.canControl}
            control={browser.control}
            currentUrl={browser.currentUrl}
            key={threadId}
            onHold={setHold}
            statusClock={{ now: browser.now, skew }}
            threadId={threadId}
        />
    );
};

export default BrowserLiveView;
