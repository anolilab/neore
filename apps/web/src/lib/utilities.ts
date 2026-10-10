import { isUnauthorizedError } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import type { QueryClient } from "@tanstack/react-query";

import type { LunoraReactClient } from "@/lib/lunora/crpc";
import { createLunoraQueryOptions } from "@/lib/lunora/crpc";

const UNAUTHORIZED_MESSAGE_RE = /UNAUTHORIZED|please sign in/i;

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

/**
 * Determines whether an error is auth related (UNAUTHORIZED / 401).
 */
export const isAuthError = (error: unknown): boolean => {
    if (!error) {
        return false;
    }

    // Fast path: Lunora error with UNAUTHORIZED code (most common case)
    if (isUnauthorizedError(error)) {
        return true;
    }

    // Generic object with .code property (covers LunoraError.data.code, plain objects)
    if (typeof error === "object" && error !== null) {
        if ("data" in error) {
            const { data } = error as { data: unknown };

            if (data && typeof data === "object" && "code" in data && (data as { code: unknown }).code === "UNAUTHORIZED") {
                return true;
            }
        }

        if ("code" in error && (error as { code: unknown }).code === "UNAUTHORIZED") {
            return true;
        }
    }

    // Message fallback for edge cases
    const message = error instanceof Error ? error.message : "";

    return UNAUTHORIZED_MESSAGE_RE.test(message);
};
