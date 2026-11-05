import { join } from "node:path";

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import storybookViteConfig from "./.storybook/vite.config.ts";

/**
 * Every story as a test, in Chromium: it must render without throwing, its `play` function
 * must pass, and axe must find no violation (`a11y.test: "error"` in `.storybook/preview.tsx`).
 *
 * Each story runs once per appearance below. `.storybook/preview.tsx` reads
 * `VITE_STORYBOOK_APPEARANCE` into its starting globals, so a contrast failure in dark mode or
 * under an accent preset fails like one in light mode.
 *
 * Named apart from `vitest.config.ts` so the root workspace glob does not pull it into
 * `pnpm vis run test`.
 */
const APPEARANCES = ["light", "dark", "dark:violet"] as const;

export default mergeConfig(
    storybookViteConfig,
    defineConfig({
        test: {
            projects: APPEARANCES.map((appearance) => {
                return {
                    define: { "import.meta.env.VITE_STORYBOOK_APPEARANCE": JSON.stringify(appearance) },
                    extends: true,
                    plugins: [storybookTest({ configDir: join(import.meta.dirname, ".storybook") })],
                    test: {
                        browser: {
                            enabled: true,
                            headless: true,
                            instances: [{ browser: "chromium" }],
                            provider: playwright(),
                        },
                        name: `storybook:${appearance}`,
                    },
                };
            }),
        },
    }),
);
