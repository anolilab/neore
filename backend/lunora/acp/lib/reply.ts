/**
 * The reply a host turn leaves in the thread, built from the chunks the host posted. Pure, so the shape is
 * pinned without a database. Nothing here bills: the agent bills its own account, and host turns write no usage
 * row and charge no credit (`scheduleReplyUsage` is deliberately not called; plans/acp-agent-host.md §5.2).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import { toStorageRef } from "../../lib/storage-ref";
import type { HostChanges } from "./changes";
import { HOST_MEDIA_IMAGE_MIME_TYPES, HOST_MEDIA_MAX_BYTES, HOST_MEDIA_MAX_INLINE_IMAGE_BYTES, MAX_HOST_REPLY_CHARS, MAX_MEDIA_PER_TURN } from "./constants";

export const HOST_PROVIDER = "acp-host";

/**
 * Marks the text of a host reply for the reader (`packages/chat-ui/src/utils/host-run-text.ts`): it is a coding
 * agent's own text, so its Markdown images are not loaded.
 */
const HOST_TEXT_MARK = { neore: { runner: "host" } } as const;

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

/** A file the reply refers to, as its `media` event was stored: attached when the ingest finalized its upload. */
export interface HostMedia {
    contentType?: string;
    fileId?: string;
    name: string;
    /** The Markdown image target the agent wrote, decoded: the reply's text names the file by it. */
    reference?: string;
    size: number;
    storageKey?: string;
}

export interface HostTranscript {
    children: ChildTranscript[];
    media: HostMedia[];
    reasoning: string;
    text: string;
}

/** A reply keeps at most this many children, and each of them this much. The host cuts to the same. */
const MAX_CHILDREN = 16;
const MAX_CHILD_CHARS = 64_000;
const MAX_CHILD_TOOLS = 50;

export const emptyTranscript = (): HostTranscript => {
    return { children: [], media: [], reasoning: "", text: "" };
};

/** Keeps a stored `media` event for the reply. Past the per-turn count it is dropped, not the turn. */
export const addMediaToTranscript = (transcript: HostTranscript, media: HostMedia): void => {
    if (transcript.media.length < MAX_MEDIA_PER_TURN) {
        transcript.media.push(media);
    }
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

/** `![alt](target "title")`; the desktop reads the same shape (`apps/desktop/src/acp/media.ts`). */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gu; // eslint-disable-line sonarjs/regex-complexity -- the same shape the desktop parses

const decodedTarget = (target: string): string => {
    const bare = target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;

    try {
        return decodeURIComponent(bare);
    } catch {
        return bare;
    }
};

/** The text with each image that became an attachment replaced by its alt text: the file is shown below, not as Markdown. */
const withoutAttachedImages = (text: string, references: ReadonlySet<string>): string =>
    references.size === 0
        ? text
        : text.replaceAll(MARKDOWN_IMAGE, (whole, alt: string, target: string) => (references.has(decodedTarget(target)) ? alt : whole));

const formatSize = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** A file name as inline code: the name is the agent's text, and must not become Markdown, a link or an image. */
const asCode = (name: string): string => `\`${name.replaceAll(/[`\r\n]/gu, " ").trim()}\``;

/** Whether an attached file is shown in the message. Any other (a document, or an image over the inline cap) is a download card. */
const isInline = (file: HostMedia): boolean =>
    file.contentType !== undefined && HOST_MEDIA_IMAGE_MIME_TYPES.includes(file.contentType) && file.size <= HOST_MEDIA_MAX_INLINE_IMAGE_BYTES;

/** What the reply says next to a file shown as a download: its name and size. */
const attachedNote = (file: HostMedia): string => `${asCode(file.name)} (${formatSize(file.size)}) is attached as a file.`;

/** What the reply says about a file it could not carry: its name and size, and why. */
const notAttachedNote = (files: HostMedia[]): string =>
    files
        .map((file) =>
            file.size > HOST_MEDIA_MAX_BYTES
                ? `${asCode(file.name)} (${formatSize(file.size)}) is over the ${formatSize(HOST_MEDIA_MAX_BYTES)} limit and was not attached.`
                : `${asCode(file.name)} (${formatSize(file.size)}) could not be attached.`,
        )
        .join("\n\n");

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
    const { children, media, reasoning, text } = input.transcript;

    if (!failed && text.length === 0 && reasoning.length === 0 && children.length === 0 && media.length === 0 && input.changes === undefined) {
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

    const attached = media.filter((file) => file.storageKey !== undefined && file.fileId !== undefined);
    const notAttached = media.filter((file) => file.storageKey === undefined || file.fileId === undefined);
    const notes = [
        ...attached.filter((file) => !isInline(file)).map((file) => attachedNote(file)),
        ...(notAttached.length > 0 ? [notAttachedNote(notAttached)] : []),
    ];
    const shownText = withoutAttachedImages(text, new Set(attached.flatMap((file) => (file.reference === undefined ? [] : [file.reference]))));
    const parts = [
        ...(shownText ? [{ providerMetadata: HOST_TEXT_MARK, text: shownText, type: "text" as const }] : []),
        // The part carries a `storage:` reference, signed when the message is read (`agent/stored-media.ts`).
        // An image over the inline cap goes as an opaque file, so the reader offers it as a download, not a picture.
        ...attached.map((file) => {
            const declared = file.contentType ?? "application/octet-stream";
            const mediaType = HOST_MEDIA_IMAGE_MIME_TYPES.includes(declared) && !isInline(file) ? "application/octet-stream" : declared;

            return { data: toStorageRef(file.storageKey as string), filename: file.name, mediaType, type: "file" as const };
        }),
        ...(notes.length > 0 ? [{ providerMetadata: HOST_TEXT_MARK, text: notes.join("\n\n"), type: "text" as const }] : []),
    ];

    return {
        ...(error !== undefined && { error }),
        ...(attached.length > 0 && { fileIds: [...new Set(attached.map((file) => file.fileId as Id<"chatFiles">))] }),
        finishReason: finishReasonOf(input.reason),
        message: { content: parts, role: "assistant" as const },
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
