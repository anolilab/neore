"use client";

import { api } from "@neore/backend/api";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import type { ChangelogEntry } from "@/features/changelog/types";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useAction } from "@/lib/lunora/crpc";

const STORAGE_KEY = "neore:changelog:viewed";

const readViewedIds = (): Set<string> => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);

        return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set();
    } catch {
        return new Set();
    }
};

const persistViewedIds = (ids: Set<string>) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
    } catch {
        // ignore storage errors
    }
};

const useChangelog = () => {
    const fetchChangelogs = useAction(api.changelog.functions.getChangelogs);
    // Nothing on first paint needs the changelog — an unread badge can land later.
    const afterFirstPaint = useAfterFirstPaint();

    const { data: changelogs = [], isLoading } = useQuery<ChangelogEntry[]>({
        enabled: afterFirstPaint,
        gcTime: 1000 * 60 * 60,
        queryFn: () => fetchChangelogs({}),
        queryKey: ["changelog"],
        retry: 1,
        staleTime: 1000 * 60 * 30, // 30 min client-side cache
    });

    const [viewedIds, setViewedIds] = useState<Set<string>>(new Set());

    // Hydrate viewed IDs from localStorage on mount (avoids SSR mismatch)
    useEffect(() => {
        setViewedIds(readViewedIds());
    }, []);

    // The write to localStorage happens outside the updater: React may replay a
    // state updater, and a replayed persist would run twice.
    const markAsViewed = useCallback(
        (id: string) => {
            const next = new Set([...viewedIds, id]);

            persistViewedIds(next);
            setViewedIds(next);
        },
        [viewedIds],
    );

    const markAllAsViewed = useCallback(() => {
        const next = new Set([...viewedIds, ...changelogs.map((c) => c.id)]);

        persistViewedIds(next);
        setViewedIds(next);
    }, [changelogs, viewedIds]);

    const unread = changelogs.filter((c) => !viewedIds.has(c.id));
    const latestUnread = unread[0] ?? null;

    return {
        changelogs,
        isLoading,
        latestUnread,
        markAllAsViewed,
        markAsViewed,
        unreadCount: unread.length,
        viewedIds,
    };
};

export default useChangelog;
