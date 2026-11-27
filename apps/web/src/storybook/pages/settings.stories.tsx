import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, screen, waitFor } from "storybook/test";

import { SettingsModal } from "@/components/settings/settings-modal";
import { Route as ChatIndexRoute } from "@/routes/(chat)/chat/index";
import { Route as ChatLayoutRoute } from "@/routes/(chat)/route";
import { apiKeyHandlers } from "@/storybook/fixtures/api-keys";
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
 * Settings open in the modal over the page the user is on, here the new chat. A story opens it at one tab through the
 * URL keys a settings link sets (`settings-link.ts`).
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
                lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures()),
            },
        },
    },
    title: "Pages/Settings",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The linked-account (a password login) and session lists the security and account pages read. */
const authListHandlers = () => [
    http.get("*/api/auth/list-accounts", () =>
        HttpResponse.json([
            {
                accountId: "user-pro",
                createdAt: "2026-10-01T00:00:00.000Z",
                id: "account-credential",
                providerId: "credential",
                scopes: [],
                updatedAt: "2026-10-01T00:00:00.000Z",
                userId: "user-pro",
            },
        ]),
    ),
    http.get("*/api/auth/list-sessions", () => HttpResponse.json([])),
];

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

export const ModelFilters: Story = {
    args: openAt("chat-model-filters"),
    play: async () => {
        // The page's words follow the locale toolbar, so the check is on its controls, not on English text.
        await settingsDialog();
        await expect(await screen.findAllByRole("switch", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

export const ApiKeys: Story = {
    args: openAt("auth-api-keys"),
    play: async () => {
        await settingsDialog();
        await expect(await screen.findByText("Laptop CLI", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** Form-bodied cards (change email, change password) with their action footer. */
export const Security: Story = {
    args: openAt("auth-security"),
    parameters: {
        msw: { handlers: { authLists: authListHandlers() } },
    },
    play: async () => {
        const dialog = await settingsDialog();

        await waitFor(() => expect(dialog.querySelector('input[type="password"]')).not.toBeNull(), PAGE_WAIT);
    },
};

/** The account tab: profile form cards, and the destructive delete-account card at the bottom. */
export const Account: Story = {
    args: openAt("auth-account"),
    parameters: {
        msw: { handlers: { authLists: authListHandlers() } },
    },
    play: async () => {
        await settingsDialog();
        await expect(await screen.findAllByRole("textbox", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

/** Toggles, selects and sliders in rows: the first tab. */
export const Customization: Story = {
    args: openAt("app-customization"),
    play: async () => {
        await settingsDialog();
        await expect(await screen.findAllByRole("switch", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

/** The tabs that were pages of their own before settings moved into the modal. */
export const Usage: Story = {
    args: openAt("chat-usage"),
    play: async () => {
        await settingsDialog();
    },
};

export const Connectors: Story = {
    args: openAt("connectors"),
    play: async () => {
        await settingsDialog();
    },
};

export const Devices: Story = {
    args: openAt("chat-devices"),
    play: async () => {
        await settingsDialog();
    },
};

export const Triggers: Story = {
    args: openAt("chat-triggers"),
    play: async () => {
        await settingsDialog();
    },
};
