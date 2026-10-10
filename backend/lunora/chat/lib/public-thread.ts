/**
 * Projection of a thread's messages for the anonymous, read-only share page
 * (`/thread/$token`).
 *
 * The share link is a bearer token anyone can forward, so what leaves here is an
 * ALLOW-list, not the owner's `UIMessage` with fields deleted. A `UIMessage`
 * carries `userId`, a `key` built from the thread id, provider metadata, tool
 * inputs/outputs (memory search, connectors, e-mail, browser sessions …) and the
 * URLs of files the owner uploaded. None of that is part of "the conversation"
 * the owner chose to publish:
 *
 *  - text and web sources are kept;
 *  - reasoning, data parts and source documents are dropped;
 *  - a tool call becomes its NAME only — never its input or output;
 *  - media the ASSISTANT produced keeps its URL, unless the NSFW check has not
 *    cleared it;
 *  - anything the USER attached becomes a placeholder with no URL or filename.
 *
 * Message ids are replaced with positional ones — the page needs a React key,
 * not a database id.
 *
 * A group-chat reply keeps its participant's NAME (`speakerName`), which the
 * conversation shows anyway — never the skill id, and never its instructions.
 */
import { v } from "lunorash/server";
import type { Infer } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import type { QueryCtx as QueryContext } from "../../_generated/server";

/**
 * Upper bound on raw message rows read for one share page. Rows, not rendered
 * messages: an assistant turn with tool calls spans several rows.
 */
export const MAX_PUBLIC_THREAD_ROWS = 200;

/** Placeholder texts the streaming path writes while media is generating. */
const GENERATION_MARKERS = new Set(["__AUDIO_GENERATING__", "__IMAGE_GENERATING__", "__VIDEO_GENERATING__"]);

/** NSFW states under which a file must not be shown to an anonymous viewer. */
const UNCLEARED_NSFW_STATUSES = new Set(["blocked", "checking", "pending"]);

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);

export const vPublicThreadPart = v.union(
    v.object({ text: v.string(), type: v.literal("text") }),
    v.object({ title: v.optional(v.string()), type: v.literal("source-url"), url: v.string() }),
    v.object({ filename: v.optional(v.string()), mediaType: v.string(), type: v.literal("file"), url: v.string() }),
    v.object({ mediaType: v.optional(v.string()), type: v.literal("attachment") }),
    v.object({ toolName: v.string(), type: v.literal("tool") }),
);

export const vPublicThreadMessage = v.object({
    createdAt: v.number(),
    id: v.string(),
    parts: v.array(vPublicThreadPart),
    role: v.union(v.literal("user"), v.literal("assistant")),
    speakerName: v.optional(v.string()),
});

export type PublicThreadPart = Infer<typeof vPublicThreadPart>;
export type PublicThreadMessage = Infer<typeof vPublicThreadMessage>;

/** The subset of a `UIMessage` this projection reads. */
export interface PublicThreadSourceMessage {
    _creationTime: number;
    /** Only read for a group-chat reply (`speakerSkillId` set) — otherwise it is the model id. */
    agentName?: string;
    metadata?: unknown;
    parts: ReadonlyArray<unknown>;
    role: string;
    speakerSkillId?: string;
}

/** The participant name of a group-chat reply, or `undefined` for any other message. */
export const publicSpeakerName = (message: Pick<PublicThreadSourceMessage, "agentName" | "role" | "speakerSkillId">): string | undefined =>
    message.role === "assistant" && message.speakerSkillId && message.agentName ? message.agentName : undefined;

/** Reads `metadata.fileIds`, the chatFiles ids the send path records per message. */
export const getMessageFileIds = (message: Pick<PublicThreadSourceMessage, "metadata">): string[] => {
    const { metadata } = message;

    if (!metadata || typeof metadata !== "object" || !("fileIds" in metadata)) {
        return [];
    }

    const { fileIds } = metadata as { fileIds?: unknown };

    return Array.isArray(fileIds) ? fileIds.filter((id): id is string => typeof id === "string") : [];
};

