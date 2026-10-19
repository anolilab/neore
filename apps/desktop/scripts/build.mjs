// Bundles the main process, the two sandboxed preloads and the Quick Composer
// page into `dist/`. The site origin is baked in at build time (like the Tauri
// shell's NEORE_SITE_URL): there is no runtime override.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
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

const common = {
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    // electron-updater is a runtime dependency: electron-builder packs it, esbuild does not inline it.
    external: ["electron", "electron-updater"],
    define: { "process.env.NEORE_SITE_URL": JSON.stringify(process.env.NEORE_SITE_URL ?? DEFAULT_SITE_URL) },
    sourcemap: !release,
    logLevel: "info",
};

await esbuild.build({ ...common, entryPoints: [path.join(root, "src/main.ts")], outfile: path.join(dist, "main.cjs") });
await esbuild.build({ ...common, entryPoints: [path.join(root, "src/preload.ts")], outfile: path.join(dist, "preload.cjs") });
await esbuild.build({
    ...common,
    entryPoints: [path.join(root, "src/quick-composer/preload.ts")],
    outfile: path.join(dist, "quick-composer", "preload.cjs"),
});

// The Quick Composer page is plain HTML/JS (as in the Tauri shell): copied, not bundled.
for (const file of ["index.html", "quick-composer.css", "quick-composer.js"]) {
    copyFileSync(path.join(root, "src/quick-composer", file), path.join(dist, "quick-composer", file));
}

// The local device window: its own sandboxed preload, and a classic script for the page (no module
// scripts from file://). The page and its stylesheet are copied as they are.
await esbuild.build({
    ...common,
    entryPoints: [path.join(root, "src/device/window/preload.ts")],
    outfile: path.join(dist, "device-window", "preload.cjs"),
});
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

copyFileSync(path.join(root, "assets/icon.png"), path.join(dist, "icon.png"));
