import { defineManifest } from "@crxjs/vite-plugin";
import { loadEnv } from "vite";

import pkg from "./package.json" with { type: "json" };
import type { TargetBrowser } from "./src/manifest/build-manifest.ts";
import { buildManifest } from "./src/manifest/build-manifest.ts";

const DEFAULT_APP_URL = "https://neore.ai";

/** Which browser this build is for: `TARGET_BROWSER=firefox` (the `build:firefox` script), else Chrome. */
export const targetBrowser = (): TargetBrowser => (process.env.TARGET_BROWSER === "firefox" ? "firefox" : "chrome");

export default defineManifest(({ command, mode }) => {
    const env = loadEnv(mode, process.cwd(), "VITE_");

    return buildManifest({
        appUrl: env.VITE_APP_URL || DEFAULT_APP_URL,
        browser: targetBrowser(),
        command,
        description: "Chat with Anole from a side panel — ask about the page you are reading, or explain, summarize and translate a selection.",
        gatewayUrl: env.VITE_LLM_GATEWAY_URL,
        lunoraUrl: env.VITE_LUNORA_URL,
        name: "Anole Chat",
        version: pkg.version,
    });
});
