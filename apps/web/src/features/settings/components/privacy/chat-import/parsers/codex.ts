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
import { asRecord, buildSession, messageFromTexts, parseTimestamp } from "./local-session";
import type { NormalizedConversation, NormalizedMessage } from "./types";

const RECORD_TYPES = new Set(["event_msg", "response_item", "session_meta", "turn_context"]);
const TOOL_PAYLOAD_TYPES = new Set(["custom_tool_call", "custom_tool_call_output", "function_call", "function_call_output"]);
const INJECTED_PREFIXES = ["<environment_context>", "<user_instructions>", "# AGENTS.md instructions"];

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

const parseCodex = (data: unknown): NormalizedConversation[] => {
    if (!Array.isArray(data)) {
        throw new TypeError("Expected an array of rollout records");
    }

    const messages: NormalizedMessage[] = [];
    let dropped = 0;

    // Current rollouts repeat every turn as a `response_item` message; older ones
    // carry turns only as `event_msg` user/agent messages. Use one source, never both.
    const hasResponseMessages = data.some((raw) => {
        const payload = asRecord(asRecord(raw)?.payload);

        return asRecord(raw)?.type === "response_item" && payload?.type === "message";
    });

    for (const raw of data) {
        const record = asRecord(raw);
        const payload = asRecord(record?.payload);

        if (record?.type === "event_msg" && !hasResponseMessages && payload) {
            const role = eventRole(payload.type);
            const message =
                role && typeof payload.message === "string"
                    ? messageFromTexts([payload.message], role, parseTimestamp(record.timestamp), INJECTED_PREFIXES)
                    : null;

            if (message) {
                messages.push(message);
            }

            continue;
        }

        if (record?.type !== "response_item" || !payload) {
            continue;
        }

        if (typeof payload.type === "string" && TOOL_PAYLOAD_TYPES.has(payload.type)) {
            dropped += 1;

            continue;
        }

        if (payload.type !== "message" || (payload.role !== "user" && payload.role !== "assistant") || !Array.isArray(payload.content)) {
            continue;
        }

        const texts = payload.content
            .map((block) => asRecord(block))
            .flatMap((block) => (block && (block.type === "input_text" || block.type === "output_text") && typeof block.text === "string" ? [block.text] : []));
        const message = messageFromTexts(texts, payload.role, parseTimestamp(record.timestamp), INJECTED_PREFIXES);

        if (message) {
            messages.push(message);
        }
    }

    const session = buildSession(messages, dropped);

    return session ? [session] : [];
};

export default parseCodex;
