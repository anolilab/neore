/**
 * Shared tail of the local coding-agent transcript parsers. The normalised
 * shape carries text only, so tool calls, tool results and reasoning are
 * dropped and the loss is noted on the last assistant message.
 */
import type { NormalizedConversation, NormalizedMessage } from "./types";

const MAX_TITLE_LENGTH = 80;

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export const parseTimestamp = (value: unknown): number | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }

    const ts = new Date(value).getTime();

    return Number.isNaN(ts) ? undefined : ts;
};

const titleFrom = (text: string): string => {
    const line = text.trim().split("\n", 1)[0] ?? "";

    return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH)}…` : line || "Untitled";
};

/** Merge consecutive same-role messages: one turn is often written as several records. */
export const buildSession = (messages: NormalizedMessage[], droppedToolItems: number, title?: string): NormalizedConversation | null => {
    const merged: NormalizedMessage[] = [];

    for (const message of messages) {
        const last = merged.at(-1);

        if (last?.role === message.role) {
            last.content = `${last.content}\n\n${message.content}`;
        } else {
            merged.push({ ...message });
        }
    }

    if (merged.length === 0) {
        return null;
    }

    const lastAssistant = merged.findLast((message) => message.role === "assistant");

    if (lastAssistant && droppedToolItems > 0) {
        lastAssistant.content += `\n\n---\n_${droppedToolItems} tool calls and results were not included in this import._`;
    }

    const firstUser = merged.find((message) => message.role === "user");

    return { createdAt: merged[0]?.createdAt, messages: merged, title: title?.trim() || titleFrom(firstUser?.content ?? "") };
};
