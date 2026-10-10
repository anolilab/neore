import path from "node:path";

import { crx } from "@crxjs/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import zip from "vite-plugin-zip-pack";

import manifest, { targetBrowser } from "./manifest.config.js";
import pkg from "./package.json" with { type: "json" };
import { SIDEBAR_PATH } from "./src/manifest/build-manifest.ts";

const browser = targetBrowser();
const isFirefox = browser === "firefox";

export default defineConfig({
    build: {
        outDir: isFirefox ? "dist-firefox" : "dist",
        // crxjs discovers pages from `side_panel.default_path` but not from
        // Firefox's `sidebar_action.default_panel`, so name the panel explicitly.
        ...(isFirefox && { rollupOptions: { input: { sidebar: SIDEBAR_PATH } } }),
    },
    // Compile-time, so the Chrome build carries no Firefox sign-in code path and
    // vice versa (`src/lib/target.ts`).
    define: {
        "import.meta.env.VITE_TARGET_BROWSER": JSON.stringify(browser),
    },
    plugins: [
        tailwindcss(),
        // `@neore/chat-ui` is compiled from source and uses Lingui macros, which
        // throw at runtime unless compiled away. `descriptorFields: "message"`
        // keeps each source string in the build — the extension ships no catalog,
        // so the English source text IS the rendered text (see `src/lib/i18n.tsx`).
        babel({
            plugins: [["@lingui/babel-plugin-lingui-macro", { descriptorFields: "message" }]],
        }),
        react(),
        crx({ browser, manifest }),
        // `name` is the scoped package name (`@neore/browser-extension`), and the
        // slash in it was read as a directory — the packer tried to write into a
        // `release/crx-@neore/` that does not exist. Use the unscoped segment.
        // The Firefox zip is what AMO takes: `manifest.json` at the archive root.
        zip({
            inDir: isFirefox ? "dist-firefox" : "dist",
            outDir: "release",
            outFileName: `${isFirefox ? "firefox" : "crx"}-${pkg.name.split("/").pop()}-${pkg.version}.zip`,
        }),
    ],
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "src"),
        },
        // One Lingui instance: chat-ui's `useLingui` must find the provider this
        // app mounts, not a context from a second copy.
        dedupe: ["react", "react-dom", "@lingui/core", "@lingui/react"],
    },
    server: {
        cors: {
            origin: [/chrome-extension:\/\//],
        },
    },
});
