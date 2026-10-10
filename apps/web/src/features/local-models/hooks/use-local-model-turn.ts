"use client";

import { useLingui } from "@lingui/react/macro";
import { isCustomModelId } from "@neore/ai/models";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import type { LocalModelTarget } from "@/features/settings/lib/custom-models";
import { findLocalModelTarget } from "@/features/settings/lib/custom-models";
import type { UIMessage } from "@/lib/agent";
import { useCRPC } from "@/lib/lunora/crpc";

import { describeLocalError } from "../lib/local-errors";
import type { HistoryMessage } from "../lib/run-local-turn";
import { runLocalTurn } from "../lib/run-local-turn";

export interface LocalTurnSendOptions {
    /**
     * Regenerate the reply to prompt `messageId`, or answer an edit of it. The
     * backend saves either as a sibling branch, as the gateway path does.
     */
    branch?: { kind: "edit" | "regenerate"; messageId: string };
    /** The conversation BEFORE this prompt. */
    history: ReadonlyArray<HistoryMessage>;
    language?: string;
    /** Never reached the model (or stopped before a token): the caller restores the composer. */
    onNotSaved: (message: string | undefined) => void;
    /** The turn is persisted; `isNewThread` when this send created the thread. */
    onSaved: (result: { isNewThread: boolean; message: string | undefined; threadId: string }) => void;
    prompt: string;
    systemPrompt?: string;
    threadId: string | undefined;
}

export interface LocalModelTurn {
    /** Stop the in-flight local stream. `false` when none is running. */
    cancel: () => boolean;
    isStreaming: boolean;
    send: (options: LocalTurnSendOptions) => Promise<void>;
    /** The assistant reply while it streams (and until its saved row replaces it). */
    streamingMessage: UIMessage | null;
    /** Set when `model` runs on a `local-browser` endpoint; `undefined` for the gateway path. */
    target: LocalModelTarget | undefined;
}

interface LiveReply {
    persistedId?: string;
    reasoning: string;
    startedAt: number;
    text: string;
}

/**
 * The browser path for `local-browser` models: stream from the user's own
 * Ollama / LM Studio, show the reply as it arrives, then persist the turn via
 * `chat_local_models.saveLocalTurn`. Everything else about a chat — the
 * gateway, the agent loop, tools — is skipped, because none of it can reach
 * the user's machine.
 *
 * `savedMessageIds` is the thread's loaded message ids; the live reply is
 * dropped once its saved row is among them, so there is no flash between the
 * two.
 */
const useLocalModelTurn = (model: string, savedMessageIds: ReadonlySet<string>): LocalModelTurn => {
    const { i18n } = useLingui();
    const crpc = useCRPC();
    const { isAnonymous } = useIsAnonymous();
    // Only a `custom:` model can be local; every other chat skips the query.
    const { data: providers } = useQuery(crpc.chat.custom_providers.listCustomProviders.queryOptions(isCustomModelId(model) && !isAnonymous ? {} : skipToken));
    const { mutateAsync: saveLocalTurn } = useMutation(crpc.chat.local_models.saveLocalTurn.mutationOptions());
    const target = useMemo(() => findLocalModelTarget(providers, model), [providers, model]);
    const [live, setLive] = useState<LiveReply | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Drop the live copy once the subscription delivered the saved row.
    useEffect(() => {
        if (live?.persistedId && savedMessageIds.has(live.persistedId)) {
            setLive(null);
        }
    }, [live?.persistedId, savedMessageIds]);

    const cancel = useCallback(() => {
        if (!abortRef.current) {
            return false;
        }

        abortRef.current.abort();

        return true;
    }, []);

    const send = useCallback(
        async ({ branch, history, language, onNotSaved, onSaved, prompt, systemPrompt, threadId }: LocalTurnSendOptions) => {
            if (!target) {
                return;
            }

            const controller = new AbortController();

            abortRef.current = controller;
            setLive({ reasoning: "", startedAt: Date.now(), text: "" });

            let assistantMessageId: string | undefined;

            try {
                const result = await runLocalTurn({
                    baseUrl: target.baseUrl,
                    history,
                    modelId: target.modelId,
                    onUpdate: (text, reasoning) => setLive((current) => (current ? { ...current, reasoning, text } : current)),
                    prompt,
                    save: async (input) => {
                        const saved = await saveLocalTurn({
                            ...input,
                            ...(branch && { branch: { kind: branch.kind, messageId: branch.messageId as Id<"messages"> } }),
                            ...(language && { language }),
                            model,
                            ...(threadId && { threadId: threadId as Id<"threads"> }),
                        });

                        assistantMessageId = saved.assistantMessageId;

                        return saved;
                    },
                    signal: controller.signal,
                    systemPrompt,
                });

                if (!result.saved) {
                    setLive(null);
                    onNotSaved(result.error.kind === "aborted" ? undefined : i18n._(describeLocalError(result.error)));

                    return;
                }

                setLive((current) => (current && assistantMessageId ? { ...current, persistedId: assistantMessageId } : null));
                onSaved({
                    isNewThread: !threadId,
                    message: result.error ? i18n._(describeLocalError(result.error)) : undefined,
                    threadId: result.threadId,
                });
            } catch (error) {
                // The save itself failed (rate limit, validation, network to our backend).
                setLive(null);
                onNotSaved(error instanceof Error ? error.message : undefined);
            } finally {
                if (abortRef.current === controller) {
                    abortRef.current = null;
                }
            }
        },
        [i18n, model, saveLocalTurn, target],
    );

    const streamingMessage = useMemo((): UIMessage | null => {
        if (!live) {
            return null;
        }

        const id = `local-${live.startedAt}`;

        return {
            _creationTime: live.startedAt,
            id,
            key: id,
            model: target?.modelId,
            order: Number.MAX_SAFE_INTEGER,
            parts: [
                ...(live.reasoning ? [{ state: "streaming" as const, text: live.reasoning, type: "reasoning" as const }] : []),
                { text: live.text, type: "text" as const },
            ],
            role: "assistant",
            status: live.persistedId ? "success" : "streaming",
            stepOrder: 1,
            text: live.text,
        } as UIMessage;
    }, [live, target?.modelId]);

    return { cancel, isStreaming: live !== null && !live.persistedId, send, streamingMessage, target };
};

export default useLocalModelTurn;
