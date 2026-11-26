import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Text } from "react-native";

import { getClient } from "@/lib/lunora";

import { watchBrowserStatus } from "./browser-api";

/** A link to the chat's browser screen, shown only while the agent's cloud browser runs in the chat. */
export const BrowserLink = ({ threadId }: { threadId: string }) => {
    /** The thread whose browser was last seen running: another chat's answer never shows the link here. */
    const [runningIn, setRunningIn] = useState<string | undefined>(undefined);

    useEffect(
        () =>
            watchBrowserStatus(
                getClient(),
                threadId,
                (status) => setRunningIn(status.kind === "running" ? threadId : undefined),
                () => setRunningIn(undefined),
            ),
        [threadId],
    );

    if (runningIn !== threadId) {
        return null;
    }

    return (
        <Link accessibilityRole="button" href={{ params: { threadId }, pathname: "/browser/[threadId]" }} style={{ minHeight: 44, padding: 12 }}>
            <Text style={{ fontWeight: "600" }}>View the agent&apos;s browser</Text>
        </Link>
    );
};
