import { CHAT_FILES_READ_BYTES } from "../gdpr/read-budget";

/**
 * A page of ids from a source: the ids, where the next page starts (`null` when this was the last), and the bytes the query read
 * (`readBytes`, each row as stored), which the walk meters against its budget.
 */
export interface IdsPage {
    cursor: string | null;
    ids: string[];
    readBytes?: number;
}

/** A walk to its end, or until its read budget was spent (`truncated`): the ids it reached, and the bytes it read. */
export interface Walked {
    ids: string[];
    readBytes: number;
    truncated: boolean;
}

/** Metadata is read this many ids at a time: one query per chunk. */
export const CHAT_FILE_METADATA_CHUNK = 100;

/**
 * The chat-file section of the export is held to this many bytes as written (indented JSON). Past it the section is cut, and says so,
 * so a large history cannot push the whole file past its cap and lose every other section.
 */
export const CHAT_FILE_EXPORT_BYTES = 8 * 1024 * 1024;

/**
 * Walks one source to its end, or until the bytes its pages read reach `budget`: the check runs before each page, so the page that
 * crosses the budget is the last one read, and the walk says it stopped short.
 */
export const walkIds = async (read: (cursor: string | null) => Promise<IdsPage>, budget: number): Promise<Walked> => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let more = true;
    let readBytes = 0;

    while (more) {
        if (readBytes >= budget) {
            return { ids, readBytes, truncated: true };
        }

        const page = await read(cursor);

        ids.push(...page.ids);
        readBytes += page.readBytes ?? 0;
        more = page.cursor !== null;
        cursor = page.cursor;
    }

    return { ids, readBytes, truncated: false };
};

/**
 * The file ids named by the messages of every thread the user owns. Threads are walked to their end; each thread's messages are
 * walked to theirs. A message keeps its files in `fileIds`, so these are the files the chats still hold. `listThreads` reads one page
 * of the owner's thread ids; `listFiles` reads one page of one thread's message file ids.
 */
export const collectAllMessageFileIds = async (
    listThreads: (cursor: string | null) => Promise<IdsPage>,
    listFiles: (threadId: string, cursor: string | null) => Promise<IdsPage>,
    budget: number,
): Promise<Walked> => {
    const threads = await walkIds(listThreads, budget);
    const ids: string[] = [];
    let { readBytes, truncated } = threads;

    // Each thread's messages take what the threads and the threads before them left of the budget.
    for (const threadId of threads.ids) {
        const messages = await walkIds(async (cursor) => await listFiles(threadId, cursor), budget - readBytes);

        ids.push(...messages.ids);
        readBytes += messages.readBytes;

        if (messages.truncated) {
            truncated = true;
            break;
        }
    }

    return { ids, readBytes, truncated };
};

/**
 * Every chat file of one user for the export: the files behind their grants and the files their messages name, each once.
 * `listGrantedIds` reads one page of the grants; `listMessageFileIds` returns the message source (see
 * {@link collectAllMessageFileIds}); `readMetadata` reads one chunk of ids.
 *
 * Kept apart from `gdpr.ts`: the export action imports this, and the job queue is reached through `gdpr.ts`, which the mobile and
 * extension type checks do not resolve.
 */
export const collectAllChatFileMetadata = async <Row>(
    walkGrants: (budget: number) => Promise<Walked>,
    walkMessages: (budget: number) => Promise<Walked>,
    readMetadata: (fileIds: string[]) => Promise<{ readBytes: number; rows: Row[] }>,
    chunkSize: number = CHAT_FILE_METADATA_CHUNK,
    readBudget: number = CHAT_FILES_READ_BYTES,
): Promise<{ rows: Row[]; truncated: boolean }> => {
    // The walks and the metadata reads share one budget: each takes what the ones before it left, so the section cannot read past it.
    const granted = await walkGrants(readBudget);
    const messages = await walkMessages(Math.max(0, readBudget - granted.readBytes));
    const all = [...new Set([...granted.ids, ...messages.ids])];
    const rows: Row[] = [];
    let readBytes = granted.readBytes + messages.readBytes;
    const truncated = granted.truncated || messages.truncated;

    for (let start = 0; start < all.length; start += chunkSize) {
        // Past the budget the rest of the files are not read: the section says so, as it does past its byte cap.
        if (readBytes >= readBudget) {
            return { rows, truncated: true };
        }

        const chunk = await readMetadata(all.slice(start, start + chunkSize));

        readBytes += chunk.readBytes;
        rows.push(...chunk.rows);
    }

    return { rows, truncated };
};

/**
 * What the section takes beyond its rows, as the export writes it: the `chatFiles` and `files` keys, the brackets and the flag. Reserved
 * whole, so the rows that fit are never over-counted by less than this and the section never runs past its budget.
 */
const CHAT_FILE_SECTION_FRAME_BYTES = 256;

/** What one row takes in the array beyond its own lines: the line break and indent before it, and the comma after it. */
const CHAT_FILE_ROW_FRAME_BYTES = 8;

/**
 * The rows that fit in the section's byte budget, in order, measured as the export writes them: each row's lines indented to the depth
 * of the `chatFiles.files` array (the export is `JSON.stringify(…, null, 2)`), plus the section's frame. Past the budget the rest are
 * left out and `truncated` says so; the caller records that in the export.
 */
export const capChatFiles = <Row>(rows: Row[], budget: number = CHAT_FILE_EXPORT_BYTES): { files: Row[]; truncated: boolean } => {
    const encoder = new TextEncoder();
    const files: Row[] = [];
    let bytes = CHAT_FILE_SECTION_FRAME_BYTES;

    for (const row of rows) {
        // An array element sits three levels deep (`chatFiles` → `files` → element), so each of its lines is indented six spaces more.
        const written = JSON.stringify(row, null, 2).replaceAll("\n", "\n      ");

        bytes += encoder.encode(written).byteLength + CHAT_FILE_ROW_FRAME_BYTES;

        if (bytes > budget) {
            return { files, truncated: true };
        }

        files.push(row);
    }

    return { files, truncated: false };
};
