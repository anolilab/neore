// Bundles the main process, the two sandboxed preloads and the Quick Composer
// page into `dist/`. The site origin is baked in at build time (`NEORE_SITE_URL`):
// there is no runtime override.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const DEFAULT_SITE_URL = "http://localhost:5173";
const release = process.env.NEORE_RELEASE === "1";

if (release && !process.env.NEORE_SITE_URL) {
    throw new Error("NEORE_SITE_URL is required for a release build");
}

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");

rmSync(dist, { force: true, recursive: true });
mkdirSync(path.join(dist, "quick-composer"), { recursive: true });
mkdirSync(path.join(dist, "device-window"), { recursive: true });
mkdirSync(path.join(dist, "terminal-window"), { recursive: true });
mkdirSync(path.join(dist, "dictation-window"), { recursive: true });
mkdirSync(path.join(dist, "dictation-settings-window"), { recursive: true });

const common = {
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    // electron-updater is a runtime dependency: electron-builder packs it, esbuild does not inline it.
    external: ["electron", "electron-updater"],
    define: {
        "process.env.NEORE_SITE_URL": JSON.stringify(process.env.NEORE_SITE_URL ?? DEFAULT_SITE_URL),
    },
    sourcemap: !release,
    logLevel: "info",
};

/**
 * A sandboxed preload runs with Node's built-ins unavailable, so its only import may be `electron`.
 * esbuild marks the built-ins it leaves alone as external, so any `fs`, `child_process`, … shows up here.
 */
const assertSandboxedPreload = (name, result) => {
    const forbidden = Object.values(result.metafile.outputs)
        .flatMap((output) => output.imports)
        .filter((imported) => imported.external && imported.path !== "electron")
        .map((imported) => imported.path);

    if (forbidden.length > 0) {
        throw new Error(`${name} imports ${[...new Set(forbidden)].join(", ")}; a sandboxed preload may import only "electron"`);
    }
};

const preloadEntries = [
    ["site preload", path.join(root, "src/preload.ts"), path.join(dist, "preload.cjs")],
    ["Quick Composer preload", path.join(root, "src/quick-composer/preload.ts"), path.join(dist, "quick-composer", "preload.cjs")],
    ["device window preload", path.join(root, "src/device/window/preload.ts"), path.join(dist, "device-window", "preload.cjs")],
    ["terminal window preload", path.join(root, "src/terminal/window/preload.ts"), path.join(dist, "terminal-window", "preload.cjs")],
    ["dictation window preload", path.join(root, "src/dictation/window/preload.ts"), path.join(dist, "dictation-window", "preload.cjs")],
    [
        "dictation settings window preload",
        path.join(root, "src/dictation/settings-window/preload.ts"),
        path.join(dist, "dictation-settings-window", "preload.cjs"),
    ],
];

await esbuild.build({ ...common, entryPoints: [path.join(root, "src/main.ts")], outfile: path.join(dist, "main.cjs") });

// The terminal host is its own process (an Electron utility process). `node-pty` is native: it stays outside the
// bundle and is loaded from node_modules by the host, on the first spawn.
await esbuild.build({
    ...common,
    external: [...common.external, "node-pty"],
    entryPoints: [path.join(root, "src/terminal/host-main.ts")],
    outfile: path.join(dist, "terminal-host.cjs"),
});

for (const [name, entryPoint, outfile] of preloadEntries) {
    assertSandboxedPreload(name, await esbuild.build({ ...common, entryPoints: [entryPoint], outfile, metafile: true }));
}

// The Quick Composer page is plain HTML/JS: copied, not bundled.
for (const file of ["index.html", "quick-composer.css", "quick-composer.js"]) {
    copyFileSync(path.join(root, "src/quick-composer", file), path.join(dist, "quick-composer", file));
}

// The local device window's page: a classic script (no module scripts from file://). Its sandboxed
// preload is built with the others above. The page and its stylesheet are copied as they are.
await esbuild.build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    entryPoints: [path.join(root, "src/device/window/device.ts")],
    outfile: path.join(dist, "device-window", "device.js"),
    sourcemap: !release,
    logLevel: "info",
});

for (const file of ["device.html", "device.css"]) {
    copyFileSync(path.join(root, "src/device/window", file), path.join(dist, "device-window", file));
}

// The local terminal window's page, built like the device window's. The emulator's stylesheet is copied beside it.
await esbuild.build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    entryPoints: [path.join(root, "src/terminal/window/terminal.ts")],
    outfile: path.join(dist, "terminal-window", "terminal.js"),
    sourcemap: !release,
    logLevel: "info",
});

for (const file of ["terminal.html", "terminal.css"]) {
    copyFileSync(path.join(root, "src/terminal/window", file), path.join(dist, "terminal-window", file));
}

copyFileSync(
    path.join(path.dirname(createRequire(import.meta.url).resolve("@xterm/xterm/package.json")), "css", "xterm.css"),
    path.join(dist, "terminal-window", "xterm.css"),
);

// The dictation window's page: a classic script too, bundled the same way.
await esbuild.build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    entryPoints: [path.join(root, "src/dictation/window/dictation.ts")],
    outfile: path.join(dist, "dictation-window", "dictation.js"),
    sourcemap: !release,
    logLevel: "info",
});

for (const file of ["dictation.html", "dictation.css"]) {
    copyFileSync(path.join(root, "src/dictation/window", file), path.join(dist, "dictation-window", file));
}

// The dictation settings window's page, built the same way.
await esbuild.build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    entryPoints: [path.join(root, "src/dictation/settings-window/settings.ts")],
    outfile: path.join(dist, "dictation-settings-window", "settings.js"),
    sourcemap: !release,
    logLevel: "info",
});

for (const file of ["settings.html", "settings.css"]) {
    copyFileSync(path.join(root, "src/dictation/settings-window", file), path.join(dist, "dictation-settings-window", file));
}

copyFileSync(path.join(root, "assets/icon.png"), path.join(dist, "icon.png"));
