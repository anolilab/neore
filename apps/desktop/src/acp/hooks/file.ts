/** Reads `.neore/hooks.json` from the approved folder: the bytes, their hash and what they parse to, from one read. */
import { createHash } from "node:crypto";

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
 * `root` is the folder's real path. Neither the folder nor the file may be a link (so the file cannot be one outside
 * the folder), and the hash is of the bytes that were parsed: they come from one checked, open file.
 */
export const loadHooksFile = async (fs: HookFs, root: string): Promise<HooksFile> => {
    const read = await fs.readInside(root, HOOKS_PATH, MAX_FILE_BYTES + 1);

    if (read.state === "none") {
        return { state: "none" };
    }

    if (read.state === "refused") {
        return { error: "the hooks file is not a regular file inside the folder", hash: "", state: "invalid" };
    }

    const { bytes } = read;
    const hash = createHash("sha256").update(bytes).digest("hex");

    if (bytes.length > MAX_FILE_BYTES) {
        return { error: `the file is larger than ${String(MAX_FILE_BYTES)} bytes`, hash, state: "invalid" };
    }

    const parsed = parseHooks(bytes.toString("utf8"));

    return parsed.ok ? { hash, hooks: parsed.hooks, state: "ok" } : { error: parsed.error, hash, state: "invalid" };
};
