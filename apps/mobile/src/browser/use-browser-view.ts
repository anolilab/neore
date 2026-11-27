import { randomUUID } from "expo-crypto";
import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";

import { useIsAppActive } from "@/chat/use-app-active";
import { getClient } from "@/lib/lunora";
import { isNetworkFailure } from "@/offline/connectivity";
import { isThreadRefusal } from "@/offline/message-read";
import { useOffline } from "@/offline/offline-context";

import type { BrowserFrame, BrowserStatus } from "./browser-api";
import { handBackBrowser, keepBrowserControl, navigateBrowser, readBrowserStatus, readFrame, takeBrowserControl, watchBrowserStatus } from "./browser-api";
import type { Seen, ViewState } from "./browser-view-state";
import {
    expiredReread,
    frameMessage,
    frameTrigger,
    GRANT_END_MARGIN_MS,
    grantEndOnDevice,
    isRateLimited,
    isReadDue,
    otherLeaseEndOnDevice,
    shouldReadFrame,
    viewStateOf,
    withAnswer,
} from "./browser-view-state";
import type { ControlSession, ControlState } from "./control-session";
import { createControlSession, forgetClaim, rememberClaim, rememberedClaim, viewNameFor } from "./control-session";
import type { FrameReader } from "./frame-reader";
import { startFrameReader } from "./frame-reader";
import { readUntilAnswered, watchGrantEnd } from "./grant-end";

export interface ShownFrame {
    /** The browser the picture is of: one replaced since is not shown. */
    browserId: string;
    image: string;
    /** On the server's clock: the "Last synced" time of the picture on screen. */
    takenAt: number;
    viewport?: { height: number; width: number };
}

export interface BrowserView {
    control: ControlState;
    /** Only a picture of the browser the screen may show now: none once access ended or the browser changed. */
    frame: ShownFrame | undefined;
    /** Why the newest frame read brought no picture; the last picture stays on screen. */
    frameNote: string | undefined;
    /** Reads a frame now: after the person opened a page, which the status does not show. */
    refresh: () => void;
    session: ControlSession;
    view: ViewState;
}

const NOT_SHOWN = "The page could not be shown right now.";

/**
 * The thread's cloud browser on the phone: the live status, a frame read on every agent action and on a timer while the
 * screen is in front and online, and the phone's control session, given back when the screen is left, the app goes to
 * the background, or the phone goes offline. The screen is keyed by account and thread, so none of this outlives either.
 */
