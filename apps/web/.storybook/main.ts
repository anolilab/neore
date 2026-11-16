import { join } from "node:path";

import type { StorybookConfig } from "@storybook/react-vite";

/**
 * Storybook for the web app, `packages/ui` and `packages/chat-ui`.
 *
 * It builds with its own Vite config (`.storybook/vite.config.ts`), never the app's:
 * `tanstackStart()` and `cloudflare()` there expect a server entry and a Worker.
 * The backend is MSW (`src/storybook/lunora.ts`), so every story is a fixture.
 */
const config: StorybookConfig = {
    addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest", "msw-storybook-addon"],
    core: {
        builder: {
            name: "@storybook/builder-vite",
            options: { viteConfigPath: join(import.meta.dirname, "vite.config.ts") },
        },
        disableTelemetry: true,
    },
    framework: { name: "@storybook/react-vite", options: {} },
    // `mockServiceWorker.js` for MSW.
    staticDirs: [join(import.meta.dirname, "public")],
    stories: ["../src/**/*.stories.@(ts|tsx)", "../../../packages/ui/src/**/*.stories.@(ts|tsx)", "../../../packages/chat-ui/src/**/*.stories.@(ts|tsx)"],
    typescript: { reactDocgen: "react-docgen-typescript" },
};

export default config;
