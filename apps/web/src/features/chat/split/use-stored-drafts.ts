import { useEffect } from "react";

import type { ThreadLoad } from "@/features/chat/core/context/thread-load";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import { draftGeneration, draftOwnership, hasDraftContent, setDraftBound } from "./composer-drafts";

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
 * Whether it is known yet if the chat keeps a stored draft, and whose: never while the session loads (a signed-in account's
 * draft would not be bound yet), then at once for a new chat, otherwise once its thread's read has answered and its worker
 * is known. A failed read is not an answer: a draft stored for the chat may still come back.
 */
export const storedDraftKnown = (state: {
    isNewThread: boolean;
    isSessionPending: boolean;
    isWorkerLoading: boolean;
    threadId: string | undefined;
    threadLoad: ThreadLoad | undefined;
}): boolean => !state.isSessionPending && (state.isNewThread || !state.threadId || ((state.threadLoad ?? "ready") === "ready" && !state.isWorkerLoading));

/** The storage module once it loaded, so a cleanup can release its binding synchronously, before the next composer binds. */
const loaded: { module?: typeof import("./stored-drafts") } = {};

/**
 * Keeps the composer's draft in `localStorage` under `owner` (a chat id, or "new") for `userId`, and brings a stored draft back
 * into an empty composer. The storage code loads after the composer has painted. Nothing is stored without a user. `known` is
 * false while the caller cannot yet tell whether the chat keeps a stored draft (its document still loading): then the draft is
 * not settled (`setDraftBound`) either way.
 */
const useStoredDrafts = (owner: string, userId: string | undefined, locked: boolean, known = true): void => {
    useEffect(() => {
        const settle = () => setDraftBound(owner, true);
        const unsettle = () => setDraftBound(owner, false);

        // No stored draft can come back: the composer is settled at once, once that is known.
        if (!userId) {
            if (known) {
                settle();
            }

            return unsettle;
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

                // Bound, or stale with nothing to bring back: either way nothing more comes into the composer.
                if (current) {
                    settle();
                }

                return undefined;
            })
            .catch(() => {
                // The chunk did not load: the draft is just not kept.
                if (current) {
                    settle();
                }
            });

        return () => {
            current = false;
            unsettle();
            loaded.module?.releaseStoredDrafts(owner);
        };
    }, [known, locked, owner, userId]);
};

export default useStoredDrafts;
