import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Text } from "react-native";

import { getClient } from "@/lib/lunora";
import { isThreadRefusal } from "@/offline/message-read";

import { readBrowserStatus, watchBrowserStatus } from "./browser-api";
import { watchBrowserLink } from "./browser-link-watch";

/** A link to the chat's browser screen, shown only while the agent's cloud browser runs in the chat. */
export const BrowserLink = ({ threadId }: { threadId: string }) => {
    /** The thread the link shows for: another chat's answer never shows the link here. */
    const [shownIn, setShownIn] = useState<string | undefined>(undefined);

    useEffect(() => {
        const link = watchBrowserLink({
            onChange: (isShown) => setShownIn(isShown ? threadId : undefined),
            read: async () => await readBrowserStatus(getClient(), threadId),
        });
        // As the browser screen reads them: only a refusal of the chat hides the link; a lapsed sign-in or a server hiccup
        // leaves it as it was.
        const stopStatus = watchBrowserStatus(getClient(), threadId, link.show, (failure) => {
            if (isThreadRefusal(failure)) {
                link.show(undefined);
            }
        });

        return () => {
            stopStatus();
            link.stop();
        };
    }, [threadId]);

    if (shownIn !== threadId) {
        return null;
    }

    return (
        <Link accessibilityRole="link" href={{ params: { threadId }, pathname: "/browser/[threadId]" }} style={{ minHeight: 44, padding: 12 }}>
            <Text style={{ fontWeight: "600" }}>View the agent&apos;s browser</Text>
        </Link>
    );
};
