"use client";

import { api } from "@neore/backend/api";
import { useCallback } from "react";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useAction } from "@/lib/lunora/crpc";

import type { GhostRequest } from "./ghost-completion-controller";

/**
 * The composer's ghost-text source, or `undefined` while the user has not
 * opted in (`composerAutocompleteEnabled` — absent is off; the backend refuses
 * too). `getUserSettings` is already a first-paint query, so this adds none.
 */
const useComposerAutocomplete = (): GhostRequest | undefined => {
    const { data: userSettings } = useUserSettings();
    const suggestCompletion = useAction(api.chat.autocomplete.suggestCompletion);
    const enabled = userSettings?.composerAutocompleteEnabled === true;

    const request = useCallback<GhostRequest>(
        async (text, signal) => {
            if (signal.aborted) {
                return null;
            }

            // The Lunora client takes no signal; a superseded answer is dropped by the controller.
            const { completion } = await suggestCompletion({ text });

            return completion || null;
        },
        [suggestCompletion],
    );

    return enabled ? request : undefined;
};

export default useComposerAutocomplete;
