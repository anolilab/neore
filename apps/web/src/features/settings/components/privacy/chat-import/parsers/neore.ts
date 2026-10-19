/**
 * Parser for the Neore data export (`requestDataExport`, `backend/lunora/gdpr/steps.ts`
 * `collectConversations` and the `projectMessage` / `projectThread` projections).
 *
 * The export root carries `exportVersion` and `conversations: [{ thread, messages }]`.
 * Fields the normalised shape cannot hold are dropped: files, memories, usage, tags,
 * model and settings, and the active-branch pointer. The export publishes EVERY row of a
 * thread, including the sibling replies of regenerated or edited turns, and nothing that
 * says which one is active, so those siblings import as one linear sequence.
 *
 * A row's `role` is used when the export has it, and a row with any role other than user or
 * assistant (system and tool rows) is not a turn and is skipped. Exports made before that field
 * existed fall back to `stepOrder`: a user prompt is written at `stepOrder` 0 and every assistant
 * row after it at `stepOrder` >= 1 (`agent/messages.ts`). That fallback misreads any reply
 * that opens a fresh `order` without a prompt, which is also written at `stepOrder` 0:
 * sub-agent and coding-agent results, the text after a tool approval or an answered
 * question (`agent/client/index.ts`, `forceNewOrder`), and the replies of later speakers
 * in a group chat (`chat/group/run.ts`).
 *
 * Rows are kept by their text, whatever their status: a failed or interrupted reply keeps
 * its partial text as an ordinary reply, rather than dropping a prompt along with it.
 */
import { asRecord, buildSession } from "./local-session";
import type { NormalizedConversation, NormalizedMessage } from "./types";

interface NeoreExportMessage {
    createdAt?: number;
    order?: number;
    role?: string;
    stepOrder?: number;
    text?: string;
}

interface NeoreExportConversation {
    messages?: NeoreExportMessage[];
    thread?: { createdAt?: number; title?: string };
}

interface NeoreExportRoot {
    conversations?: NeoreExportConversation[];
    exportVersion?: string;
}

/** A Neore export root: an object with `exportVersion` and a `conversations` array of thread/messages entries. */
export const isNeoreExport = (record: unknown): boolean => {
    const root = asRecord(record);

    if (typeof root?.exportVersion !== "string" || !Array.isArray(root.conversations)) {
        return false;
    }

    // The parser skips null, non-object and damaged entries, so one well-formed conversation anywhere
    // in the file is enough: a damaged first entry must not hide the ones after it.
    const entries = (root.conversations as unknown[]).map((entry) => asRecord(entry)).filter((entry) => entry !== undefined);

    // An export of an account with no threads is valid and still detected; it imports nothing.
    if (entries.length === 0) {
        return true;
    }

    return entries.some((entry) => asRecord(entry.thread) !== undefined && Array.isArray(entry.messages));
};

const validTime = (time: unknown): number | undefined => (typeof time === "number" && Number.isFinite(time) && time > 0 ? time : undefined);

/** The row's role, or `undefined` for a row that is not a user or assistant turn. */
const roleOfRow = (row: NeoreExportMessage): NormalizedMessage["role"] | undefined => {
    // A role the export names is taken as it is: it must not fall through to the stepOrder guess.
    if (typeof row.role === "string") {
        return row.role === "user" || row.role === "assistant" ? row.role : undefined;
    }

    return row.stepOrder === 0 ? "user" : "assistant";
};

const parseConversation = (conversation: NeoreExportConversation): NormalizedConversation | null => {
    if (!conversation.thread || !Array.isArray(conversation.messages)) {
        return null;
    }

    // Rows arrive in (order, stepOrder) order already; the sort keeps that true for any reordering of the file.
    // A null or non-object row is skipped on its own rather than failing the conversation.
    const rows = conversation.messages
        .filter((row) => asRecord(row) !== undefined)
        .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.stepOrder ?? 0) - (b.stepOrder ?? 0));

    const messages: NormalizedMessage[] = [];

    for (const row of rows) {
        const content = typeof row.text === "string" ? row.text.trim() : "";
        const role = roleOfRow(row);

        // Tool-result rows and empty steps carry no text. A row with no stepOrder cannot be placed as a turn.
        if (!content || role === undefined || typeof row.stepOrder !== "number") {
            continue;
        }

        messages.push({ content, createdAt: validTime(row.createdAt), role });
    }

    // Consecutive steps of one reply merge into one turn, as the local-session parsers do.
    const session = buildSession(messages, 0, conversation.thread.title);

    if (!session) {
        return null;
    }

    return { ...session, createdAt: validTime(conversation.thread.createdAt) ?? session.createdAt };
};

/**
 * Parse Neore export data. Accepts the root object, or an array holding it, since a
 * `.json` file is delivered wrapped once in an array.
 */
const parseNeore = (data: unknown): NormalizedConversation[] => {
    const roots = Array.isArray(data) ? data : [data];
    const conversations: NormalizedConversation[] = [];

    for (const root of roots) {
        if (!isNeoreExport(root)) {
            continue;
        }

        const exported = (root as NeoreExportRoot).conversations ?? [];

        for (const conversation of exported) {
            // A null or non-object entry is skipped on its own; it must not abort the whole file.
            const parsed = asRecord(conversation) ? parseConversation(conversation) : null;

            if (parsed) {
                conversations.push(parsed);
            }
        }
    }

    return conversations;
};

export default parseNeore;
