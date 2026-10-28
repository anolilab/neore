/**
 * The reply a host turn leaves in the thread, built from the chunks the host posted. Pure, so the shape is
 * pinned without a database. Nothing here bills: the agent bills its own account, and host turns write no usage
 * row and charge no credit (`scheduleReplyUsage` is deliberately not called; plans/acp-agent-host.md §5.2).
 */
import { MAX_HOST_REPLY_CHARS } from "./constants";

export const HOST_PROVIDER = "acp-host";

const MAX_ERROR_CHARS = 1000;

export type HostReplyReason = "cancelled" | "failed" | "finished" | "interrupted" | "stopped";

export interface HostTranscript {
    reasoning: string;
    text: string;
}

export const emptyTranscript = (): HostTranscript => {
    return { reasoning: "", text: "" };
};

/** Adds one chunk's text to the transcript, cut at the reply cap. */
export const appendToTranscript = (transcript: HostTranscript, chunk: { reasoning?: string | null; text: string }): void => {
    transcript.text = (transcript.text + chunk.text).slice(0, MAX_HOST_REPLY_CHARS);
    transcript.reasoning = (transcript.reasoning + (chunk.reasoning ?? "")).slice(0, MAX_HOST_REPLY_CHARS);
};

const INTERRUPTED = "The turn was interrupted when the app restarted. Anything the agent started in the background was stopped with it.";

const finishReasonOf = (reason: HostReplyReason): "error" | "other" | "stop" => {
    if (reason === "failed" || reason === "interrupted") {
        return "error";
    }

    return reason === "finished" ? "stop" : "other";
};

/**
 * `null` when there is nothing to save: a finished or stopped turn that wrote nothing. A failed or interrupted
 * turn is always saved, so the thread says what happened.
 */
export const buildHostReply = (input: { agentKey: string; error?: string; reason: HostReplyReason; transcript: HostTranscript }) => {
    const failed = input.reason === "failed" || input.reason === "interrupted";
    const { reasoning, text } = input.transcript;

    if (!failed && text.length === 0 && reasoning.length === 0) {
        return null;
    }

    let error: string | undefined;

    if (input.reason === "interrupted") {
        error = INTERRUPTED;
    } else if (failed) {
        error = (input.error?.trim() || "The agent stopped with an error").slice(0, MAX_ERROR_CHARS);
    }

    return {
        ...(error !== undefined && { error }),
        finishReason: finishReasonOf(input.reason),
        message: { content: text ? [{ text, type: "text" as const }] : [], role: "assistant" as const },
        model: input.agentKey,
        provider: HOST_PROVIDER,
        providerMetadata: { neore: { billed: false, runtime: HOST_PROVIDER } },
        ...(reasoning && { reasoning }),
        status: failed ? ("failed" as const) : ("success" as const),
    };
};
