import type { ReturnOf } from "@lunora/react";
import type { api } from "@neore/backend/api";
import type { ChatMessage, MessagePart } from "@neore/chat-ui/types";

export type PublicThread = NonNullable<ReturnOf<typeof api.chat.sharing.getPublicThread>>;
export type PublicThreadMessage = PublicThread["messages"][number];

export interface PublicThreadRenderable {
    /** Media types of files the user attached — shown as placeholders, never fetched. */
    attachments: (string | undefined)[];
    /** What the shared chat-ui renderer draws: text, web sources, generated media. */
    message: ChatMessage;
    /** Group chat: the participant that wrote this reply. Its name only — never its instructions. */
    speakerName?: string;
    /** Tool names in call order; their inputs and outputs are never sent. */
    tools: string[];
}

/**
 * Splits a public share message into what the chat-ui renderer can draw and the
 * placeholder-only parts (`tool`, `attachment`) the share page renders itself.
 */
export const toPublicThreadRenderable = (source: PublicThreadMessage): PublicThreadRenderable => {
    const attachments: (string | undefined)[] = [];
    const tools: string[] = [];
    const parts: MessagePart[] = [];

    for (const [index, part] of source.parts.entries()) {
        switch (part.type) {
            case "attachment": {
                attachments.push(part.mediaType);
                break;
            }
            case "file": {
                parts.push({ filename: part.filename, mediaType: part.mediaType, type: "file", url: part.url });
                break;
            }
            case "source-url": {
                parts.push({ sourceId: `${source.id}-source-${String(index)}`, title: part.title, type: "source-url", url: part.url });
                break;
            }
            case "text": {
                parts.push({ text: part.text, type: "text" });
                break;
            }
            case "tool": {
                tools.push(part.toolName);
                break;
            }
            default: {
                break;
            }
        }
    }

    return {
        attachments,
        message: { _creationTime: source.createdAt, id: source.id, parts, role: source.role, status: "success" },
        ...(source.speakerName && { speakerName: source.speakerName }),
        tools,
    };
};

/** `web_search` → `web search`; MCP names keep their server prefix readable. */
export const formatToolName = (toolName: string): string => toolName.replaceAll(/[_-]+/g, " ").trim();
