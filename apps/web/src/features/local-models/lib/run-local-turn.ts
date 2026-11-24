/**
 * One chat turn against a `local-browser` endpoint: stream from the user's
 * machine, then persist the finished turn through `chat_local_models.saveLocalTurn`.
 *
 * Framework-free so the whole decision table is unit-tested: what is saved on
 * success, on a stop, on a mid-stream failure, and what is NOT saved when the
 * server was never reached (the prompt goes back to the composer instead of
 * leaving a thread with an unanswered message behind).
 */
import type { LocalChatMessage } from "./local-client";
import { streamLocalChat } from "./local-client";
import type { LocalErrorInfo } from "./local-errors";
import { diagnoseLocalError } from "./local-errors";
import type { ReplyStopKind } from "./reply-guard";
import { createReplyGuard, LOCAL_IDLE_TIMEOUT_MS } from "./reply-guard";

/** How many earlier messages go to the local model as context. */
export const LOCAL_HISTORY_LIMIT = 40;

export interface HistoryMessage {
    role: string;
    text: string;
}

export interface SaveLocalTurnInput {
    error?: string;
    outcome: "aborted" | "complete" | "failed";
    prompt: string;
    reasoning?: string;
    reply: string;
}

export interface RunLocalTurnOptions {
    baseUrl: string;
    /** The words saved as the reply's error when the reply guard stopped it. Defaults to the stop's kind. */
    describeStop?: (info: LocalErrorInfo) => string;
    /** Diagnosis is injectable because the real one probes the network. */
    diagnose?: (error: unknown, baseUrl: string) => Promise<LocalErrorInfo>;
    fetchImpl?: typeof fetch;
    history: ReadonlyArray<HistoryMessage>;
    modelId: string;
    onUpdate: (text: string, reasoning: string) => void;
    prompt: string;
    save: (input: SaveLocalTurnInput) => Promise<{ threadId: string }>;
    signal: AbortSignal;
    systemPrompt?: string;
}

export type RunLocalTurnResult =
    | { error?: LocalErrorInfo; outcome: "aborted" | "complete" | "failed"; saved: true; threadId: string }
    | { error: LocalErrorInfo; saved: false };

/**
 * Earlier turns as plain text. Only user/assistant rows with text survive:
 * tool calls, images and empty streaming placeholders mean nothing to a local
 * model that was never offered those tools.
 */
export const buildLocalHistory = (messages: ReadonlyArray<HistoryMessage>, systemPrompt?: string, limit = LOCAL_HISTORY_LIMIT): LocalChatMessage[] => {
    const turns: LocalChatMessage[] = [];

    for (const message of messages) {
        const content = message.text.trim();

        if ((message.role === "user" || message.role === "assistant") && content) {
            turns.push({ content, role: message.role });
        }
    }

    const recent = turns.slice(-limit);

    return systemPrompt?.trim() ? [{ content: systemPrompt.trim(), role: "system" }, ...recent] : recent;
};

export const runLocalTurn = async (options: RunLocalTurnOptions): Promise<RunLocalTurnResult> => {
    const {
        baseUrl,
        describeStop = (info: LocalErrorInfo) => info.kind,
        diagnose = diagnoseLocalError,
        fetchImpl,
        history,
        modelId,
        onUpdate,
        prompt,
        save,
        signal,
        systemPrompt,
    } = options;
    let text = "";
    let reasoning = "";
    // The reply guard stops the stream through its own controller, so its stop reads as ours and not as the user's.
    const stream = new AbortController();
    const onUserAbort = () => {
        stream.abort();
    };
    const guard = createReplyGuard();
    // An object, not a `let`: the stop is set inside callbacks, which TypeScript does not follow.
    const state: { failure?: { error: unknown }; idleTimer?: ReturnType<typeof setTimeout>; stop?: ReplyStopKind } = {};

    const stopWith = (kind: ReplyStopKind) => {
        if (state.stop) {
            return;
        }

        state.stop = kind;
        clearTimeout(state.idleTimer);
        stream.abort();
    };

    const armIdle = () => {
        clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(stopWith, LOCAL_IDLE_TIMEOUT_MS, "idle");
    };

    if (signal.aborted) {
        stream.abort();
    } else {
        signal.addEventListener("abort", onUserAbort, { once: true });
    }

    armIdle();

    try {
        await streamLocalChat({
            baseUrl,
            fetchImpl,
            messages: [...buildLocalHistory(history, systemPrompt), { content: prompt, role: "user" }],
            model: modelId,
            onDelta: (delta) => {
                // Tokens of a chunk that arrived after the stop are not part of the saved reply.
                if (state.stop) {
                    return;
                }

                text += delta.content;
                reasoning += delta.reasoning;
                onUpdate(text, reasoning);
                armIdle();

                const cause = guard.pushContent(delta.content) ?? guard.pushReasoning(delta.reasoning);

                if (cause) {
                    stopWith(cause);
                }
            },
            signal: stream.signal,
        });
    } catch (error) {
        state.failure = { error };
    } finally {
        clearTimeout(state.idleTimer);
        signal.removeEventListener("abort", onUserAbort);
    }

    // The guard's stop wins over whatever the stream did next: a stream that ended on its own right after the stop is still a stop.
    if (state.stop) {
        const info: LocalErrorInfo = { kind: state.stop };
        const { threadId } = await save({ error: describeStop(info), outcome: "failed", prompt, reasoning, reply: text });

        return { error: info, outcome: "failed", saved: true, threadId };
    }

    if (state.failure) {
        const info = await diagnose(state.failure.error, baseUrl);

        if (info.kind === "aborted") {
            // A stop before the first token leaves nothing worth a thread entry.
            if (!text && !reasoning) {
                return { error: info, saved: false };
            }

            const { threadId } = await save({ outcome: "aborted", prompt, reasoning, reply: text });

            return { outcome: "aborted", saved: true, threadId };
        }

        // Never reached the model: hand the prompt back rather than save half a turn.
        if (!text && !reasoning) {
            return { error: info, saved: false };
        }

        const { threadId } = await save({ error: info.detail ?? info.kind, outcome: "failed", prompt, reasoning, reply: text });

        return { error: info, outcome: "failed", saved: true, threadId };
    }

    const { threadId } = await save({ outcome: "complete", prompt, reasoning, reply: text });

    return { outcome: "complete", saved: true, threadId };
};
