import "./preview.css";

import type { Decorator, Preview, StoryContext } from "@storybook/react-vite";
import { mswLoader } from "msw-storybook-addon/csf3";
import { useEffect } from "react";

import { ACCENT_IDS } from "@/features/appearance/lib/accent-presets";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";
import { locales } from "@/lib/intl/shared";
import { pinClock, STORY_NOW } from "@/storybook/clock";
import { lunoraHandlers, lunoraIdle, resetLunoraAnswers } from "@/storybook/lunora";
import type { StoryConnection } from "@/storybook/providers";
import { AppProviders, loadStoryLocale, settleSession, StoryRouter } from "@/storybook/providers";
import type { Persona } from "@/storybook/session";
import { setActivePersona } from "@/storybook/session";

// Starts the mock backend; this module waits for it before its body runs.
import { worker } from "./msw";

type Theme = "dark" | "light";
type Direction = "ltr" | "rtl";

interface Mode {
    accent?: string;
    direction?: Direction;
    theme?: Theme;
}

/**
 * Where the toolbar starts: light, LTR and the default accent in Storybook, and one mode per
 * Vitest project in CI (`vitest.storybook.config.ts`), passed as JSON.
 */
const MODE = JSON.parse(import.meta.env.VITE_STORYBOOK_MODE ?? "{}") as Mode;

/**
 * `class="dark"`, `data-accent` and `dir` on `<html>`, as `AppearanceSync`, the boot scripts and
 * the root route set them in the app.
 */
const DocumentAppearance = ({ accent, direction, theme }: { accent: string; direction: Direction; theme: Theme }) => {
    useEffect(() => {
        const root = document.documentElement;

        root.classList.toggle("dark", theme === "dark");
        root.style.colorScheme = theme;
        root.dir = direction;
        useUIStateStore.setState((state) => {
            return { layout: { ...state.layout, direction } };
        });

        if (accent === "default") {
            delete root.dataset.accent;
        } else {
            root.dataset.accent = accent;
        }
    }, [theme, accent, direction]);

    return null;
};

const withAppearance: Decorator = (Story, context) => (
    <>
        <DocumentAppearance
            accent={context.globals.accent as string}
            direction={context.globals.direction as Direction}
            theme={context.globals.theme as Theme}
        />
        <Story />
    </>
);

const NO_FLAGS: string[] = [];

const personaOf = (context: Pick<StoryContext, "globals" | "parameters">): Persona => (context.parameters.persona ?? context.globals.persona) as Persona;

const withApp: Decorator = (Story, context) => {
    const persona = personaOf(context);
    const path = (context.parameters.route as string | undefined) ?? "/";

    return (
        // The router is outermost: the auth UI provider reads search params.
        <StoryRouter path={path}>
            <AppProviders
                connection={(context.parameters.connection as StoryConnection | undefined) ?? "connected"}
                direction={context.globals.direction as Direction}
                featureFlags={(context.parameters.featureFlags as string[] | undefined) ?? NO_FLAGS}
                persona={persona}
                theme={context.globals.theme as Theme}
            >
                <Story />
            </AppProviders>
        </StoryRouter>
    );
};

const preview: Preview = {
    // After the story's own `play`: let the mock backend go quiet, so axe (an `afterEach` of
    // addon-a11y) checks the page with its data rather than its loading state.
    afterEach: async () => {
        await lunoraIdle();
    },
    decorators: [withApp, withAppearance],
    globalTypes: {
        accent: {
            description: "Accent colour preset (data-accent)",
            toolbar: { dynamicTitle: true, icon: "paintbrush", items: [...ACCENT_IDS], title: "Accent" },
        },
        direction: {
            description: "Text direction",
            toolbar: {
                dynamicTitle: true,
                icon: "transfer",
                items: [
                    { title: "Left to right", value: "ltr" },
                    { title: "Right to left", value: "rtl" },
                ],
                title: "Direction",
            },
        },
        locale: {
            description: "Interface language",
            toolbar: { dynamicTitle: true, icon: "globe", items: Object.keys(locales), title: "Locale" },
        },
        persona: {
            description: "Who is signed in (a story's `parameters.persona` wins)",
            toolbar: {
                dynamicTitle: true,
                icon: "user",
                items: [
                    { title: "Pro user", value: "pro" },
                    { title: "Free user", value: "free" },
                    { title: "Guest", value: "guest" },
                    { title: "Admin", value: "admin" },
                    { title: "Organization member", value: "org-member" },
                    { title: "Signed out", value: "signed-out" },
                ],
                title: "Persona",
            },
        },
        theme: {
            description: "Light or dark mode",
            toolbar: { dynamicTitle: true, icon: "mirror", items: ["light", "dark"], title: "Theme" },
        },
    },
    initialGlobals: {
        accent: MODE.accent ?? "default",
        direction: MODE.direction ?? "ltr",
        locale: "en",
        persona: "pro",
        theme: MODE.theme ?? "light",
        // Storybook's built-in viewport tool; CI's mobile project sizes the page itself.
        viewport: { isRotated: false, value: undefined },
    },
    loaders: [
        async (context) => {
            // A story that needs another "now" sets `parameters.now` (a timestamp).
            pinClock((context.parameters.now as number | undefined) ?? STORY_NOW);
            setActivePersona(personaOf(context));
            resetLunoraAnswers();
            await loadStoryLocale(context.globals.locale as string);
        },
        mswLoader(async () => worker),
        async (context) => {
            await settleSession(personaOf(context));
        },
    ],
    parameters: {
        a11y: {
            // An axe violation fails the story in the Vitest run (and CI). A story that cannot meet
            // that yet sets `a11y: { test: "todo" }` and says why.
            test: "error",
        },
        controls: { expanded: true, matchers: { color: /(background|color)$/i, date: /Date$/i } },
        layout: "centered",
        viewport: {
            options: {
                desktop: { name: "Desktop", styles: { height: "900px", width: "1440px" }, type: "desktop" },
                mobile: { name: "Mobile (iPhone 15)", styles: { height: "844px", width: "390px" }, type: "mobile" },
                tablet: { name: "Tablet", styles: { height: "1024px", width: "768px" }, type: "tablet" },
            },
        },
        msw: {
            // Named groups, so a story replaces one (`handlers: { lunora: lunoraHandlers(...) }`)
            // and keeps the others.
            handlers: { lunora: lunoraHandlers() },
        },
    },
    tags: ["autodocs"],
};

export default preview;
