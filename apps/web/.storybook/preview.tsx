import "./preview.css";

import type { Decorator, Preview, StoryContext } from "@storybook/react-vite";
import { mswLoader } from "msw-storybook-addon/csf3";
import { useEffect } from "react";

import { ACCENT_IDS } from "@/features/appearance/lib/accent-presets";
import { locales } from "@/lib/intl/shared";
import { lunoraHandlers, resetLunoraAnswers } from "@/storybook/lunora";
import { AppProviders, loadStoryLocale, settleSession, StoryRouter } from "@/storybook/providers";
import type { Persona } from "@/storybook/session";
import { setActivePersona } from "@/storybook/session";

// Starts the mock backend; this module waits for it before its body runs.
import { worker } from "./msw";

type Theme = "dark" | "light";

/**
 * Where the toolbar starts: `light` in Storybook, and one per Vitest project in CI
 * (`vitest.storybook.config.ts`), written `<theme>` or `<theme>:<accent>`.
 */
const [initialTheme = "light", initialAccent = "default"] = (import.meta.env.VITE_STORYBOOK_APPEARANCE ?? "light").split(":", 2);

/** `class="dark"` and `data-accent` on `<html>`, as `AppearanceSync` and the boot scripts set them in the app. */
const DocumentAppearance = ({ accent, theme }: { accent: string; theme: Theme }) => {
    useEffect(() => {
        const root = document.documentElement;

        root.classList.toggle("dark", theme === "dark");
        root.style.colorScheme = theme;

        if (accent === "default") {
            delete root.dataset.accent;
        } else {
            root.dataset.accent = accent;
        }
    }, [theme, accent]);

    return null;
};

const withAppearance: Decorator = (Story, context) => (
    <>
        <DocumentAppearance accent={context.globals.accent as string} theme={context.globals.theme as Theme} />
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
    decorators: [withApp, withAppearance],
    globalTypes: {
        accent: {
            description: "Accent colour preset (data-accent)",
            toolbar: { dynamicTitle: true, icon: "paintbrush", items: [...ACCENT_IDS], title: "Accent" },
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
    initialGlobals: { accent: initialAccent, locale: "en", persona: "pro", theme: initialTheme },
    loaders: [
        async (context) => {
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
        msw: {
            // Named groups, so a story replaces one (`handlers: { lunora: lunoraHandlers(...) }`)
            // and keeps the others.
            handlers: { lunora: lunoraHandlers() },
        },
    },
    tags: ["autodocs"],
};

export default preview;
