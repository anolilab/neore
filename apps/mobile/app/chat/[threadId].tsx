import { LegendList } from "@legendapp/list/react-native";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AccessibilityInfo, Pressable, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth/auth-state";
import { fetchAccessToken } from "@/auth/grant";
import { secureGrantStore } from "@/auth/secure-store";
import { ChatError, startChat } from "@/chat/chat-api";
import { relayReply } from "@/chat/stream";
import { loadConfig } from "@/lib/config";
import { DEFAULT_CHAT_MODEL } from "@/lib/defaults";
import { getClient } from "@/lib/lunora";

interface Row {
    id: string;
    role: string;
    text: string;
}

const NEW_THREAD = "new";
const MAX_HISTORY_PAGES = 10;

/** What one stored message part shows: its text, or a label for an attachment (the preview is not in this slice yet). */
const partText = (part: unknown): string => {
    const kind = typeof part === "object" && part !== null ? (part as { type?: unknown }).type : undefined;

    if (kind === "text") {
        return String((part as { text?: unknown }).text ?? "");
    }

    return kind === "image" || kind === "file" ? "[Attachment]" : "";
};

const toRow = (message: { id: string; parts: unknown[]; role: string }): Row => {
    return {
        id: message.id,
        role: message.role,
        text: message.parts.map((part) => partText(part)).join(""),
    };
};

/** Adds `text` to the end of the row with `id`, leaving every other row as it is. */
const appendToRow = (rows: Row[], id: string, text: string): Row[] =>
    rows.map((row) => {
        if (row.id !== id) {
            return row;
        }

        return { ...row, text: row.text + text };
    });

const fetchMessagePage = (threadId: string, cursor: string | null) =>
    getClient().query(api.chat.functions.getThreadUIMessages, {
        paginationOpts: { cursor, numItems: 100 },
        threadId: threadId as Id<"threads">,
    });

const ChatScreen = () => {
    const { threadId: routeThreadId } = useLocalSearchParams<{ threadId: string }>();
    const router = useRouter();
    const { status } = useAuth();
    const [threadId, setThreadId] = useState<string | undefined>(routeThreadId === NEW_THREAD ? undefined : routeThreadId);
    const [rows, setRows] = useState<Row[]>([]);
    // Where the next older page starts; null once the whole history is loaded.
    const [olderCursor, setOlderCursor] = useState<string | null>(null);
    const [isLoadingOlder, setIsLoadingOlder] = useState(false);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The newest pages load when a chat opens; "Load older messages" fetches the rest one page at a time.
    const loadMessages = useCallback(async (id: string) => {
        try {
            const pages: Row[][] = [];
            let cursor: string | null = null;
            let isDone = false;

            for (let index = 0; !isDone && index < MAX_HISTORY_PAGES; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- each page needs the cursor of the one before it
                const page = await fetchMessagePage(id, cursor);

                // The server returns each page newest first; the rows are shown oldest first.
                pages.unshift(page.page.map((message) => toRow(message)).toReversed());
                isDone = page.isDone;
                cursor = page.continueCursor;
            }

            setRows(pages.flat());
            setOlderCursor(isDone ? null : cursor);
        } catch (error_: unknown) {
            setError(error_ instanceof Error ? error_.message : "Could not load messages.");
        }
    }, []);

    const loadOlder = async () => {
        if (!threadId || olderCursor === null || isLoadingOlder) {
            return;
        }

        setIsLoadingOlder(true);

        try {
            const page = await fetchMessagePage(threadId, olderCursor);

            setRows((current) => [...page.page.map((message) => toRow(message)).toReversed(), ...current]);
            setOlderCursor(page.isDone ? null : page.continueCursor);
        } catch (error_: unknown) {
            setError(error_ instanceof Error ? error_.message : "Could not load messages.");
        } finally {
            setIsLoadingOlder(false);
        }
    };

    useEffect(() => {
        if (status === "signed-in" && threadId && !sending) {
            loadMessages(threadId);
        }
    }, [loadMessages, sending, status, threadId]);

    const send = async () => {
        const prompt = draft.trim();

        if (!prompt || sending) {
            return;
        }

        setSending(true);
        setError(null);
        // Announced when a reply starts and when it finishes. The deltas stay silent: an announcement on each would flood the reader.
        AccessibilityInfo.announceForAccessibility("Assistant is replying");
        setDraft("");
        const stamp = Date.now();
        const assistantId = `pending-${stamp}`;

        setRows((current) => [...current, { id: `user-${stamp}`, role: "user", text: prompt }, { id: assistantId, role: "assistant", text: "" }]);

        try {
            const config = loadConfig();
            const jwt = await fetchAccessToken({ fetch, lunoraUrl: config.lunoraUrl, store: secureGrantStore });

            if (jwt === null) {
                throw new ChatError("Your sign-in expired. Sign in again.");
            }

            getClient().setAuthToken(jwt);

            const started = await startChat({
                body: { model: DEFAULT_CHAT_MODEL, prompt, threadId },
                fetch,
                gatewayUrl: config.gatewayUrl,
                jwt,
            });

            setThreadId(started.threadId);

            if (routeThreadId === NEW_THREAD) {
                router.setParams({ threadId: started.threadId });
            }

            const outcome = await relayReply({
                fetch,
                gatewayUrl: config.gatewayUrl,
                onDelta: ({ text }) => setRows((current) => appendToRow(current, assistantId, text)),
                streamToken: started.streamToken,
            });

            if (outcome === "failed") {
                throw new ChatError("The reply did not finish. Try again.");
            }

            AccessibilityInfo.announceForAccessibility("Reply finished");
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Could not send.");
        } finally {
            setSending(false);
        }
    };

    const olderHeader = olderCursor === null
        ? undefined
        : (
        <Pressable accessibilityRole="button" accessibilityState={{ busy: isLoadingOlder, disabled: isLoadingOlder }} disabled={isLoadingOlder} onPress={loadOlder} style={{ padding: 12 }}>
            <Text style={{ textAlign: "center" }}>{isLoadingOlder ? "Loading older messages..." : "Load older messages"}</Text>
        </Pressable>
        );

    return (
        <View style={{ flex: 1 }}>
            <LegendList
                data={rows}
                estimatedItemSize={72}
                keyExtractor={(row) => row.id}
                ListHeaderComponent={olderHeader}
                renderItem={({ item }) => (
                    <View style={{ alignSelf: item.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", padding: 12 }}>
                        <Text selectable>{item.text || (item.role === "assistant" ? "..." : "")}</Text>
                    </View>
                )}
            />
            {error
                ? (
                <Text accessibilityRole="alert" style={{ color: "#b00020", padding: 12 }}>
                    {error}
                </Text>
                )
                : null}
            <View style={{ flexDirection: "row", gap: 8, padding: 12 }}>
                <TextInput
                    accessibilityLabel="Message"
                    multiline
                    onChangeText={setDraft}
                    placeholder="Message"
                    style={{ borderColor: "#ccc", borderRadius: 10, borderWidth: 1, flex: 1, padding: 10 }}
                    value={draft}
                />
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: sending }}
                    disabled={sending}
                    onPress={send}
                    style={{ justifyContent: "center", padding: 12 }}
                >
                    <Text style={{ fontWeight: "600" }}>Send</Text>
                </Pressable>
            </View>
        </View>
    );
};

export default ChatScreen;
