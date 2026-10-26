// Packaging smoke test: the built shell's bundles exist and the device-execution
// addon loads and answers. Plain Node, no display, so it runs on all three CI OSes.
// Run after `pnpm --filter @neore/desktop run build`.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
const require = createRequire(import.meta.url);

const fail = (message) => {
    console.error(`smoke: ${message}`);
    process.exit(1);
};

const bundles = ["main.cjs", "preload.cjs", "quick-composer/preload.cjs", "device-window/preload.cjs"];

for (const bundle of bundles) {
    if (!existsSync(path.join(dist, bundle))) {
        fail(`missing dist/${bundle}; run the build first`);
    }
}

let DeviceCore;

try {
    ({ DeviceCore } = require("@neore/device-core-node"));
} catch (error) {
    fail(`cannot load @neore/device-core-node: ${error instanceof Error ? error.message : String(error)}`);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "neore-smoke-"));

try {
    const core = new DeviceCore(dataDir, () => {});
    const status = JSON.parse(core.status());

    if (!["linux", "macos", "windows"].includes(status.platform)) {
        fail(`status() returned an unexpected platform: ${JSON.stringify(status)}`);
    }

    core.stop();
    console.log(`smoke: ok (${status.platform}, device-core-node loaded)`);
} catch (error) {
    fail(`device-core-node failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
    rmSync(dataDir, { force: true, recursive: true });
}

// The engine's threads may keep the event loop alive.
process.exit(0);
