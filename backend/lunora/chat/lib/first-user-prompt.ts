/** The longest prompt text a title is generated from; the title needs its subject, not the whole message. */
const MAX_PROMPT_CHARS = 2000;

interface ContextRow {
    _id?: string;
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
 * The first user message on a context window that has any text: its text, trimmed and capped, and the id of the message it came
 * from. Returns `undefined` when the window holds no user text (a thread that only has tool output or nothing yet).
 */
export const firstUserPrompt = (rows: ReadonlyArray<ContextRow>): { id: string | undefined; text: string } | undefined => {
    for (const row of rows) {
        if (row.message?.role !== "user") {
            continue;
        }

        const text = textOf(row.message.content).trim();

        if (text) {
            // Cut by characters, not UTF-16 units: a cut inside a surrogate pair would leave half an emoji.
            return { id: row._id, text: [...text].slice(0, MAX_PROMPT_CHARS).join("") };
        }
    }

    return undefined;
};

/** The text of {@link firstUserPrompt}, for a caller that does not need where it came from. */
export const firstUserPromptText = (rows: ReadonlyArray<ContextRow>): string | undefined => firstUserPrompt(rows)?.text;
