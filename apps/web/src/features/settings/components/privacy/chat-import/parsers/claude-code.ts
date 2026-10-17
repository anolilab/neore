/**
 * Parser for local Claude Code session transcripts (`<session>.jsonl`).
 *
 * One JSON event per line. `user` and `assistant` events carry a `message`
 * whose `content` is a string or an array of blocks (`text`, `thinking`,
 * `tool_use`, `tool_result`). Only text is kept; sidechain (sub-agent) and
 * meta events are skipped.
 */
import { asRecord, buildSession, parseTimestamp } from "./local-session";
import type { NormalizedConversation, NormalizedMessage } from "./types";

const HARNESS_PREFIXES = ["<command-name>", "<command-message>", "<local-command-", "<system-reminder>", "Caveat: The messages below"];

export const isClaudeCodeRecord = (record: unknown): boolean => {
    const item = asRecord(record);

    return typeof item?.sessionId === "string" && (item.type === "user" || item.type === "assistant") && asRecord(item.message) !== undefined;
};

const parseClaudeCode = (data: unknown): NormalizedConversation[] => {
    if (!Array.isArray(data)) {
        throw new TypeError("Expected an array of session events");
    }

    const messages: NormalizedMessage[] = [];
    let dropped = 0;
    let title: string | undefined;

    for (const raw of data) {
        const event = asRecord(raw);

        if (!event) {
            continue;
        }

        if (event.type === "summary" && typeof event.summary === "string") {
            title ??= event.summary;

            continue;
        }

        if ((event.type !== "user" && event.type !== "assistant") || event.isSidechain === true || event.isMeta === true) {
            continue;
        }

        const content = asRecord(event.message)?.content;
        let blocks: unknown[] = [];

        if (typeof content === "string") {
            blocks = [{ text: content, type: "text" }];
        } else if (Array.isArray(content)) {
            blocks = content;
        }

        const texts: string[] = [];

        for (const block of blocks) {
            const item = asRecord(block);

            if (item?.type === "text" && typeof item.text === "string") {
                texts.push(item.text);
            } else if (item?.type === "tool_use" || item?.type === "tool_result") {
                dropped += 1;
            }
        }

        const text = texts.join("\n\n").trim();

        if (!text || HARNESS_PREFIXES.some((prefix) => text.startsWith(prefix))) {
            continue;
        }

        messages.push({ content: text, createdAt: parseTimestamp(event.timestamp), role: event.type });
    }

    const session = buildSession(messages, dropped, title);

    return session ? [session] : [];
};

export default parseClaudeCode;
