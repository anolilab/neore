import { join } from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import { lingui } from "@lingui/vite-plugin";
import { VitePluginWatchWorkspace } from "@prosopo/vite-plugin-watch-workspace";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { devToolbar } from "@visulima/dev-toolbar/vite";
import viteErrorOverlay from "@visulima/vite-overlay";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import mdxPlugin from "fumadocs-mdx/vite";
import Unfonts from "unplugin-fonts/vite";
import { purgePolyfills } from "unplugin-purge-polyfills";
import type { UserConfig } from "vite";
import { defineConfig, loadEnv } from "vite";
import { ViteImageOptimizer } from "vite-plugin-image-optimizer";
import svgr from "vite-plugin-svgr";
import wasm from "vite-plugin-wasm";

// Manual groups hold ONLY what every page loads anyway, for cache stability.
// A group is emitted as one chunk and swallows the dependencies of what it
// matches, so anything lazy that shares a group with anything eager becomes
// eager. That has bitten here repeatedly: `@streamdown/math` in the markdown
// group put KaTeX on every chat page; a `vendor-diagrams` group put Mermaid back;
// `jspdf`/`pptxgenjs`/`jszip` cost every chat page 749.7KB. Measured 2026-09-25,
// the remaining lazy-intended groups still cost every page: `vendor-ui` held all
// ~1,600 lucide icons (the `lucide-react/dynamic` import map made each one a
// member), `vendor-markdown` swallowed `tailwind-merge` (which every `cn()` call
// needs) and so loaded streamdown/shiki/parse5 on the landing page, `vendor-ai`
// swallowed `zod` (needed by `lib/env.ts`) and loaded the AI SDK with it,
// `vendor-editor-cm` put CodeMirror on the landing and chat pages, and the form
// and virtual members of `vendor-tanstack` shipped TanStack Form/Virtual to pages
// using neither. Left ungrouped,
// rolldown splits each module by the set of chunks that import it, so a new
// group needs a measurement first (see the per-route closure in `.vite/manifest.json`
// with `vite build --manifest`).
const REACT_CHUNK_RE = /\/node_modules\/(react|react-dom|react-compiler-runtime|scheduler|use-sync-external-store)\//;
const TANSTACK_CHUNK_RE = /\/node_modules\/@tanstack\/(react-query|react-router)\//;
const LUNORA_CHUNK_RE = /\/node_modules\/@lunora\//;
// Kept although it ships every Base UI component to every page: ungrouped, the
// chat route (which uses nearly all of them) paid more for ~50 extra chunks
// (1,477 vs 1,441KB gzip) than the entry saved (93KB).
const BASE_UI_CHUNK_RE = /\/node_modules\/@base-ui\/react\//;
const LLM_GATEWAY_PATH_RE = /^\/llm-gateway/;
const LUNORA_HTTP_PATH_RE = /^\/lunora-http/;

