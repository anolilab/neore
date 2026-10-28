/**
 * Reads files of one approved folder, and only inside it. Paths are resolved against the folder and refused outside
 * it (`..`, an absolute path elsewhere, a symlink that leaves it); a refused path is never opened.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { MAX_SUMMARY_PATH_CHARS } from "./host-events";

/** One side of one file. The device file tools cap a read at the same size. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** The file operations used; tests swap them to see what was read. */
export interface FileIo {
    lstat: typeof lstat;
    readFile: (file: string) => Promise<Buffer>;
    realpath: (file: string) => Promise<string>;
}

const nodeIo: FileIo = { lstat, readFile: async (file) => await readFile(file), realpath: async (file) => await realpath(file) };

const isInside = (root: string, target: string): boolean => {
    const relative = path.relative(root, target);

    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/** A path with a control character could forge a line of the patch, so it is not a path. */
const isPlainPath = (value: string): boolean => value.length <= MAX_SUMMARY_PATH_CHARS && [...value].every((char) => (char.codePointAt(0) ?? 0) > 0x1F);

export class FolderFiles {
    private realFolder: Promise<string> | undefined;

    public constructor(
        private readonly folder: string,
        private readonly io: FileIo = nodeIo,
    ) {}

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

        return isPlainPath(relative) ? relative : undefined;
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
                return isInside(root, await this.io.realpath(target));
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
                real = await this.io.realpath(target);
            } catch (error) {
                // Nothing there, or a link that points nowhere: only a plain absence counts, and only below the folder.
                return isMissing(error) && await this.confines(relative) ? null : undefined;
            }

            if (!isInside(root, real)) {
                return undefined;
            }

            const info = await this.io.lstat(real);

            if (!info.isFile() || info.size > MAX_FILE_BYTES) {
                return undefined;
            }

            const bytes = await this.io.readFile(real);

            return bytes.length > MAX_FILE_BYTES || bytes.includes(0) ? undefined : bytes.toString("utf8");
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
            return await this.io.realpath(folder);
        } catch (error) {
            if (!isMissing(error) || !isInside(this.folder, folder)) {
                throw error;
            }

            return await this.nearestExisting(path.dirname(folder));
        }
    }

    private async root(): Promise<string> {
        this.realFolder ??= this.io.realpath(this.folder);

        return await this.realFolder;
    }
}
