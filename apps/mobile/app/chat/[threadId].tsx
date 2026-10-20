import { LegendList } from "@legendapp/list/react-native";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth/auth-context";
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

/** The text parts of a stored UI message. Other part kinds are not shown in this slice. */
const toRow = (message: { id: string; parts: unknown[]; role: string }): Row => {
    return {
        id: message.id,
        role: message.role,
        text: message.parts
            .map((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")
            .join(""),
    };
};

export default function ChatScreen() {
    const { threadId: routeThreadId } = useLocalSearchParams<{ threadId: string }>();
    const router = useRouter();
    const { status } = useAuth();
    const [threadId, setThreadId] = useState<string | undefined>(routeThreadId === NEW_THREAD ? undefined : routeThreadId);
    const [rows, setRows] = useState<Row[]>([]);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadMessages = useCallback(async (id: string) => {
        const page = await getClient().query(api.chat.functions.getThreadUIMessages, {
            paginationOpts: { cursor: null, numItems: 100 },
            threadId: id as Id<"threads">,
        });

        setRows(page.page.map(toRow));
    }, []);

    useEffect(() => {
        if (status === "signed-in" && threadId && !sending) {
            loadMessages(threadId).catch((error_: unknown) => setError(error_ instanceof Error ? error_.message : "Could not load messages."));
        }
    }, [loadMessages, sending, status, threadId]);

    const send = async () => {
        const prompt = draft.trim();

        if (!prompt || sending) {
            return;
        }

        setSending(true);
        setError(null);
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
                body: { model: DEFAULT_CHAT_MODEL, prompt, ...threadId && { threadId } },
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
                onDelta: ({ text }) => setRows((current) => current.map((row) => (row.id === assistantId ? { ...row, text: row.text + text } : row))),
                streamToken: started.streamToken,
            });

            if (outcome === "failed") {
                throw new ChatError("The reply did not finish. Try again.");
            }
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Could not send.");
        } finally {
            setSending(false);
        }
    };

    return (
        <View style={{ flex: 1 }}>
            <LegendList
                data={rows}
                estimatedItemSize={72}
                keyExtractor={(row) => row.id}
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
                <Pressable accessibilityRole="button" accessibilityState={{ disabled: sending }} disabled={sending} onPress={send} style={{ justifyContent: "center", padding: 12 }}>
                    <Text style={{ fontWeight: "600" }}>Send</Text>
                </Pressable>
            </View>
        </View>
    );
}
