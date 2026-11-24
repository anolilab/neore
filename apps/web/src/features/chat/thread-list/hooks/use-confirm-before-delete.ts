"use client";

import { useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

import { chatActionConfirmations } from "../lib/chat-action-confirmations";

/**
 * Whether deleting a chat from a sidebar row asks first. Selects one boolean out of the cached settings, so a row
 * re-renders only when that boolean changes, not on every settings write. Until the settings load, delete asks.
 */
export const useConfirmBeforeDelete = (): boolean => {
    const crpc = useCRPC();
    const { data } = useQuery({
        ...crpc.auth.functions.getUserSettings.queryOptions({}),
        select: (settings) => chatActionConfirmations(settings).delete,
    });

    return data ?? true;
};
