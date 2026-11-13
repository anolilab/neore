import { join } from "node:path";

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import storybookViteConfig from "./.storybook/vite.config.ts";

/**
 * Every story as a test, in Chromium: it must render without throwing, its `play` function
 * must pass, and axe must find no violation (`a11y.test: "error"` in `.storybook/preview.tsx`).
 *
 * Each story runs once per mode below. `.storybook/preview.tsx` reads `VITE_STORYBOOK_MODE`
 * into its starting globals, so a contrast failure in dark mode or under an accent preset, a
 * layout that throws on a phone, or one that breaks right to left fails like any other. The
 * time zone and locale are pinned, as the clock is (`src/storybook/clock.ts`).
 *
 * Named apart from `vitest.config.ts` so the root workspace glob does not pull it into
 * `pnpm vis run test`.
 */
const DESKTOP = { height: 900, width: 1440 };
const MOBILE = { height: 844, width: 390 };

/**
 * Motion is pinned: timing checks (the sidebar's slide) assume no preference, and the reduced-motion project runs only the stories
 * tagged `reduced-motion`, which check what reduced motion changes.
 */
const MODES = [
    { mode: { theme: "light" }, name: "light", reducedMotion: "no-preference", viewport: DESKTOP },
    { mode: { accent: "violet", theme: "dark" }, name: "dark-violet", reducedMotion: "no-preference", viewport: DESKTOP },
    { mode: { theme: "light" }, name: "mobile", reducedMotion: "no-preference", viewport: MOBILE },
    { mode: { direction: "rtl", theme: "dark" }, name: "rtl", reducedMotion: "no-preference", viewport: DESKTOP },
    { mode: { theme: "light" }, name: "reduced-motion", reducedMotion: "reduce", tags: ["reduced-motion"], viewport: DESKTOP },
] as const;

export default mergeConfig(
    storybookViteConfig,
    defineConfig({
        test: {
            projects: MODES.map((project) => {
                const { mode, name, reducedMotion, viewport } = project;
                const tags = "tags" in project ? { include: [...project.tags] } : undefined;

                return {
                    define: { "import.meta.env.VITE_STORYBOOK_MODE": JSON.stringify(JSON.stringify(mode)) },
                    extends: true,
                    plugins: [storybookTest({ configDir: join(import.meta.dirname, ".storybook"), tags })],
                    test: {
                        // A page story's `play` waits for several loaded queries (up to 5 s each, see `PAGE_WAIT`);
                        // under a loaded machine the 15 s default is not enough for the chat pages.
                        testTimeout: 30_000,
                        browser: {
                            enabled: true,
                            headless: true,
                            instances: [{ browser: "chromium" }],
                            provider: playwright({ contextOptions: { locale: "en-US", reducedMotion, timezoneId: "UTC" } }),
                            viewport,
                        },
                        name: `storybook:${name}`,
                    },
                };
            }),
        },
    }),
);
