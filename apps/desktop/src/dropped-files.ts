import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** A file dropped on the dock icon is read whole into memory, so the shell caps it. The site applies its own limits. */
const MAX_DROPPED_FILE_BYTES = 25 * 1024 * 1024;

export interface DroppedFile {
    data: Uint8Array;
    name: string;
}

/**
 * The page may never take what it was sent (a window closed, a site not loaded), so the held files are
 * capped in count and in bytes. Arrival order is kept, and the first file that does not fit ends the
 * drop: the earliest files win.
 */
const MAX_PENDING_FILES = 20;
const MAX_PENDING_BYTES = 100 * 1024 * 1024;

/** Files waiting for the page: the ones already held, then the new drop, in the order they arrived, up to the caps. */
export const queueDroppedFiles = (pending: ReadonlyArray<DroppedFile> | undefined, incoming: ReadonlyArray<DroppedFile>): DroppedFile[] => {
    const held = pending === undefined ? [] : [...pending];
    let bytes = held.reduce((total, file) => total + file.data.byteLength, 0);

    for (const file of incoming) {
        if (held.length >= MAX_PENDING_FILES || bytes + file.data.byteLength > MAX_PENDING_BYTES) {
            break;
        }

        held.push(file);
        bytes += file.data.byteLength;
    }

    return held;
};

/** Reads the paths the OS hands over. Skips anything that is not a regular file within the cap, or cannot be read. */
export const readDroppedFiles = async (paths: ReadonlyArray<string>, maxBytes = MAX_DROPPED_FILE_BYTES): Promise<DroppedFile[]> => {
    const read = async (filePath: string): Promise<DroppedFile | undefined> => {
        if (!path.isAbsolute(filePath)) {
            return undefined;
        }

        try {
            const info = await stat(filePath);

            return info.isFile() && info.size <= maxBytes ? { data: await readFile(filePath), name: path.basename(filePath) } : undefined;
        } catch {
            // Gone or unreadable: nothing to attach.
            return undefined;
        }
    };

    const files = await Promise.all(paths.map((filePath) => read(filePath)));

    return files.filter((file): file is DroppedFile => file !== undefined);
};
