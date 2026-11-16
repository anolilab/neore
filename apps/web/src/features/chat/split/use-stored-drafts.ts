import { useEffect } from "react";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import { draftGeneration, draftOwnership, hasDraftContent } from "./composer-drafts";

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

/** The storage module once it loaded, so a cleanup can release its binding synchronously, before the next composer binds. */
const loaded: { module?: typeof import("./stored-drafts") } = {};

/**
 * Keeps the composer's draft in `localStorage` under `owner` (a chat id, or "new") for `userId`, and brings a stored draft back
 * into an empty composer. The storage code loads after the composer has painted. Nothing is stored without a user.
 */
const useStoredDrafts = (owner: string, userId: string | undefined, locked: boolean): void => {
    useEffect(() => {
        if (!userId) {
            return undefined;
        }

        // Now, not once the chunk loads: text typed before then is this chat's even if the chat changes meanwhile. Only an empty
        // composer changes hands.
        if (!draftOwnership.first || !hasDraftContent(useChatUIStore.getState())) {
            draftOwnership.first = { generation: draftGeneration(userId), owner, userId };
        }

        // The chunk may load after the chat changed or this account's drafts were dropped (sign-out): then this binding is stale.
        // Another account's drop (the one just switched away from) leaves it be.
        let current = true;
        const generation = draftGeneration(userId);

        void import("./stored-drafts")
            .then((module) => {
                loaded.module = module;

                if (current && generation === draftGeneration(userId)) {
                    module.bindStoredDrafts(owner, userId, locked);
                }

                return undefined;
            })
            .catch(() => {
                // The chunk did not load: the draft is just not kept.
            });

        return () => {
            current = false;
            loaded.module?.releaseStoredDrafts(owner);
        };
    }, [locked, owner, userId]);
};

export default useStoredDrafts;
