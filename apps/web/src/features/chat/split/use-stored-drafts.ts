import { useEffect } from "react";

/**
 * Keeps the composer's draft in `localStorage` under `owner` (a chat id, or "new") for `userId`, and brings a stored draft back
 * into an empty composer. The storage code loads after the composer has painted. Nothing is stored without a user.
 */
const useStoredDrafts = (owner: string, userId: string | undefined, locked: boolean): void => {
    useEffect(() => {
        if (!userId) {
            return;
        }

        void import("./stored-drafts")
            .then(({ bindStoredDrafts }) => bindStoredDrafts(owner, userId, locked))
            .catch(() => {
                // The chunk did not load: the draft is just not kept.
            });
    }, [locked, owner, userId]);
};

export default useStoredDrafts;
