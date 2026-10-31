/** Reads `.neore/hooks.json` from the approved folder: the bytes, their hash and what they parse to, from one read. */
import { createHash } from "node:crypto";
import path from "node:path";

import type { HookFs } from "./fs";
import type { Hook } from "./schema";
import { MAX_FILE_BYTES, parseHooks } from "./schema";

export const HOOKS_DIR = ".neore";
export const HOOKS_PATH = `${HOOKS_DIR}/hooks.json`;

export type HooksFile
    = | { error: string; hash: string; state: "invalid" }
        | { hash: string; hooks: Hook[]; state: "ok" }
        | { state: "none" };

/**
 * `root` is the folder's real path. The directory and the file must be real (a symlink is refused, so the file cannot be
 * one outside the folder) and the hash is of the bytes that were parsed.
 */
export const loadHooksFile = async (fs: HookFs, root: string): Promise<HooksFile> => {
    const directory = path.join(root, HOOKS_DIR);
    const target = path.join(root, HOOKS_PATH);
    const [folderInfo, info] = await Promise.all([fs.lstat(directory), fs.lstat(target)]);

    if (info === undefined || folderInfo === undefined) {
        return { state: "none" };
    }

    if (folderInfo.symlink || !folderInfo.directory || info.symlink || !info.file) {
        return { error: "the hooks file is not a regular file inside the folder", hash: "", state: "invalid" };
    }

    if (info.size > MAX_FILE_BYTES) {
        return { error: `the file is larger than ${String(MAX_FILE_BYTES)} bytes`, hash: "", state: "invalid" };
    }

    const bytes = await fs.read(target, MAX_FILE_BYTES + 1);

    if (bytes === undefined) {
        return { state: "none" };
    }

    const hash = createHash("sha256").update(bytes).digest("hex");

    if (bytes.length > MAX_FILE_BYTES) {
        return { error: `the file is larger than ${String(MAX_FILE_BYTES)} bytes`, hash, state: "invalid" };
    }

    const parsed = parseHooks(bytes.toString("utf8"));

    return parsed.ok ? { hash, hooks: parsed.hooks, state: "ok" } : { error: parsed.error, hash, state: "invalid" };
};
