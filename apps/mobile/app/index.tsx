import { api } from "@neore/backend/api";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Pressable, Text } from "react-native";

import { useAuth } from "@/auth/auth-context";
import { getClient } from "@/lib/lunora";

interface ThreadRow {
    id: string;
    title: string;
}

export default function ThreadListScreen() {
    const { status } = useAuth();
    const [threads, setThreads] = useState<ThreadRow[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (status !== "signed-in") {
            return;
        }

        let isCancelled = false;

        getClient()
            .query(api.chat.composite.getThreadListData, { paginationOpts: { cursor: null, numItems: 100 } })
            .then((data) => {
                if (!isCancelled) {
                    setThreads(data.threads.page.map((thread) => { return { id: thread._id, title: thread.title || "Untitled" }; }));
                }
            })
            .catch((error_: unknown) => {
                if (!isCancelled) {
                    setError(error_ instanceof Error ? error_.message : "Could not load chats.");
                }
            });

        return () => {
            isCancelled = true;
        };
    }, [status]);

    if (error) {
        return <Text accessibilityRole="alert" style={{ padding: 16 }}>{error}</Text>;
    }

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
            renderItem={({ item }) => (
                <Link asChild href={`/chat/${item.id}`}>
                    <Pressable accessibilityRole="link" style={{ padding: 16 }}>
                        <Text numberOfLines={1}>{item.title}</Text>
                    </Pressable>
                </Link>
            )}
        />
    );
}
