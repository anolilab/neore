import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen } from "storybook/test";

import { SettingsModal } from "@/components/settings/settings-modal";
import { Route as ChatIndexRoute } from "@/routes/(chat)/chat/index";
import { Route as ChatLayoutRoute } from "@/routes/(chat)/route";
import { ago, DAY } from "@/storybook/clock";
import { agentSettingsFixtures, triggerFixtures } from "@/storybook/fixtures/agent-settings";
import { apiKeyHandlers } from "@/storybook/fixtures/api-keys";
import { chatFixtures } from "@/storybook/fixtures/chat";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { lunora, lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// A tab's content waits for the modal's chunk, then its own, then its data; with four browser projects running at once
// that can outlast a few seconds.
const PAGE_WAIT = { timeout: 15_000 } as const;

/** Settings open in the modal over the new chat; the tabs here are the ones that configure what the agent may do. */
const meta = {
    args: { levels: [], overlay: SettingsModal, url: "/chat" },
    component: StoryPage,
    parameters: {
        layout: "fullscreen",
        msw: {
            handlers: {
                apiKeys: apiKeyHandlers(),
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(...shellFixtures(), ...chatFixtures(), ...agentSettingsFixtures()),
            },
        },
    },
    title: "Pages/Settings/Agent",
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

const BOTS = [
    {
        _creationTime: ago(9 * DAY),
        _id: "bot-docs",
        computerEnabled: false,
        createdAt: ago(9 * DAY),
        description: "Answers from the docs",
        instructions: "Be brief and cite the page.",
        model: "anthropic/claude-sonnet-4.5",
        name: "Docs helper",
        toolSelection: { allow: ["webSearch"], exclude: [] },
        updatedAt: ago(DAY),
        userId: "user-1",
    },
    {
        _creationTime: ago(4 * DAY),
        _id: "bot-ops",
        computerEnabled: true,
        createdAt: ago(4 * DAY),
        description: "Watches the deploys",
        instructions: "Report failures first.",
        model: "anthropic/claude-sonnet-4.5",
        name: "Ops watcher",
        permissionMode: "supervised",
        updatedAt: ago(DAY),
        userId: "user-1",
    },
];

/** Switches and a choice of how the agent's browser clicks: the agent's modules. */
export const Agent: Story = {
    args: openAt("chat-agent"),
    play: async () => {
        await settingsDialog();
        await expect(await screen.findAllByRole("switch", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

/** Bots in a list, with the form that makes a new one. */
export const Bots: Story = {
    args: openAt("chat-bots"),
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...shellFixtures(),
                    ...chatFixtures(),
                    ...agentSettingsFixtures(),
                    lunora(api.bots.functions.listBots, BOTS as never),
                    lunora(api.connectors.user_connectors.listConnectorCatalog, []),
                    lunora(api.devices.functions.listDevices, []),
                ),
            },
        },
    },
    play: async () => {
        await settingsDialog();
        await expect(await screen.findByText("Docs helper", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** A schedule, a webhook with a failed run and a disabled trigger. */
export const Triggers: Story = {
    args: openAt("chat-triggers"),
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...shellFixtures(), ...chatFixtures(), ...triggerFixtures()) } },
    },
    play: async () => {
        await settingsDialog();
        await expect(await screen.findByText("Daily inbox summary", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** Configured servers, then the registry (shown from the popular list here, as when the registry is unreachable). */
export const McpServers: Story = {
    args: openAt("chat-mcp"),
    play: async () => {
        await settingsDialog();
        await expect(await screen.findByText("Linear", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** Auto / Ask / Off per tool, a time-boxed allow and the MCP servers' tools. */
export const ToolPermissions: Story = {
    args: openAt("chat-tools"),
    play: async () => {
        await settingsDialog();
        await expect(await screen.findByText("webSearch", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** One model and one delegation mode per kind of work. */
export const SubAgentRoles: Story = {
    args: openAt("chat-sub-agent-roles"),
    play: async () => {
        await settingsDialog();
        await expect(await screen.findAllByRole("textbox", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

/** Provider keys: some stored, most not. */
export const ProviderApiKeys: Story = {
    args: openAt("chat-api-keys"),
    play: async () => {
        await settingsDialog();
        await expect(await screen.findAllByText("Configured", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};
