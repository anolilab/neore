import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import type { QueryClient } from "@tanstack/react-query";

import type { LunoraReactClient } from "@/lib/lunora/crpc";
import { createLunoraQueryOptions } from "@/lib/lunora/crpc";

/**
 * Determines the appropriate redirect URL after successful authentication.
 * Checks for the user's last chat ID and validates if it still exists.
 * Falls back to /chat if no last chat is found or if it doesn't exist.
 */
export const getAuthRedirectUrl = async (queryClient: QueryClient, lunoraClient: LunoraReactClient): Promise<string> => {
    try {
        const settings = await queryClient.fetchQuery(createLunoraQueryOptions(lunoraClient, api.auth.functions.getUserSettings, {}));

        if (settings?.lastChatId) {
            const threadExists = await queryClient.fetchQuery(
                createLunoraQueryOptions(lunoraClient, api.chat.functions.validateThreadExists, {
                    // `lastChatId` is written from a thread's `_id`; the column is
                    // a bare string, so the brand has to be restated here.
                    threadId: settings?.lastChatId as Id<"threads">,
                }),
            );

            if (threadExists) {
                return `/chat/${settings?.lastChatId}`;
            }
        }
    } catch (error) {
        console.warn("Failed to get last chat ID:", error);
    }

    // Default to chat home if no last chat or if it doesn't exist
    return "/chat";
};

export { isAuthError } from "@neore/client-runtime";