const isSafeUrl = (value: unknown): value is string => {
    if (typeof value !== "string") {
        return false;
    }

    try {
        return SAFE_URL_PROTOCOLS.has(new URL(value).protocol);
    } catch {
        return false;
    }
};

const optionalString = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** `tool-<name>` (static tools) or `dynamic-tool` with a `toolName` (MCP). */
const getToolName = (part: Record<string, unknown>): string | undefined => {
    if (part.type === "dynamic-tool") {
        return optionalString(part.toolName);
    }

    if (typeof part.type === "string" && part.type.startsWith("tool-")) {
        return optionalString(part.type.slice("tool-".length));
    }

    return undefined;
};

const projectPart = (raw: unknown, role: "assistant" | "user", isMediaCleared: boolean): PublicThreadPart | undefined => {
    if (!raw || typeof raw !== "object") {
        return undefined;
    }

    const part = raw as Record<string, unknown>;

    switch (part.type) {
        case "file": {
            const mediaType = optionalString(part.mediaType);

            if (role === "user") {
                return { mediaType, type: "attachment" };
            }

            if (!isMediaCleared || !mediaType || !isSafeUrl(part.url)) {
                return undefined;
            }

            return { filename: optionalString(part.filename), mediaType, type: "file", url: part.url };
        }
        case "source-url": {
            return isSafeUrl(part.url) ? { title: optionalString(part.title), type: "source-url", url: part.url } : undefined;
        }
        case "text": {
            const text = typeof part.text === "string" ? part.text : "";

            return text.trim().length === 0 || GENERATION_MARKERS.has(text.trim()) ? undefined : { text, type: "text" };
        }
        default: {
            const toolName = getToolName(part);

            return toolName ? { toolName, type: "tool" } : undefined;
        }
    }
};

/**
 * Whether every file a message references has cleared the NSFW check. A file id
 * with NO entry — no `chatFiles` row, or a map that never loaded it — is unknown
 * media and counts as not cleared. That is the one missing-row rule; callers
 * pass what `loadNsfwStatuses` read and add no default of their own.
 */
const isMessageMediaCleared = (message: Pick<PublicThreadSourceMessage, "metadata">, nsfwStatusByFileId: ReadonlyMap<string, string | undefined>): boolean =>
    getMessageFileIds(message).every((fileId) => nsfwStatusByFileId.has(fileId) && !UNCLEARED_NSFW_STATUSES.has(nsfwStatusByFileId.get(fileId) ?? ""));

/**
 * The allow-listed parts of one message, each with its index in the raw parts,
 * or `undefined` for a role that is never shown. Shared by both projections
 * below, so what a non-member sees is decided here once.
 */
const projectMessageParts = (
    message: PublicThreadSourceMessage,
    nsfwStatusByFileId: ReadonlyMap<string, string | undefined>,
): { index: number; part: PublicThreadPart }[] | undefined => {
    if (message.role !== "user" && message.role !== "assistant") {
        return undefined;
    }

    const { role } = message;
    const isMediaCleared = isMessageMediaCleared(message, nsfwStatusByFileId);

    return [...message.parts.entries()].flatMap(([index, raw]) => {
        const part = projectPart(raw, role, isMediaCleared);

        return part ? [{ index, part }] : [];
    });
};

/**
 * Projects UI messages (ascending) onto the public share shape.
 *
 * `nsfwStatusByFileId` maps chatFiles ids to their NSFW status. A message whose
 * files include ANY uncleared one loses all of its media — parts and fileIds are
 * not reliably aligned one-to-one, so the conservative reading is per message.
 */
export const toPublicThreadMessages = (
    messages: ReadonlyArray<PublicThreadSourceMessage>,
    nsfwStatusByFileId: ReadonlyMap<string, string | undefined> = new Map(),
): PublicThreadMessage[] => {
    const result: PublicThreadMessage[] = [];

    for (const message of messages) {
        const projected = projectMessageParts(message, nsfwStatusByFileId);

        if (!projected) {
            continue;
        }

        const parts: PublicThreadPart[] = [];

        for (const { part } of projected) {
            // One chip per consecutive run of the same tool — an agent that calls
            // `web_search` five times in a row reads as one step to a viewer.
            const previous = parts.at(-1);

            if (part.type === "tool" && previous?.type === "tool" && previous.toolName === part.toolName) {
                continue;
            }

            parts.push(part);
        }

        if (parts.length === 0) {
            continue;
        }

        const speakerName = publicSpeakerName(message);

        result.push({
            createdAt: message._creationTime,
            id: `m${String(result.length)}`,
            parts,
            role: message.role as "assistant" | "user",
            ...(speakerName && { speakerName }),
        });
    }

    return result;
};

