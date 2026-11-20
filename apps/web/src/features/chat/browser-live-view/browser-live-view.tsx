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
import { useEffect, useId, useRef, useState } from "react";

import { useAction, useCRPC } from "@/lib/lunora/crpc";

/** `opening` carries the attempt it waits for: only that attempt's answer may fill the view. */
type View =
    | { kind: "closed" }
    | { kind: "failed"; reason: FailureReason }
    | { attempt: number; kind: "opening" }
    | { kind: "open"; url: string }
    | { kind: "unavailable" };

/** Why asking for the view failed: the hourly limit is not fixed by asking again at once. */
type FailureReason = "other" | "rate-limited";

const failureReasonOf = (error: unknown): FailureReason => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return code === "TOO_MANY_REQUESTS" || data?.code === "TOO_MANY_REQUESTS" ? "rate-limited" : "other";
};

const CLOSED: View = { kind: "closed" };

/** True once `until` has passed; re-renders at that moment, so the card leaves without a new server answer. */
const usePassed = (until: number | undefined): boolean => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (until === undefined || until <= now) {
            return undefined;
        }

        // From the real time, not the last render's: a later `until` would otherwise fire late by the time between.
        const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 50);

        return () => clearTimeout(timer);
    }, [until, now]);

    return until !== undefined && until <= now;
};

/**
 * What the view becomes after the person asked for it. `ended` reads as unavailable too: the browser may be gone before the
 * status read drops the card, or the provider may not see it at all, and either way the click must not do nothing.
 */
const viewFrom = (result: { status: "ended" | "unavailable" } | { status: "ok"; url: string }): View =>
    result.status === "ok" ? { kind: "open", url: result.url } : { kind: "unavailable" };

/** The answer to `attempt`, applied only while the view still waits for that attempt. */
const answerFor =
    (attempt: number, next: View) =>
    (current: View): View =>
        current.kind === "opening" && current.attempt === attempt ? next : current;

/** The card for one running browser. It unmounts when the browser stops, so its view and the view's credential go with it. */
const BrowserCard: FC<{ currentUrl: string | undefined; threadId: Id<"threads"> }> = ({ currentUrl, threadId }) => {
    const { t } = useLingui();
    const headingId = useId();
    const viewId = useId();
    const openLiveView = useAction(api.browser.live_view.openLiveView);
    const [view, setView] = useState<View>(CLOSED);
    const attempts = useRef(0);
    const expanded = view.kind !== "closed";

    const toggle = (): void => {
        if (expanded) {
            setView(CLOSED);

            return;
        }

        attempts.current += 1;
        const attempt = attempts.current;

        setView({ attempt, kind: "opening" });
        // Hidden again, or hidden and opened again, while it was asked for: that older answer (and its credential) is
        // dropped, whatever order the answers arrive in.
        void openLiveView({ threadId })
            .then((result) => setView(answerFor(attempt, viewFrom(result))))
            .catch((error: unknown) => setView(answerFor(attempt, { kind: "failed", reason: failureReasonOf(error) })));
    };

    return (
        <section aria-labelledby={headingId} className="mb-2 rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/50">
            <div className="flex items-center gap-2">
                <Globe aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                    <h3 className="text-xs font-medium text-gray-700 dark:text-gray-300" id={headingId}>{t`Browser`}</h3>
                    <p className="text-muted-foreground truncate text-xs">{currentUrl ?? t`The agent is using a browser`}</p>
                </div>
                <Button aria-controls={viewId} aria-expanded={expanded} onClick={toggle} size="sm" type="button" variant="outline">
                    {expanded ? t`Hide live view` : t`Watch live`}
                </Button>
            </div>
            <div hidden={!expanded} id={viewId}>
                {view.kind === "opening" && (
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
                    <p className="text-destructive mt-2 text-xs" role="alert">
                        {view.reason === "rate-limited"
                            ? t`Too many live views were opened. Try again later.`
                            : t`The live view could not be opened. Try again.`}
                    </p>
                )}
                {view.kind === "open" && (
                    // Read-only: the view refuses input, so the person watches without steering the agent's page.
                    <iframe
                        className="ph-no-capture mt-2 aspect-video w-full rounded-md border border-gray-200 bg-white dark:border-gray-700"
                        referrerPolicy="no-referrer"
                        sandbox="allow-scripts allow-same-origin"
                        src={view.url}
                        title={t`Live view of the agent's browser (read-only)`}
                    />
                )}
            </div>
        </section>
    );
};

const BrowserLiveView: FC<{ threadId: Id<"threads"> | undefined }> = ({ threadId }) => {
    const crpc = useCRPC();
    const { data: browser } = useQuery(crpc.browser.live_view.getThreadBrowser.queryOptions(threadId ? { threadId } : skipToken));
    const idle = usePassed(browser?.idleUntil);

    if (threadId === undefined || browser === undefined || browser === null || idle) {
        return null;
    }

    return <BrowserCard currentUrl={browser.currentUrl} key={threadId} threadId={threadId} />;
};

export default BrowserLiveView;
