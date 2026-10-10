import type { ChatMessage, MessagePart } from "@neore/chat-ui/types";
import type { StreamSpeaker } from "@neore/chat-ui/utils/stream-line";

/** The text of a text part; `MessagePart`'s open member means `type` alone does not narrow. */
const textOf = (part: MessagePart): string | undefined => (part.type === "text" && "text" in part && typeof part.text === "string" ? part.text : undefined);

interface RawMessage {
    _creationTime?: number;
    _id?: string;
    agentName?: string;
    content?: unknown;
    error?: string;
    id?: string;
    metadata?: ChatMessage["metadata"];
    model?: string;
    parts?: MessagePart[];
    role: ChatMessage["role"];
    speakerSkillId?: string;
    status?: string;
    text?: string;
    usage?: ChatMessage["usage"];
}

/**
 * Backend UI messages → `@neore/chat-ui` messages, oldest first. Page-context
 * parts pass through untouched: chat-ui recognises their
 * `providerMetadata.neore.pageContext` marker and renders a chip.
 *
 * A group-chat reply carries `speakerSkillId`, and its `agentName` is then the
 * participant's name; on any other reply `agentName` is the model id, not a
 * speaker. Same rule as the web app's `getMessageSpeakerName`.
 */
export const toChatMessages = (rows: ReadonlyArray<unknown>): ChatMessage[] =>
    (rows as RawMessage[])
        .map((row) => {
            const parts = row.parts ?? (typeof row.content === "string" ? [{ text: row.content, type: "text" }] : []);

            return {
                _creationTime: row._creationTime,
                error: row.error,
                id: row._id ?? row.id ?? "",
                metadata: row.metadata,
                model: row.model,
                parts,
                role: row.role,
                ...(row.speakerSkillId && row.agentName && { speakerName: row.agentName, speakerSkillId: row.speakerSkillId }),
                status: row.status,
                text: row.text,
                usage: row.usage,
            };
        })
        .toSorted((a, b) => (a._creationTime ?? 0) - (b._creationTime ?? 0));

const hasText = (message: ChatMessage): boolean => message.parts.some((part) => (textOf(part)?.trim().length ?? 0) > 0);

export interface LiveReply {
    /** The user message the reply answers — the persisted reply comes after it. */
    promptMessageId: string;
    reasoning: string;
    /** Group chat: the participant talking now; `text`/`reasoning` are theirs only. */
    speaker?: StreamSpeaker;
    text: string;
}

/**
 * True once the persisted thread holds the finished reply `live` is streaming.
 * In a group chat one prompt gets a reply per participant, so only the current
 * speaker's counts — an earlier participant's saved reply does not.
 */
export const isReplyPersisted = (messages: ChatMessage[], live: Pick<LiveReply, "promptMessageId" | "speaker">): boolean => {
    const promptIndex = messages.findIndex((message) => message.id === live.promptMessageId);

    return (
        promptIndex !== -1 &&
        messages
            .slice(promptIndex + 1)
            .some(
                (message) =>
                    message.role === "assistant" &&
                    message.status !== "pending" &&
                    hasText(message) &&
                    (!live.speaker || message.speakerSkillId === live.speaker.skillId),
            )
    );
};

/**
 * The thread as displayed: persisted messages, with the live-streamed reply in
 * place of its still-empty pending row until the finished one lands.
 */
export const withLiveReply = (messages: ChatMessage[], live: LiveReply | null): ChatMessage[] => {
    if (!live || isReplyPersisted(messages, live)) {
        return messages;
    }

    // Everything but an assistant row that is still pending and empty.
    const base = messages.filter((message) => message.role !== "assistant" || message.status !== "pending" || hasText(message));
    const parts: MessagePart[] = [
        ...(live.reasoning ? [{ text: live.reasoning, type: "reasoning" as const }] : []),
        { text: live.text, type: "text" as const },
    ];

    return [
        ...base,
        {
            id: `live-${live.promptMessageId}`,
            parts,
            role: "assistant",
            ...(live.speaker && { speakerName: live.speaker.name, speakerSkillId: live.speaker.skillId }),
            status: "streaming",
            text: live.text,
        },
    ];
};
