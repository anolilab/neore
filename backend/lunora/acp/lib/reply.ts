/**
 * The reply a host turn leaves in the thread, built from the chunks the host posted. Pure, so the shape is
 * pinned without a database. Nothing here bills: the agent bills its own account, and host turns write no usage
 * row and charge no credit (`scheduleReplyUsage` is deliberately not called; plans/acp-agent-host.md §5.2).
 */
import type { Id } from "../../_generated/dataModel";
import { toStorageRef } from "../../lib/storage-ref";
import { HOST_MEDIA_IMAGE_MIME_TYPES, HOST_MEDIA_MAX_BYTES, HOST_MEDIA_MAX_INLINE_IMAGE_BYTES, MAX_HOST_REPLY_CHARS, MAX_MEDIA_PER_TURN } from "./constants";

export const HOST_PROVIDER = "acp-host";

/**
 * Marks the text of a host reply for the reader (`packages/chat-ui/src/utils/host-run-text.ts`): it is a coding
 * agent's own text, so its Markdown images are not loaded.
 */
const HOST_TEXT_MARK = { neore: { runner: "host" } } as const;

const MAX_ERROR_CHARS = 1000;

export type HostReplyReason = "cancelled" | "failed" | "finished" | "interrupted" | "revoked" | "stopped" | "timeout";

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
    media: HostMedia[];
    reasoning: string;
    text: string;
}

export const emptyTranscript = (): HostTranscript => {
    return { media: [], reasoning: "", text: "" };
};

/** Keeps a stored `media` event for the reply. Past the per-turn count it is dropped, not the turn. */
export const addMediaToTranscript = (transcript: HostTranscript, media: HostMedia): void => {
    if (transcript.media.length < MAX_MEDIA_PER_TURN) {
        transcript.media.push(media);
    }
};

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
    references.size === 0 ? text : text.replaceAll(MARKDOWN_IMAGE, (whole, alt: string, target: string) => (references.has(decodedTarget(target)) ? alt : whole));

const formatSize = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

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
 * interrupted, timed out or lost its device is always saved, so the thread says what happened.
 */
export const buildHostReply = (input: { agentKey: string; error?: string; reason: HostReplyReason; transcript: HostTranscript }) => {
    const failed = isFailure(input.reason);
    const { media, reasoning, text } = input.transcript;

    if (!failed && text.length === 0 && reasoning.length === 0 && media.length === 0) {
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
    const notes = [...attached.filter((file) => !isInline(file)).map((file) => attachedNote(file)), ...(notAttached.length > 0 ? [notAttachedNote(notAttached)] : [])];
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
        providerMetadata: { neore: { billed: false, runtime: HOST_PROVIDER } },
        ...(reasoning && { reasoning }),
        status: failed ? ("failed" as const) : ("success" as const),
    };
};
