import type { LegendListRef } from "@legendapp/list/react-native";
import { LegendList } from "@legendapp/list/react-native";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { randomUUID } from "expo-crypto";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { ComponentRef } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Keyboard, KeyboardAvoidingView, Pressable, Share, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/auth/auth-state";
import { fetchAccessToken } from "@/auth/grant";
import { secureGrantStore } from "@/auth/secure-store";
import type { StartedChat } from "@/chat/chat-api";
import { ChatError, startChat } from "@/chat/chat-api";
import type { ShownRow } from "@/chat/chunk-batcher";
import { appendTexts, createChunkBatcher } from "@/chat/chunk-batcher";
import { forgetLastThread, rememberLastThread } from "@/chat/last-thread-store";
import { displayTextOf, shareTextOf } from "@/chat/message-parts";
import { MessageRowView } from "@/chat/message-row";
import { isScrolledToEnd, scrollToLatestLabel, scrollToLatestText, shouldShowScrollToLatest } from "@/chat/scroll-to-latest";
import type { SendSession } from "@/chat/send-sessions";
import { sendSessions } from "@/chat/send-sessions";
import type { HeldSend } from "@/chat/start-send";
import { abortableSleep, afterStart, clientMessageIdFor, replyStreamOf, startWithRetries } from "@/chat/start-send";
import { relayReply } from "@/chat/stream";
import type { SendStage } from "@/chat/unsent-send";
import { failedSendMessage, failedSendOutcome, giveBackDraft, shouldKeepClientMessageId, withoutUnsentRows } from "@/chat/unsent-send";
import { useReplyConfirmation } from "@/chat/use-reply-confirmation";
import { loadConfig } from "@/lib/config";
import { DEFAULT_CHAT_MODEL } from "@/lib/defaults";
import { withCatch, withFinally } from "@/lib/guarded";
import { getClient } from "@/lib/lunora";
import { streamingFetch } from "@/lib/streaming-fetch";
import { offerPhonePush } from "@/notifications/use-phone-push";
import { isOldestFreshRowOnScreen, withFreshRows } from "@/offline/fresh-rows";
import { mergeRows } from "@/offline/merge";
import { createMessageReadGate, readOlderMessages, readThreadMessages } from "@/offline/message-read";
import { OfflineBanner } from "@/offline/offline-banner";
import { useOffline, useWriteControl } from "@/offline/offline-context";
import { settleQuietly } from "@/offline/quietly";
import { requireOnline } from "@/offline/write-gate";
import { useDictation } from "@/voice/use-dictation";
import { VoiceButton, VoiceStatus } from "@/voice/voice-button";
import { appendTranscript } from "@/voice/voice-input";

/** A row on this screen; `finished` marks a local row whose send completed, which no server read has confirmed yet. */
type Row = ShownRow;

const rowKey = (row: Row): string => row.id;

const NEW_THREAD = "new";

/** A new chat's screen moves to the chat its start opened, unless the send was stopped meanwhile (sign-out, leaving, a refusal). */
const shouldMoveRoute = (routeThreadId: string, signal: AbortSignal): boolean => routeThreadId === NEW_THREAD && !signal.aborted;
const MAX_HISTORY_PAGES = 10;
const REFUSED_MESSAGE = "This chat is locked or no longer available.";
const SHARE_FAILED_MESSAGE = "The message could not be shared. Try again.";
const AWAIT_REPLY_MESSAGE = "Wait for the last reply to finish before sending another.";

/** A failed share fills an empty error slot; an error already on screen is not replaced by it. */
const withShareFailure = (current: string | null): string | null => current ?? SHARE_FAILED_MESSAGE;

/** A share that works clears the share failure on screen; any other error on screen is not the share's to clear. */
const withoutShareFailure = (current: string | null): string | null => {
    if (current === SHARE_FAILED_MESSAGE) {
        return null;
    }

    return current;
};

