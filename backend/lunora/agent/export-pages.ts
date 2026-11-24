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
 * What the chat-file section may still spend, shared by every walk and read of one export: the bytes its rows cost and the queries it
 * issues. A walk or a read stops, and the section says so, once either is gone.
 */
export interface ChatFileMeter {
    bytesLeft: number;
    queriesLeft: number;
}

/** The queries the id walks may issue in one export action: each page of grants, threads and messages is one. */
export const CHAT_FILE_MAX_QUERIES = 200;

/** The metadata chunks one export action may read, each one query: their own allowance, so many granted files cannot stall the walks. */
export const CHAT_FILE_METADATA_MAX_QUERIES = 200;

/**
 * Held back from the message walk for reading the metadata of the files it finds, so a walk that runs long cannot leave them unread. The
 * walk stops short of the reserve and the section says so.
 */
export const CHAT_FILE_METADATA_RESERVE_BYTES = 2 * 1024 * 1024;

/** A meter for the chat-file section: the bytes it may read (default `CHAT_FILES_READ_BYTES`) and the queries it may issue. */
export const chatFileMeter = (bytes: number = CHAT_FILES_READ_BYTES, queries: number = CHAT_FILE_MAX_QUERIES): ChatFileMeter => {
    return {
        bytesLeft: bytes,
        queriesLeft: queries,
    };
};

/**
 * Walks one source to its end, or until the meter is spent: the check runs before each page, so the page that spends the last of it is
 * the last one read, and the walk says it stopped short.
 */
export const walkIds = async (read: (cursor: string | null) => Promise<IdsPage>, meter: ChatFileMeter): Promise<Walked> => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let more = true;
    let readBytes = 0;

    while (more) {
        if (meter.bytesLeft <= 0 || meter.queriesLeft <= 0) {
            return { ids, readBytes, truncated: true };
        }

        const page = await read(cursor);
        const pageBytes = page.readBytes ?? 0;

        meter.bytesLeft -= pageBytes;
        meter.queriesLeft -= 1;
        readBytes += pageBytes;
        ids.push(...page.ids);
        more = page.cursor !== null;
        cursor = page.cursor;
    }

    return { ids, readBytes, truncated: false };
};

/**
 * The file ids named by the messages of every thread the user owns. Threads are walked to their end; each thread's messages are walked
 * to theirs, until the meter is spent. A message keeps its files in `fileIds`, so these are the files the chats still hold.
 * `listThreads` reads one page of the owner's thread ids; `listFiles` reads one page of one thread's message file ids.
 */
