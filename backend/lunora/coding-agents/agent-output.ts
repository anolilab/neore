/**
 * Turning an agent CLI's stdout into a readable log line by line.
 *
 * Claude Code runs with `--output-format stream-json`: one JSON event per line.
 * The raw events are unreadable in a terminal view, so each is rendered as a
 * short human line, and the final `result` event carries the run's summary.
 * Codex prints plain text, which passes through unchanged. A line that is not
 * JSON always passes through — the agent's output is untrusted and may be
 * anything.
 */

const TOOL_INPUT_PREVIEW = 160;

const preview = (value: unknown): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value);

    if (!text) {
        return "";
    }

    const flat = text.replaceAll(/\s+/gu, " ").trim();

    return flat.length > TOOL_INPUT_PREVIEW ? `${flat.slice(0, TOOL_INPUT_PREVIEW)}…` : flat;
};

interface ContentBlock {
    content?: unknown;
    input?: unknown;
    is_error?: boolean;
    name?: string;
    text?: string;
    type?: string;
}

export interface FormattedLine {
    /** Set on Claude's final `result` event. */
    summary?: string;
    /** The rendered line, or `undefined` for an event not worth showing. */
    text?: string;
}

const renderBlocks = (blocks: ReadonlyArray<ContentBlock>): string | undefined => {
    const lines: string[] = [];

    for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) {
            lines.push(block.text.trim());
        } else if (block.type === "tool_use" && block.name) {
            lines.push(`→ ${block.name} ${preview(block.input)}`.trimEnd());
        } else if (block.type === "tool_result" && block.is_error) {
            lines.push(`✗ tool error: ${preview(block.content)}`);
        }
    }

    return lines.length > 0 ? lines.join("\n") : undefined;
};

export const formatClaudeStreamLine = (line: string): FormattedLine => {
    const trimmed = line.trim();

    if (!trimmed.startsWith("{")) {
        return { text: line };
    }

    let event: { is_error?: boolean; message?: { content?: unknown }; model?: string; result?: unknown; subtype?: string; type?: string };

    try {
        event = JSON.parse(trimmed) as typeof event;
    } catch {
        return { text: line };
    }

    const content = Array.isArray(event.message?.content) ? (event.message.content as ContentBlock[]) : [];

    switch (event.type) {
        case "assistant": {
            return { text: renderBlocks(content) };
        }

        case "result": {
            const summary = typeof event.result === "string" ? event.result : undefined;

            return { summary, text: event.is_error ? `✗ agent finished with an error (${event.subtype ?? "error"})` : "✓ agent finished" };
        }

        case "system": {
            return event.subtype === "init" ? { text: `agent started${event.model ? ` (${event.model})` : ""}` } : {};
        }

        case "user": {
            return { text: renderBlocks(content) };
        }

        default: {
            return {};
        }
    }
};

/**
 * Wrap agent-produced text for OUR model. The coding agent read an arbitrary
 * repository, so its summary can carry injected instructions; the model is told
 * the block is data and the closing tag cannot be forged from inside.
 */
export const wrapUntrusted = (text: string): string =>
    `<coding_agent_output>\n${text.replaceAll(/<\/?coding_agent_output>/giu, "[tag removed]")}\n</coding_agent_output>`;
