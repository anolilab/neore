import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";

import { useIsAppActive } from "@/chat/use-app-active";
import { withCatch } from "@/lib/guarded";
import { getClient } from "@/lib/lunora";
import { useOffline } from "@/offline/offline-context";
import { settleQuietly } from "@/offline/quietly";

import type { BrowserStatus } from "./browser-api";
import { handBackBrowser, keepBrowserControl, navigateBrowser, readFrame, takeBrowserControl, watchBrowserStatus } from "./browser-api";
import type { ViewState } from "./browser-view-state";
import { FRAME_REFRESH_MS, frameMessage, frameTrigger, shouldReadFrame, viewStateOf } from "./browser-view-state";
import type { ControlSession, ControlState } from "./control-session";
import { createControlSession } from "./control-session";

export interface ShownFrame {
    image: string;
    /** On the server's clock: the "Last synced" time of the picture on screen. */
    takenAt: number;
    viewport?: { height: number; width: number };
}

export interface BrowserView {
    control: ControlState;
    frame: ShownFrame | undefined;
    /** Why the newest frame read brought no picture; the last picture stays on screen. */
    frameNote: string | undefined;
    /** Reads a frame now: after the person opened a page, which the status does not show. */
    refresh: () => void;
    session: ControlSession;
    view: ViewState;
}

/**
 * The thread's cloud browser on the phone: the live status, a frame read on every agent action and on a timer while the
 * screen is in front and online, and the phone's control session, given back when the screen is left, the app goes to
 * the background, or the phone goes offline.
 */
export const useBrowserView = (threadId: string): BrowserView => {
    const { isOffline } = useOffline();
    const isActive = useIsAppActive();
    const isFocused = useIsFocused();
    const [status, setStatus] = useState<BrowserStatus | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [frame, setFrame] = useState<ShownFrame | undefined>(undefined);
    const [frameNote, setFrameNote] = useState<string | undefined>(undefined);
    const [control, setControl] = useState<ControlState>({ kind: "idle" });
    const [session] = useState<ControlSession>(() => {
        const client = getClient();

        return createControlSession({
            api: {
                handBack: async (claim, reason) => await handBackBrowser(client, threadId, claim, reason),
                keep: async (claim) => await keepBrowserControl(client, threadId, claim),
                navigate: async (claim, url) => await navigateBrowser(client, threadId, claim, url),
                take: async (renews) => await takeBrowserControl(client, threadId, renews),
            },
            onChange: setControl,
        });
    });
    /** Only the newest frame read may paint: an older one that answers late is dropped. */
    const reads = useRef(0);
    const [nudge, setNudge] = useState(0);

    useEffect(
        () =>
            watchBrowserStatus(
                getClient(),
                threadId,
                (next) => {
                    setError(undefined);
                    setStatus(next);
                },
                setError,
            ),
        [threadId],
    );

    useEffect(() => {
        if (status !== undefined) {
            session.noteLease(status.kind === "running" ? status.control : undefined, status.now);
        }
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

    const view = viewStateOf(status, error);
    const isReading = shouldReadFrame(view, { isActive: isActive && isFocused, isOffline });
    const trigger = frameTrigger(status);

    useEffect(() => {
        if (!isReading) {
            return undefined;
        }

        const read = (): void => {
            reads.current += 1;

            const mine = reads.current;

            settleQuietly(async () => {
                const answer = await withCatch(async () => await readFrame(getClient(), threadId), () => undefined);

                if (mine !== reads.current) {
                    return;
                }

                if (answer === undefined) {
                    setFrameNote("The page could not be shown right now.");

                    return;
                }

                setFrameNote(frameMessage(answer));

                if (answer.status === "ok") {
                    setFrame({ image: answer.image, takenAt: answer.takenAt, ...answer.viewport !== undefined && { viewport: answer.viewport } });
                }
            });
        };

        read();

        const timer = setInterval(read, FRAME_REFRESH_MS);

        return () => {
            clearInterval(timer);
            // A read still out when the screen stops reading paints nothing.
            reads.current += 1;
        };
    }, [isReading, nudge, threadId, trigger]);

    return { control, frame, frameNote, refresh: () => setNudge((count) => count + 1), session, view };
};
