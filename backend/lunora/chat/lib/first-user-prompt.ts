/** The longest prompt text a title is generated from; the title needs its subject, not the whole message. */
const MAX_PROMPT_CHARS = 2000;

interface ContextRow {
    message?: { content: unknown; role: string };
}

/** The text of one message's content: a plain string, or the text parts of a structured one. */
const textOf = (content: unknown): string => {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .filter(
            (part): part is { text: string; type: "text" } =>
                typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join(" ");
};

/**
 * The first user message on a context window that has any text, trimmed and capped. Returns `undefined` when
 * the window holds no user text (a thread that only has tool output or nothing yet), so nothing is generated.
 */
export const firstUserPromptText = (rows: ReadonlyArray<ContextRow>): string | undefined => {
    for (const row of rows) {
        if (row.message?.role !== "user") {
            continue;
        }

        const text = textOf(row.message.content).trim();

        if (text) {
            return text.slice(0, MAX_PROMPT_CHARS);
        }
    }

    return undefined;
};
