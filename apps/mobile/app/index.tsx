import { api } from "@neore/backend/api";
import { Link } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, Text } from "react-native";

import { useAuth } from "@/auth/auth-state";
import { getClient } from "@/lib/lunora";
import { isNetworkFailure } from "@/offline/connectivity";
import { displayStatus } from "@/offline/labels";
import { mergeRows } from "@/offline/merge";
import { OfflineBanner } from "@/offline/offline-banner";
import { useOffline, useWriteControl } from "@/offline/offline-context";
import type { ThreadPage } from "@/offline/thread-list";
import { combineFirstPage, listNotice, loadCachedThreads, persistThreadPage, readLiveThreadList } from "@/offline/thread-list";
import type { ShownStatus, ThreadRow } from "@/offline/types";
import { useHostStatuses } from "@/offline/use-host-statuses";

/** Threads per request. The list asks for the next page when its end comes into view. */
const PAGE_SIZE = 100;

const fetchThreadPage = async (cursor: string | null, startedAt: number): Promise<ThreadPage> => {
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
                syncedAt: startedAt,
                title: thread.title || "Untitled",
                updatedAt: thread.updatedAt ?? thread._creationTime,
                ...thread.runner === "host" && { runner: "host" as const },
            };
            /* eslint-enable no-underscore-dangle */
        }),
    };
};

/** A host or worker status line for a row; any other thread shows one only while it is running. */
const statusLine = (thread: ThreadRow, tracked: ShownStatus | undefined, isOffline: boolean, isLive: boolean) => {
    if (tracked) {
        return <Text style={{ fontSize: 12 }}>{displayStatus(tracked.status, { fromCache: tracked.fromCache, isOffline, lastSeenAt: tracked.lastSeenAt })}</Text>;
    }

    if (thread.status === "running") {
        return <Text style={{ fontSize: 12 }}>{displayStatus(thread.status, { fromCache: !isLive, isOffline, lastSeenAt: thread.syncedAt })}</Text>;
    }

    return null;
};

const ThreadList = () => {
    const { hasToken, status } = useAuth();
    const { cache, isOffline, refreshTick, reportRead } = useOffline();
    const startChat = useWriteControl("start");
    const statuses = useHostStatuses();
    const [threads, setThreads] = useState<ThreadRow[]>([]);
    // Once live data is in, a late read of the cache must not touch the list.
    const hasLiveData = useRef(false);
    // The same fact for the render: until live data is in, every row is a saved copy and a running one reads "Last seen".
    const [isLive, setIsLive] = useState(false);
    const [cursor, setCursor] = useState<string | null>(null);
    const [isDone, setIsDone] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [cacheChecked, setCacheChecked] = useState(false);
    // A refusal of the read, shown above the rows that stay on screen. Cleared when a read starts, so a reconnect ends it.
    const [loadError, setLoadError] = useState<string | undefined>();

    useEffect(() => {
        if (status !== "signed-in") {
            return undefined;
        }

        let isCancelled = false;

        // The saved list paints first. Live rows replace it when they arrive, and a cached row never replaces a newer live one.
        const showCached = async () => {
            const cached = await loadCachedThreads(cache);

            if (!isCancelled) {
                if (!hasLiveData.current && cached.length > 0) {
                    setThreads((current) => mergeRows(current, cached));
                }

                // Not "checked" while the account's cache is still binding: nothing is known about what is saved yet.
                setCacheChecked(cache !== undefined);
            }
        };

        const load = async () => {
            setLoadError(undefined);

            const cachedShown = showCached();

            // No token yet (a launch with no network): the saved list is all there is until one is minted.
            if (!hasToken) {
                await cachedShown;

                return;
            }

            const result = await readLiveThreadList({ cache, fetchFirstPage: (startedAt) => fetchThreadPage(null, startedAt) });

            if (isCancelled) {
                return;
            }

            switch (result.kind) {
                case "page": {
                    // A complete list is the whole truth (the cache was just pruned to it). A partial first page is only
                    // the newest 100: the saved rows beyond it stay until later pages replace them.
                    const shown = result.page.isDone ? result.page.rows : combineFirstPage(result.page.rows, await loadCachedThreads(cache));

                    if (isCancelled) {
                        return;
                    }

                    hasLiveData.current = true;
                    setIsLive(true);
                    setThreads(shown);
                    setCursor(result.page.continueCursor);
                    setIsDone(result.page.isDone);
                    reportRead("succeeded");
                    break;
                }
                case "unreachable": {
                    // No answer is not an error to show: the saved list stays, under the offline banner.
                    reportRead("failed");
                    break;
                }
                default: {
                    // The server answered with a refusal: say so, and keep the saved rows on screen.
                    setLoadError(result.message);
                    break;
                }
            }
        };

        load();

        return () => {
            isCancelled = true;
        };
    }, [cache, hasToken, refreshTick, reportRead, status]);

    const loadMore = async () => {
        if (isDone || isLoadingMore) {
            return;
        }

        setIsLoadingMore(true);

        const startedAt = Date.now();

        try {
            const page: ThreadPage = await fetchThreadPage(cursor, startedAt);

            setThreads((current) => {
                const known = new Set(current.map((thread) => thread.id));

                return [...current, ...page.rows.filter((thread) => !known.has(thread.id))];
            });
            setCursor(page.continueCursor);
            setIsDone(page.isDone);
            // A later page says nothing about the threads of the pages before it: it saves, and never prunes.
            persistThreadPage(cache, page, { isComplete: false, startedAt });
        } catch (error_: unknown) {
            if (isNetworkFailure(error_)) {
                // The rows already on screen stay; the offline banner says why more did not load.
                reportRead("failed");
            } else {
                setLoadError(error_ instanceof Error ? error_.message : "Could not load chats.");
            }
        } finally {
            setIsLoadingMore(false);
        }
    };

    const syncedAt = threads.length === 0 ? undefined : Math.max(...threads.map((thread) => thread.syncedAt));
    const notice = listNotice({ cacheChecked, isOffline, loadError, rowCount: threads.length });

    return (
        <FlatList
            data={threads}
            keyExtractor={(thread) => thread.id}
            ListHeaderComponent={(
                <>
                    <OfflineBanner syncedAt={syncedAt} />
                    {notice ? <Text accessibilityRole="alert" style={{ padding: 16 }}>{notice}</Text> : null}
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
                        {statusLine(item, statuses.get(item.id), isOffline, isLive)}
                    </Pressable>
                </Link>
            )}
        />
    );
};

/** Keyed by the signed-in account, so the rows of one account never stay in screen state for the next. */
// eslint-disable-next-line react/function-component-definition -- the default export is declared inline (unicorn/default-export-style), which makes it a function declaration
export default function ThreadListScreen() {
    const { user } = useAuth();

    return <ThreadList key={user?.id ?? "none"} />;
}
