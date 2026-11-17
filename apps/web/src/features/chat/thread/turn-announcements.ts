/**
 * Pure helpers for what a screen reader hears during a turn: a short snippet of a
 * finished reply, and the tool calls that just started in the reply being written.
 * They read the message list, so a row rendered twice in the DOM is still one
 * announcement.
 */

import type { MessagePart, ToolPart } from "@neore/chat-ui/types";
import { resolveDeviceToolName } from "@neore/chat-ui/utils/device-tool-name";
import { markdownToPlainText } from "@neore/chat-ui/utils/markdown-text";
import { resolveMcpToolName } from "@neore/chat-ui/utils/mcp-tool-name";

/** Longest reply snippet read out. A longer reply is cut at a word and ends with an ellipsis. */
export const REPLY_SNIPPET_MAX_LENGTH = 200;

/** The fields of a chat message these helpers read. */
export interface TurnMessage {
    id: string;
    parts: ReadonlyArray<MessagePart>;
    /** The run that wrote the reply (`replyId` on the backend). Set on the rows a streamed run saved. */
    replyId?: string;
    role: string;
    status?: string;
}

/** A tool call the reader hears start: its key across the thread, and the name to say. */
export interface ToolStep {
    key: string;
    toolName: string;
}

const UNFINISHED_STATUSES = new Set(["pending", "streaming"]);

/** Static tools are `tool-<name>`; the backend sends MCP calls as `dynamic-tool` with the name in `toolName`. */
const isToolPart = (part: MessagePart): part is ToolPart => {
    const type = part.type as string;

    return type.startsWith("tool-") || type === "dynamic-tool";
};

/**
 * Identity of a call: the turn it belongs to and its tool-call id. A provider may reuse an
 * id in a later turn, so the id alone is not enough to tell two calls apart.
 */
export const toolCallKey = (turnId: string, toolCallId: string): string => `${turnId}\u{0}${toolCallId}`;

/**
 * The reply each message belongs to. A reply that names the run that wrote it is identified by
 * that run: a regenerated or group reply has its own run, and merging or swapping the rows of one
 * run leaves the identity unchanged. Otherwise the reply is the turn the user message starts, which
 * keeps a call's identity across a merge of a multi-step turn's rows. A message with no user
 * message before it is its own turn.
 */
const turnAnchors = (messages: ReadonlyArray<TurnMessage>): string[] => {
    let turn: string | undefined;

    return messages.map((message) => {
        if (message.role === "user") {
            turn = message.id;

            return message.id;
        }

        if (message.replyId) {
            return `run\u{1}${message.replyId}`;
        }

        return turn ?? message.id;
    });
};

/**
 * The first few words of a reply, as plain text: the whole reply when it is short,
 * else cut at the last word that fits and marked with an ellipsis. Empty for a reply with no text.
 */
export const replySnippet = (markdown: string): string => {
    // Private-use characters have no spoken form, and the converter uses them as placeholders, so a
    // literal one could be mistaken for a placeholder and dropped or replaced. They are removed first.
    const plain = markdownToPlainText(markdown.replaceAll(/\p{Co}/gu, ""))
        .replaceAll(/\s+/g, " ")
        .trim();
    // Counted by code point, so a cut never splits an emoji or other surrogate pair. A code
    // point is at most two UTF-16 units, so the first 2 * max + 1 units decide the length
    // without expanding the whole reply.
    const head = plain.slice(0, 2 * REPLY_SNIPPET_MAX_LENGTH + 1);
    const characters = [...head];

    if (characters.length <= REPLY_SNIPPET_MAX_LENGTH) {
        return plain;
    }

    const cut = characters.slice(0, REPLY_SNIPPET_MAX_LENGTH).join("");
    const wordEnd = cut.lastIndexOf(" ");
    const kept = wordEnd > REPLY_SNIPPET_MAX_LENGTH / 2 ? cut.slice(0, wordEnd) : cut;

    return `${kept.trimEnd()}…`;
};

/** What a finished reply says: its snippet, or nothing when it failed, since a failed reply is not "complete". */
export const announcedReplyText = (reply: { failed: boolean; message: { text: string } }): string => (reply.failed ? "" : replySnippet(reply.message.text));

/**
 * The reply being written: the newest assistant message, when it has not settled yet,
 * or, while the turn is still streaming, even when it has. A call that starts and
 * finishes inside one saved message reaches the list already settled. A reply that
 * comes before the latest prompt belongs to an earlier turn, so it is never the one being written.
 */
export const inFlightReply = (messages: ReadonlyArray<TurnMessage>, isStreaming = false): TurnMessage | null => {
    const reply = messages.findLast((message) => message.role === "assistant");
    const prompt = messages.findLastIndex((message) => message.role === "user");

    if (!reply || messages.indexOf(reply) < prompt) {
        return null;
    }

    return isStreaming || UNFINISHED_STATUSES.has(reply.status ?? "") ? reply : null;
};

/** Every tool call in the list, by key. Calls present when the screen reader arrives are not news. */
export const knownToolCalls = (messages: ReadonlyArray<TurnMessage>): ReadonlySet<string> => {
    const keys = new Set<string>();
    const anchors = turnAnchors(messages);

    for (const [index, message] of messages.entries()) {
        for (const part of message.parts) {
            if (isToolPart(part)) {
                keys.add(toolCallKey(anchors[index] ?? message.id, part.toolCallId));
            }
        }
    }

    return keys;
};

/** The name to say for a call: the MCP tool's when the backend labelled it, the device tool's for a call run on a paired computer (as the chat shows it), else the tool's own name. */
const toolLabel = (part: ToolPart): string => {
    const dynamicName = (part as { toolName?: unknown }).toolName;
    // A dynamic-tool part names its tool in `toolName`, not in its type, so the MCP parser is given the name as the type.
    const named = part.type === "dynamic-tool" && typeof dynamicName === "string" ? `tool-${dynamicName}` : part.type;
    const mcp = resolveMcpToolName({ callProviderMetadata: part.callProviderMetadata, type: named as ToolPart["type"] });

    if (mcp) {
        return mcp.toolName;
    }

    const device = resolveDeviceToolName(part);

    if (device) {
        return device.toolName;
    }

    if (typeof dynamicName === "string" && dynamicName.length > 0) {
        return dynamicName;
    }

    return part.type.replace("tool-", "");
};

/**
 * Tool calls in the reply being written that are not in `known`, in the order they
 * appear. `isStreaming` says the turn is still going, so its newest reply counts even
 * when the list already shows it settled.
 */
export const freshToolSteps = (messages: ReadonlyArray<TurnMessage>, known: ReadonlySet<string>, isStreaming = false): ToolStep[] => {
    const reply = inFlightReply(messages, isStreaming);

    if (!reply) {
        return [];
    }

    const anchor = turnAnchors(messages)[messages.indexOf(reply)] ?? reply.id;

    return reply.parts
        .filter(isToolPart)
        .map((part) => {
            return { key: toolCallKey(anchor, part.toolCallId), toolName: toolLabel(part) };
        })
        .filter((step) => !known.has(step.key));
};
