import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nodeTreeDependencies } from "./fs";
import type { TreeDependencies } from "./watch-tree";
import { watchTree } from "./watch-tree";

/** Taking the read bit off a folder locks out its owner, but not root, and Windows has no such bit. */
const canLockFolders = process.platform !== "win32" && process.getuid?.() !== 0;

const ignored = (relative: string): boolean => relative.split("/").some((segment) => segment === "node_modules" || segment === ".git");

/** A tree of directories (relative paths → their subdirectories) and the watchers placed on it, driven by hand. */
const fakeTree = (tree: Record<string, string[]>) => {
    const watched = new Map<string, { close: ReturnType<typeof vi.fn>; fail: (error: Error) => void; fire: (eventType: string, name: string | null) => void }>();
    const files = new Map<string, string[]>();

    const dependencies = (limit = 100): TreeDependencies => {
        return {
            limit,
            list: async (relative) => {
                return { directories: tree[relative] ?? [], files: files.get(relative) ?? [] };
            },
            skip: ignored,
            watchDirectory: (relative, onEvent, onError) => {
                const close = vi.fn();

                watched.set(relative, { close, fail: onError, fire: onEvent });

                return { close };
            },
        };
    };

    return { deps: dependencies, files, tree, watched };
};

const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, 20);
    });
};

