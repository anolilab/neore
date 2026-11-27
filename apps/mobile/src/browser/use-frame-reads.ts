/**
 * The browser screen's frame reads: a reader runs while the page may be shown (`isReading`), reads again whenever the
 * read key changes (an agent action, a page the person opened), and keeps the last picture and the note on the newest
 * read. Status and lease stay with `useBrowserView`; it hears here of a browser found gone and of a refusal of the chat.
 */
import { useEffect, useRef, useState } from "react";

import { getClient } from "@/lib/lunora";
import { isNetworkFailure } from "@/offline/connectivity";
import { isThreadRefusal } from "@/offline/message-read";
import { useOffline } from "@/offline/offline-context";

import type { BrowserFrame } from "./browser-api";
import { readFrame } from "./browser-api";
import { frameMessage, isRateLimited, isReadDue } from "./browser-view-state";
import type { FrameReader } from "./frame-reader";
import { startFrameReader } from "./frame-reader";

export interface ShownFrame {
    /** The browser the picture is of: one replaced since is not shown. */
    browserId: string;
    image: string;
    /** On the server's clock: the "Last synced" time of the picture on screen. */
    takenAt: number;
    viewport?: { height: number; width: number };
}

const NOT_SHOWN = "The page could not be shown right now.";

/**
 * When each account's last frame read began, kept past any one screen: a screen back in front starts a new reader, and
 * the reads it may make are counted per account on the server.
 */
const lastFrameReads = new Map<string, { at: number }>();

const lastFrameReadOf = (userId: string): { at: number } => {
    const known = lastFrameReads.get(userId);

    if (known !== undefined) {
        return known;
    }

    const fresh = { at: -Infinity };

    lastFrameReads.set(userId, fresh);

    return fresh;
};

export const useFrameReads = ({
    browserId,
    isReading,
    onClosed,
    onRefused,
    readKey,
    threadId,
    userId,
}: {
    browserId: string | undefined;
    isReading: boolean;
    /** A frame read found `browserId` gone while the status still says it runs. */
    onClosed: (browserId: string) => void;
    /** A frame read was refused for the chat. */
    onRefused: (message: string) => void;
    /** Changes on an agent action or a page the person opened: the running reader is asked for a read. */
    readKey: string;
    threadId: string;
    userId: string;
}): { frame: ShownFrame | undefined; frameNote: string | undefined } => {
    const { reportRead } = useOffline();
    const [frame, setFrame] = useState<ShownFrame | undefined>(undefined);
    const [frameNote, setFrameNote] = useState<string | undefined>(undefined);
    const reader = useRef<FrameReader | undefined>(undefined);
    /** The key the running reader last read for. */
    const readFor = useRef<string | undefined>(undefined);
    /** The newest callbacks, so a new render's never restarts the reader; set after each render, never during it. */
    const handlers = useRef({ onClosed, onRefused });

    useEffect(() => {
        handlers.current = { onClosed, onRefused };
    });

    // Declared before the reader's effect, so a reader started in the same commit reads for the new key itself, and a
    // reader restarted on the same key (back to the front, online again) still asks on the next change.
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
            lastRead: lastFrameReadOf(userId),
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
                // on it, which would only keep the agent waiting.
                if (read.status === "ended") {
                    handlers.current.onClosed(browserId);
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

                // Refused for the chat: the picture goes at once, before the status says so too.
                if (isThreadRefusal(failure)) {
                    setFrame(undefined);
                    handlers.current.onRefused(failure instanceof Error ? failure.message : NOT_SHOWN);

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
    }, [browserId, isReading, reportRead, threadId, userId]);

    return { frame, frameNote };
};
