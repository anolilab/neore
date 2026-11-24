/** A page of ids from a source: the ids, and where the next page starts (`null` when this was the last). */
export interface IdsPage {
    cursor: string | null;
    ids: string[];
}

/** The two indexed sources a user's chat files come from (`collectChatFileIdsForExport`). */
export type ChatFileSource = "grants" | "threads";

/** Metadata is read this many ids at a time: one query per chunk. */
export const CHAT_FILE_METADATA_CHUNK = 100;

/** Walks one source to its end, returning every id it yields. */
const walkIds = async (read: (cursor: string | null) => Promise<IdsPage>): Promise<string[]> => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let more = true;

    while (more) {
        const page = await read(cursor);

        ids.push(...page.ids);
        more = page.cursor !== null;
        cursor = page.cursor;
    }

    return ids;
};

/**
 * The file ids named by the messages of every thread the user owns. Threads are walked to their end; each thread's messages are
 * walked to theirs. A message keeps its files in `fileIds`, so this is the source of last resort: a chat from before the links and
 * grants existed has neither, and only its messages name the files. `listThreads` reads one page of the owner's thread ids;
 * `listFiles` reads one page of one thread's message file ids.
 */
export const collectAllMessageFileIds = async (
    listThreads: (cursor: string | null) => Promise<IdsPage>,
    listFiles: (threadId: string, cursor: string | null) => Promise<IdsPage>,
): Promise<string[]> => {
    const threadIds = await walkIds(listThreads);
    const ids: string[] = [];

    for (const threadId of threadIds) {
        ids.push(...(await walkIds(async (cursor) => await listFiles(threadId, cursor))));
    }

    return ids;
};

/**
 * Every chat file of one user for the export: the files behind their grants, the files linked to their own chats, and the files
 * their messages name, each once. `listIds` reads one page of an indexed source. `listMessageFileIds` returns the message source
 * (see {@link collectAllMessageFileIds}). `readMetadata` reads one chunk of ids.
 *
 * Kept apart from `gdpr.ts`: the export action imports this, and the job queue is reached through `gdpr.ts`, which the mobile and
 * extension type checks do not resolve.
 */
export const collectAllChatFileMetadata = async <Row>(
    listIds: (source: ChatFileSource, cursor: string | null) => Promise<IdsPage>,
    listMessageFileIds: () => Promise<string[]>,
    readMetadata: (fileIds: string[]) => Promise<Row[]>,
    chunkSize: number = CHAT_FILE_METADATA_CHUNK,
): Promise<Row[]> => {
    const ids = new Set<string>();

    for (const source of ["grants", "threads"] as const) {
        const sourceIds = await walkIds(async (cursor) => await listIds(source, cursor));

        for (const id of sourceIds) {
            ids.add(id);
        }
    }

    const messageIds = await listMessageFileIds();

    for (const id of messageIds) {
        ids.add(id);
    }

    const all = [...ids];
    const rows: Row[] = [];

    for (let start = 0; start < all.length; start += chunkSize) {
        rows.push(...(await readMetadata(all.slice(start, start + chunkSize))));
    }

    return rows;
};
