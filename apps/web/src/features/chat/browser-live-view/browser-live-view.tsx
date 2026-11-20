/**
 * BrowserLiveView - while the agent has a cloud browser running for this thread, a card above the composer names the
 * page it is on and lets the person watch it live, read-only. The view URL is a short-lived credential: it is asked
 * for only when the person opens the view, kept in this component's state, and dropped when the view closes. The
 * card leaves once the browser is gone (closed, or idle past the provider's reap).
 */
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Globe, Loader2 } from "lucide-react";
import type { FC } from "react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { useAction, useCRPC } from "@/lib/lunora/crpc";

/**
 * How long a new view URL may take to connect (the backend's `LIVE_VIEW_CONNECT_DEADLINE_MS`). The answer's `connectBy`
 * is on the server's clock, so the card measures the same window on its own, from the moment it asked: never later
 * than the provider's deadline, whatever the two clocks say.
 */
const CONNECT_WINDOW_MS = 60_000;

/** `size="sm"` is 24 px tall: on any touch pointer (also a touchscreen laptop driven by a trackpad) the card's buttons grow to 44 px. */
const TOUCH_TARGET = "any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11";

/**
 * `opening` and `open` carry the attempt they belong to (only that attempt's answer may fill the view), the browser it
 * was asked for (a replaced browser asks again), and whether it is already the one automatic renewal of an expired URL.
 * `stale`: the answer came after its connect deadline (a sleeping tab), so its URL is never framed.
 */
type View =
    | { kind: "closed" }
    | { kind: "failed"; reason: FailureReason }
    | { attempt: number; browserId: string; kind: "opening"; renewed: boolean }
    | { attempt: number; browserId: string; connectBy: number; connected: boolean; kind: "open"; renewed: boolean; stale: boolean; url: string }
    | { kind: "unavailable" };

/** Why asking for the view failed: the hourly limit is not fixed by asking again at once. */
type FailureReason = "other" | "rate-limited";

const failureReasonOf = (error: unknown): FailureReason => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return code === "TOO_MANY_REQUESTS" || data?.code === "TOO_MANY_REQUESTS" ? "rate-limited" : "other";
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

type Asked = { attempt: number; browserId: string; connectBy: number; renewed: boolean };

/**
 * What the view becomes after the person asked for it. `ended` reads as unavailable too: the browser may be gone before the
 * status read drops the card, or the provider may not see it at all, and either way the click must not do nothing.
 */
const viewFrom = (asked: Asked, result: { status: "controlled" | "ended" | "unavailable" } | { status: "ok"; url: string }, now: number): View =>
    result.status === "ok" ? { ...asked, connected: false, kind: "open", stale: now >= asked.connectBy, url: result.url } : { kind: "unavailable" };

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

/** The card for one thread's browser. It unmounts when the browser stops, so its view and the view's credential go with it. */
const BrowserCard: FC<{ browserId: string; controlledByOther: boolean; currentUrl: string | undefined; threadId: Id<"threads"> }> = ({
    browserId,
    controlledByOther,
    currentUrl,
    threadId,
}) => {
    const { t } = useLingui();
    const headingId = useId();
    const viewId = useId();
    const openLiveView = useAction(api.browser.live_view.openLiveView);
    const [view, setView] = useState<View>(CLOSED);
    const attempts = useRef(0);
    const expanded = view.kind !== "closed";

    const ask = (renewed: boolean): void => {
        attempts.current += 1;
        const asked: Asked = { attempt: attempts.current, browserId, connectBy: Date.now() + CONNECT_WINDOW_MS, renewed };
        const answered = (result: Parameters<typeof viewFrom>[1]): ((current: View) => View) => answerFor(asked.attempt, viewFrom(asked, result, Date.now()));

        setView({ attempt: asked.attempt, browserId, kind: "opening", renewed });
        // Hidden again, or hidden and opened again, while it was asked for: that older answer (and its credential) is
        // dropped, whatever order the answers arrive in.
        void openLiveView({ threadId })
            .then((result) => setView(answered(result)))
            .catch((error: unknown) => setView(answerFor(asked.attempt, { kind: "failed", reason: failureReasonOf(error) })));
    };

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

        ask(true);
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

    // The renderer replaced the browser while the view was open: its URL shows a browser that is gone.
    const askForReplacement = useEffectEvent((): void => {
        if (isForOtherBrowser(view, browserId)) {
            ask(false);
        }
    });

    useEffect(() => {
        askForReplacement();
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

    const toggle = (): void => {
        if (expanded) {
            setView(CLOSED);

            return;
        }

        ask(false);
    };

    const framed = view.kind === "open" && !view.stale && !isForOtherBrowser(view, browserId) ? view : undefined;

    return (
        <section aria-labelledby={headingId} className="mb-2 rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/50">
            <div className="flex items-center gap-2">
                <Globe aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                    <h3 className="text-xs font-medium text-gray-700 dark:text-gray-300" id={headingId}>{t`Browser`}</h3>
                    <p className="text-muted-foreground truncate text-xs">{currentUrl ?? t`The agent is using a browser`}</p>
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
            </div>
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
                {view.kind === "failed" && (
                    <div className="mt-2 flex items-center gap-2">
                        <p className="text-destructive flex-1 text-xs" role="alert">
                            {view.reason === "rate-limited" ? t`Too many live views were opened. Try again later.` : t`The live view could not be opened.`}
                        </p>
                        {view.reason === "other" && (
                            <Button className={TOUCH_TARGET} onClick={() => ask(false)} size="sm" type="button" variant="outline">
                                {t`Try again`}
                            </Button>
                        )}
                    </div>
                )}
                {framed !== undefined && (
                    // Read-only: the view refuses input, so the person watches without steering the agent's page.
                    <iframe
                        className="ph-no-capture mt-2 aspect-video w-full rounded-md border border-gray-200 bg-white dark:border-gray-700"
                        key={framed.attempt}
                        onLoad={() => setView(loadedFor(framed.attempt, Date.now()))}
                        referrerPolicy="no-referrer"
                        sandbox="allow-scripts allow-same-origin"
                        src={framed.url}
                        title={t`Live view of the agent's browser (read-only)`}
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
    const idle = usePassed(browser?.idleUntil);
    // A grantee's grant ended: nothing re-runs the live query when only the clock moves, so the card goes at once and the
    // status is asked again; the server answers nothing after the grant's end.
    const accessEnded = usePassed(browser?.accessUntil);
    // Another person's lease ends on the clock too: the view may be asked for again then.
    const controlEnded = usePassed(browser?.control?.until);
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
            controlledByOther={browser.control !== undefined && !browser.control.byYou && !controlEnded}
            currentUrl={browser.currentUrl}
            key={threadId}
            threadId={threadId}
        />
    );
};

export default BrowserLiveView;
