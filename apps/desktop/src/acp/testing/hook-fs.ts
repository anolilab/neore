/** An in-memory folder for the runner's tests: files, symlinks and a watcher the test fires by hand. */
import path from "node:path";

import type { FileInfo, HookFs } from "../hooks/fs";

export class FakeFs implements HookFs {
    public readonly files = new Map<string, string>();

    /** Symlinks: path → target (absolute). */
    public readonly links = new Map<string, string>();

    public readonly dirs = new Set<string>();

    public closed = false;

    public get watching(): boolean {
        return this.listener !== undefined;
    }

    private failure: ((error: Error) => void) | undefined;

    private listener: ((eventType: string, filename: string | null) => void) | undefined;

    public constructor(public readonly root: string) {
        this.dirs.add(root);
    }

    public write(relative: string, content = "x"): void {
        const absolute = path.join(this.root, relative);

        for (let parent = path.dirname(absolute); parent.length >= this.root.length; parent = path.dirname(parent)) {
            this.dirs.add(parent);
        }

        this.files.set(absolute, content);
    }

    public remove(relative: string): void {
        this.files.delete(path.join(this.root, relative));
    }

    public link(relative: string, target: string): void {
        this.links.set(path.join(this.root, relative), target);
    }

    /** The watcher reports an error, as it does when the system is out of watches. */
    public fail(message: string): void {
        this.failure?.(new Error(message));
    }

    public emit(eventType: "change" | "rename", filename: string | null): void {
        this.listener?.(eventType, filename);
    }

    public lstat = async (target: string): Promise<FileInfo | undefined> => {
        if (this.links.has(target)) {
            return { directory: false, file: false, size: 0, symlink: true };
        }

        const content = this.files.get(target);

        if (content !== undefined) {
            return { directory: false, file: true, size: content.length, symlink: false };
        }

        return this.dirs.has(target) ? { directory: true, file: false, size: 0, symlink: false } : undefined;
    };

    public read = async (target: string, maxBytes: number): Promise<Buffer | undefined> => {
        const content = this.files.get(target);

        return content === undefined ? undefined : Buffer.from(content).subarray(0, maxBytes);
    };

    public realpath = async (target: string): Promise<string | undefined> => {
        // A directory that is a link resolves to its target; anything below it, too.
        for (const [link, destination] of this.links) {
            if (target === link || target.startsWith(`${link}${path.sep}`)) {
                return path.join(destination, target.slice(link.length));
            }
        }

        return this.files.has(target) || this.dirs.has(target) ? target : undefined;
    };

    // eslint-disable-next-line unicorn/prefer-iterator-to-array -- the desktop's tsconfig `lib` has no iterator helpers
    public scan = async (root: string, limit: number, skip: (relative: string) => boolean): Promise<string[]> => [...this.files.keys()]
        .map((file) => path.relative(root, file).split(path.sep).join("/"))
        .filter((relative) => !skip(relative))
        .slice(0, limit);

    public watch = (_root: string, listener: (eventType: string, filename: string | null) => void, onError: (error: Error) => void): { close: () => void } => {
        this.listener = listener;
        this.failure = onError;

        return {
            close: () => {
                this.closed = true;
                this.listener = undefined;
            },
        };
    };
}
