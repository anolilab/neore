import { LegendList } from "@legendapp/list/react-native";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ComponentRef } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Keyboard, KeyboardAvoidingView, Pressable, Share, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/auth/auth-state";
import { fetchAccessToken } from "@/auth/grant";
import { secureGrantStore } from "@/auth/secure-store";
import { ChatError, startChat } from "@/chat/chat-api";
import { displayTextOf, shareTextOf } from "@/chat/message-parts";
import { shareableMessageText, shareLabel } from "@/chat/share-message";
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

/** A row on this screen; `finished` marks a local row whose send completed, which no server read has confirmed yet. */
type Row = MessageRow & { finished?: boolean };

const NEW_THREAD = "new";
const MAX_HISTORY_PAGES = 10;
/** Follow-up reads, and how far apart, after a reply the relay could not confirm as complete. */
const CONFIRM_READS = 6;
const CONFIRM_READ_INTERVAL_MS = 2000;
const REFUSED_MESSAGE = "This chat is locked or no longer available.";
const SHARE_FAILED_MESSAGE = "The message could not be shared. Try again.";

/** The server's replies on screen: every assistant row that is not a local one. */
const serverReplies = (rows: Row[]): Row[] => rows.filter((row) => row.role === "assistant" && row.status !== "local");

/** The creation time of the newest server reply on screen, or 0 when there is none. */
const latestReplyTime = (rows: Row[]): number => Math.max(0, ...serverReplies(rows).map((row) => row.createdAt));

/** A failed share fills an empty error slot; an error already on screen is not replaced by it. */
const withShareFailure = (current: string | null): string | null => current ?? SHARE_FAILED_MESSAGE;

/** A share that works clears the share failure on screen; any other error on screen is not the share's to clear. */
const withoutShareFailure = (current: string | null): string | null => {
    if (current === SHARE_FAILED_MESSAGE) {
        return null;
    }

    return current;
};

/** A chat that reads again is no longer refused; any other message on screen is not this read's to clear. */
const withoutRefusal = (current: string | null): string | null => {
    if (current === REFUSED_MESSAGE) {
        return null;
    }

    return current;
};

/* eslint-disable no-underscore-dangle -- `_creationTime` is the Lunora document field, not a private one */
const toRow = (message: { _creationTime: number; id: string; parts: unknown[]; role: string; status: string }, threadId: string, syncedAt: number): Row => {
    return {
        createdAt: message._creationTime,
        id: message.id,
        role: message.role,
        shareText: shareTextOf(message.parts),
        status: message.status,
        syncedAt,
        text: displayTextOf(message.parts),
        threadId,
        updatedAt: message._creationTime,
    };
};
/* eslint-enable no-underscore-dangle */

/** A row made on this screen, before the server has stored it. It is never saved to the cache. */
const localRow = (id: string, role: string, threadId: string, text: string): Row => {
    const now = Date.now();

    return { createdAt: now, id, role, shareText: text, status: "local", syncedAt: now, text, threadId, updatedAt: now };
};

const byCreation = (rows: Row[]): Row[] => rows.toSorted((a, b) => a.createdAt - b.createdAt);

/** Marks a row on this screen as finished, so it can be shared before the server's copy replaces it. */
const finishRow = (rows: Row[], id: string): Row[] =>
    rows.map((row) => {
        if (row.id !== id) {
            return row;
        }

        return { ...row, finished: true };
    });

/** Adds `text` to the end of the row with `id`, leaving every other row as it is. */
const appendToRow = (rows: Row[], id: string, text: string): Row[] =>
    rows.map((row) => {
        if (row.id !== id) {
            return row;
        }

        return { ...row, shareText: row.shareText + text, text: row.text + text };
    });

const fetchMessagePage = (threadId: string, cursor: string | null) =>
    getClient().query(api.chat.functions.getThreadUIMessages, {
        paginationOpts: { cursor, numItems: 100 },
        threadId: threadId as Id<"threads">,
    });

type MessagePage = Awaited<ReturnType<typeof fetchMessagePage>>["page"];

/* eslint-disable no-underscore-dangle -- `_creationTime` is the Lunora document field, not a private one */

/**
 * The creation time of the send's own user message: the newest user message on the page that reads `prompt` and was
 * created after `after`, the newest reply on screen when the send began. Null while the page does not hold it yet.
 */
const sentAtOf = (messages: MessagePage, prompt: string, after: number): number | null => {
    const sent = messages.find((message) => message.role === "user" && displayTextOf(message.parts) === prompt && message._creationTime > after);

    return sent ? sent._creationTime : null;
};

