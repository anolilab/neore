/**
 * Parser for local Codex CLI rollout transcripts (`rollout-*.jsonl`).
 *
 * ASSUMED shape (no sample was available to confirm it): one JSON object per
 * line, `{ timestamp, type, payload }`. `response_item` payloads of
 * `type: "message"` carry `role` and a `content` array of `input_text` /
 * `output_text` blocks; `function_call`, `function_call_output` and tool-call
 * payloads are counted and dropped, as are `reasoning`,
 * `turn_context` and `session_meta` records. Legacy rollouts carry their turns as
 * `event_msg` `user_message` / `agent_message` instead, read only when no
 * `response_item` messages exist. Context the CLI injects as user
 * messages (environment and instruction blocks) is skipped.
 */
import type { InjectedBlock } from "./local-session";
import { asRecord, buildSession, isInjectedText, messageFromTexts, parseTimestamp } from "./local-session";
import type { NormalizedConversation, NormalizedMessage } from "./types";

const RECORD_TYPES = new Set(["event_msg", "response_item", "session_meta", "turn_context"]);
const TOOL_PAYLOAD_TYPES = new Set(["custom_tool_call", "custom_tool_call_output", "function_call", "function_call_output"]);
const INJECTED_BLOCKS: InjectedBlock[] = [
    { close: "</environment_context>", open: "<environment_context>" },
    { close: "</user_instructions>", open: "<user_instructions>" },
    // No closing tag: the trailing marker of this block is not verified against real exports.
    { open: "# AGENTS.md instructions" },
];

export const isCodexRecord = (record: unknown): boolean => {
    const item = asRecord(record);

    return typeof item?.type === "string" && RECORD_TYPES.has(item.type) && asRecord(item.payload) !== undefined;
};

/** The role of a legacy `event_msg` turn, or undefined for any other event. */
const eventRole = (type: unknown): NormalizedMessage["role"] | undefined => {
    if (type === "user_message") {
        return "user";
    }

    return type === "agent_message" ? "assistant" : undefined;
};

/**
 * The text blocks of a `response_item` message, minus the injected context blocks: a user message
 * may carry an environment block before the real prompt, and only the prompt is the user's.
 */
const keptTexts = (payload: Record<string, unknown>): string[] => {
    const content = Array.isArray(payload.content) ? payload.content : [];

    return content
        .map((block) => asRecord(block))
        .flatMap((block) => (block && (block.type === "input_text" || block.type === "output_text") && typeof block.text === "string" ? [block.text] : []))
        .filter((text) => !isInjectedText(text, INJECTED_BLOCKS));
};

const responseText = (payload: Record<string, unknown>): string => keptTexts(payload).join("\n\n").trim();

/**
 * True when a legacy event is a copy of a response message to skip. Each response message can
 * account for one copy; a legacy event with no copy left is kept.
 */
const consumeCopy = (copies: Map<string, number>, key: string): boolean => {
    const left = copies.get(key) ?? 0;

    if (left === 0) {
        return false;
    }

    copies.set(key, left - 1);

    return true;
};

const parseCodex = (data: unknown): NormalizedConversation[] => {
    if (!Array.isArray(data)) {
        throw new TypeError("Expected an array of rollout records");
    }

    const messages: NormalizedMessage[] = [];
    let dropped = 0;

    // Current rollouts repeat each turn as a `response_item` message; older ones carry turns only as
    // `event_msg` messages. An `event_msg` turn is skipped only when a `response_item` message with the
    // same role and text exists, so a prompt with no copy is never lost.
    // Each response-item message can account for one legacy copy of the same role and text, in order.
    const responseCopies = new Map<string, number>();

    for (const raw of data) {
        const record = asRecord(raw);
        const payload = asRecord(record?.payload);

        if (record?.type === "response_item" && payload?.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
            const text = responseText(payload);

            // Injected context is not kept, so it cannot stand in for the prompt it would have shadowed.
            if (messageFromTexts([text], payload.role, undefined, INJECTED_BLOCKS)) {
                const key = `${payload.role}\n${text}`;

                responseCopies.set(key, (responseCopies.get(key) ?? 0) + 1);
            }
        }
    }

    for (const raw of data) {
        const record = asRecord(raw);
        const payload = asRecord(record?.payload);

        if (record?.type === "event_msg" && payload) {
            const role = eventRole(payload.type);
            const text = typeof payload.message === "string" ? payload.message.trim() : "";
            const message =
                role && text && !consumeCopy(responseCopies, `${role}\n${text}`)
                    ? messageFromTexts([text], role, parseTimestamp(record.timestamp), INJECTED_BLOCKS)
                    : null;

            if (message) {
                messages.push(message);
            }

            continue;
        }

        if (record?.type !== "response_item" || !payload) {
            continue;
        }

        if (typeof payload.type === "string" && (TOOL_PAYLOAD_TYPES.has(payload.type) || payload.type === "reasoning")) {
            dropped += 1;

            continue;
        }

        if (payload.type !== "message" || (payload.role !== "user" && payload.role !== "assistant") || !Array.isArray(payload.content)) {
            continue;
        }

        const message = messageFromTexts(keptTexts(payload), payload.role, parseTimestamp(record.timestamp), INJECTED_BLOCKS);

        if (message) {
            messages.push(message);
        }
    }

    const session = buildSession(messages, dropped);

    return session ? [session] : [];
};

export default parseCodex;
