import { useEffect } from "react";

import { draftGeneration } from "./composer-drafts";

/**
 * Whether the chat's draft is the shared composer's, so it can be stored: not a worker's (its own composer) nor a host-run chat's
 * (`HostComposer` keeps its text to itself), and only once the chat is known.
 */
export const keepsStoredDraft = (
    composerActive: boolean,
    isNewThread: boolean,
    thread: { runner?: string } | null | undefined,
    ownComposer: boolean,
): boolean => composerActive && !ownComposer && (isNewThread || (thread !== null && thread !== undefined && thread.runner !== "host"));

/**
 * Keeps the composer's draft in `localStorage` under `owner` (a chat id, or "new") for `userId`, and brings a stored draft back
 * into an empty composer. The storage code loads after the composer has painted. Nothing is stored without a user.
 */
const useStoredDrafts = (owner: string, userId: string | undefined, locked: boolean): void => {
    useEffect(() => {
        if (!userId) {
            return undefined;
        }

        // The chunk may load after the chat changed or the drafts were dropped (sign-out): then this binding is stale.
        let current = true;
        const generation = draftGeneration();

        void import("./stored-drafts")
            .then(({ bindStoredDrafts }) => {
                if (current && generation === draftGeneration()) {
                    bindStoredDrafts(owner, userId, locked);
                }

                return undefined;
            })
            .catch(() => {
                // The chunk did not load: the draft is just not kept.
            });

        return () => {
            current = false;
        };
    }, [locked, owner, userId]);
};

export default useStoredDrafts;