describe("watchTree", () => {
    it("watches every directory but never what the skip list names, nor anything below it", async () => {
        const { deps, watched } = fakeTree({ "": ["src", "node_modules", ".git"], ".git": ["objects"], node_modules: ["pkg"], src: ["src/deep"] });

        watchTree(deps(), () => {}, () => {});
        await settle();

        expect(new Set(watched.keys())).toEqual(new Set(["", "src", "src/deep"]));
    });

    it("reports a name relative to the root, not to the directory it came from", async () => {
        const { deps, watched } = fakeTree({ "": ["src"], src: ["src/deep"] });
        const seen: [string, string | null][] = [];

        watchTree(
            deps(),
            (eventType, filename) => {
                seen.push([eventType, filename]);
            },
            () => {},
        );
        await settle();
        watched.get("")?.fire("change", "README.md");
        watched.get("src")?.fire("change", "a.ts");
        watched.get("src/deep")?.fire("rename", "b.ts");

        expect(seen).toEqual([
            ["change", "README.md"],
            ["change", "src/a.ts"],
            ["rename", "src/deep/b.ts"],
        ]);
    });

    it("places no more watchers than the cap", async () => {
        const many = Array.from({ length: 50 }, (_, index) => `d${String(index)}`);
        const { deps, watched } = fakeTree({ "": many });

        watchTree(deps(10), () => {}, () => {});
        await settle();

        expect(watched.size).toBe(10);
    });

    it("starts watching a directory that appears, and reports the files it already holds", async () => {
        const { deps, files, tree, watched } = fakeTree({ "": [] });
        const seen: [string, string | null][] = [];

        watchTree(
            deps(),
            (eventType, filename) => {
                seen.push([eventType, filename]);
            },
            () => {},
        );
        await settle();

        tree[""] = ["fresh"];
        tree.fresh = ["fresh/inner"];
        tree["fresh/inner"] = [];
        files.set("fresh", ["fresh/a.ts"]);
        watched.get("")?.fire("rename", "fresh");
        await settle();

        expect(watched.has("fresh")).toBe(true);
        expect(watched.has("fresh/inner")).toBe(true);
        expect(seen).toContainEqual(["rename", "fresh/a.ts"]);

        watched.get("fresh/inner")?.fire("change", "c.ts");
        expect(seen).toContainEqual(["change", "fresh/inner/c.ts"]);
    });

    it("does not start watching a directory the skip list names when one appears", async () => {
        const { deps, tree, watched } = fakeTree({ "": [] });

        watchTree(deps(), () => {}, () => {});
        await settle();
        tree[""] = ["node_modules"];
        tree.node_modules = [];
        watched.get("")?.fire("rename", "node_modules");
        await settle();

        expect(watched.has("node_modules")).toBe(false);
    });

    it("lets go of a directory that was removed, and of everything below it", async () => {
        const { deps, tree, watched } = fakeTree({ "": ["src"], src: ["src/deep"] });

        watchTree(deps(), () => {}, () => {});
        await settle();

        const gone = [watched.get("src"), watched.get("src/deep")];

        tree[""] = [];
        delete tree.src;
        watched.get("")?.fire("rename", "src");
        await settle();

        expect(gone.map((watcher) => watcher?.close.mock.calls.length)).toEqual([1, 1]);
    });

    it("keeps the watches below a directory whose listing could not be read", async () => {
        const { deps, watched } = fakeTree({ "": ["src"], src: ["src/deep"] });
        const dependencies = deps();
        const { list } = dependencies;

        watchTree(dependencies, () => {}, () => {});
        await settle();

        const kept = [watched.get("src"), watched.get("src/deep")];

        dependencies.list = async (relative) => relative === "" ? undefined : list(relative);
        watched.get("")?.fire("rename", "other");
        await settle();

        expect(kept.map((watcher) => watcher?.close.mock.calls.length)).toEqual([0, 0]);
    });

    it("reports running out of watches as the watcher failing, but one directory vanishing as nothing", async () => {
        const { deps, watched } = fakeTree({ "": ["a", "b"] });
        const onError = vi.fn();

        watchTree(deps(), () => {}, onError);
        await settle();

        watched.get("a")?.fail(Object.assign(new Error("gone"), { code: "ENOENT" }));
        expect(onError).not.toHaveBeenCalled();
        expect(watched.get("a")?.close).toHaveBeenCalled();

        watched.get("b")?.fail(Object.assign(new Error("no space"), { code: "ENOSPC" }));
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("closes every watcher, and places none after that", async () => {
        const { deps, watched } = fakeTree({ "": ["a"], a: ["a/b"] });
        const watcher = watchTree(deps(), () => {}, () => {});

        await settle();
        watcher.close();
        watcher.close();

        expect(Array.from(watched.values(), (entry) => entry.close.mock.calls.length)).toEqual([1, 1, 1]);
    });
});

describe("watchTree on a real folder", () => {
    let directory = "";

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it.skipIf(!canLockFolders)("tells an unreadable directory apart from an empty or vanished one", async () => {
        const prefix = path.join(tmpdir(), "neore-watch-tree-");

        directory = realpathSync(mkdtempSync(prefix));
        mkdirSync(path.join(directory, "locked", "inner"), { recursive: true });

        const real = nodeTreeDependencies(directory, ignored, 100);

        chmodSync(path.join(directory, "locked"), 0o300);

        try {
            await expect(real.list("locked")).resolves.toBeUndefined();
            await expect(real.list("gone")).resolves.toEqual({ directories: [], files: [] });
        } finally {
            chmodSync(path.join(directory, "locked"), 0o700);
        }
    });

    it("hears a nested file, and never puts a watch on node_modules or .git", async () => {
        const prefix = path.join(tmpdir(), "neore-watch-tree-");

        directory = realpathSync(mkdtempSync(prefix));
        mkdirSync(path.join(directory, "src", "deep"), { recursive: true });
        mkdirSync(path.join(directory, "node_modules", "pkg"), { recursive: true });
        mkdirSync(path.join(directory, ".git", "objects"), { recursive: true });

        const seen: string[] = [];
        const placed: string[] = [];
        const real = nodeTreeDependencies(directory, ignored, 100);
        const watcher = watchTree(
            {
                ...real,
                watchDirectory: (relative, onEvent, onError) => {
                    placed.push(relative);

                    return real.watchDirectory(relative, onEvent, onError);
                },
            },
            (_eventType, filename) => {
                seen.push(String(filename));
            },
            (error) => {
                throw error;
            },
        );

        try {
            await settle();
            writeFileSync(path.join(directory, "src", "deep", "a.ts"), "a");
            await expect.poll(() => seen.includes("src/deep/a.ts"), { timeout: 4000 }).toBe(true);
            expect(new Set(placed)).toEqual(new Set(["", "src", "src/deep"]));
            expect(placed).toHaveLength(3);
        } finally {
            watcher.close();
        }
    });
});
