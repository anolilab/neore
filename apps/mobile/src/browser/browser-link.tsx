import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Text } from "react-native";

import { getClient } from "@/lib/lunora";

import { watchBrowserStatus } from "./browser-api";
import { browserLinkUntil } from "./browser-view-state";

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

        // A newer status clears this timer and sets its own.
        const timer = setTimeout(setShown, Math.max(0, shown.until - Date.now()), undefined);

        return () => clearTimeout(timer);
    }, [shown]);

    if (shown?.threadId !== threadId) {
        return null;
    }

    return (
        <Link accessibilityRole="button" href={{ params: { threadId }, pathname: "/browser/[threadId]" }} style={{ minHeight: 44, padding: 12 }}>
            <Text style={{ fontWeight: "600" }}>View the agent&apos;s browser</Text>
        </Link>
    );
};
