/**
 * Watching a folder one directory at a time, for where the system's recursive watch is not native. On Linux Node
 * walks the whole tree itself and puts an inotify watch on every directory it meets (`node_modules` and `.git`
 * included), which can use up the user's `fs.inotify.max_user_watches` and break their editor. Here a directory the
 * skip list names, and anything below it, never gets one, a symlinked directory is not followed (the listing leaves
 * it out), and the number of watches is capped.
 *
 * Pure over {@link TreeDependencies}, so the rules are tested where the system's watch is not the one that matters.
 */

export interface TreeDependencies {
    /** At most this many directories are watched at once; the rest of a very large tree is simply not covered. */
    limit: number;
    /** The directories and files directly inside a directory, as paths relative to the root, symlinks left out. */
    list: (relative: string) => Promise<{ directories: string[]; files: string[] }>;
    skip: (relative: string) => boolean;
    /** Watches one directory (`""` is the root). Event names are relative to that directory. */
    watchDirectory: (relative: string, onEvent: (eventType: string, name: string | null) => void, onError: (error: Error) => void) => { close: () => void };
}

/** Of a new directory's files, this many are reported as events: they may have been written before its watch existed. */
const MAX_ANNOUNCED = 200;
const OUT_OF_WATCHES = new Set(["EMFILE", "ENFILE", "ENOSPC"]);

const join = (directory: string, name: string): string => directory === "" ? name : `${directory}/${name}`;

const parentOf = (relative: string): string => relative.slice(0, Math.max(0, relative.lastIndexOf("/")));

export const watchTree = (
    dependencies: TreeDependencies,
    listener: (eventType: string, filename: string | null) => void,
    onError: (error: Error) => void,
): { close: () => void } => {
    const watchers = new Map<string, { close: () => void }>();
    const rechecking = new Set<string>();
    let closed = false;

    const drop = (relative: string): void => {
        for (const [key, handle] of watchers) {
            if (!(key === relative || key.startsWith(`${relative}/`))) {
                continue;
            }

            handle.close();
            watchers.delete(key);
        }
    };

    /** `announce`: reports a file of a directory that is new (it may have been written before its watch), until the budget is spent. */
    const add = async (relative: string, announce?: () => boolean): Promise<void> => {
        if (closed || watchers.has(relative) || (relative !== "" && dependencies.skip(relative)) || watchers.size >= dependencies.limit) {
            return;
        }

        try {
            watchers.set(
                relative,
                dependencies.watchDirectory(
                    relative,
                    (eventType, name) => {
                        if (name === null) {
                            return;
                        }

                        const child = join(relative, name);

                        listener(eventType, child);

                        if (eventType === "rename") {
                            recheck(relative);
                        }
                    },
                    (error) => {
                        drop(relative);

                        // A directory that vanished is not a failure; running out of watches is.
                        if (OUT_OF_WATCHES.has((error as NodeJS.ErrnoException).code ?? "")) {
                            onError(error);
                        }
                    },
                ),
            );
        } catch (error) {
            if (OUT_OF_WATCHES.has((error as NodeJS.ErrnoException).code ?? "")) {
                onError(error as Error);
            }

            return;
        }

        const { directories, files } = await dependencies.list(relative);

        if (announce !== undefined) {
            for (const file of files) {
                if (announce()) {
                    listener("rename", file);
                }
            }
        }

        for (const child of directories) {
            // eslint-disable-next-line no-await-in-loop -- one directory after another keeps the open handles of a walk to one listing
            await add(child, announce);
        }
    };

    /** A name appeared or went in `directory`: watch the new directories, and let go of the ones that are gone. */
    const recheck = (directory: string): void => {
        if (closed || rechecking.has(directory)) {
            return;
        }

        rechecking.add(directory);
        setTimeout(async () => {
            rechecking.delete(directory);

            if (closed) {
                return;
            }

            const { directories } = await dependencies.list(directory);
            const present = new Set(directories);

            for (const key of watchers.keys()) {
                if (key !== "" && parentOf(key) === directory && !present.has(key)) {
                    drop(key);
                }
            }

            let left = MAX_ANNOUNCED;
            const announce = (): boolean => {
                left -= 1;

                return left >= 0;
            };

            for (const child of directories) {
                // eslint-disable-next-line no-await-in-loop -- see above
                await add(child, announce);
            }
        }, 0);
    };

    (async () => {
        try {
            await add("");
        } catch (error) {
            onError(error as Error);
        }
    })();

    return {
        close: () => {
            closed = true;

            for (const handle of watchers.values()) {
                handle.close();
            }

            watchers.clear();
        },
    };
};
