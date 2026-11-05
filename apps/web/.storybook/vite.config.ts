import { join } from "node:path";

import { lingui } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import svgr from "vite-plugin-svgr";

const appRoot = join(import.meta.dirname, "..");

/**
 * Fixed origins for `lib/env.ts`. MSW answers every request to them (`src/storybook/handlers.ts`),
 * so nothing here is reached over the network. Vite's `loadEnv` reads prefixed vars from `process.env`.
 */
const STORYBOOK_ENV = {
    VITE_LLM_GATEWAY_URL: "https://gateway.storybook.test",
    VITE_LUNORA_URL: "https://lunora.storybook.test",
    VITE_SITE_URL: "https://app.storybook.test",
} as const;

Object.assign(process.env, STORYBOOK_ENV);

const mock = (file: string): string => join(import.meta.dirname, "mocks", file);

/**
 * Modules that only work inside a TanStack Start server, swapped for `./mocks`. Matched on the
 * RESOLVED path, so `@/lib/...` and relative imports are both caught, and the dependency scan
 * sees the mock too (it would otherwise try to bundle Start's server entry and fail).
 */
const SERVER_MODULES: ReadonlyArray<[suffix: string, replacement: string]> = [
    ["/src/lib/auth/server-functions.ts", mock("server-functions.ts")],
    ["/src/lib/posthog/client-state.ts", mock("posthog-client-state.ts")],
];

const PACKAGE_MOCKS: Readonly<Record<string, string>> = {
    "@tanstack/react-start": mock("react-start.ts"),
    "@tanstack/react-start/server": mock("react-start-server.ts"),
};

const mockServerModules = (): Plugin => {
    return {
        enforce: "pre",
        name: "storybook-mock-server-modules",
        async resolveId(source, importer, options) {
            const packageMock = PACKAGE_MOCKS[source];

            if (packageMock) {
                return packageMock;
            }

            const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
            const match = resolved && SERVER_MODULES.find(([suffix]) => resolved.id.endsWith(suffix));

            return match ? match[1] : resolved;
        },
    };
};

/**
 * Storybook's Vite config. A subset of `../vite.config.ts`: the plugins that turn
 * the source into a page (Lingui, the macro + React Compiler, Tailwind, SVGR),
 * none of the ones that turn it into a Worker (`tanstackStart`, `cloudflare`, mdx).
 * `@storybook/react-vite` adds its own React plugin; this one carries the babel step.
 */
export default defineConfig({
    define: {
        // `lib/env.ts` spreads `process.env` into its runtime env.
        "process.env": "{}",
    },
    optimizeDeps: {
        // Crawl every story up front. Left to discover deps lazily, Vite re-optimizes and
        // reloads mid-run, which fails whatever tests were in flight (the Vitest run in CI).
        entries: [".storybook/preview.tsx", "src/**/*.stories.tsx", "../../packages/ui/src/**/*.stories.tsx", "../../packages/chat-ui/src/**/*.stories.tsx"],
        exclude: ["@lingui/react/macro", "@lingui/core/macro", "@silvia-odwyer/photon"],
        // Reached only from Storybook's own runtime, which the crawl does not enter.
        include: ["axe-core", "msw", "msw/browser", "storybook/test"],
    },
    plugins: [
        mockServerModules(),
        lingui(),
        babel({
            plugins: ["@lingui/babel-plugin-lingui-macro"],
            presets: [reactCompilerPreset({ target: "19" })],
        }),
        tailwindcss(),
        svgr(),
        react(),
    ],
    resolve: {
        alias: {
            "@": join(appRoot, "src"),
            "@ui": join(appRoot, "../../packages/ui/src"),
            "~": join(appRoot, "src"),
        },
        dedupe: ["react", "react-dom", "react/jsx-runtime"],
    },
    root: appRoot,
});