/**
 * The `UIMessage` fields the in-app thread view needs from a redacted message.
 * A structural subset of `UIMessage` — no user id, metadata, usage or cost — so
 * it needs no cast to travel where a `UIMessage` page is expected.
 */
export interface RedactedUIMessage {
    _creationTime: number;
    id: string;
    key: string;
    order: number;
    parts: (
        | { text: string; type: "text" }
        | { filename?: string; mediaType: string; type: "file"; url: string }
        | { sourceId: string; title?: string; type: "source-url"; url: string }
    )[];
    role: "assistant" | "user";
    /** A group-chat reply's participant name — see `publicSpeakerName`. */
    speakerName?: string;
    status: "success";
    stepOrder: number;
    text: string;
}

/**
 * The same allow-list as `toPublicThreadMessages`, returned in `UIMessage` shape
 * for the in-app thread page, so a non-owner opening a public thread by id sees
 * exactly what the share page shows — no user id, metadata, usage, tool payloads
 * or user-uploaded file URLs. Tool and attachment placeholders are dropped: the
 * in-app renderer would draw them as empty tool cards.
 */
export const redactUIMessagesForPublicViewer = (
    messages: ReadonlyArray<PublicThreadSourceMessage & { order?: number; status?: string; stepOrder?: number }>,
    nsfwStatusByFileId: ReadonlyMap<string, string | undefined> = new Map(),
): RedactedUIMessage[] => {
    const result: RedactedUIMessage[] = [];

    for (const message of messages) {
        // Only settled messages: a pending row can still carry a half-written tool call.
        const isSettled = message.status === undefined || message.status === "success";
        const projected = (isSettled && projectMessageParts(message, nsfwStatusByFileId)) || [];
        const parts: RedactedUIMessage["parts"] = [];

        for (const { index, part } of projected) {
            if (part.type === "text" || part.type === "file") {
                parts.push(part);
            } else if (part.type === "source-url") {
                parts.push({ sourceId: `s${String(index)}`, title: part.title, type: "source-url", url: part.url });
            }
        }

        if (parts.length === 0) {
            continue;
        }

        const id = `m${String(result.length)}`;
        const speakerName = publicSpeakerName(message);

        result.push({
            ...(speakerName && { speakerName }),
            _creationTime: message._creationTime,
            id,
            key: id,
            order: message.order ?? result.length,
            parts,
            role: message.role as "assistant" | "user",
            status: "success",
            stepOrder: message.stepOrder ?? 0,
            text: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        });
    }

    return result;
};

/**
 * NSFW status of every chatFiles row the messages reference, keyed by id. Only
 * rows that EXIST get an entry (their status may itself be unset); a missing row
 * is left out, which the projections above read as "not cleared".
 */
export const loadNsfwStatuses = async (
    context: Pick<QueryContext, "db">,
    messages: ReadonlyArray<Pick<PublicThreadSourceMessage, "metadata">>,
): Promise<Map<string, string | undefined>> => {
    const fileIds = [...new Set(messages.flatMap((message) => getMessageFileIds(message)))];
    const statuses = new Map<string, string | undefined>();

    if (fileIds.length === 0) {
        return statuses;
    }

    // One read for the page, not one per file: `chatFiles` is `.global()`, so
    // each read is a D1 round trip.
    const { page: files } = await context.db.chatFiles.findMany({ where: { _id: { in: fileIds as Id<"chatFiles">[] } } });

    for (const file of files) {
        statuses.set(file._id as string, file.nsfwStatus ?? undefined);
    }

    return statuses;
};
