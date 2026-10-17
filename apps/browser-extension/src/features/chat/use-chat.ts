import { usePaginatedQuery } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { clearAccessToken, getAccessToken } from "@/lib/access-token";
import { LLM_GATEWAY_URL } from "@/lib/env";
import type { PageContext } from "@/page-context/build";

import type { LiveReply } from "./messages";
import { isReplyPersisted, toChatMessages, withLiveReply } from "./messages";
import type { StreamDelta } from "./stream";
import { streamReply } from "./stream";

export interface SendOptions {
    modelId: string;
    pageContext?: PageContext;
    text: string;
}

/** The `POST /v1/chat` body. */
interface StartBody {
    model: string;
    pageContext?: PageContext;
    prompt: string;
    threadId?: string;
}

interface StartResponse {
    messageId?: string;
    streamToken?: string;
    threadId?: string;
}

/** The gateway's error bodies: `{ error: "CODE", message }` or `{ error: { code, message } }`. */
const readError = async (response: Response): Promise<string> => {
    try {
        const body = (await response.json()) as { error?: unknown; message?: unknown };

        if (typeof body.message === "string") {
            return body.message;
        }

        if (typeof body.error === "object" && body.error !== null && "message" in body.error && typeof body.error.message === "string") {
            return body.error.message;
        }

        if (typeof body.error === "string") {
            return body.error;
        }
    } catch {
        // fall through
    }

    return `Request failed (${response.status})`;
};

/**
 * One thread's messages plus sending. `threadId: null` is a new chat: the first
 * send creates the thread server-side and reports it through `onThreadCreated`.
 *
 * Sending goes through the gateway exactly as the web app does — `POST /v1/chat`
 * creates the message and schedules the agent, then the reply streams from
 * `/v1/stream` — so the extension gets the same routing, rate limits and
 * content checks.
 */
export function useChat(threadId: string | null, onThreadCreated: (threadId: string) => void) {
    const [live, setLive] = useState<LiveReply | null>(null);
    const [isSending, setIsSending] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    const { loadMore, results, status } = usePaginatedQuery(
        api.chat.functions.getThreadUIMessages,
        // `threadId` crosses into the app as a plain string (view state); this is
        // the boundary where it becomes the branded row id.
        threadId ? { threadId: threadId as Id<"threads"> } : "skip",
        { initialNumItems: 50 },
    );

    const persisted = useMemo(() => toChatMessages(results ?? []), [results]);
    const messages = useMemo(() => withLiveReply(persisted, live), [persisted, live]);

    // Drop the live copy once the finished reply is persisted.
    useEffect(() => {
        if (live && !isStreaming && isReplyPersisted(persisted, live)) {
            setLive(null);
        }
    }, [isStreaming, live, persisted]);

    useEffect(() => () => abortRef.current?.abort(), []);

    const start = useCallback(async (body: StartBody, retry = true): Promise<StartResponse> => {
        const token = await getAccessToken();

        if (!token) {
            throw new Error("You are signed out. Sign in again to keep chatting.");
        }

        const response = await fetch(`${LLM_GATEWAY_URL}/v1/chat`, {
            body: JSON.stringify(body),
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            method: "POST",
        });

        // A token can be revoked before its `exp`; fetch a fresh one once.
        if (response.status === 401 && retry) {
            await response.body?.cancel();
            clearAccessToken();

            return start(body, false);
        }

        if (!response.ok) {
            throw new Error(await readError(response));
        }

        return (await response.json()) as StartResponse;
    }, []);

    const send = useCallback(
        async ({ modelId, pageContext, text }: SendOptions): Promise<boolean> => {
            if (!LLM_GATEWAY_URL) {
                setError("VITE_LLM_GATEWAY_URL is not configured for this build.");

                return false;
            }

            setError(null);
            setIsSending(true);
            abortRef.current?.abort();

            let started: StartResponse;

            try {
                started = await start({
                    model: modelId,
                    prompt: text,
                    ...(threadId && { threadId }),
                    ...(pageContext && { pageContext }),
                });
            } catch (startError) {
                setError(startError instanceof Error ? startError.message : "Failed to send the message.");
                setIsSending(false);

                return false;
            }

            setIsSending(false);

            if (started.threadId && started.threadId !== threadId) {
                onThreadCreated(started.threadId);
            }

            if (!started.streamToken || !started.messageId) {
                // Media models answer without a text stream; the thread query shows the result.
                return true;
            }

            const controller = new AbortController();
            const promptMessageId = started.messageId;

            abortRef.current = controller;
            setLive({ promptMessageId, reasoning: "", text: "" });
            setIsStreaming(true);

            // Stream only from our configured gateway. The response's `gatewayUrl` is
            // deliberately ignored: the stream token is bearer-equivalent, and a
            // server-supplied origin must never decide where it is sent.
            const gatewayOrigin = new URL(LLM_GATEWAY_URL).origin;
            const { streamToken } = started;

            const onDelta = (delta: StreamDelta) => {
                setLive((current) => {
                    if (current?.promptMessageId !== promptMessageId) {
                        return current;
                    }

                    // Group chat: a speaker marker starts the next participant's reply.
                    // The previous one is saved by now, so the live copy shows only the
                    // participant talking.
                    if (delta.speaker) {
                        return { promptMessageId, reasoning: delta.reasoning, speaker: delta.speaker, text: delta.text };
                    }

                    return { ...current, reasoning: current.reasoning + delta.reasoning, text: current.text + delta.text };
                });
            };

            const pump = async () => {
                try {
                    await streamReply(gatewayOrigin, streamToken, onDelta, controller.signal);
                } catch (streamError: unknown) {
                    setError(streamError instanceof Error ? streamError.message : "The reply stream failed.");
                } finally {
                    if (abortRef.current === controller) {
                        setIsStreaming(false);
                    }
                }
            };

            void pump();

            return true;
        },
        [onThreadCreated, start, threadId],
    );

    return {
        error,
        hasMore: status === "CanLoadMore",
        isLoading: threadId !== null && status === "LoadingFirstPage",
        isSending,
        isStreaming,
        loadMore: () => loadMore(20),
        messages,
        send,
    };
}
