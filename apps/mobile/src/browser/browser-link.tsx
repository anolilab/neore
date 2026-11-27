import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Text } from "react-native";

import { getClient } from "@/lib/lunora";

import type { BrowserStatus } from "./browser-api";
import { readBrowserStatus, watchBrowserStatus } from "./browser-api";
import { browserLinkUntil, GRANT_END_MARGIN_MS } from "./browser-view-state";
import { readUntilAnswered, watchGrantEnd } from "./grant-end";

/** A link to the chat's browser screen, shown only while the agent's cloud browser runs in the chat. */
export const BrowserLink = ({ threadId }: { threadId: string }) => {
    /**
     * The thread whose browser was last seen running, and until when the link shows (a reader's grant ends without a new
     * status): another chat's answer never shows the link here.
     */
    const [shown, setShown] = useState<{ threadId: string; until: number } | undefined>(undefined);

    useEffect(
        () =>
            watchBrowserStatus(
                getClient(),
                threadId,
                (status) => {
                    const until = browserLinkUntil(status, Date.now());

                    setShown(until === undefined ? undefined : { threadId, until });
                },
                () => setShown(undefined),
            ),
        [threadId],
    );

    useEffect(() => {
        if (shown === undefined || shown.until === Infinity) {
            return undefined;
        }

        // The link goes at the grant's end; at its real end the status is read once, as the screen does, since a renewed
        // grant pushes nothing. A newer status replaces both.
        let stopRead: (() => void) | undefined;
        const stopWait = watchGrantEnd({
            endsAt: shown.until,
            onEnd: () => setShown(undefined),
            reread: () => {
                stopRead = readUntilAnswered({
                    onAnswer: (status: BrowserStatus) => {
                        const until = browserLinkUntil(status, Date.now());

                        setShown(until === undefined ? undefined : { threadId: shown.threadId, until });
                    },
                    read: async () => await readBrowserStatus(getClient(), shown.threadId),
                });
            },
            rereadAt: shown.until + GRANT_END_MARGIN_MS,
        });

        return () => {
            stopWait();
            stopRead?.();
        };
    }, [shown]);

    if (shown?.threadId !== threadId) {
        return null;
    }

    return (
        <Link accessibilityRole="link" href={{ params: { threadId }, pathname: "/browser/[threadId]" }} style={{ minHeight: 44, padding: 12 }}>
            <Text style={{ fontWeight: "600" }}>View the agent&apos;s browser</Text>
        </Link>
    );
};
