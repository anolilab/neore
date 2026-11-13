import type { LegendListRef } from "@legendapp/list/react-native";
import { LegendList } from "@legendapp/list/react-native";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { randomUUID } from "expo-crypto";
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import type { ComponentRef } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Keyboard, KeyboardAvoidingView, Pressable, Share, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/auth/auth-state";
import { fetchAccessToken } from "@/auth/grant";
import { secureGrantStore } from "@/auth/secure-store";
import type { StartedChat } from "@/chat/chat-api";
import { ChatError, startChat } from "@/chat/chat-api";
import { ChatComposer } from "@/chat/chat-composer";
import type { ChatHistory, HistoryGap, HistoryPage } from "@/chat/chat-history";
import {
    createFillRunner,
    createLoadingOwner,
    fillHistory,
    hasOlder,
    newestRun,
    nextOlderCursor,
    olderPageOf,
    OPEN_FILL_ROWS,
    requiresFill,
    withFillTarget,
    withNewestPage,
    withOlderPage,
} from "@/chat/chat-history";
import type { ShownRow } from "@/chat/chunk-batcher";
import { appendTexts, createChunkBatcher } from "@/chat/chunk-batcher";
import { createDraftStore } from "@/chat/draft-store";
import { forgetLastThread, rememberLastThread } from "@/chat/last-thread-store";
import { HISTORY_PAGE_SIZE, readNewestRows } from "@/chat/message-pages";
import { displayTextOf, shareTextOf } from "@/chat/message-parts";
import { MessageRowView } from "@/chat/message-row";
import { isScrolledToEnd, scrollToLatestLabel, scrollToLatestText, shouldShowScrollToLatest } from "@/chat/scroll-to-latest";
import type { SendSession } from "@/chat/send-sessions";
import { sendSessions } from "@/chat/send-sessions";
import type { HeldSend } from "@/chat/start-send";
import { abortableSleep, afterStart, clientMessageIdFor, replyStreamOf, startWithRetries } from "@/chat/start-send";
import type { StreamDelta } from "@/chat/stream";
import { relayReply } from "@/chat/stream";
import type { SendStage } from "@/chat/unsent-send";
import { failedSendMessage, failedSendOutcome, giveBackDraft, shouldKeepClientMessageId, withoutUnsentRows } from "@/chat/unsent-send";
import { useIsAppActive } from "@/chat/use-app-active";
import { useReplyConfirmation } from "@/chat/use-reply-confirmation";
import { loadConfig } from "@/lib/config";
import { DEFAULT_CHAT_MODEL } from "@/lib/defaults";
import { withCatch, withFinally } from "@/lib/guarded";
import { getClient } from "@/lib/lunora";
import { streamingFetch } from "@/lib/streaming-fetch";
import { offerPhonePush } from "@/notifications/use-phone-push";
import { MAX_MESSAGES_PER_THREAD } from "@/offline/cache";
import { mergeRows } from "@/offline/merge";
import { createMessageReadGate, readOlderMessages, readThreadMessages } from "@/offline/message-read";
import { OfflineBanner } from "@/offline/offline-banner";
import { useOffline, useWriteControl } from "@/offline/offline-context";
import { settleQuietly } from "@/offline/quietly";
import { requireOnline } from "@/offline/write-gate";

/** A row on this screen; `finished` marks a local row whose send completed, which no server read has confirmed yet. */
type Row = ShownRow;

const rowKey = (row: Row): string => row.id;

const NEW_THREAD = "new";

/** A new chat's screen moves to the chat its start opened, unless the send was stopped meanwhile (sign-out, leaving, a refusal). */
const shouldMoveRoute = (routeThreadId: string, signal: AbortSignal): boolean => routeThreadId === NEW_THREAD && !signal.aborted;
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

