import { chmodSync, existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The `node-pty` library starts a shell through a small `spawn-helper` binary, and its published tarball ships that
 * file without the execute bit: the first spawn then fails with `posix_spawnp failed`. The packaged app
 * is fixed before signing (`scripts/after-pack.cjs`); this covers a checkout and an install that was
 * unpacked another way. A read-only location is left alone, and the spawn reports its own failure.
 */
export const makeSpawnHelperExecutable = (packageDirectory: string, platform: string = process.platform, arch: string = process.arch): void => {
    const unpacked = packageDirectory.replace("app.asar", "app.asar.unpacked");

    for (const directory of [path.join(unpacked, "build", "Release"), path.join(unpacked, "prebuilds", `${platform}-${arch}`)]) {
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
