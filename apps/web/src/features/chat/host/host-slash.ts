/**
 * The `/` menu of a coding-agent thread: the commands the agent advertised (`session_state.availableCommands`). Pure, so
 * the composer's keyboard and the tests read the same rules. Matching is by prefix, as the cloud composer's menu does.
 */

export interface AgentCommand {
    description?: string;
    hint?: string;
    name: string;
}

/** The rest of the word after the cursor: a word the cursor sits in is replaced whole. */
const WORD_AFTER_CURSOR = /^\S*/u;

export interface SlashContext {
    /** Where the token ends: the cursor, or the end of the word the cursor is in, so a pick replaces the whole word. */
    end: number;
    /** The text typed after the `/`, up to the cursor. */
    query: string;
    /** Where the `/` sits in the text. */
    start: number;
}

const SLASH_BEFORE_CURSOR = /(?:^|\s)\/(\S*)$/u;

/**
 * The `/` the cursor is in: a `/` at the start of the text or after a whitespace, with no whitespace between it and the
 * cursor. Null when the cursor is not in one.
 */
export const slashAtCursor = (text: string, cursor: number): SlashContext | null => {
    const before = text.slice(0, cursor);
    const match = SLASH_BEFORE_CURSOR.exec(before);

    if (match === null) {
        return null;
    }

    const query = match[1] ?? "";
    const start = before.length - query.length - 1;
    const rest = WORD_AFTER_CURSOR.exec(text.slice(cursor))?.[0] ?? "";

    return { end: cursor + rest.length, query, start };
};

/**
 * The commands whose name starts with the query, in the agent's order. The query is matched case-insensitively. A name the agent
 * lists twice is shown once: the first listing wins, since a second entry with the same name would insert the same text. Names
 * that differ only by case insert different text, so both are kept.
 */
export const matchingCommands = (commands: ReadonlyArray<AgentCommand>, query: string): AgentCommand[] => {
    const wanted = query.toLowerCase();
    const seen = new Set<string>();

    return commands.filter((command) => {
        if (seen.has(command.name) || !command.name.toLowerCase().startsWith(wanted)) {
            return false;
        }

        seen.add(command.name);

        return true;
    });
};

/**
 * The text after a command is picked: the whole word the cursor is in is replaced by `/<name>`, followed by a space unless a literal
 * space already follows it. The caret goes after that space: left before it, the menu would still match the command. A newline or
 * tab after the word is not a separator: the space is inserted before it, and the caret stays on the command's line.
 */
export const insertCommand = (text: string, context: SlashContext, command: AgentCommand): { cursor: number; text: string } => {
    const after = text.slice(context.end);
    const spaceFollows = after.charAt(0) === " ";
    const inserted = `/${command.name}${spaceFollows ? "" : " "}`;

    return {
        cursor: context.start + inserted.length + (spaceFollows ? 1 : 0),
        text: `${text.slice(0, context.start)}${inserted}${after}`,
    };
};