export const useBrowserView = (threadId: string, userId: string): BrowserView => {
    const { isOffline, refreshTick, reportRead } = useOffline();
    const isActive = useIsAppActive();
    const isFocused = useIsFocused();
    const [seen, setSeen] = useState<Seen>({});
    /** The answer whose grant ran out on this device's clock. */
    const [expiredAnswer, setExpiredAnswer] = useState<BrowserStatus | undefined>(undefined);
    const [frame, setFrame] = useState<ShownFrame | undefined>(undefined);
    const [frameNote, setFrameNote] = useState<string | undefined>(undefined);
    /** A browser a frame read found gone while the status still says it runs. */
    const [closedBrowserId, setClosedBrowserId] = useState<string | undefined>(undefined);
    const [control, setControl] = useState<ControlState>({ kind: "idle" });
    const [session] = useState<ControlSession>(() => {
        const client = getClient();
        const key = `${userId}:${threadId}`;

        return createControlSession({
            api: {
                handBack: async (claim, reason) => await handBackBrowser(client, threadId, claim, reason),
                keep: async (claim) => await keepBrowserControl(client, threadId, claim),
                navigate: async (claim, url) => await navigateBrowser(client, threadId, claim, url),
                take: async (renews) => await takeBrowserControl(client, threadId, viewNameFor(key, randomUUID), renews),
            },
            lastClaim: rememberedClaim(key),
            onChange: setControl,
            onClaim: (claim) => rememberClaim(key, claim),
            onReleased: (claim) => forgetClaim(key, claim),
        });
    });
    const reader = useRef<FrameReader | undefined>(undefined);
    /** The trigger the running reader last read for: a change is an agent action or a page the person opened. */
    const readFor = useRef<string | undefined>(undefined);
    const [nudge, setNudge] = useState(0);
    const { answer } = seen;
    const status = answer?.status;
    const error = seen.refusal?.message;

    /** `startedAt`: when the read that brought `next` began; a live push is taken as it comes. */
    const accept = (next: BrowserStatus, startedAt = Date.now()): void => setSeen((current) => withAnswer(current, next, startedAt, Date.now()));
    /** A status read past the subscription (a grant's end or a renewal pushes nothing to it), tried again on failure. */
    const reread = (): () => void =>
        readUntilAnswered({ onAnswer: (next, startedAt) => accept(next, startedAt), read: async () => await readBrowserStatus(getClient(), threadId) });

    // Only a refusal of the chat hides the page; any other subscription error (a lost connection resumes on its own,
    // a server hiccup) leaves the last page and its "Last synced" time on screen.
    useEffect(
        () =>
            watchBrowserStatus(
                getClient(),
                threadId,
                (next) => accept(next),
                (failure) => {
                    // As the chat screen reads them: a lapsed sign-in says nothing about the chat, so it hides nothing.
                    if (isThreadRefusal(failure)) {
                        setSeen((current) => {
                            return { ...current, refusal: { at: Date.now(), message: failure.message } };
                        });
                    }
                },
            ),
        [threadId],
    );

    // A grant ends without a write, so no new answer comes: the screen stops at its end, then reads once to learn
    // whether it was renewed (a renewal pushes nothing either).
    const grantEnd = grantEndOnDevice(status, answer?.receivedAt ?? 0);

    useEffect(() => {
        if (grantEnd === undefined || status === undefined) {
            return undefined;
        }

        let stopRead: (() => void) | undefined;
        const stopWait = watchGrantEnd({
            endsAt: grantEnd,
            onEnd: () => setExpiredAnswer(status),
            reread: () => {
                stopRead = reread();
            },
            // The grant still holds until its real end: a read before it would answer it again, and loop.
            rereadAt: grantEnd + GRANT_END_MARGIN_MS,
        });

        return () => {
            stopWait();
            stopRead?.();
        };
    }, [grantEnd, status, threadId]);

    const otherLeaseEnd = otherLeaseEndOnDevice(status, answer?.receivedAt ?? 0);

    useEffect(() => {
        if (otherLeaseEnd === undefined) {
            return undefined;
        }

        let stopRead: (() => void) | undefined;
        const stopWait = watchGrantEnd({
            endsAt: otherLeaseEnd,
            reread: () => {
                stopRead = reread();
            },
        });

        return () => {
            stopWait();
            stopRead?.();
        };
    }, [otherLeaseEnd, threadId]);

    // Back online, or a retry due (the offline provider's tick): a page held off by a grant's end reads its status
    // again, in case every read at the end failed.
    const isExpired = status !== undefined && expiredAnswer === status;

    /** The offline provider's tick when the grant ran out: only a later tick reads again (the end's own read is timed). */
    const expiredAtTick = useRef<number | undefined>(undefined);

    useEffect(() => {
        if (!isExpired) {
            expiredAtTick.current = undefined;

            return undefined;
        }

        const next = expiredReread(expiredAtTick.current, refreshTick);

        expiredAtTick.current = next.expiredAt;

        return next.isDue ? reread() : undefined;
    }, [isExpired, refreshTick, threadId]);

    const view = viewStateOf(status, error, status !== undefined && expiredAnswer === status, closedBrowserId);
    const isHolding = control.kind === "holding";
    const browserId = status?.kind === "running" ? status.browserId : undefined;

    useEffect(() => {
        if (status === undefined) {
            return;
        }

        // The person may no longer drive the browser (access ended, or a grant lowered to read): the claim goes back at
        // once, so the agent need not wait out the lease. `handBack` takes no thread decision, so it still ends it.
        if (status.kind !== "running" || !status.canControl) {
            session.release("left");

            return;
        }

        session.noteLease(status.control, status.now);
    }, [session, status]);

    useEffect(() => {
        if (isOffline) {
            session.suspend();
        }
    }, [isOffline, session]);

    // The page went (a refusal of the chat, or the grant ran out) with no new status: the claim goes back too.
    useEffect(() => {
        if (view.kind === "ended") {
            session.release("left");
        }
    }, [session, view.kind]);

    // Left, backgrounded or unmounted: the claim goes back at once, so the agent need not wait out the lease.
    useEffect(() => {
        if (!isActive || !isFocused) {
            session.release("left");
        }
    }, [isActive, isFocused, session]);
    useEffect(
        () => () => {
            session.release("left");
        },
        [session],
    );

    const isReading = shouldReadFrame(view, { isActive: isActive && isFocused, isOffline }) && browserId !== undefined;
    const trigger = frameTrigger(status, isHolding);

    // An agent action, or a page the person opened, asks the running reader for a read; one still out is kept. Declared
    // before the reader's effect, so a reader started in the same commit reads for the new key itself, and a reader
    // restarted on the same key (back to the front, online again) still asks on the next change.
    const readKey = `${trigger ?? ""}|${nudge}`;

    useEffect(() => {
        if (isReadDue(readFor.current, readKey)) {
            reader.current?.request();
        }

        readFor.current = readKey;
    }, [readKey]);

    useEffect(() => {
        if (!isReading || browserId === undefined) {
            return undefined;
        }

        const started = startFrameReader<BrowserFrame>({
            onAnswer: (read) => {
                reportRead("succeeded");
                setFrameNote(frameMessage(read));

                if (read.status === "ok") {
                    setFrame({ browserId, image: read.image, takenAt: read.takenAt, ...read.viewport !== undefined && { viewport: read.viewport } });
                } else if (read.status === "ended" || read.status === "controlled") {
                    // The browser closed, or someone else drives it: the last picture is no longer one to show.
                    setFrame(undefined);
                }

                // The browser is gone: the screen shows it closed, stops reading it, and hands back a lease the phone holds
                // on it (the ended view's effect), which would only keep the agent waiting.
                if (read.status === "ended") {
                    setClosedBrowserId(browserId);
                }
            },
            onFailure: (failure) => {
                // A refusal is the server's answer, not a lost connection.
                if (isNetworkFailure(failure)) {
                    reportRead("failed");
                }

                if (isRateLimited(failure)) {
                    return;
                }

                setFrameNote(NOT_SHOWN);
            },
            read: async () => await readFrame(getClient(), threadId),
        });

        reader.current = started;

        return () => {
            started.stop();
            reader.current = undefined;
        };
    }, [browserId, isReading, reportRead, session, threadId]);

    const isShown = view.kind === "ready" && frame !== undefined && frame.browserId === browserId;

    return {
        control,
        frame: isShown ? frame : undefined,
        frameNote: view.kind === "ready" ? frameNote : undefined,
        refresh: () => setNudge((count) => count + 1),
        session,
        view,
    };
};
