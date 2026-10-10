import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

/** Matches the server's 30 s stale threshold with room for one missed beat. */
const HEARTBEAT_INTERVAL_MS = 10_000;

/** Typing in the last this-many ms counts as "editing" for the soft lock. */
const EDITING_WINDOW_MS = 15_000;

/**
 * Heartbeats this tab's presence on a page and lists the other live sessions —
 * the soft edit lock. `markEditing()` is called on local edits; the next beat
 * (sent at once when editing starts) tells others "X is editing".
 */
const usePagePresence = (pageId: string) => {
    const crpc = useCRPC();
    const [sessionId] = useState(() => crypto.randomUUID());
    const lastEditRef = useRef(0);
    const editingSentRef = useRef(false);
    const { mutate: heartbeat } = useMutation(crpc.pages.presence.heartbeatPagePresence.mutationOptions());
    const { mutate: leave } = useMutation(crpc.pages.presence.leavePagePresence.mutationOptions());
    const { data: others = [] } = useQuery(crpc.pages.presence.listPagePresence.queryOptions({ pageId: pageId as never, sessionId }));

    const beat = useCallback(() => {
        const isEditing = Date.now() - lastEditRef.current < EDITING_WINDOW_MS;

        editingSentRef.current = isEditing;
        heartbeat({ isEditing, pageId: pageId as never, sessionId });
    }, [heartbeat, pageId, sessionId]);

    useEffect(() => {
        beat();

        const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

        return () => {
            clearInterval(timer);
            leave({ sessionId });
        };
    }, [beat, leave, sessionId]);

    const markEditing = useCallback(() => {
        lastEditRef.current = Date.now();

        if (!editingSentRef.current) {
            beat();
        }
    }, [beat]);

    return { editors: others.filter((other) => other.isEditing), markEditing, others };
};

export default usePagePresence;
