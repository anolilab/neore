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
    { error?: LocalErrorInfo; outcome: "aborted" | "complete" | "failed"; saved: true; threadId: string } | { error: LocalErrorInfo; saved: false };

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
    const { baseUrl, diagnose = diagnoseLocalError, fetchImpl, history, modelId, onUpdate, prompt, save, signal, systemPrompt } = options;
    let text = "";
    let reasoning = "";

    try {
        await streamLocalChat({
            baseUrl,
            fetchImpl,
            messages: [...buildLocalHistory(history, systemPrompt), { content: prompt, role: "user" }],
            model: modelId,
            onDelta: (delta) => {
                text += delta.content;
                reasoning += delta.reasoning;
                onUpdate(text, reasoning);
            },
            signal,
        });
    } catch (error) {
        const info = await diagnose(error, baseUrl);

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
