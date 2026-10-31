import { LegendList } from "@legendapp/list/react-native";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth/auth-state";
import { fetchAccessToken } from "@/auth/grant";
import { secureGrantStore } from "@/auth/secure-store";
import { ChatError, startChat } from "@/chat/chat-api";
import { relayReply } from "@/chat/stream";
import { loadConfig } from "@/lib/config";
import { DEFAULT_CHAT_MODEL } from "@/lib/defaults";
import { getClient } from "@/lib/lunora";
import { streamingFetch } from "@/lib/streaming-fetch";
import { mergeRows } from "@/offline/merge";
import { createMessageReadGate, readOlderMessages, readThreadMessages } from "@/offline/message-read";
import { OfflineBanner } from "@/offline/offline-banner";
import { useOffline, useWriteControl } from "@/offline/offline-context";
import type { MessageRow } from "@/offline/types";
import { requireOnline } from "@/offline/write-gate";

type Row = MessageRow;

const NEW_THREAD = "new";
const MAX_HISTORY_PAGES = 10;
const REFUSED_MESSAGE = "This chat is locked or no longer available.";

/** A chat that reads again is no longer refused; any other message on screen is not this read's to clear. */
const withoutRefusal = (current: string | null): string | null => {
    if (current === REFUSED_MESSAGE) {
        return null;
    }

    return current;
};

/** What one stored message part shows: its text, or a label for an attachment (the preview is not in this slice yet). */
const partText = (part: unknown): string => {
    const kind = typeof part === "object" && part !== null ? (part as { type?: unknown }).type : undefined;

    if (kind === "text") {
        return String((part as { text?: unknown }).text ?? "");
    }

    return kind === "image" || kind === "file" ? "[Attachment]" : "";
};

/* eslint-disable no-underscore-dangle -- `_creationTime` is the Lunora document field, not a private one */
const toRow = (message: { _creationTime: number; id: string; parts: unknown[]; role: string; status: string }, threadId: string, syncedAt: number): Row => {
    return {
        createdAt: message._creationTime,
        id: message.id,
        role: message.role,
        status: message.status,
        syncedAt,
        text: message.parts.map((part) => partText(part)).join(""),
        threadId,
        updatedAt: message._creationTime,
    };
};
/* eslint-enable no-underscore-dangle */

/** A row made on this screen, before the server has stored it. It is never saved to the cache. */
const localRow = (id: string, role: string, threadId: string, text: string): Row => {
    const now = Date.now();

    return { createdAt: now, id, role, status: "local", syncedAt: now, text, threadId, updatedAt: now };
};

const byCreation = (rows: Row[]): Row[] => rows.toSorted((a, b) => a.createdAt - b.createdAt);

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

