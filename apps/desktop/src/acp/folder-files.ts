/**
 * Reads files of one approved folder, and only inside it. Paths are resolved against the folder and refused outside
 * it (`..`, an absolute path elsewhere, a symlink that leaves it); a refused path is never opened.
 *
 * The check and the open are two steps: the path is resolved with links followed, then the resolved path is opened
 * with `O_NOFOLLOW` and the OPEN handle is examined (a regular file, its size), so a link swapped in after the check
 * fails the open instead of being followed. A swap of a folder higher up in the same instant is not closed (the Rust
 * walk in `packages/device-core/src/fs.rs` opens every component, this does not), which is why this path only READS
 * files the user's own agent named. Windows has no `O_NOFOLLOW`; there the resolved path is opened as is.
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { isSummaryPath } from "./host-events";

/** One side of one file, in UTF-8 bytes. The device file tools cap a read at the same size. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** The file operations used; tests swap them to see what was read. */
export interface FileIo {
    lstat: typeof lstat;
    /** The file's bytes, or undefined when it is not a regular file or holds more than `maxBytes`. Never follows a link at the last step. */
    readRegular: (file: string, maxBytes: number) => Promise<Buffer | undefined>;
    realpath: (file: string) => Promise<string>;
}

/** Invalid UTF-8 is not text: decoded loosely, two different binary files could read the same and an edit vanish. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

const readRegular = async (file: string, maxBytes: number): Promise<Buffer | undefined> => {
    const handle = await open(file, constants.O_RDONLY + (constants.O_NOFOLLOW ?? 0));

    try {
        const info = await handle.stat();

        if (!info.isFile() || info.size > maxBytes) {
            return undefined;
        }

        const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

        // The file grew between `fstat` and the read.
        return bytesRead > maxBytes ? undefined : buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
};

export const nodeIo: FileIo = { lstat, readRegular, realpath: async (file) => await realpath(file) };

const VERBATIM_UNC = /^\\\\\?\\UNC\\/u;
const VERBATIM_DRIVE = /^\\\\\?\\(?=[A-Za-z]:)/u;

/**
 * The core canonicalises the approved folder, which on Windows gives `\\?\C:\work`; an agent names `C:\work\a.ts`.
 * The two only compare once the verbatim prefix is gone. Anything else passes through.
 */
export const withoutVerbatimPrefix = (value: string): string => value.replace(VERBATIM_UNC, "\\\\").replace(VERBATIM_DRIVE, "");

const isInside = (root: string, target: string): boolean => {
    const relative = path.relative(root, target);

    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

export class FolderFiles {
    private readonly folder: string;

    private realFolder: Promise<string> | undefined;

    public constructor(
        folder: string,
        private readonly io: FileIo = nodeIo,
    ) {
        this.folder = withoutVerbatimPrefix(folder);
    }

    /** The path as the folder sees it (relative, forward slashes); undefined when it is outside the folder or not a plain path. */
    public relative(raw: string): string | undefined {
        if (raw === "" || raw.includes("\0")) {
            return undefined;
        }

        const absolute = path.resolve(this.folder, raw);

        if (!isInside(this.folder, absolute)) {
            return undefined;
        }

        const relative = path.relative(this.folder, absolute).split(path.sep).join("/");

        return isSummaryPath(relative) ? relative : undefined;
    }

    /**
     * Whether the file, once links are followed, is inside the folder: for a path the agent already described in full
     * (diff content), where nothing needs reading. A file that does not exist yet counts if its folder is inside.
     */
    public async confines(relative: string): Promise<boolean> {
        const target = path.join(this.folder, ...relative.split("/"));

        try {
            const root = await this.root();

            try {
                return isInside(root, withoutVerbatimPrefix(await this.io.realpath(target)));
            } catch (error) {
                // Not there yet (a new file may sit in a new folder): the nearest folder that exists decides, and the name itself must not be a link.
                return isMissing(error) && await this.absentBelow(root, target);
            }
        } catch {
            return false;
        }
    }

    /**
     * The file's text, `null` when it does not exist, `undefined` when it must not be read: outside the folder once
     * links are followed, not a regular file, over the cap, or binary.
     */
    public async read(relative: string): Promise<string | null | undefined> {
        const target = path.join(this.folder, ...relative.split("/"));

        try {
            const root = await this.root();
            let real: string;

            try {
                real = withoutVerbatimPrefix(await this.io.realpath(target));
            } catch (error) {
                // Nothing there, or a link that points nowhere: only a plain absence counts, and only below the folder.
                return isMissing(error) && await this.confines(relative) ? null : undefined;
            }

            if (!isInside(root, real)) {
                return undefined;
            }

            const bytes = await this.io.readRegular(real, MAX_FILE_BYTES);

            return bytes === undefined || bytes.includes(0) ? undefined : STRICT_UTF8.decode(bytes);
        } catch {
            return undefined;
        }
    }

    private async absentBelow(root: string, target: string): Promise<boolean> {
        const parent = await this.nearestExisting(path.dirname(target));

        if (parent !== root && !isInside(root, parent)) {
            return false;
        }

        try {
            await this.io.lstat(target);

            return false;
        } catch (error) {
            return isMissing(error);
        }
    }

    private async nearestExisting(folder: string): Promise<string> {
        try {
            return withoutVerbatimPrefix(await this.io.realpath(folder));
        } catch (error) {
            if (!isMissing(error) || !isInside(this.folder, folder)) {
                throw error;
            }

            return await this.nearestExisting(path.dirname(folder));
        }
    }

    private async root(): Promise<string> {
        this.realFolder ??= this.resolveRoot();

        return await this.realFolder;
    }

    private async resolveRoot(): Promise<string> {
        return withoutVerbatimPrefix(await this.io.realpath(this.folder));
    }
}
