import { randomUUID } from "expo-crypto";
import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";

import { useIsAppActive } from "@/chat/use-app-active";
import { getClient } from "@/lib/lunora";
import { isNetworkFailure } from "@/offline/connectivity";
import { useOffline } from "@/offline/offline-context";
import { settleQuietly } from "@/offline/quietly";

import type { BrowserFrame, BrowserStatus } from "./browser-api";
import { handBackBrowser, keepBrowserControl, navigateBrowser, readBrowserStatus, readFrame, takeBrowserControl, watchBrowserStatus } from "./browser-api";
import type { ViewState } from "./browser-view-state";
import { frameMessage, frameTrigger, grantEndOnDevice, isOlderStatus, otherLeaseEndOnDevice, shouldReadFrame, viewStateOf } from "./browser-view-state";
import type { ControlSession, ControlState } from "./control-session";
import { createControlSession, forgetClaim, rememberClaim, rememberedClaim, viewNameFor } from "./control-session";
import { startFrameReader } from "./frame-reader";
import { watchGrantEnd } from "./grant-end";

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

type Answer = { receivedAt: number; status: BrowserStatus } | undefined;

/** An answer older than the one on screen (a lagging read of a grant since removed) never replaces it. */
const accepting
    = (setAnswer: (update: (current: Answer) => Answer) => void, setError: (error: string | undefined) => void) =>
        (next: BrowserStatus): void => {
            setError(undefined);
            setAnswer((current) => {
                if (isOlderStatus(current?.status, next)) {
                    return current;
                }

                return { receivedAt: Date.now(), status: next };
            });
        };

/**
 * The thread's cloud browser on the phone: the live status, a frame read on every agent action and on a timer while the
 * screen is in front and online, and the phone's control session, given back when the screen is left, the app goes to
 * the background, or the phone goes offline. The screen is keyed by account and thread, so none of this outlives either.
 */
export const useBrowserView = (threadId: string, userId: string): BrowserView => {
    const { isOffline, reportRead } = useOffline();
    const isActive = useIsAppActive();
    const isFocused = useIsFocused();
    const [answer, setAnswer] = useState<Answer>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    /** The answer whose grant ran out on this device's clock. */
    const [expiredAnswer, setExpiredAnswer] = useState<BrowserStatus | undefined>(undefined);
    const [frame, setFrame] = useState<ShownFrame | undefined>(undefined);
    const [frameNote, setFrameNote] = useState<string | undefined>(undefined);
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
    const lastRead = useRef(-Infinity);
    const [nudge, setNudge] = useState(0);
    const status = answer?.status;

    const accept = accepting(setAnswer, setError);

    useEffect(() => watchBrowserStatus(getClient(), threadId, accept, setError), [threadId]);

    // A grant ends without a write, so no new answer comes: the screen stops at its end, then reads once to learn
    // whether it was renewed (a renewal pushes nothing either).
    const grantEnd = grantEndOnDevice(status, answer?.receivedAt ?? 0);

    useEffect(() => {
        if (grantEnd === undefined || status === undefined) {
            return undefined;
        }

        return watchGrantEnd({
            endsAt: grantEnd,
            onEnd: () => setExpiredAnswer(status),
            reread: () => settleQuietly(async () => accept(await readBrowserStatus(getClient(), threadId))),
        });
    }, [grantEnd, status, threadId]);

    const otherLeaseEnd = otherLeaseEndOnDevice(status, answer?.receivedAt ?? 0);

    useEffect(() => {
        if (otherLeaseEnd === undefined) {
            return undefined;
        }

        return watchGrantEnd({ endsAt: otherLeaseEnd, reread: () => settleQuietly(async () => accept(await readBrowserStatus(getClient(), threadId))) });
    }, [otherLeaseEnd, threadId]);

    const view = viewStateOf(status, error, status !== undefined && expiredAnswer === status);
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

    useEffect(() => {
        if (!isReading || browserId === undefined) {
            return undefined;
        }

        return startFrameReader<BrowserFrame>({
            lastReadAt: lastRead.current,
            onAnswer: (read) => {
                reportRead("succeeded");
                setFrameNote(frameMessage(read));

                if (read.status === "ok") {
                    setFrame({ browserId, image: read.image, takenAt: read.takenAt, ...read.viewport !== undefined && { viewport: read.viewport } });
                } else if (read.status === "ended" || read.status === "controlled") {
                    // The browser closed, or someone else drives it: the last picture is no longer one to show.
                    setFrame(undefined);
                }
            },
            onFailure: (failure) => {
                // A refusal is the server's answer, not a lost connection.
                if (isNetworkFailure(failure)) {
                    reportRead("failed");
                }

                setFrameNote(NOT_SHOWN);
            },
            onRead: (at) => {
                lastRead.current = at;
            },
            read: async () => await readFrame(getClient(), threadId),
        });
    }, [browserId, isReading, nudge, reportRead, threadId, trigger]);

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
