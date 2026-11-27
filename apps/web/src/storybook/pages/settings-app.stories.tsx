import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, waitFor } from "storybook/test";

import { SettingsModal } from "@/components/settings/settings-modal";
import { Route as ChatIndexRoute } from "@/routes/(chat)/chat/index";
import { Route as ChatLayoutRoute } from "@/routes/(chat)/route";
import { apiKeyHandlers } from "@/storybook/fixtures/api-keys";
import { APP_SETTINGS, appSettingsFixtures } from "@/storybook/fixtures/app-settings";
import { chatFixtures } from "@/storybook/fixtures/chat";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// A tab's content waits for the modal's chunk, then its own, then its data; with four browser projects running at once
// that can outlast a few seconds.
const PAGE_WAIT = { timeout: 15_000 } as const;

/**
 * The settings tabs of the app group, each in its populated state: keyboard shortcuts, personalization, system prompt
 * presets, the knowledge base, default models, the model list, model restrictions and notifications.
 */
const meta = {
    args: { levels: [], overlay: SettingsModal, url: "/chat" },
    component: StoryPage,
    parameters: {
        // Axe checks the settings dialog; the page behind it shows through a dimmed backdrop, which skews its contrast, and has stories of its own.
        a11y: { context: { include: ['[role="dialog"]'] } },
        layout: "fullscreen",
        msw: {
            handlers: {
                apiKeys: apiKeyHandlers(),
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(...userFixtures({ settings: APP_SETTINGS }), ...shellFixtures(), ...chatFixtures(), ...appSettingsFixtures()),
            },
        },
    },
    title: "Pages/Settings/App",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

const CHAT_LEVELS = [
    { id: "/(chat)", route: ChatLayoutRoute },
    { path: "chat/", route: ChatIndexRoute },
] as const;

/** The chat with settings open at `tab`. */
const openAt = (tab: string) => {
    return { levels: CHAT_LEVELS, overlay: SettingsModal, url: `/chat?settings=true&settingsTab=${tab}` };
};

/** The dialog is portalled out of the story's canvas. */
const settingsDialog = async () => await screen.findByRole("dialog", undefined, PAGE_WAIT);

/** Sixteen shortcut rows, each with a recorder and a clear button, and the reset and save actions last. */
export const Keyboard: Story = {
    args: openAt("app-keyboard"),
    play: async () => {
        await settingsDialog();
        await expect(await screen.findAllByRole("textbox", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

/** Three text sections, the memory list with a digest, and the replay-onboarding action. */
export const Personalization: Story = {
    args: openAt("chat-personalization"),
    play: async () => {
        await settingsDialog();
        await expect(await screen.findByDisplayValue("Dani", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** Presets as rows, with their model and size. */
export const SystemPrompts: Story = {
    args: openAt("chat-system-prompts"),
    play: async () => {
        await settingsDialog();
        await expect(await screen.findByText("Strict JSON coder", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** A collection picker, the upload zone, and indexed, processing and failed files as rows. */
export const Knowledge: Story = {
    args: openAt("chat-knowledge"),
    play: async () => {
        await settingsDialog();
        await expect(await screen.findByText("Product spec v3.pdf", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** One row per default model, grouped by text, image and video, with the backup models list. */
export const DefaultModels: Story = {
    args: openAt("chat-default-models"),
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures({
                        preferences: {
                            defaultModels: { textToImage: "cf-flux-1-schnell", textToText: "anthropic/claude-sonnet-4.5" },
                        },
                        settings: { ...APP_SETTINGS, backupModels: ["google/gemini-2.5-flash", "cf-kimi-k2.5"] },
                    }),
                    ...shellFixtures(),
                    ...chatFixtures(),
                    ...appSettingsFixtures(),
                ),
            },
        },
    },
    play: async () => {
        await settingsDialog();
        await expect(await screen.findAllByRole("combobox", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

/** Favourite models with nicknames, then every model with its switch. */
export const Models: Story = {
    args: openAt("chat-models"),
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures({
                        preferences: { modelOverrides: { "cf-llama-4-scout": false, "openai/gpt-5": true } },
                        settings: APP_SETTINGS,
                    }),
                    ...shellFixtures(),
                    ...chatFixtures(),
                    ...appSettingsFixtures(),
                ),
            },
        },
    },
    play: async () => {
        await settingsDialog();
        await expect(await screen.findAllByRole("switch", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

/** Region and provider rules set, a hidden lab, a blocked model and one privacy switch on. */
export const ModelFilters: Story = {
    args: openAt("chat-model-filters"),
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures({
                        preferences: {
                            modelFilterRules: {
                                allowedRegions: ["EU"],
                                blockedCreators: ["meta", "xai"],
                                blockedModels: ["llama-4-scout"],
                                blockedProviders: ["groq"],
                                requireZDR: true,
                            },
                        },
                        settings: APP_SETTINGS,
                    }),
                    ...shellFixtures(),
                    ...chatFixtures(),
                    ...appSettingsFixtures(),
                ),
            },
        },
    },
    play: async () => {
        await settingsDialog();
        await expect(await screen.findAllByRole("switch", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

/** The notifications section, at the bottom of Customization: scrolled into view. */
export const Notifications: Story = {
    args: openAt("app-customization"),
    play: async () => {
        const dialog = await settingsDialog();

        await waitFor(async () => {
            const heading = await screen.findByRole("heading", { name: "Notifications" });

            heading.scrollIntoView({ block: "start" });
            await expect(heading).toBeVisible();
        }, PAGE_WAIT);
        await expect(dialog).toBeVisible();
    },
};