/**
 * Whether the page holds a reply to the send created after its user message, with a final status. A reply made before
 * the send cannot satisfy it, however settled it is.
 */
const hasSettledReplySince = (messages: MessagePage, sentAt: number): boolean =>
    messages.some((message) => message.role === "assistant" && message._creationTime > sentAt && (message.status === "success" || message.status === "failed"));

/* eslint-enable no-underscore-dangle */

/**
 * Replaces the newest rows with a fresh read and keeps the older rows already on screen, so a refresh does not drop
 * history loaded page by page. Local rows are never kept: the read either has their server copy or they are still
 * being written, and the read is newer than either.
 */
const withFreshRows = (current: Row[], fresh: Row[]): Row[] => {
    const oldest = fresh[0]?.createdAt ?? 0;
    const freshIds = new Set(fresh.map((row) => row.id));
    const older = current.filter((row) => row.createdAt < oldest && !freshIds.has(row.id) && row.status !== "local" && !row.finished);

    return [...older, ...fresh];
};

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
    const insets = useSafeAreaInsets();
    const [keyboardShown, setKeyboardShown] = useState(false);
    // The header sits above this view, so the keyboard offset is the view's distance from the window top.
    const [topOffset, setTopOffset] = useState(0);
    const rootRef = useRef<ComponentRef<typeof View>>(null);
    const measureTopOffset = useCallback(() => {
        rootRef.current?.measureInWindow((_x, y) => setTopOffset(y));
    }, []);

    useEffect(() => {
        const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardShown(true));
        const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardShown(false));

        return () => {
            show.remove();
            hide.remove();
        };
    }, []);
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
    const loadMessages = useCallback(
        async (id: string) => {
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
                    setRows((current) => withFreshRows(current, result.rows));
                    // Older pages already loaded keep their cursor; the fresh read only ever sets the first one.
                    setOlderCursor((current) => current ?? result.olderCursor);
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
        },
        [cache, reportRead, showRefused],
    );

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

                    return {
                        olderCursor: page.isDone ? null : page.continueCursor,
                        rows: page.page.map((message) => toRow(message, threadId, syncedAt)).toReversed(),
                    };
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

    // After a send, check the newest page on a timer until the server's copy of the reply is final. Each check reads one
    // page, so older pages on screen are not touched; a full read happens once, when the check settles or runs out.
    const [confirmation, setConfirmation] = useState<{ after: number; prompt: string; threadId: string } | null>(null);
    const [confirmTick, setConfirmTick] = useState(0);
    const isAwaitingReply = confirmation !== null && confirmation.threadId === threadId;

    useEffect(() => {
        if (!isAwaitingReply || confirmation === null) {
            return undefined;
        }

        const { after, prompt, threadId: id } = confirmation;
        let reads = 0;
        let isActive = true;
        let isChecking = false;
        // The send's user message, found once the newest page holds it. Until then no reply can be known as its reply.
        let sentAt: number | null = null;

        const check = async () => {
            if (isChecking) {
                return;
            }

            isChecking = true;
            reads += 1;
            let isConfirmed = false;

            try {
                const { page } = await fetchMessagePage(id, null);

                if (sentAt === null) {
                    sentAt = sentAtOf(page, prompt, after);
                }

                isConfirmed = sentAt !== null && hasSettledReplySince(page, sentAt);
            } catch {
                // A failed check is tried again on the next tick.
            }

            isChecking = false;

            if (isActive && (isConfirmed || reads >= CONFIRM_READS)) {
                setConfirmation(null);
                setConfirmTick((tick) => tick + 1);
            }
        };

        const timer = setInterval(check, CONFIRM_READ_INTERVAL_MS);

        return () => {
            isActive = false;
            clearInterval(timer);
        };
    }, [confirmation, isAwaitingReply]);

    useEffect(() => {
        // Without a token (a launch with no network) the saved messages are all there is; the read waits for one.
        if (status === "signed-in" && hasToken && threadId && !sending) {
            loadMessages(threadId);
        }
    }, [confirmTick, hasToken, loadMessages, refreshTick, sending, status, threadId]);

    const send = async () => {
        const prompt = draft.trim();

        if (!prompt || sending || sendControl.disabled) {
            return;
        }

        if (isAwaitingReply) {
            setError("Wait for the last reply to finish before sending another.");

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
        const userId = `user-${stamp}`;
        const assistantId = `pending-${stamp}`;
        // The newest reply on screen when the send began; the reply to wait for is created after it and after the send's message.
        const after = latestReplyTime(rows);

        setConfirmation(null);

        readGate.current.invalidate();
        setRows((current) => [
            ...current,
            localRow(userId, "user", threadId ?? NEW_THREAD, prompt),
            localRow(assistantId, "assistant", threadId ?? NEW_THREAD, ""),
        ]);

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
            // The prompt is complete once the server has accepted it, whether or not the screen's next read succeeds.
            setRows((current) => finishRow(current, userId));

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

            // Only a reply relayed through its end marker is complete here. Either way the server's copy is re-read until it is final.
            if (outcome === "finished") {
                setRows((current) => finishRow(current, assistantId));
            }

            setConfirmation({ after, prompt, threadId: started.threadId });

            AccessibilityInfo.announceForAccessibility("Reply finished");
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Could not send.");
        } finally {
            setSending(false);
        }
    };

    const olderHeader
        = olderCursor === null
            ? undefined
            : (
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: isLoadingOlder, disabled: isLoadingOlder }}
                disabled={isLoadingOlder}
                onPress={loadOlder}
                style={{ padding: 12 }}
            >
                <Text style={{ textAlign: "center" }}>{isLoadingOlder ? "Loading older messages..." : "Load older messages"}</Text>
            </Pressable>
            );

    /** Opens the system share sheet. Cancelling resolves normally, so a rejection is a failure to open it. */
    const shareRow = async (text: string): Promise<void> => {
        try {
            await Share.share({ message: text });
            setError(withoutShareFailure);
        } catch (shareError) {
            console.warn("Could not open the share sheet.", shareError);
            setError(withShareFailure);
        }
    };

    // The home indicator's inset, which the open keyboard already covers.
    const safeBottom = keyboardShown ? 0 : insets.bottom;
    const syncedTimes = rows.filter((row) => row.status !== "local" && row.finished !== true).map((row) => row.syncedAt);
    const syncedAt = syncedTimes.length === 0 ? undefined : Math.max(...syncedTimes);

    return (
        <View onLayout={measureTopOffset} ref={rootRef} style={{ flex: 1 }}>
            <OfflineBanner syncedAt={syncedAt} />
            <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={topOffset} style={{ flex: 1 }}>
                <LegendList
                    data={rows}
                    estimatedItemSize={72}
                    keyExtractor={(row) => row.id}
                    ListHeaderComponent={olderHeader}
                    renderItem={({ item }) => {
                        // Only a finished message can be shared: one still streaming, or one that failed, is not the whole text.
                        const isFinished = item.status === "success" || item.finished === true;
                        const shareText = isFinished ? shareableMessageText({ text: item.shareText }) : undefined;

                        return (
                            <View style={{ alignSelf: item.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", padding: 12 }}>
                                <Text selectable>{item.text || (item.role === "assistant" ? "..." : "")}</Text>
                                {shareText !== undefined && (
                                    <Pressable
                                        accessibilityLabel={shareLabel({ role: item.role, text: shareText })}
                                        accessibilityRole="button"
                                        onPress={() => shareRow(shareText)}
                                        style={{ alignItems: "center", alignSelf: "flex-start", justifyContent: "center", minHeight: 44, minWidth: 44, paddingHorizontal: 12 }}
                                    >
                                        <Text style={{ fontSize: 12 }}>Share</Text>
                                    </Pressable>
                                )}
                            </View>
                        );
                    }}
                />
                {error
                    ? (
                    <Text accessibilityRole="alert" style={{ color: "#b00020", padding: 12 }}>
                        {error}
                    </Text>
                    )
                    : null}
                <View style={{ flexDirection: "row", gap: 8, padding: 12, paddingBottom: sendControl.reason ? 12 : 12 + safeBottom }}>
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
                {sendControl.reason
                    ? (
                    <Text style={{ fontSize: 12, paddingBottom: 8 + safeBottom, paddingHorizontal: 12 }}>{sendControl.reason}</Text>
                    )
                    : null}
            </KeyboardAvoidingView>
        </View>
    );
};

/** Keyed by the signed-in account, so one account's messages never stay in screen state for the next. */
// eslint-disable-next-line react/function-component-definition -- the default export is declared inline (unicorn/default-export-style), which makes it a function declaration
export default function ChatScreen() {
    const { user } = useAuth();

    return <Chat key={user?.id ?? "none"} />;
}
