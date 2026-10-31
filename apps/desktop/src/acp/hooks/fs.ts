/** The file system as the hook runner uses it, so tests can stand in for it and a watcher's timing is theirs to set. */
import { watch } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface FileInfo {
    directory: boolean;
    file: boolean;
    size: number;
    symlink: boolean;
}

export type InsideRead = { bytes: Buffer; state: "ok" } | { reason: string; state: "refused" } | { state: "none" };

export interface HookFs {
    lstat: (target: string) => Promise<FileInfo | undefined>;
    /**
     * At most `maxBytes` of the regular file `relative` (`/`-separated) under `root`, which is a real path. A link
     * anywhere on the way, a file that is not where its real path says, or anything but a regular file is `refused`.
     * One open handle is checked and read, so what was checked is what is read.
     */
    readInside: (root: string, relative: string, maxBytes: number) => Promise<InsideRead>;
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

const refusedRead = (reason: string): InsideRead => {
    return { reason, state: "refused" };
};

/** The open handle's own view of the file, compared with what its path says now. */
const readInside = async (root: string, relative: string, maxBytes: number): Promise<InsideRead> => {
    const segments = relative.split("/");
    const target = path.join(root, ...segments);
    let walked = root;

    // Every folder on the way and the file itself must be real entries, not links.
    for (const segment of segments) {
        walked = path.join(walked, segment);

        // eslint-disable-next-line no-await-in-loop -- each step is below the one before
        const info = await orMissing(() => lstat(walked));

        if (info === undefined) {
            return { state: "none" };
        }

        if (info.isSymbolicLink()) {
            return refusedRead("a link on the way to the file");
        }
    }

    let handle;

    try {
        // O_NOFOLLOW refuses a link as the last part of the path; the checks below cover the rest of it.
        handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";

        if (missing(error)) {
            return { state: "none" };
        }

        if (code === "ELOOP") {
            return refusedRead("a link on the way to the file");
        }

        throw error;
    }

    try {
        const opened = await handle.stat();

        if (!opened.isFile()) {
            return refusedRead("not a regular file");
        }

        const [real, current] = await Promise.all([orMissing(() => realpath(target)), orMissing(() => stat(target))]);

        if (real !== target || current === undefined || current.dev !== opened.dev || current.ino !== opened.ino) {
            return refusedRead("the file is not where its path says");
        }

        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);

        return { bytes: buffer.subarray(0, bytesRead), state: "ok" };
    } finally {
        await handle.close();
    }
};

export const nodeHookFs: HookFs = {
    lstat: async (target) => {
        const info = await orMissing(() => lstat(target));

        return info === undefined ? undefined : { directory: info.isDirectory(), file: info.isFile(), size: info.size, symlink: info.isSymbolicLink() };
    },
    readInside,
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
