import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * What a long paste may still do once its upload finishes: nothing after the composer that started it unmounted
 * (a chat switch), since the thread id it reads then belongs to the previous chat. Toasts it showed are dismissed on
 * unmount so their Undo cannot reach the next chat.
 */
export const usePasteGuard = (threadId: string | undefined) => {
    const threadIdRef = useRef(threadId);
    const mountedRef = useRef(false);
    const toastIdsRef = useRef(new Set<number | string>());

    useEffect(() => {
        threadIdRef.current = threadId;
    }, [threadId]);

    useEffect(() => {
        mountedRef.current = true;

        const toastIds = toastIdsRef.current;

        return () => {
            mountedRef.current = false;

            for (const id of toastIds) {
                toast.dismiss(id);
            }

            toastIds.clear();
        };
    }, []);

    /** The chat this composer belongs to, or null once it unmounted. */
    const getChatKey = useCallback((): string | null | undefined => (mountedRef.current ? threadIdRef.current : null), []);
    const isMounted = useCallback(() => mountedRef.current, []);
    const trackToast = useCallback((id: number | string) => {
        toastIdsRef.current.add(id);
    }, []);

    return { getChatKey, isMounted, trackToast };
};
