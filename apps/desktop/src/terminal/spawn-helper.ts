import { chmodSync, existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The `node-pty` library starts a shell through a small `spawn-helper` binary, and its published tarball ships that
 * file without the execute bit: the first spawn then fails with `posix_spawnp failed`. The packaged app
 * is fixed before signing (`scripts/after-pack.cjs`); this covers a checkout and an install that was
 * unpacked another way (a development run, not an app). A packaged app is left alone, since changing a file in it
 * would break its signature. A read-only location is left alone too, and the spawn reports its own failure.
 */
export const makeSpawnHelperExecutable = (packageDirectory: string, platform: string = process.platform, arch: string = process.arch): void => {
    if (packageDirectory.includes("app.asar")) {
        return;
    }

    for (const directory of [path.join(packageDirectory, "build", "Release"), path.join(packageDirectory, "prebuilds", `${platform}-${arch}`)]) {
        const helper = path.join(directory, "spawn-helper");

        if (existsSync(helper)) {
            try {
                // eslint-disable-next-line no-bitwise -- the execute bits of a file mode
                if ((statSync(helper).mode & 0o111) === 0) {
                    chmodSync(helper, 0o755);
                }
            } catch {
                // Not writable: nothing more to try here.
            }
        }
    }
};

const ASAR_SEGMENT = /app\.asar(?=[\\/])/u;

/**
 * On Windows `node-pty` starts a worker thread from its own folder, and `node-pty` only rewrites `node_modules.asar` to its unpacked path, so the worker script path would point inside `app.asar`. A packaged app
 * loads the copy electron-builder unpacked beside the archive (`asarUnpack` in `electron-builder.yml`); anywhere else the
 * folder is returned as it is.
 */
export const loadableDirectory = (packageDirectory: string, platform: string = process.platform, exists: (file: string) => boolean = existsSync): string => {
    if (platform !== "win32") {
        return packageDirectory;
    }

    const unpacked = packageDirectory.replace(ASAR_SEGMENT, "app.asar.unpacked");

    return exists(unpacked) ? unpacked : packageDirectory;
};
