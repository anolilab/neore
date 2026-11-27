import { ConsentProvider, local } from "@c15t/react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";

import { SettingsModal } from "@/components/settings/settings-modal";
import { Route as ChatIndexRoute } from "@/routes/(chat)/chat/index";
import { Route as ChatLayoutRoute } from "@/routes/(chat)/route";
import {
    authListHandlers,
    billingFixtures,
    connectorFixtures,
    deviceFixtures,
    messengerFixtures,
    organizationFixtures,
    organizationHandlers,
    privacyFixtures,
    usageFixtures,
} from "@/storybook/fixtures/account";
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
                authLists: authListHandlers(),
                lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures()),
            },
        },
    },
    title: "Pages/Settings/Account",
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

export const Devices: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...deviceFixtures()) } } },
    args: openAt("chat-devices"),
    play: async () => {
        await settingsDialog();
    },
};

export const Usage: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...usageFixtures()) } } },
    args: openAt("chat-usage"),
    play: async () => {
        await settingsDialog();
    },
};

export const Connectors: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...connectorFixtures()) } } },
    args: openAt("connectors"),
    play: async () => {
        await settingsDialog();
    },
};

export const Messenger: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...messengerFixtures()) } } },
    args: openAt("connectors-messenger"),
    play: async () => {
        await settingsDialog();
    },
};

export const Account: Story = {
    args: openAt("auth-account"),
    play: async () => {
        await settingsDialog();
    },
};

export const Security: Story = {
    args: openAt("auth-security"),
    play: async () => {
        await settingsDialog();
    },
};

export const ApiKeys: Story = {
    args: openAt("auth-api-keys"),
    play: async () => {
        await settingsDialog();
    },
};

export const Organizations: Story = {
    parameters: {
        persona: "org-member",
        msw: {
            handlers: {
                organization: organizationHandlers(),
                lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...organizationFixtures()),
            },
        },
    },
    args: openAt("auth-organizations"),
    play: async () => {
        await settingsDialog();
    },
};

export const Organization: Story = {
    parameters: {
        persona: "org-member",
        msw: {
            handlers: {
                organization: organizationHandlers(),
                lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...organizationFixtures()),
            },
        },
    },
    args: openAt("auth-organization"),
    play: async () => {
        await settingsDialog();
    },
};

export const Members: Story = {
    parameters: {
        persona: "org-member",
        msw: {
            handlers: {
                organization: organizationHandlers(),
                lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...organizationFixtures()),
            },
        },
    },
    args: openAt("auth-members"),
    play: async () => {
        await settingsDialog();
    },
};

export const Teams: Story = {
    parameters: {
        persona: "org-member",
        msw: {
            handlers: {
                organization: organizationHandlers(),
                lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...organizationFixtures()),
            },
        },
    },
    args: openAt("auth-teams"),
    play: async () => {
        await settingsDialog();
    },
};

export const Billing: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...billingFixtures()) } } },
    args: openAt("auth-billing"),
    play: async () => {
        await settingsDialog();
    },
};

/** The organization's billing editor, shown to an owner: contact e-mail, allowed models and Save. */
export const BillingOwner: Story = {
    parameters: {
        persona: "org-member",
        msw: {
            handlers: {
                organization: organizationHandlers(),
                lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...organizationFixtures({ billingOwner: true })),
            },
        },
    },
    args: openAt("auth-billing"),
    play: async () => {
        await settingsDialog();
    },
};

/** The consent preferences button opens the consent dialog, which the app root mounts under its provider; the story supplies one. */
export const Privacy: Story = {
    decorators: [
        (Story) => (
            <ConsentProvider options={{ consentCategories: ["necessary", "functionality", "measurement", "marketing"], mode: local() }}>
                <Story />
            </ConsentProvider>
        ),
    ],
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...privacyFixtures()) } } },
    args: openAt("privacy"),
    play: async () => {
        await settingsDialog();
    },
};
