import { api } from "@neore/backend/api";
import { Link } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, Text } from "react-native";

import { useAuth } from "@/auth/auth-state";
import { getClient } from "@/lib/lunora";
import type { ScopedCache } from "@/offline/cache";
import { isNetworkFailure } from "@/offline/connectivity";
import { displayStatus } from "@/offline/labels";
import { mergeRows } from "@/offline/merge";
import { OfflineBanner } from "@/offline/offline-banner";
import { useOffline, useWriteControl } from "@/offline/offline-context";
import { settleQuietly } from "@/offline/quietly";
import type { StatusRow, ThreadRow } from "@/offline/types";
import { useHostStatuses } from "@/offline/use-host-statuses";

/** Threads per request. The list asks for the next page when its end comes into view. */
const PAGE_SIZE = 100;

const fetchThreadPage = async (cursor: string | null) => {
    const data = await getClient().query(api.chat.composite.getThreadListData, { paginationOpts: { cursor, numItems: PAGE_SIZE } });

    return {
        continueCursor: data.threads.continueCursor,
        isDone: data.threads.isDone,
        // A locked thread's title is its content: it is listed, never saved to the device.
        // eslint-disable-next-line no-underscore-dangle -- `_id` is the Lunora document id, not a private field
        lockedIds: new Set(data.threads.page.filter((thread) => thread.lockedAt !== undefined && thread.lockedAt !== null).map((thread) => thread._id as string)),
        rows: data.threads.page.map((thread): ThreadRow => {
            /* eslint-disable no-underscore-dangle -- `_id` and `_creationTime` are the Lunora document fields, not private ones */
            return {
                id: thread._id,
                status: thread.status,
                syncedAt: Date.now(),
                title: thread.title || "Untitled",
                updatedAt: thread.updatedAt ?? thread._creationTime,
                ...thread.runner === "host" && { runner: "host" as const },
            };
            /* eslint-enable no-underscore-dangle */
        }),
    };
};

const saveThreadPage = (cache: ScopedCache | undefined, page: Awaited<ReturnType<typeof fetchThreadPage>>) => {
    settleQuietly(cache?.saveThreads(page.rows.filter((thread) => !page.lockedIds.has(thread.id))));
    // Locked after it was saved: its title is content now, so the copy goes. A page that merely lacks a thread removes nothing.
    settleQuietly(cache?.forgetThreads([...page.lockedIds]));
};

/** A host or worker status line for a row; any other thread shows one only while it is running. */
const statusLine = (thread: ThreadRow, tracked: StatusRow | undefined, isOffline: boolean) => {
    if (tracked) {
        return <Text style={{ fontSize: 12 }}>{displayStatus(tracked.status, { isOffline, lastSeenAt: tracked.lastSeenAt })}</Text>;
    }

    if (thread.status === "running") {
        return <Text style={{ fontSize: 12 }}>{displayStatus(thread.status, { isOffline, lastSeenAt: thread.syncedAt })}</Text>;
    }

    return null;
};

const ThreadListScreen = () => {
    const { hasToken, status } = useAuth();
    const { cache, isOffline, refreshTick, reportRead } = useOffline();
    const startChat = useWriteControl("start");
    const statuses = useHostStatuses();
    const [threads, setThreads] = useState<ThreadRow[]>([]);
    // Once live data is in, a late read of the cache must not touch the list.
    const hasLiveData = useRef(false);
    const [cursor, setCursor] = useState<string | null>(null);
    const [isDone, setIsDone] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (status !== "signed-in") {
            return undefined;
        }

        let isCancelled = false;

        // The saved list paints first. Live rows replace it when they arrive, and a cached row never replaces a newer live one.
        const showCached = async (): Promise<number> => {
            let cached: ThreadRow[] = [];

            try {
                cached = await cache?.loadThreads() ?? [];
            } catch {
                // An unreadable cache is an empty one.
            }

            if (!isCancelled && !hasLiveData.current && cached.length > 0) {
                setThreads((current) => mergeRows(current, cached));
            }

            return cached.length;
        };

        const load = async () => {
            const cachedCount = showCached();

            // No token yet (a launch with no network): the saved list is all there is until one is minted.
            if (!hasToken) {
                await cachedCount;

                return;
            }

            try {
                const page = await fetchThreadPage(null);

                if (!isCancelled) {
                    hasLiveData.current = true;
                    setThreads(page.rows);
                    setCursor(page.continueCursor);
                    setIsDone(page.isDone);
                    setError(null);
                    reportRead("succeeded");
                    saveThreadPage(cache, page);
                }
            } catch (error_: unknown) {
                if (isCancelled) {
                    return;
                }

                if (isNetworkFailure(error_)) {
                    // No answer is not an error to show: the saved list stays, under the offline banner.
                    reportRead("failed");

                    if (await cachedCount === 0) {
                        setError("You are offline and nothing is saved on this device yet.");
                    }

                    return;
                }

                setError(error_ instanceof Error ? error_.message : "Could not load chats.");
            }
        };

        load();

        return () => {
            isCancelled = true;
        };
    }, [cache, hasToken, refreshTick, reportRead, status]);

    if (error) {
        return (
            <>
                <OfflineBanner syncedAt={undefined} />
                <Text accessibilityRole="alert" style={{ padding: 16 }}>
                    {error}
                </Text>
            </>
        );
    }

    const loadMore = async () => {
        if (isDone || isLoadingMore) {
            return;
        }

        setIsLoadingMore(true);

        try {
            const page = await fetchThreadPage(cursor);

            setThreads((current) => {
                const known = new Set(current.map((thread) => thread.id));

                return [...current, ...page.rows.filter((thread) => !known.has(thread.id))];
            });
            setCursor(page.continueCursor);
            setIsDone(page.isDone);
            saveThreadPage(cache, page);
        } catch (error_: unknown) {
            if (isNetworkFailure(error_)) {
                // The rows already on screen stay; the offline banner says why more did not load.
                reportRead("failed");
            } else {
                setError(error_ instanceof Error ? error_.message : "Could not load chats.");
            }
        } finally {
            setIsLoadingMore(false);
        }
    };

    // When the list was last synced: the newest sync among its rows.
    const syncedAt = threads.length === 0 ? undefined : Math.max(...threads.map((thread) => thread.syncedAt));

    return (
        <FlatList
            data={threads}
            keyExtractor={(thread) => thread.id}
            ListHeaderComponent={(
                <>
                    <OfflineBanner syncedAt={syncedAt} />
                    <Link asChild href="/chat/new">
                        <Pressable
                            accessibilityHint={startChat.reason}
                            accessibilityRole="link"
                            accessibilityState={{ disabled: startChat.disabled }}
                            disabled={startChat.disabled}
                            style={{ opacity: startChat.disabled ? 0.5 : 1, padding: 16 }}
                        >
                            <Text style={{ fontWeight: "600" }}>New chat</Text>
                            {startChat.reason ? <Text style={{ fontSize: 12 }}>{startChat.reason}</Text> : null}
                        </Pressable>
                    </Link>
                </>
              )}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            renderItem={({ item }) => (
                <Link asChild href={`/chat/${item.id}`}>
                    <Pressable accessibilityRole="link" style={{ padding: 16 }}>
                        <Text numberOfLines={1}>{item.title}</Text>
                        {statusLine(item, statuses.get(item.id), isOffline)}
                    </Pressable>
                </Link>
            )}
        />
    );
};

export default ThreadListScreen;
