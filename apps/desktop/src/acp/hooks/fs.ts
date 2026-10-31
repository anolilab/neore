/** The file system as the hook runner uses it, so tests can stand in for it and a watcher's timing is theirs to set. */
import { watch } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export interface FileInfo {
    directory: boolean;
    file: boolean;
    size: number;
    symlink: boolean;
}

export interface HookFs {
    lstat: (target: string) => Promise<FileInfo | undefined>;
    /** At most `maxBytes` of a regular file; `undefined` when it is not there. */
    read: (target: string, maxBytes: number) => Promise<Buffer | undefined>;
    realpath: (target: string) => Promise<string | undefined>;
    /** Regular files under `root` (relative, `/`-separated), skipping what `skip` says and every symlink, at most `limit`. */
    scan: (root: string, limit: number, skip: (relative: string) => boolean) => Promise<string[]>;
    /** Calls `listener` for every change under `root`. `filename` is relative to it. */
    watch: (root: string, listener: (eventType: string, filename: string | null) => void, onError: (error: Error) => void) => { close: () => void };
}

const missing = (error: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Runs `action`, answering `undefined` for a path that is not there. */
const orMissing = async <Result>(action: () => Promise<Result>): Promise<Result | undefined> => {
    try {
        return await action();
    } catch (error) {
        if (missing(error)) {
            return undefined;
        }

        throw error;
    }
};

/** The entries of one folder, as paths relative to `root`: symlinks and what `skip` names are left out. */
const listFolder = async (root: string, relative: string, skip: (relative: string) => boolean): Promise<{ directories: string[]; files: string[] }> => {
    const listing: { directories: string[]; files: string[] } = { directories: [], files: [] };
    let entries;

    try {
        entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
        return listing;
    }

    for (const entry of entries) {
        const child = relative === "" ? entry.name : `${relative}/${entry.name}`;

        if (!skip(child) && !entry.isSymbolicLink()) {
            if (entry.isDirectory()) {
                listing.directories.push(child);
            } else if (entry.isFile()) {
                listing.files.push(child);
            }
        }
    }

    return listing;
};

const readFrom = async (target: string, maxBytes: number): Promise<Buffer> => {
    const handle = await open(target, "r");

    try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);

        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
};

export const nodeHookFs: HookFs = {
    lstat: async (target) => {
        const info = await orMissing(() => lstat(target));

        return info === undefined ? undefined : { directory: info.isDirectory(), file: info.isFile(), size: info.size, symlink: info.isSymbolicLink() };
    },
    read: (target, maxBytes) => orMissing(() => readFrom(target, maxBytes)),
    realpath: (target) => orMissing(() => realpath(target)),
    scan: async (root, limit, skip) => {
        const found: string[] = [];
        const queue = [""];

        while (queue.length > 0 && found.length < limit) {
            // eslint-disable-next-line no-await-in-loop -- one folder after another keeps the scan's open handles to one
            const { directories, files } = await listFolder(root, queue.shift() as string, skip);

            queue.push(...directories);
            found.push(...files.slice(0, limit - found.length));
        }

        return found;
    },
    watch: (root, listener, onError) => {
        const watcher = watch(root, { persistent: false, recursive: true }, (eventType, filename) => listener(eventType, filename === null ? null : String(filename)));

        watcher.on("error", onError);

        return { close: () => watcher.close() };
    },
};
