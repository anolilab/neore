import { api } from "@neore/backend/api";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Pressable, Text } from "react-native";

import { useAuth } from "@/auth/auth-state";
import { getClient } from "@/lib/lunora";

interface ThreadRow {
    id: string;
    title: string;
}

/** Threads per request. The list asks for the next page when its end comes into view. */
const PAGE_SIZE = 100;

const fetchThreadPage = async (cursor: string | null) => {
    const data = await getClient().query(api.chat.composite.getThreadListData, { paginationOpts: { cursor, numItems: PAGE_SIZE } });

    return {
        continueCursor: data.threads.continueCursor,
        isDone: data.threads.isDone,
        rows: data.threads.page.map((thread) => {
            // eslint-disable-next-line no-underscore-dangle -- `_id` is the Lunora document id, not a private field
            return { id: thread._id, title: thread.title || "Untitled" };
        }),
    };
};

const ThreadListScreen = () => {
    const { status } = useAuth();
    const [threads, setThreads] = useState<ThreadRow[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [isDone, setIsDone] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (status !== "signed-in") {
            return undefined;
        }

        let isCancelled = false;

        const load = async () => {
            try {
                const page = await fetchThreadPage(null);

                if (!isCancelled) {
                    setThreads(page.rows);
                    setCursor(page.continueCursor);
                    setIsDone(page.isDone);
                }
            } catch (error_: unknown) {
                if (!isCancelled) {
                    setError(error_ instanceof Error ? error_.message : "Could not load chats.");
                }
            }
        };

        load();

        return () => {
            isCancelled = true;
        };
    }, [status]);

    if (error) {
        return (
            <Text accessibilityRole="alert" style={{ padding: 16 }}>
                {error}
            </Text>
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
        } catch (error_: unknown) {
            setError(error_ instanceof Error ? error_.message : "Could not load chats.");
        } finally {
            setIsLoadingMore(false);
        }
    };

    return (
        <FlatList
            data={threads}
            keyExtractor={(thread) => thread.id}
            ListHeaderComponent={(
                <Link asChild href="/chat/new">
                    <Pressable accessibilityRole="link" style={{ padding: 16 }}>
                        <Text style={{ fontWeight: "600" }}>New chat</Text>
                    </Pressable>
                </Link>
              )}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            renderItem={({ item }) => (
                <Link asChild href={`/chat/${item.id}`}>
                    <Pressable accessibilityRole="link" style={{ padding: 16 }}>
                        <Text numberOfLines={1}>{item.title}</Text>
                    </Pressable>
                </Link>
            )}
        />
    );
};

export default ThreadListScreen;
