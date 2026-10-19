/**
 * Parser for the Neore data export (`requestDataExport`, `backend/lunora/gdpr/steps.ts`
 * `collectConversations` and the `projectMessage` / `projectThread` projections).
 *
 * The export root carries `exportVersion` and `conversations: [{ thread, messages }]`.
 * Fields the normalised shape cannot hold are dropped: files, memories, usage, tags,
 * model and settings. The export publishes EVERY row of a thread, including the sibling
 * replies of regenerated or edited turns. An export that names the active branch
 * (`thread.activeLeafMessageId`, with each row's `parentMessageId`) imports only the path
 * the user saw, by the rule the backend displays it with (`agent/branch-tree.ts`). An
 * export from before those fields existed has no way to tell the siblings apart, so they
 * import as one linear sequence, as they always did.
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
import { buildBranchTree, resolveActivePath } from "@neore/backend/agent/branch-tree";

import { asRecord, buildSession } from "./local-session";
import type { NormalizedConversation, NormalizedMessage } from "./types";

interface NeoreExportMessage {
    _id?: string;
    createdAt?: number;
    order?: number;
    parentMessageId?: string;
    role?: string;
    stepOrder?: number;
    text?: string;
}

interface NeoreExportConversation {
    messages?: NeoreExportMessage[];
    thread?: { activeLeafMessageId?: string; createdAt?: number; title?: string };
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

/**
 * The rows on the path the user saw. A thread without an active leaf (never branched,
 * or an export from before the pointer existed) keeps every row, as it always has.
 * Rows without a string `_id`, or repeating one, cannot be linked, so they are keyed by position;
 * a real id never starts with `#`. A repeated id would make a row its own parent, and the walk down never ends.
 */
const activePathRows = (thread: NeoreExportConversation["thread"], rows: NeoreExportMessage[]): NeoreExportMessage[] => {
    const leafId = thread?.activeLeafMessageId;

    if (typeof leafId !== "string") {
        return rows;
    }

    const seen = new Set<string>();
    const keyed = rows.map((row, index) => {
        const key = typeof row._id === "string" && !seen.has(row._id) ? row._id : `#${String(index)}`;

        seen.add(key);

        return { key, row };
    });
    const tree = buildBranchTree(
        keyed.map(({ key, row }) => {
            return {
                _id: key,
                order: row.order ?? 0,
                parentMessageId: row.parentMessageId,
                stepOrder: row.stepOrder ?? 0,
            };
        }),
    );
    // A leaf the file no longer contains degrades to the latest path from the top, as the backend shows it.
    const onPath = new Set(resolveActivePath(tree, leafId));

    return keyed.filter(({ key }) => onPath.has(key)).map(({ row }) => row);
};

const parseConversation = (conversation: NeoreExportConversation): NormalizedConversation | null => {
    if (!conversation.thread || !Array.isArray(conversation.messages)) {
        return null;
    }

    // Rows arrive in (order, stepOrder) order already; the sort keeps that true for any reordering of the file.
    // A null or non-object row is skipped on its own rather than failing the conversation.
    const sorted = conversation.messages
        .filter((row) => asRecord(row) !== undefined)
        .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.stepOrder ?? 0) - (b.stepOrder ?? 0));
    // The active path is chosen over every row, tool and empty steps included, because they are links in the chain.
    const rows = activePathRows(conversation.thread, sorted);

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
