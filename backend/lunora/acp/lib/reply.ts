/**
 * The reply a host turn leaves in the thread, built from the chunks the host posted. Pure, so the shape is
 * pinned without a database. Nothing here bills: the agent bills its own account, and host turns write no usage
 * row and charge no credit (`scheduleReplyUsage` is deliberately not called; plans/acp-agent-host.md §5.2).
 */
import type { Doc } from "../../_generated/dataModel";
import type { HostChanges } from "./changes";
import { MAX_HOST_REPLY_CHARS } from "./constants";

export const HOST_PROVIDER = "acp-host";

const MAX_ERROR_CHARS = 1000;

export type HostReplyReason = "cancelled" | "failed" | "finished" | "interrupted" | "revoked" | "stopped" | "timeout";

/** What one of the agent's own children did, keyed by the tool call that spawned it (§4.7). */
export interface ChildTranscript {
    reasoning: string;
    spawnId: string;
    /** Unset while the child had not ended when the turn did. */
    status?: "cancelled" | "completed" | "failed";
    text: string;
    tools: { id: string; status: string; title: string; toolKind: string }[];
}

export interface HostTranscript {
    children: ChildTranscript[];
    reasoning: string;
    text: string;
}

/** A reply keeps at most this many children, and each of them this much. The host cuts to the same. */
const MAX_CHILDREN = 16;
const MAX_CHILD_CHARS = 64_000;
const MAX_CHILD_TOOLS = 50;

export const emptyTranscript = (): HostTranscript => {
    return { children: [], reasoning: "", text: "" };
};

type ChildEvent = Extract<Doc<"persistentChunks">["event"], { spawnId: string }>;

/**
 * Adds one child event to its child's transcript. The first event for a spawn call makes the child; once it has
 * ended nothing more is added (a repeated end and a late word are ignored), and the completion's own text is kept
 * only for a child that streamed none.
 */
export const appendChildEvent = (transcript: HostTranscript, event: ChildEvent): void => {
    let child = transcript.children.find((candidate) => candidate.spawnId === event.spawnId);

    if (!child) {
        if (transcript.children.length >= MAX_CHILDREN) {
            return;
        }

        child = { reasoning: "", spawnId: event.spawnId, text: "", tools: [] };
        transcript.children.push(child);
    }

    if (child.status !== undefined) {
        return;
    }

    if (event.kind === "child_text") {
        const field = event.field === "text" ? "text" : "reasoning";

        child[field] += event.text.slice(0, MAX_CHILD_CHARS - child[field].length);
    } else if (event.kind === "child_tool") {
        const known = child.tools.find((tool) => tool.id === event.id);
        const next = { id: event.id, status: event.status, title: event.title, toolKind: event.toolKind };

        if (known) {
            Object.assign(known, next);
        } else if (child.tools.length < MAX_CHILD_TOOLS) {
            child.tools.push(next);
        }
    } else {
        child.status = event.status;

        if (child.text === "" && event.text !== undefined) {
            child.text = event.text.slice(0, MAX_CHILD_CHARS);
        }
    }
};

export const isChildEvent = (event: Doc<"persistentChunks">["event"]): event is ChildEvent =>
    event?.kind === "child_text" || event?.kind === "child_tool" || event?.kind === "child_end";

/** Adds one chunk's text to the transcript, cut at the reply cap; only the part that still fits is joined on. */
export const appendToTranscript = (transcript: HostTranscript, chunk: { reasoning?: string | null; text: string }): void => {
    transcript.text += chunk.text.slice(0, MAX_HOST_REPLY_CHARS - transcript.text.length);
    transcript.reasoning += (chunk.reasoning ?? "").slice(0, MAX_HOST_REPLY_CHARS - transcript.reasoning.length);
};

/** Whether the text is at the cap. A reply with no reasoning never fills that part, so only the text decides when reading can stop. */
export const isTranscriptFull = (transcript: HostTranscript): boolean => transcript.text.length >= MAX_HOST_REPLY_CHARS;

const INTERRUPTED = "The turn was interrupted when the app restarted. Anything the agent started in the background was stopped with it.";

const TIMED_OUT = "The agent stopped sending output, so the turn was ended. The app may have restarted or lost its connection.";

const REVOKED = "This computer was removed, so the turn was ended.";

/** The turn did not end well: the host failed, was cut off, went silent or was removed. The reply is always saved. */
const isFailure = (reason: HostReplyReason): boolean => ["failed", "interrupted", "revoked", "timeout"].includes(reason);

const finishReasonOf = (reason: HostReplyReason): "error" | "other" | "stop" => {
    if (isFailure(reason)) {
        return "error";
    }

    return reason === "finished" ? "stop" : "other";
};

/**
 * `null` when there is nothing to save: a finished or stopped turn that wrote nothing. A turn that failed, was
 * interrupted, timed out or lost its device is always saved, so the thread says what happened. A turn that
 * changed files is saved too, even with no words, since the summary lives on the reply.
 */
export const buildHostReply = (input: { agentKey: string; changes?: HostChanges; error?: string; reason: HostReplyReason; transcript: HostTranscript }) => {
    const failed = isFailure(input.reason);
    const { children, reasoning, text } = input.transcript;

    if (!failed && text.length === 0 && reasoning.length === 0 && children.length === 0 && input.changes === undefined) {
        return null;
    }

    let error: string | undefined;

    switch (input.reason) {
        case "interrupted": {
            error = INTERRUPTED;
            break;
        }
        case "revoked": {
            error = REVOKED;
            break;
        }
        case "timeout": {
            error = TIMED_OUT;
            break;
        }
        default: {
            if (failed) {
                error = (input.error?.trim() || "The agent stopped with an error").slice(0, MAX_ERROR_CHARS);
            }
        }
    }

    return {
        ...(error !== undefined && { error }),
        finishReason: finishReasonOf(input.reason),
        message: { content: text ? [{ text, type: "text" as const }] : [], role: "assistant" as const },
        model: input.agentKey,
        provider: HOST_PROVIDER,
        // The children's transcripts ride beside the reply, keyed by the call that spawned each. The reply has no tool
        // parts to hang them on (a host turn keeps text and reasoning only), and a content part type of their own would
        // touch every reader of message content.
        providerMetadata: {
            neore: {
                billed: false,
                runtime: HOST_PROVIDER,
                ...(children.length > 0 && { subagentTranscripts: children }),
                ...(input.changes !== undefined && { hostChanges: input.changes }),
            },
        },
        ...(reasoning && { reasoning }),
        status: failed ? ("failed" as const) : ("success" as const),
    };
};