/** A confirmation that ends clears the wait message; any other message on screen is not the confirmation's to clear. */
const withoutAwaitReply = (current: string | null): string | null => {
    if (current === AWAIT_REPLY_MESSAGE) {
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

/** When the newest server-confirmed row on screen was read; local rows, and finished ones not yet re-read, do not count. */
const newestSyncedAt = (rows: Row[]): number | undefined => {
    let newest: number | undefined;

    for (const row of rows) {
        if (row.status !== "local" && row.finished !== true && (newest === undefined || row.syncedAt > newest)) {
            newest = row.syncedAt;
        }
    }

    return newest;
};

/** A steer starts a new row. The row before it stays unless it has no text yet: then it is not part of the reply. */
const withSteeredRow = (rows: Row[], previousId: string, steered: Row): Row[] => [
    ...rows.filter((row) => row.id !== previousId || row.text !== ""),
    steered,
];

const fetchMessagePage = (threadId: string, cursor: string | null) =>
    getClient().query(api.chat.functions.getThreadUIMessages, {
        paginationOpts: { cursor, numItems: 100 },
        threadId: threadId as Id<"threads">,
    });

const Chat = () => {
    const { threadId: routeThreadId } = useLocalSearchParams<{ threadId: string }>();
    const router = useRouter();
    const { hasToken, status, user } = useAuth();
    const accountId = user?.id;
    const { cache, refreshTick, reportRead } = useOffline();
    const composer = useWriteControl("composer");
    const sendControl = useWriteControl("send");
    // Once live rows are in, a late read of the cache must not touch the thread.
    const hasLiveRows = useRef(false);
    // Set when the server refused this chat (locked, gone): a late read of the cache must not paint it again.
    const isRefused = useRef(false);
    // Whether "Load older messages" has added pages here: only then does the cursor on screen continue a loaded run.
    const hasLoadedOlder = useRef(false);
    const readGate = useRef(createMessageReadGate());
    // Whether this chat is the one on screen: a read that lands after another chat was pushed over it must not save it.
    const isFocusedRef = useRef(false);
    const [threadId, setThreadId] = useState<string | undefined>(routeThreadId === NEW_THREAD ? undefined : routeThreadId);
    const [rows, setRows] = useState<Row[]>([]);
    // The prompt that went back to the composer with its `clientMessageId`: sending that prompt again reuses the id, so a
    // send the server took on a try whose answer was lost is saved once (`start-send.ts`).
    const heldSend = useRef<HeldSend | null>(null);
    // The rows as the last write left them. Every write goes through `writeRows`, so a read can decide against the rows on
    // screen when it lands, not against the rows of the render it was started in.
    const rowsRef = useRef<Row[]>([]);
    const writeRows = useCallback((update: Row[] | ((current: Row[]) => Row[])) => {
        const next = typeof update === "function" ? update(rowsRef.current) : update;

        rowsRef.current = next;
        setRows(next);
    }, []);
    // Where the next older page starts; null once the whole history is loaded.
    const [olderCursor, setOlderCursor] = useState<string | null>(null);
    const [isLoadingOlder, setIsLoadingOlder] = useState(false);
    const [draft, setDraftState] = useState("");
    // The composer as the last write left it, like `rowsRef`: a failed send decides whether its prompt lands alone or ahead
    // of text typed meanwhile against the composer as it is, not as it was when the send started.
    const draftRef = useRef("");
    const setDraft = useCallback((update: string | ((current: string) => string)) => {
        const next = typeof update === "function" ? update(draftRef.current) : update;

        draftRef.current = next;
        setDraftState(next);
    }, []);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The words land in the draft, after anything typed meanwhile; they are never sent on their own.
    const voice = useDictation({ onText: (text) => setDraft((current) => appendTranscript(current, text)) });
    const listRef = useRef<LegendListRef>(null);
    // Whether the list shows its last message: the jump button shows whenever it does not, and while a reply streams.
    const [isAtEnd, setIsAtEnd] = useState(true);
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
    const showRefused = useCallback(
        (refusedThreadId: string) => {
            isRefused.current = true;
            hasLiveRows.current = false;
            hasLoadedOlder.current = false;
            writeRows([]);
            setOlderCursor(null);
            setError(REFUSED_MESSAGE);
            // A chat the server refuses is not reopened on launch, and only this account's record of it is forgotten.
            settleQuietly(accountId ? forgetLastThread({ threadId: refusedThreadId, userId: accountId }) : undefined);
        },
        [accountId, writeRows],
    );

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

                        // Pages come newest first, and each page is oldest first inside (`toUIMessages` sorts it ascending).
                        // Each older page goes in front, so the rows read oldest first.
                        pages.unshift(page.page.map((message) => toRow(message, id, startedAt)));
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
                    showRefused(id);
                    reportRead("succeeded");
                    break;
                }
                case "rows": {
                    isRefused.current = false;
                    hasLiveRows.current = true;
                    // The older rows stay only when the read reaches them; otherwise the read's own cursor takes over.
                    const isOlderKept = hasLoadedOlder.current && isOldestFreshRowOnScreen(rowsRef.current, result.rows);

                    writeRows(withFreshRows(rowsRef.current, result.rows, isOlderKept));

                    if (!isOlderKept) {
                        hasLoadedOlder.current = false;
                        setOlderCursor(result.olderCursor);
                    }

                    setError(withoutRefusal);

                    // Only a chat the server has just let this account read is saved as the one to reopen.
                    if (accountId && isFocusedRef.current) {
                        settleQuietly(rememberLastThread({ threadId: id, userId: accountId }));
                    }

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
        [accountId, cache, reportRead, showRefused, writeRows],
    );

    const loadOlder = async () => {
        if (!threadId || olderCursor === null || isLoadingOlder) {
            return;
        }

        setIsLoadingOlder(true);

        const showOlder = (result: Awaited<ReturnType<typeof readOlderMessages>>) => {
            switch (result.kind) {
                case "failed": {
                    setError(result.message);
                    break;
                }
                case "page": {
                    hasLoadedOlder.current = true;
                    writeRows((current) => {
                        const onScreen = new Set(current.map((row) => row.id));

                        return [...result.rows.filter((row) => !onScreen.has(row.id)), ...current];
                    });
                    setOlderCursor(result.olderCursor);
                    break;
                }
                case "refused": {
                    showRefused(threadId);
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
        };

        const fetchPage = async () => {
            const page = await fetchMessagePage(threadId, olderCursor);
            const syncedAt = Date.now();

            return {
                olderCursor: page.isDone ? null : page.continueCursor,
                rows: page.page.map((message) => toRow(message, threadId, syncedAt)),
            };
        };

        // `withFinally`, not `try … finally`: the React Compiler skips a component that holds a `finally`.
        await withFinally(
            async () => {
                showOlder(await readOlderMessages({ cache, fetchPage, gate: readGate.current, threadId }));
            },
            () => {
                setIsLoadingOlder(false);
            },
        );
    };

    // The saved messages paint first; live rows replace them, and a cached row never replaces a newer live one.
    useEffect(() => {
        if (status !== "signed-in" || !threadId || !cache) {
            return undefined;
        }

        let isCancelled = false;

        const showCached = async () => {
            // An unreadable cache is an empty one.
            const cached = await withCatch(async () => await cache.loadMessages(threadId), (): Row[] => []);

            if (!isCancelled && !hasLiveRows.current && !isRefused.current && cached.length > 0) {
                writeRows((current) => byCreation(mergeRows(current, cached)));
            }
        };

        showCached();

        return () => {
            isCancelled = true;
        };
    }, [cache, status, threadId, writeRows]);

    useEffect(() => {
        const gate = readGate.current;

        // A read begun for another chat must not land on this one.
        return () => gate.invalidate();
    }, [threadId]);

    useFocusEffect(
        useCallback(() => {
            isFocusedRef.current = true;

            return () => {
                isFocusedRef.current = false;
            };
        }, []),
    );

    // The reply checks run in a hook; the screen decides what a refusal or a settled check means for the chat.
    const onConfirmationRefused = useCallback(
        (refusedThreadId: string) => {
            // A chat the reader can no longer open is cleared now, not by a read that may not run. A send still streaming
            // into it is stopped, so no row is written into the chat after the refusal.
            sendAbort.current?.abort();
            readGate.current.invalidate();
            showRefused(refusedThreadId);
            settleQuietly(cache?.forgetThreads([refusedThreadId]));
        },
        [cache, showRefused],
    );
    const onConfirmationEnded = useCallback(() => {
        setError(withoutAwaitReply);
    }, []);
    const { addConfirmation, confirmTick, isAwaitingReply } = useReplyConfirmation({
        fetchPage: fetchMessagePage,
        onEnded: onConfirmationEnded,
        onRefused: onConfirmationRefused,
        threadId,
    });

    useEffect(() => {
        // Without a token (a launch with no network) the saved messages are all there is; the read waits for one.
        if (status === "signed-in" && hasToken && threadId && !sending) {
            loadMessages(threadId);
        }
    }, [confirmTick, hasToken, loadMessages, refreshTick, sending, status, threadId]);

    // A send the server did not accept, or whose answer was lost, gives its prompt back and drops its local rows: no read
    // will confirm them. The prompt keeps its `clientMessageId`, so sending it again cannot save it twice; the server answers
    // a resend of a saved one with its ids. Only an id the server says belongs to another request is dropped.
    const settleFailedSend = ({
        clientMessageId,
        error: failure,
        ids,
        prompt,
        stage,
    }: {
        clientMessageId: string;
        error: unknown;
        ids: { assistant: string; user: string };
        prompt: string;
        stage: SendStage;
    }) => {
        if (failedSendOutcome(stage) === "accepted") {
            return { isMerged: false };
        }

        // Back to this screen's composer, ahead of anything typed meanwhile, with its held id: the same prompt sent again
        // alone and unchanged is the same send (`clientMessageIdFor`). A screen left meanwhile is gone, and so is the prompt.
        const { draft: given, isMerged } = giveBackDraft(draftRef.current, prompt);

        setDraft(given);
        writeRows((current) => withoutUnsentRows(current, [ids.user, ids.assistant]));
        heldSend.current = shouldKeepClientMessageId(failure) ? { clientMessageId, prompt } : null;

        return { isMerged };
    };

    // After a start answered: `true` when the send was stopped while it was out (sign-out, leaving, a refusal) and changes
    // nothing more here, since the server has the message. One sign-out stopped also drops its local rows and its hold, as
    // its failure would (`afterStart`).
    const isStoppedAfterStart = ({
        controller,
        ids,
        sendSession,
    }: {
        controller: AbortController;
        ids: { assistant: string; user: string };
        sendSession: SendSession;
    }): boolean => {
        const next = afterStart({ isAborted: controller.signal.aborted, isSignedOut: sendSession.isSignedOut() });

        if (next === "signed-out") {
            writeRows((current) => withoutUnsentRows(current, [ids.user, ids.assistant]));
            heldSend.current = null;
        }

        return next !== "continue";
    };

    // A start accepted: its chat is this screen's, the prompt is complete, and a new chat's screen moves to it.
    const acceptStart = ({ controller, sender, started, userId }: { controller: AbortController; sender: string | undefined; started: StartedChat; userId: string }) => {
        setThreadId(started.threadId);

        // A reply, a question or an approval may now arrive while the app is in the background.
        if (sender) {
            offerPhonePush(sender);
        }

        // The prompt is complete once the server has accepted it, whether or not the screen's next read succeeds.
        writeRows((current) => finishRow(current, userId));

        // A send stopped meanwhile (sign-out, leaving, a refusal) keeps its result but moves no route.
        if (shouldMoveRoute(routeThreadId, controller.signal)) {
            router.setParams({ threadId: started.threadId });
        }
    };

    const send = async () => {
        // The composer as the last write left it (`draftRef`), not as this render saw it: an edit made just before the press
        // is what is sent.
        const prompt = draftRef.current.trim();

        if (!prompt || sending || sendControl.disabled) {
            return;
        }

        if (isAwaitingReply) {
            setError(AWAIT_REPLY_MESSAGE);

            return;
        }

        const controller = new AbortController();
        // The account that sends: the offer below is its, even if another account is signed in by the time it lands.
        const sender = accountId;
        // One id per composed message: the held one when this is exactly the prompt that went back, so the resend is the same send.
        const clientMessageId = clientMessageIdFor(heldSend.current, prompt, randomUUID);

        heldSend.current = null;

        sendAbort.current = controller;
        // Sign-out stops this send, retries included (`sendSessions`), and marks it the departed account's.
        const sendSession = sendSessions.begin(controller);

        setSending(true);
        setError(null);
        // Announced when a reply starts and when it finishes. The deltas stay silent: an announcement on each would flood the reader.
        AccessibilityInfo.announceForAccessibility("Assistant is replying");
        setDraft("");
        const stamp = Date.now();
        const userId = `user-${stamp}`;
        const assistantId = `pending-${stamp}`;

        readGate.current.invalidate();
        writeRows((current) => [
            ...current,
            localRow(userId, "user", threadId ?? NEW_THREAD, prompt),
            localRow(assistantId, "assistant", threadId ?? NEW_THREAD, ""),
        ]);

        // How far the send got decides whether a failure gives the prompt back (`settleFailedSend`).
        const progress: { stage: SendStage } = { stage: "before-request" };

        // The send as a closure run by `withCatch` and `withFinally` below, not a `try` around it: the React Compiler skips
        // a component that holds a `finally`, or a `throw` inside a `try`.
        const deliver = async () => {
            const config = loadConfig();
            const jwt = await fetchAccessToken({ fetch, lunoraUrl: config.lunoraUrl, store: secureGrantStore });

            if (jwt === null) {
                throw new ChatError("Your sign-in expired. Sign in again.");
            }

            getClient().setAuthToken(jwt);

            // Nothing is held back for later: a send that finds the app offline is refused, not queued. Online, the same send
            // is tried again while its first try is still being saved, or when a try gets no answer (`startWithRetries`). A
            // resend the server already took answers with that send's ids (`duplicate`), and opens that chat like any start.
            const started = await requireOnline({ isOffline: sendControl.disabled }, () => {
                progress.stage = "requested";

                return startWithRetries({
                    attempt: async () =>
                        await startChat({
                            body: { clientMessageId, model: DEFAULT_CHAT_MODEL, prompt, threadId },
                            fetch,
                            gatewayUrl: config.gatewayUrl,
                            jwt,
                        }),
                    signal: controller.signal,
                    // Cut short when the send is stopped, so a stopped send settles at once, not after its retry delay.
                    sleep: async (ms) => {
                        await abortableSleep(ms, controller.signal);
                    },
                });
            });

            if (isStoppedAfterStart({ controller, ids: { assistant: assistantId, user: userId }, sendSession })) {
                return;
            }

            progress.stage = "accepted";
            acceptStart({ controller, sender, started, userId });

            const replyStream = replyStreamOf(started);

            // No reply stream to follow (`streaming: false`): the message went through, and its saved reply is read from the
            // chat instead (the confirmation's read once `sending` ends). Its empty placeholder row goes.
            if (replyStream === undefined) {
                writeRows((current) => withoutUnsentRows(current, [assistantId]));
                addConfirmation({ holdsSend: false, messageId: started.messageId, steers: 0, threadId: started.threadId });
                AccessibilityInfo.announceForAccessibility("Reply finished");

                return;
            }

            let isSteered = false;
            // The row the text goes into. A steer starts a new row, so the text before it stays on screen; the server
            // saves that text as a message of its own.
            let activeId = assistantId;
            let steerCount = 0;
            // Deltas land at most once a frame, each batch in one update that replaces only the streaming row.
            const chunks = createChunkBatcher({
                apply: (texts) => {
                    writeRows((current) => appendTexts(current, texts));
                },
                cancelFrame: cancelAnimationFrame,
                requestFrame: requestAnimationFrame,
            });
            const outcome = await relayReply({
                fetch: streamingFetch,
                gatewayUrl: config.gatewayUrl,
                onDelta: ({ restart, text }) => {
                    // A send that was stopped, by a refusal of its chat or by leaving the screen, writes nothing more.
                    if (controller.signal.aborted) {
                        chunks.discard();

                        return;
                    }

                    if (restart) {
                        // The text before the steer lands in its own row first.
                        chunks.flush();
                        isSteered = true;
                        const previousId = activeId;

                        steerCount += 1;
                        activeId = `${assistantId}-${steerCount}`;
                        const steered = localRow(activeId, "assistant", threadId ?? NEW_THREAD, text);

                        writeRows((current) => withSteeredRow(current, previousId, steered));

                        return;
                    }

                    chunks.add(activeId, text);
                },
                signal: controller.signal,
                streamToken: replyStream.streamToken,
            });

            // A send stopped on purpose has its notice on screen already, and gets no confirmation.
            if (controller.signal.aborted) {
                chunks.discard();

                return;
            }

            // The last deltas are on screen before the reply is marked finished or confirmed.
            chunks.flush();

            if (outcome === "failed") {
                throw new ChatError("The reply did not finish. Try again.");
            }

            // Only a reply relayed through its end marker is complete here. A steered reply is not: its text is only part of it
            // until the server's copy is read. Either way the server's copy is re-read until it is final.
            if (outcome === "finished" && !isSteered) {
                writeRows((current) => finishRow(current, assistantId));
            }

            addConfirmation({ holdsSend: outcome === "unconfirmed", messageId: started.messageId, steers: steerCount, threadId: started.threadId });

            AccessibilityInfo.announceForAccessibility("Reply finished");
        };
        const recover = (error_: unknown) => {
            // A send sign-out stopped belongs to the account that left: its prompt and held id are dropped, never kept for
            // the next one to sign in.
            if (sendSession.isSignedOut()) {
                writeRows((current) => withoutUnsentRows(current, [userId, assistantId]));
                heldSend.current = null;

                return;
            }

            const { isMerged } = settleFailedSend({ clientMessageId, error: error_, ids: { assistant: assistantId, user: userId }, prompt, stage: progress.stage });

            // The abort error of a send stopped on purpose is not shown: its notice is.
            if (!controller.signal.aborted) {
                setError(failedSendMessage(error_, progress.stage, { isMerged }));
            }
        };

        await withFinally(
            async () => {
                await withCatch(deliver, recover);
            },
            () => {
                sendSession.end();
                setSending(false);
            },
        );
    };

    // The last known geometry of the list. The end is recomputed whenever any of it changes, not only on a scroll.
    const metrics = useRef({ contentHeight: 0, layoutHeight: 0, offsetY: 0 });
    const updateIsAtEnd = () => {
        setIsAtEnd(isScrolledToEnd(metrics.current));
    };

    const onListScroll = (event: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;

        metrics.current = { contentHeight: contentSize.height, layoutHeight: layoutMeasurement.height, offsetY: contentOffset.y };
        updateIsAtEnd();
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
    // Stable, so a memoised row is not re-rendered for a new handler.
    const shareRow = useCallback(async (text: string): Promise<void> => {
        try {
            await Share.share({ message: text });
            setError(withoutShareFailure);
        } catch (shareError) {
            console.warn("Could not open the share sheet.", shareError);
            setError(withShareFailure);
            // The message on screen can be out of view when the sheet fails: a screen reader needs the announcement.
            AccessibilityInfo.announceForAccessibility(SHARE_FAILED_MESSAGE);
        }
    }, []);
    const renderRow = useCallback((info: { item: Row }) => <MessageRowView onShare={shareRow} row={info.item} />, [shareRow]);

    // The home indicator's inset, which the open keyboard already covers.
    const safeBottom = keyboardShown ? 0 : insets.bottom;
    // Over every row: worked out again only when the rows change, not on each keystroke, scroll or layout.
    const syncedAt = useMemo(() => newestSyncedAt(rows), [rows]);

    // The control and its hint say why sending waits, so it is not announced as available while a reply is held.
    const sendReason = sendControl.reason ?? (isAwaitingReply ? AWAIT_REPLY_MESSAGE : undefined);
    const isSendBlocked = sending || sendControl.disabled || isAwaitingReply;

    return (
        <View onLayout={measureTopOffset} ref={rootRef} style={{ flex: 1 }}>
            <OfflineBanner syncedAt={syncedAt} />
            <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={topOffset} style={{ flex: 1 }}>
                <View
                    onLayout={(event) => {
                        metrics.current = { ...metrics.current, layoutHeight: event.nativeEvent.layout.height };
                        updateIsAtEnd();
                    }}
                    style={{ flex: 1 }}
                >
                    <LegendList
                        data={rows}
                        estimatedItemSize={72}
                        keyExtractor={rowKey}
                        ListHeaderComponent={olderHeader}
                        onContentSizeChange={(_width, height) => {
                            metrics.current = { ...metrics.current, contentHeight: height };
                            updateIsAtEnd();
                        }}
                        onScroll={onListScroll}
                        ref={listRef}
                        renderItem={renderRow}
                    />
                    {shouldShowScrollToLatest({ isScrolledToEnd: isAtEnd, isStreaming: sending })
                        ? (
                        <Pressable
                            accessibilityLabel={scrollToLatestLabel(sending)}
                            accessibilityRole="button"
                            onPress={() => settleQuietly(listRef.current?.scrollToEnd({ animated: true }))}
                            style={{
                                alignItems: "center",
                                alignSelf: "center",
                                backgroundColor: "#fff",
                                borderColor: "#ccc",
                                borderRadius: 22,
                                borderWidth: 1,
                                bottom: 12,
                                justifyContent: "center",
                                minHeight: 44,
                                minWidth: 44,
                                paddingHorizontal: 16,
                                position: "absolute",
                            }}
                        >
                            <Text style={{ fontWeight: "600" }}>{scrollToLatestText(sending)}</Text>
                        </Pressable>
                        )
                        : null}
                </View>
                {error
                    ? (
                    <Text accessibilityRole="alert" style={{ color: "#b00020", padding: 12 }}>
                        {error}
                    </Text>
                    )
                    : null}
                <View style={{ flexDirection: "row", gap: 8, padding: 12, paddingBottom: sendReason ? 12 : 12 + safeBottom }}>
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
                    <VoiceButton disabledReason={composer.reason} isDisabled={composer.disabled} voice={voice} />
                    <Pressable
                        accessibilityHint={sendReason}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: isSendBlocked }}
                        disabled={isSendBlocked}
                        onPress={send}
                        style={{ justifyContent: "center", opacity: isSendBlocked ? 0.5 : 1, padding: 12 }}
                    >
                        <Text style={{ fontWeight: "600" }}>Send</Text>
                    </Pressable>
                </View>
                <VoiceStatus error={voice.error} phase={voice.phase} />
                {sendReason ? <Text style={{ fontSize: 12, paddingBottom: 8 + safeBottom, paddingHorizontal: 12 }}>{sendReason}</Text> : null}
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