export default defineConfig(async ({ mode }) => {
    const environment = loadEnv(mode, process.cwd());
    const isDevelopment = mode === "development";
    const sourceConfig = await import("./source.config.ts");

    const config: UserConfig = {
        build: {
            cssMinify: "lightningcss",
            // `scripts/generate-sw.mjs` precaches the app shell from the client
            // manifest, then deletes it so `.vite/` is never served.
            manifest: true,
            modulePreload: { polyfill: false },
            reportCompressedSize: false,
            rolldownOptions: {
                output: {
                    codeSplitting: {
                        groups: [
                            {
                                name: "vendor-react",
                                priority: 100,
                                test: REACT_CHUNK_RE,
                            },
                            {
                                name: "vendor-tanstack",
                                priority: 99,
                                test: TANSTACK_CHUNK_RE,
                            },
                            {
                                name: "vendor-base-ui",
                                priority: 92,
                                test: BASE_UI_CHUNK_RE,
                            },
                            {
                                name: "vendor-lunora",
                                priority: 93,
                                test: LUNORA_CHUNK_RE,
                            },
                        ],
                    },
                },
                treeshake: { moduleSideEffects: "no-external" },
            },
            sourcemap: "hidden",
            target: "es2022",
        },
        css: {
            transformer: "lightningcss",
        },
        optimizeDeps: {
            // Photon ships a wasm-pack ESM bundle that vite-plugin-wasm rewrites
            // at build time. Pre-bundling it via esbuild breaks the rewrite and
            // causes the WASM module to load as a string URL instead of a real
            // WebAssembly.Module — keep it out of optimizeDeps.
            exclude: ["posthog-node", "@lingui/react/macro", "@lingui/core/macro", "@silvia-odwyer/photon"],
            include: [
                "react",
                "react-dom",
                "react/jsx-runtime",
                "react-compiler-runtime",
                "@lunora/react",
                "@tanstack/react-query",
                "@tanstack/react-router",
                "zustand",
                "lucide-react",
                "motion/react",
                "date-fns",
                "zod",
                "@codemirror/lang-javascript",
                "@codemirror/lang-python",
                "@codemirror/lang-markdown",
                "@codemirror/lang-json",
                "@codemirror/lang-css",
                "@codemirror/lang-html",
                "@base-ui/react/accordion",
                "@base-ui/react/alert-dialog",
                "@base-ui/react/autocomplete",
                "@base-ui/react/avatar",
                "@base-ui/react/button",
                "@base-ui/react/checkbox",
                "@base-ui/react/collapsible",
                "@base-ui/react/combobox",
                "@base-ui/react/context-menu",
                "@base-ui/react/dialog",
                "@base-ui/react/field",
                "@base-ui/react/input",
                "@base-ui/react/menu",
                "@base-ui/react/menubar",
                "@base-ui/react/merge-props",
                "@base-ui/react/navigation-menu",
                "@base-ui/react/popover",
                "@base-ui/react/preview-card",
                "@base-ui/react/progress",
                "@base-ui/react/radio",
                "@base-ui/react/radio-group",
                "@base-ui/react/scroll-area",
                "@base-ui/react/select",
                "@base-ui/react/separator",
                "@base-ui/react/slider",
                "@base-ui/react/switch",
                "@base-ui/react/tabs",
                "@base-ui/react/toggle",
                "@base-ui/react/toggle-group",
                "@base-ui/react/tooltip",
                "@base-ui/react/use-render",
                "@dnd-kit/core",
                "@dnd-kit/sortable",
                "@dnd-kit/utilities",
            ],
        },
        plugins: [
            // Enables ESM `import * as wasm from "*.wasm"` syntax used by
            // wasm-pack output (e.g. @silvia-odwyer/photon).
            wasm(),
            mdxPlugin(sourceConfig, { updateViteConfig: false }),
            purgePolyfills.vite({}),
            isDevelopment && viteErrorOverlay({ showBalloonButton: false }),
            isDevelopment &&
                devToolbar({
                    apps: {
                        a11y: true,
                        assets: true,
                        performance: true,
                        seo: true,
                        settings: true,
                        tailwind: true,
                        viteConfig: true,
                    },
                    placement: "bottom-center",
                }),
            !isDevelopment &&
                ViteImageOptimizer({
                    avif: { lossless: false, quality: 70 },
                    jpeg: { quality: 75 },
                    jpg: { quality: 75 },
                    png: { quality: 80 },
                    svg: {
                        multipass: true,
                        plugins: [
                            {
                                name: "preset-default",
                                params: {
                                    overrides: {
                                        cleanupNumericValues: false,
                                    },
                                },
                            },
                            // removeViewBox is not part of preset-default; keep it disabled (omit = don't run)

                            "sortAttrs",
                        ],
                    },
                    webp: { lossless: false, quality: 80 },
                }),
            cloudflare({ viteEnvironment: { name: "ssr" } }),
            isDevelopment &&
                VitePluginWatchWorkspace({
                    currentPackage: ".",
                    fileTypes: ["ts", "tsx", "js", "jsx"],
                    format: "esm",
                    ignorePaths: ["node_modules", "dist"],
                    workspaceRoot: "../..",
                }),
            lingui(),
            babel({
                plugins: ["@lingui/babel-plugin-lingui-macro"],
                presets: [reactCompilerPreset({ target: "19" })],
            }),
            Unfonts({
                custom: {
                    display: "swap",
                    families: [
                        {
                            name: "Geist Pixel Square",
                            src: "./node_modules/geist/dist/fonts/geist-pixel/GeistPixel-Square.woff2",
                        },
                        {
                            name: "Geist Pixel Grid",
                            src: "./node_modules/geist/dist/fonts/geist-pixel/GeistPixel-Grid.woff2",
                        },
                        {
                            name: "Geist Pixel Circle",
                            src: "./node_modules/geist/dist/fonts/geist-pixel/GeistPixel-Circle.woff2",
                        },
                        {
                            name: "Geist Pixel Triangle",
                            src: "./node_modules/geist/dist/fonts/geist-pixel/GeistPixel-Triangle.woff2",
                        },
                        {
                            name: "Geist Pixel Line",
                            src: "./node_modules/geist/dist/fonts/geist-pixel/GeistPixel-Line.woff2",
                        },
                    ],
                    preload: true,
                },
                fontsource: {
                    families: [
                        {
                            name: "Geist",
                            variable: { wght: true },
                        },
                        {
                            name: "Geist Mono",
                            variable: { wght: true },
                        },
                    ],
                },
            }),
            tailwindcss(),
            svgr(),
            tanstackStart(),
            react(),
        ],
        resolve: {
            alias: {
                mermaid: join(import.meta.dirname, "node_modules/mermaid/dist/mermaid.esm.min.mjs"),
            },
            // Deduplicate React to prevent multiple instances when fumadocs packages are bundled.
            // Without this, packages in ssr.noExternal can end up with their own React copy,
            // causing hook errors like "Cannot read properties of null (reading 'useMemo')".
            dedupe: ["react", "react-dom", "react/jsx-runtime"],
            tsconfigPaths: true,
        },
        server: {
            proxy: {
                "/llm-gateway": {
                    changeOrigin: true,
                    configure: (proxy, _options) => {
                        proxy.on("error", (error, _request, _res) => {
                            console.log("llm-gateway proxy error", error);
                        });
                    },
                    rewrite: (path) => path.replace(LLM_GATEWAY_PATH_RE, ""),
                    secure: false,
                    target: environment.LLM_GATEWAY_DEV_TARGET ?? "http://localhost:8787",
                    ws: true,
                },
                "/lunora-http": {
                    changeOrigin: true,
                    configure: (proxy, _options) => {
                        proxy.on("error", (error, _request, _res) => {
                            console.log("proxy error", error);
                        });
                    },
                    cookieDomainRewrite: "",
                    cookiePathRewrite: "/",
                    rewrite: (path) => path.replace(LUNORA_HTTP_PATH_RE, ""),
                    secure: false,
                    target: environment.VITE_LUNORA_URL,
                },
            },
            // `clientFiles` is deliberately absent, and adding it back hangs the
            // whole app. Warmup issues a transform for each listed file as soon
            // as the server is ready; a client file imports an optimized dep, so
            // its transform parks on the client dep optimizer. That optimizer
            // only commits `deps_temp_<hash>` -> `deps` once the client static
            // import crawl goes idle — which cannot happen while the warmup
            // transform is parked on it. Deadlock: the debug log
            // (`DEBUG=vite:deps`) shows "Dependencies bundled" with no following
            // "static imports crawl ended" / "dependencies optimized" for
            // (client), and `node_modules/.vite/` is left holding `deps_temp_*`
            // with no `deps` and no `_metadata.json`. Every browser request for
            // /node_modules/.vite/deps/*.js then blocks forever, so SSR paints
            // and hydration never starts — the page loads "long" and stays dead.
            // ONE entry is enough to trigger it; it is not a size or glob
            // problem. `ssrFiles` is safe because the SSR optimizer has already
            // committed by the time warmup runs.
            warmup: {
                ssrFiles: ["./src/routes/__root.tsx", "./src/routes/(chat)/chat/$threadId.tsx"],
            },
        },
        ssr: {
            // Note: ssr.external is not compatible with Cloudflare Workers
            // All dependencies are bundled for Workers deployment
            // Add streamdown to noExternal to prevent CSS loading errors in SSR
            // See: https://streamdown.ai/docs/faq#why-do-i-get-a-css-loading-error-when-using-streamdown-with-vite-ssr
            // Note: fumadocs-core, fumadocs-ui, @fumadocs/base-ui must NOT be listed here.
            // Putting them in noExternal creates separate React module scopes (each with their own
            // ReactCurrentDispatcher singleton), causing "Cannot read properties of null (reading
            // 'useMemo')" in FrameworkProvider. Cloudflare Workers bundles everything via the
            // cloudflare() plugin — these packages are already bundled correctly without this list.
            noExternal: ["streamdown"],
            optimizeDeps: {
                exclude: ["@lingui/react/macro", "@lingui/core/macro", "@silvia-odwyer/photon"],
                include: [
                    "react",
                    "react-dom",
                    "react-dom/server",
                    "react/jsx-runtime",
                    "zod",
                    "lucide-react",
                    "lucide-react/dynamic",
                    "@tanstack/react-form",
                    "@tanstack/react-virtual",
                    "@tanstack/react-router",
                    "@tanstack/react-query",
                    "@base-ui/react/accordion",
                    "@base-ui/react/alert-dialog",
                    "@base-ui/react/autocomplete",
                    "@base-ui/react/avatar",
                    "@base-ui/react/button",
                    "@base-ui/react/checkbox",
                    "@base-ui/react/collapsible",
                    "@base-ui/react/combobox",
                    "@base-ui/react/context-menu",
                    "@base-ui/react/dialog",
                    "@base-ui/react/field",
                    "@base-ui/react/input",
                    "@base-ui/react/menu",
                    "@base-ui/react/menubar",
                    "@base-ui/react/merge-props",
                    "@base-ui/react/navigation-menu",
                    "@base-ui/react/popover",
                    "@base-ui/react/preview-card",
                    "@base-ui/react/progress",
                    "@base-ui/react/radio",
                    "@base-ui/react/radio-group",
                    "@base-ui/react/scroll-area",
                    "@base-ui/react/select",
                    "@base-ui/react/separator",
                    "@base-ui/react/slider",
                    "@base-ui/react/switch",
                    "@base-ui/react/tabs",
                    "@base-ui/react/toggle",
                    "@base-ui/react/toggle-group",
                    "@base-ui/react/tooltip",
                    "@base-ui/react/use-render",
                    "@dnd-kit/core",
                    "@dnd-kit/sortable",
                    "@dnd-kit/utilities",
                    "motion/react",
                    "@lunora/react",
                    "zustand",
                ],
            },
        },
    };

    return config;
});