const fetchMessagePage = (threadId: string, cursor: string | null, pageSize: number = HISTORY_PAGE_SIZE) =>
    getClient().query(api.chat.functions.getThreadUIMessages, {
        paginationOpts: { cursor, numItems: pageSize },
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
    // Whether this chat has had a read land since it opened: the first one also fills older pages after it is painted.
    const hasOpened = useRef(false);
    const readGate = useRef(createMessageReadGate());
    // Which chat a fill reads for: it moves when the screen leaves the chat or the chat is refused, and a fill of the
    // chat before stops. A newest-page read does not move it: the fill goes on from what that read left.
    const fillEpoch = useRef(0);
    // At most one fill at a time (`createFillRunner`): a refresh that lands mid-fill does not start a second one.
    const [fillRunner] = useState(createFillRunner<string>);
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
    // The history's cursor and hole (`chat-history.ts`); its rows are `rowsRef`. Every read that changes the history
    // goes through `writeHistory`, so the rows, the cursor and the hole never disagree.
    const historyRef = useRef<{ fillTarget?: number; gap?: HistoryGap; olderCursor: string | null | undefined }>({ olderCursor: undefined });
    const [canLoadOlder, setCanLoadOlder] = useState(false);
    const readHistory = useCallback((): ChatHistory<Row> => {
        return { ...historyRef.current, rows: rowsRef.current };
    }, []);
    const writeHistory = useCallback(
        (apply: (history: ChatHistory<Row>) => ChatHistory<Row>) => {
            const next = apply(readHistory());

            historyRef.current = { fillTarget: next.fillTarget, gap: next.gap, olderCursor: next.olderCursor };
            writeRows(next.rows);
            setCanLoadOlder(hasOlder(next));
        },
        [readHistory, writeRows],
    );
    const [isLoadingOlder, setIsLoadingOlder] = useState(false);
    // Each fill and "Load older messages" press takes "Loading older messages" over; only the latest may end it.
    const [loadingOwner] = useState(() => createLoadingOwner(setIsLoadingOlder));
    // The composer's text. Only `ChatComposer` subscribes, so typing never re-renders this screen or its message list.
    // Like `rowsRef`, it is the composer as the last write left it: a failed send decides whether its prompt lands alone or
    // ahead of text typed meanwhile against the composer as it is, not as it was when the send started.
    const [draft] = useState(createDraftStore);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
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
            fillEpoch.current += 1;
            historyRef.current = { olderCursor: undefined };
            writeRows([]);
            setCanLoadOlder(false);
            setError(REFUSED_MESSAGE);
            // A chat the server refuses is not reopened on launch, and only this account's record of it is forgotten.
            settleQuietly(accountId ? forgetLastThread({ threadId: refusedThreadId, userId: accountId }) : undefined);
        },
        [accountId, writeRows],
    );

    // One older page of chat `id` from `cursor`, as the history takes it; `undefined` when it cannot be shown. A chat the
    // server refuses is cleared here, as the newest-page read clears it; other failures go to `onFailure`.
    const readOlderPage = useCallback(
        async (
            id: string,
            cursor: string,
            onFailure: (message: string) => void,
            isCurrent?: () => boolean,
        ): Promise<HistoryPage<Row> | undefined> => {
            const result = await readOlderMessages({
                cache,
                fetchPage: async () => {
                    // Stamped with when the read STARTED: a newer read that lands first must keep its copy in the cache.
                    const startedAt = Date.now();
                    const page = await fetchMessagePage(id, cursor);

                    return { olderCursor: page.isDone ? null : page.continueCursor, rows: page.page.map((message) => toRow(message, id, startedAt)) };
                },
                gate: readGate.current,
                isCurrent,
                threadId: id,
            });

            return olderPageOf(result, {
                onFailure,
                onRefused: () => {
                    showRefused(id);
                },
            });
        },
        [cache, showRefused],
    );

    // The run that joins the newest row is the chat's newest messages: saved as they are, up to the cache's limit, so a
    // chat reopened offline shows what was read here, not only the newest page.
    const saveNewestRun = useCallback(
        (id: string, syncedAt: number, isCurrent: () => boolean) => {
            if (!isCurrent()) {
                return;
            }

            const newest = newestRun(readHistory()).slice(-MAX_MESSAGES_PER_THREAD);

            settleQuietly(cache?.saveMessages(id, newest, { syncedAt }));
        },
        [cache, readHistory],
    );

    // Older pages read after the newest one is painted (`fillHistory`): through a hole first, then, for a chat just opened,
    // down to as far back as a chat opened before. "Load older messages" waits meanwhile. It runs through `fillRunner`,
    // which says whether it may go on (`isCurrent`): still this chat, and no fill asked for another.
    const fillOlderRows = useCallback(
        async (id: string, isCurrent: () => boolean) => {
            const startedAt = Date.now();
            const end = loadingOwner.begin();

            await withFinally(
                async () =>
                    await fillHistory({
                        // A failure of this fill shows as "Load older messages" shows it; one the screen moved on from does not.
                        fetchOlder: async (cursor) =>
                            await readOlderPage(
                                id,
                                cursor,
                                (message) => {
                                    if (isCurrent()) {
                                        setError(message);
                                    }
                                },
                                isCurrent,
                            ),
                        isCurrent,
                        read: readHistory,
                        save: (run) => {
                            if (isCurrent()) {
                                settleQuietly(cache?.saveMessages(id, run.slice(-MAX_MESSAGES_PER_THREAD), { syncedAt: startedAt }));
                            }
                        },
                        update: writeHistory,
                    }),
                end,
            );
        },
        [cache, loadingOwner, readHistory, readOlderPage, writeHistory],
    );

    // The newest page loads first, in one request, and is painted at once; older pages follow (`fillOlderRows`), and
    // "Load older messages" fetches the rest one page at a time.
    const loadMessages = useCallback(
        async (id: string) => {
            const result = await readThreadMessages({
                cache,
                // A page is oldest first inside (`toUIMessages` sorts it ascending), so its rows read oldest first.
                fetchRows: async (startedAt) =>
                    await readNewestRows(
                        async (cursor, pageSize) => await fetchMessagePage(id, cursor, pageSize),
                        (message) => toRow(message, id, startedAt),
                    ),
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

                    // Older rows on screen stay (loaded ones, and the saved ones the cache painted); a hole below the
                    // newest page is marked and filled after the paint.
                    const isOpening = !hasOpened.current;

                    hasOpened.current = true;
                    writeHistory((history) => {
                        const next = withNewestPage(history, { olderCursor: result.olderCursor, rows: result.rows });

                        // A chat just opened fills to as far back as it opened before; a fill a read stopped goes on here.
                        return isOpening ? withFillTarget(next, OPEN_FILL_ROWS) : next;
                    });

                    if (requiresFill(readHistory())) {
                        const epoch = fillEpoch.current;

                        settleQuietly(fillRunner.request({ fill: fillOlderRows, isCurrent: () => fillEpoch.current === epoch, key: id }));
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
        [accountId, cache, fillOlderRows, fillRunner, readHistory, reportRead, showRefused, writeHistory],
    );

    // One older page: the rest of a hole first, then below the run (`nextOlderCursor`).
    const loadOlder = async () => {
        const cursor = nextOlderCursor(readHistory());

        if (!threadId || cursor === null || isLoadingOlder) {
            return;
        }

        const id = threadId;
        const isCurrent = readGate.current.watch();
        const startedAt = Date.now();
        const end = loadingOwner.begin();

        // `withFinally`, not `try … finally`: the React Compiler skips a component that holds a `finally`.
        await withFinally(async () => {
            const page = await readOlderPage(id, cursor, setError);

            if (page !== undefined) {
                // Applied only where it was read from: a newest-page read that landed meanwhile may have moved the history.
                writeHistory((history) => withOlderPage(history, page, cursor));
            }
        }, end);
        saveNewestRun(id, startedAt, isCurrent);
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

        // A read begun for another chat must not land on this one, and the next chat fills its history when it opens.
        return () => {
            gate.invalidate();
            fillEpoch.current += 1;
            hasOpened.current = false;
        };
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
    const isFocused = useIsFocused();
    const isAppActive = useIsAppActive();
    const { addConfirmation, confirmTick, isAwaitingReply } = useReplyConfirmation({
        fetchPage: fetchMessagePage,
        // Nobody sees a check's result behind another screen or with the app in the background.
        isPaused: !isFocused || !isAppActive,
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
        const { draft: given, isMerged } = giveBackDraft(draft.get(), prompt);

        draft.set(given);
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
        // The composer as the last write left it (`draft`), not as this render saw it: an edit made just before the press
        // is what is sent.
        const prompt = draft.get().trim();

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
        draft.set("");
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
                signal: controller.signal,
            });
            const onDelta = ({ restart, text }: StreamDelta) => {
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
            };
            // The batcher stops listening to the send once the stream has settled, however it ended.
            const outcome = await withFinally(
                async () =>
                    await relayReply({
                        fetch: streamingFetch,
                        gatewayUrl: config.gatewayUrl,
                        onDelta,
                        signal: controller.signal,
                        streamToken: replyStream.streamToken,
                    }),
                chunks.detach,
            );

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
        = canLoadOlder
            ? (
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: isLoadingOlder, disabled: isLoadingOlder }}
                disabled={isLoadingOlder}
                onPress={loadOlder}
                style={{ padding: 12 }}
            >
                <Text style={{ textAlign: "center" }}>{isLoadingOlder ? "Loading older messages..." : "Load older messages"}</Text>
            </Pressable>
            )
            : undefined;

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
                <ChatComposer control={composer} draft={draft} isSendBlocked={isSendBlocked} onSend={send} safeBottom={safeBottom} sendReason={sendReason} />
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