export const collectAllMessageFileIds = async (
    listThreads: (cursor: string | null) => Promise<IdsPage>,
    listFiles: (threadId: string, cursor: string | null) => Promise<IdsPage>,
    meter: ChatFileMeter,
): Promise<Walked> => {
    const threads = await walkIds(listThreads, meter);
    const ids: string[] = [];
    let { readBytes, truncated } = threads;

    // Each thread's messages draw on the same meter, so the threads and messages before them leave less for the ones after.
    for (const threadId of threads.ids) {
        const messages = await walkIds(async (cursor) => await listFiles(threadId, cursor), meter);

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
 * Every chat file of one user for the export: the files behind their grants and the files their messages name, each once. The grants
 * are walked first and their metadata read before the messages are walked, so a long history cannot leave a granted file out.
 * `walkGrants` and `walkMessages` walk their ids against the meter; `readMetadata` reads one chunk of ids.
 *
 * Metadata chunks check only the bytes left: they are bounded by the ids the walks found, so a walk that spent the queries does not
 * leave the files it already found unread.
 *
 * Kept apart from `gdpr.ts`: the export action imports this, and the job queue is reached through `gdpr.ts`, which the mobile and
 * extension type checks do not resolve.
 */
export const collectAllChatFileMetadata = async <Row>(
    walkGrants: (meter: ChatFileMeter) => Promise<Walked>,
    walkMessages: (meter: ChatFileMeter) => Promise<Walked>,
    readMetadata: (fileIds: string[], bytesLeft: number) => Promise<{ readBytes: number; rows: Row[]; truncated?: boolean }>,
    chunkSize: number = CHAT_FILE_METADATA_CHUNK,
    meter: ChatFileMeter = chatFileMeter(),
): Promise<{ rows: Row[]; truncated: boolean }> => {
    // The metadata chunks have their own query allowance, so a large set of granted files cannot stall the export.
    let metadataQueriesLeft = CHAT_FILE_METADATA_MAX_QUERIES;

    const readChunks = async (fileIds: string[]): Promise<{ rows: Row[]; truncated: boolean }> => {
        const rows: Row[] = [];

        for (let start = 0; start < fileIds.length; start += chunkSize) {
            // Past the bytes or the chunk queries the rest of the files are not read: the section says so, as it does past its byte cap.
            if (meter.bytesLeft <= 0 || metadataQueriesLeft <= 0) {
                return { rows, truncated: true };
            }

            const chunk = await readMetadata(fileIds.slice(start, start + chunkSize), meter.bytesLeft);

            meter.bytesLeft -= chunk.readBytes;
            metadataQueriesLeft -= 1;
            rows.push(...chunk.rows);

            // A chunk that stopped its repairs at the budget says so: the rest of the files are not read.
            if (chunk.truncated) {
                return { rows, truncated: true };
            }
        }

        return { rows, truncated: false };
    };

    const granted = await walkGrants(meter);
    const grantedIds = [...new Set(granted.ids)];
    const grantedRead = await readChunks(grantedIds);

    // The message walk stops short of a bytes reserve, so the files it finds still get their metadata read even when it runs long.
    const walkMeter = chatFileMeter(Math.max(0, meter.bytesLeft - CHAT_FILE_METADATA_RESERVE_BYTES), meter.queriesLeft);
    const queriesBefore = walkMeter.queriesLeft;
    const messages = await walkMessages(walkMeter);

    meter.bytesLeft -= messages.readBytes;
    meter.queriesLeft -= queriesBefore - walkMeter.queriesLeft;

    const alreadyRead = new Set(grantedIds);
    const messageIds: string[] = [];
    const messageSet = new Set(messages.ids);

    for (const id of messageSet) {
        if (!alreadyRead.has(id)) {
            messageIds.push(id);
        }
    }

    const messageRead = await readChunks(messageIds);

    return {
        rows: [...grantedRead.rows, ...messageRead.rows],
        truncated: granted.truncated || grantedRead.truncated || messages.truncated || messageRead.truncated,
    };
};

/** The section as the export writes it, with its braces stripped: from the `chatFiles` key to the end of its value. */
const chatFileSectionText = (chatFiles: unknown): string => {
    const text = JSON.stringify({ chatFiles }, null, 2);

    // The export object's own braces wrap the section, so the section is what sits between the key and the closing `\n}`.
    return text.slice(text.indexOf('"chatFiles"'), -2);
};

/**
 * The section with no rows: its keys, the empty brackets and the flag. `false` is the longer flag, so a cut section (which writes `true`)
 * is never measured larger than it is.
 */
const CHAT_FILE_SECTION_EMPTY_BYTES = new TextEncoder().encode(chatFileSectionText({ files: [], truncated: false })).byteLength;

/**
 * What one row adds in the array: the line break and six spaces before its lines, and the comma after it. With the row's own lines this
 * is exact for every row but the last, whose comma the closing line takes the place of; {@link CHAT_FILE_ARRAY_OPEN_BYTES} balances it.
 */
const CHAT_FILE_ROW_FRAME_BYTES = 8;

/** The array's closing line replaces its `[]` once it holds a row. */
const CHAT_FILE_ARRAY_OPEN_BYTES = 4;

/**
 * The rows that fit in the section's byte budget, in order, measured as the export writes them: each row's lines indented to the depth
 * of the `chatFiles.files` array (the export is `JSON.stringify(…, null, 2)`), plus the section's frame. Past the budget the rest are
 * left out and `truncated` says so; the caller records that in the export.
 */
export const capChatFiles = <Row>(rows: Row[], budget: number = CHAT_FILE_EXPORT_BYTES): { files: Row[]; truncated: boolean } => {
    const encoder = new TextEncoder();
    const files: Row[] = [];
    let bytes = CHAT_FILE_SECTION_EMPTY_BYTES;

    for (const row of rows) {
        // An array element sits three levels deep (`chatFiles` → `files` → element), so each of its lines is indented six spaces more.
        const written = JSON.stringify(row, null, 2).replaceAll("\n", "\n      ");

        bytes += encoder.encode(written).byteLength + CHAT_FILE_ROW_FRAME_BYTES + (files.length === 0 ? CHAT_FILE_ARRAY_OPEN_BYTES : 0);

        if (bytes > budget) {
            return { files, truncated: true };
        }

        files.push(row);
    }

    return { files, truncated: false };
};

/**
 * One chunk's metadata for the export: the rows `read` finds, and for each file it found none for, the row `repair` writes (the file row is
 * read and its metadata written, for a file stored before the metadata was written). A file is repaired in its own mutation: its file row
 * is read whole, and one row is far below Lunora's per-transaction read limit where a chunk of them is not. The repairs stop once the
 * chunk has read `bytesLeft`, and the chunk says so.
 */
export const readChunkMetadata = async <Row extends { id: string }>(
    fileIds: string[],
    bytesLeft: number,
    read: (fileIds: string[]) => Promise<{ readBytes: number; rows: Row[] }>,
    repair: (fileId: string) => Promise<{ readBytes: number; rows: Row[] }>,
): Promise<{ readBytes: number; rows: Row[]; truncated: boolean }> => {
    const found = await read(fileIds);
    const answered = new Set(found.rows.map((row) => row.id));
    const rows = [...found.rows];
    let { readBytes } = found;

    for (const fileId of fileIds) {
        if (answered.has(fileId)) {
            continue;
        }

        if (readBytes >= bytesLeft) {
            return { readBytes, rows, truncated: true };
        }

        const repaired = await repair(fileId);

        readBytes += repaired.readBytes;
        rows.push(...repaired.rows);
    }

    // A chunk that spent its budget says so, even when its last repair overshot it: the export's next chunk would stop, and so must this one.
    return { readBytes, rows, truncated: readBytes >= bytesLeft };
};

/** The UTF-8 bytes of a text, as the file's size limit counts them. */
export const textBytes = (text: string): number => new TextEncoder().encode(text).byteLength;

/** Held back from the file's size limit for the text the splices add around the chat-file section (its key, the commas and indent). */
const CHAT_FILE_SPLICE_SLACK_BYTES = 64;

/**
 * The bytes the chat-file section may take: its own cap, and what the rest of the export leaves under the file's size limit. `restBytes`
 * is the export without the section, usage JSON included. Past it the section is cut to fit, and says so.
 */
export const chatFileSectionBudget = (restBytes: number, fileLimit: number): number =>
    Math.max(0, Math.min(CHAT_FILE_EXPORT_BYTES, fileLimit - restBytes - CHAT_FILE_SPLICE_SLACK_BYTES));

/**
 * The export's JSON with the chat-file section as its last key. `rest` is the export serialized without the section (`JSON.stringify(…,
 * null, 2)`), which ends with its closing brace; the section is written at the same depth as the export's other keys.
 */
export const withChatFiles = (rest: string, chatFiles: unknown): string => {
    const value = JSON.stringify(chatFiles, null, 2).replaceAll("\n", "\n  ");

    return `${rest.slice(0, -2)},\n  "chatFiles": ${value}\n}`;
};