const Chat = () => {
    const { threadId: routeThreadId } = useLocalSearchParams<{ threadId: string }>();
    const router = useRouter();
    const { hasToken, status } = useAuth();
    const { cache, refreshTick, reportRead } = useOffline();
    const composer = useWriteControl("composer");
    const sendControl = useWriteControl("send");
    // Once live rows are in, a late read of the cache must not touch the thread.
    const hasLiveRows = useRef(false);
    // Set when the server refused this chat (locked, gone): a late read of the cache must not paint it again.
    const isRefused = useRef(false);
    const readGate = useRef(createMessageReadGate());
    const [threadId, setThreadId] = useState<string | undefined>(routeThreadId === NEW_THREAD ? undefined : routeThreadId);
    const [rows, setRows] = useState<Row[]>([]);
    // Where the next older page starts; null once the whole history is loaded.
    const [olderCursor, setOlderCursor] = useState<string | null>(null);
    const [isLoadingOlder, setIsLoadingOlder] = useState(false);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The send in flight, if any: leaving the screen cuts its stream instead of letting it run on.
    const sendAbort = useRef<AbortController | null>(null);

    useEffect(() => () => sendAbort.current?.abort(), []);

    // Locked, gone or no longer shared: the saved copy is dropped, and nothing of it stays on screen.
    const showRefused = useCallback(() => {
        isRefused.current = true;
        hasLiveRows.current = false;
        setRows([]);
        setOlderCursor(null);
        setError(REFUSED_MESSAGE);
    }, []);

    // The newest pages load when a chat opens; "Load older messages" fetches the rest one page at a time.
    const loadMessages = useCallback(async (id: string) => {
        const result = await readThreadMessages({
            cache,
            fetchRows: async (startedAt) => {
                const pages: Row[][] = [];
                let cursor: string | null = null;
                let isDone = false;

                for (let index = 0; !isDone && index < MAX_HISTORY_PAGES; index += 1) {
                    // eslint-disable-next-line no-await-in-loop -- each page needs the cursor of the one before it
                    const page = await fetchMessagePage(id, cursor);

                    // The server returns each page newest first; the rows are shown oldest first.
                    pages.unshift(page.page.map((message) => toRow(message, id, startedAt)).toReversed());
                    isDone = page.isDone;
                    cursor = page.continueCursor;
                }

                return { olderCursor: isDone ? null : cursor, rows: pages.flat() };
            },
            gate: readGate.current,
            threadId: id,
        });

        switch (result.kind) {
            case "failed": {
                setError(result.message);
                break;
            }
            case "refused": {
                showRefused();
                reportRead("succeeded");
                break;
            }
            case "rows": {
                isRefused.current = false;
                hasLiveRows.current = true;
                setRows(result.rows);
                setOlderCursor(result.olderCursor);
                setError(withoutRefusal);
                reportRead("succeeded");
                break;
            }
            case "unreachable": {
                // No answer is not an error to show: the saved messages stay, under the offline banner.
                reportRead("failed");
                break;
            }
            default: {
                // Superseded by a newer read, which reports for itself.
                break;
            }
        }
    }, [cache, reportRead, showRefused]);

    const loadOlder = async () => {
        if (!threadId || olderCursor === null || isLoadingOlder) {
            return;
        }

        setIsLoadingOlder(true);

        try {
            const result = await readOlderMessages({
                cache,
                fetchPage: async () => {
                    const page = await fetchMessagePage(threadId, olderCursor);
                    const syncedAt = Date.now();

                    return { olderCursor: page.isDone ? null : page.continueCursor, rows: page.page.map((message) => toRow(message, threadId, syncedAt)).toReversed() };
                },
                gate: readGate.current,
                threadId,
            });

            switch (result.kind) {
                case "failed": {
                    setError(result.message);
                    break;
                }
                case "page": {
                    setRows((current) => [...result.rows, ...current]);
                    setOlderCursor(result.olderCursor);
                    break;
                }
                case "refused": {
                    showRefused();
                    break;
                }
                case "unreachable": {
                    setError("Could not load older messages. You appear to be offline.");
                    break;
                }
                default: {
                    // The screen moved on while the page loaded.
                    break;
                }
            }
        } finally {
            setIsLoadingOlder(false);
        }
    };

    // The saved messages paint first; live rows replace them, and a cached row never replaces a newer live one.
    useEffect(() => {
        if (status !== "signed-in" || !threadId || !cache) {
            return undefined;
        }

        let isCancelled = false;

        const showCached = async () => {
            try {
                const cached = await cache.loadMessages(threadId);

                if (!isCancelled && !hasLiveRows.current && !isRefused.current && cached.length > 0) {
                    setRows((current) => byCreation(mergeRows(current, cached)));
                }
            } catch {
                // An unreadable cache is an empty one.
            }
        };

        showCached();

        return () => {
            isCancelled = true;
        };
    }, [cache, status, threadId]);

    useEffect(() => {
        const gate = readGate.current;

        // A read begun for another chat must not land on this one.
        return () => gate.invalidate();
    }, [threadId]);

    useEffect(() => {
        // Without a token (a launch with no network) the saved messages are all there is; the read waits for one.
        if (status === "signed-in" && hasToken && threadId && !sending) {
            loadMessages(threadId);
        }
    }, [hasToken, loadMessages, refreshTick, sending, status, threadId]);

    const send = async () => {
        const prompt = draft.trim();

        if (!prompt || sending || sendControl.disabled) {
            return;
        }

        const controller = new AbortController();

        sendAbort.current = controller;
        setSending(true);
        setError(null);
        // Announced when a reply starts and when it finishes. The deltas stay silent: an announcement on each would flood the reader.
        AccessibilityInfo.announceForAccessibility("Assistant is replying");
        setDraft("");
        const stamp = Date.now();
        const assistantId = `pending-${stamp}`;

        setRows((current) => [...current, localRow(`user-${stamp}`, "user", threadId ?? NEW_THREAD, prompt), localRow(assistantId, "assistant", threadId ?? NEW_THREAD, "")]);

        try {
            const config = loadConfig();
            const jwt = await fetchAccessToken({ fetch, lunoraUrl: config.lunoraUrl, store: secureGrantStore });

            if (jwt === null) {
                throw new ChatError("Your sign-in expired. Sign in again.");
            }

            getClient().setAuthToken(jwt);

            // Nothing is held back for later: a send that finds the app offline is refused, not queued.
            const started = await requireOnline({ isOffline: sendControl.disabled }, () =>
                startChat({
                    body: { model: DEFAULT_CHAT_MODEL, prompt, threadId },
                    fetch,
                    gatewayUrl: config.gatewayUrl,
                    jwt,
                }));

            setThreadId(started.threadId);

            if (routeThreadId === NEW_THREAD) {
                router.setParams({ threadId: started.threadId });
            }

            const outcome = await relayReply({
                fetch: streamingFetch,
                gatewayUrl: config.gatewayUrl,
                onDelta: ({ text }) => setRows((current) => appendToRow(current, assistantId, text)),
                signal: controller.signal,
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

    const syncedTimes = rows.filter((row) => row.status !== "local").map((row) => row.syncedAt);
    const syncedAt = syncedTimes.length === 0 ? undefined : Math.max(...syncedTimes);

    return (
        <View style={{ flex: 1 }}>
            <OfflineBanner syncedAt={syncedAt} />
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
                    accessibilityHint={composer.reason}
                    accessibilityLabel="Message"
                    accessibilityState={{ disabled: composer.disabled }}
                    editable={!composer.disabled}
                    multiline
                    onChangeText={setDraft}
                    placeholder="Message"
                    style={{ borderColor: "#ccc", borderRadius: 10, borderWidth: 1, flex: 1, padding: 10 }}
                    value={draft}
                />
                <Pressable
                    accessibilityHint={sendControl.reason}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: sending || sendControl.disabled }}
                    disabled={sending || sendControl.disabled}
                    onPress={send}
                    style={{ justifyContent: "center", opacity: sendControl.disabled ? 0.5 : 1, padding: 12 }}
                >
                    <Text style={{ fontWeight: "600" }}>Send</Text>
                </Pressable>
            </View>
            {sendControl.reason ? <Text style={{ fontSize: 12, paddingBottom: 8, paddingHorizontal: 12 }}>{sendControl.reason}</Text> : null}
        </View>
    );
};

/** Keyed by the signed-in account, so one account's messages never stay in screen state for the next. */
// eslint-disable-next-line react/function-component-definition -- the default export is declared inline (unicorn/default-export-style), which makes it a function declaration
export default function ChatScreen() {
    const { user } = useAuth();

    return <Chat key={user?.id ?? "none"} />;
}
