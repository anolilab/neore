import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

/**
 * The inbox the bell and the home page share: one LIVE query
 * (`notifications_functions.getNotificationInbox`), so a new notification
 * arrives by push over the socket rather than by polling. `enabled: false`
 * keeps it off first paint (see `notification-bell.tsx`).
 */
const EMPTY: never[] = [];

const useNotificationInbox = ({ enabled = true }: { enabled?: boolean } = {}) => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const inboxQuery = crpc.notifications.functions.getNotificationInbox.queryOptions({});
    const { data, isLoading } = useQuery({ ...inboxQuery, enabled });

    // While the subscription is open these invalidations are answered from it;
    // they are the fallback for when it is not.
    const refresh = {
        onSettled: async () => {
            await queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey });
        },
    };
    const markRead = useMutation(crpc.notifications.functions.markNotificationRead.mutationOptions(refresh));
    const { isPending: markAllReadPending, mutateAsync: markAllReadBatch } = useMutation(
        crpc.notifications.functions.markAllNotificationsRead.mutationOptions(refresh),
    );

    const markAll = useCallback(async () => {
        // A batch per call; the server says when more remain.
        for (let round = 0; round < 10; round += 1) {
            const { hasMore } = await markAllReadBatch({});

            if (!hasMore) {
                break;
            }
        }
    }, [markAllReadBatch]);

    return {
        isLoading,
        items: data?.items ?? EMPTY,
        /** The first snapshot has arrived. */
        loaded: data !== undefined,
        markAllRead: markAll,
        markAllReadPending,
        markRead: (notificationId: string) => markRead.mutate({ notificationId: notificationId as never }),
        unreadCount: data?.unreadCount ?? 0,
    };
};

export default useNotificationInbox;
