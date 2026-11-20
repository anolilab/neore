import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { ago, DAY } from "@/storybook/clock";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraAnswered, lunoraError, lunoraHandlers } from "@/storybook/lunora";

import BotsSettings from "./bots-settings";

/** The docs server's stable key: the bot's selectors name it by address, and the lists show its name. */
const DOCS = "mcp=https%3A%2F%2Fdocs.example%2Fmcp";

const BOT = {
    _creationTime: ago(2 * DAY),
    _id: "bot-1",
    computerEnabled: false,
    createdAt: ago(2 * DAY),
    description: "Answers from the docs",
    instructions: "Be brief.",
    model: "gpt-4o",
    name: "Docs helper",
    toolSelection: { allow: ["webSearch", `${DOCS}:*`], exclude: [`${DOCS}:delete`] },
    updatedAt: ago(DAY),
    userId: "user-1",
};

const botFixtures = () => [
    ...userFixtures({ preferences: { mcpServers: [{ enabled: true, name: "docs", protocol: "http", url: "https://docs.example/mcp" }] } }),
    lunora(api.bots.functions.listBots, [BOT]),
    lunora(api.connectors.user_connectors.listConnectorCatalog, []),
    lunora(api.devices.functions.listDevices, []),
    lunora(api.chat.tool_permissions.getToolPermissionSettings, {
        autoApproveLowRisk: false,
        builtIn: [
            { available: true, category: "search", defaultMode: "auto", key: "builtin:webSearch", name: "webSearch" },
            { available: true, category: "utility", defaultMode: "auto", key: "builtin:dateTime", name: "dateTime" },
        ],
        grants: {},
        lowRiskTrustedServers: [],
        overrides: {},
    }),
];

const meta = {
    component: BotsSettings,
    decorators: [
        (Story) => (
            <div className="w-[48rem] max-w-full">
                <Story />
            </div>
        ),
    ],
    parameters: {
        layout: "padded",
        msw: { handlers: { gateway: gatewayModelsHandler(), lunora: lunoraHandlers(...botFixtures()) } },
    },
    title: "Settings/Bots",
} satisfies Meta<typeof BotsSettings>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A bot with a custom tool pick; the new-bot form starts on all tools and opens the lists under Custom. */
export const CustomTools: Story = {
    play: async ({ canvas }) => {
        await lunoraAnswered(api.bots.functions.listBots);
        await expect(await canvas.findByText("Custom tools")).toBeVisible();

        await userEvent.click(canvas.getByRole("radio", { name: "Custom" }));
        await userEvent.click(canvas.getByRole("switch", { name: "Only listed tools" }));
        await userEvent.type(canvas.getByRole("combobox", { name: "Allowed tools" }), "webSearch");
        await userEvent.click(canvas.getAllByRole("button", { name: "Add" })[0]!);

        await expect(canvas.getByRole("button", { name: "Remove webSearch" })).toBeVisible();
    },
};

/** A save the server refuses: the dialog keeps the unsaved pick and the bot keeps its custom tools. */
export const SaveFails: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...botFixtures(), lunoraError(api.bots.functions.updateBot, "INTERNAL_ERROR", "Save failed", 500)),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.bots.functions.listBots);
        await userEvent.click(await canvas.findByRole("button", { name: "Tools for Docs helper" }));

        const dialog = await screen.findByRole("dialog");

        // The dialog opens with an animation (a sheet on a phone).
        await waitFor(async () => await expect(within(dialog).getByRole("button", { name: "Remove docs:*" })).toBeVisible());
        await userEvent.click(within(dialog).getByRole("radio", { name: "All tools" }));
        await userEvent.click(within(dialog).getByRole("button", { name: "Save tools" }));

        await waitFor(async () => await expect(await screen.findByText("Could not save the bot's tools. Its tools are unchanged.")).toBeVisible());
        await expect(screen.getByRole("dialog")).toBeVisible();
        await expect(canvas.getByText("Custom tools")).toBeVisible();
    },
};

/** The patches the save below sent. */
const savedPatches: unknown[] = [];

/** A name typed into a list but never added with the button still goes into the save; a server typed by name is saved by its key. */
export const SavesTypedName: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...botFixtures(),
                    lunora(api.bots.functions.updateBot, (args) => {
                        savedPatches.push(args.patch);

                        return null;
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        savedPatches.length = 0;
        await lunoraAnswered(api.bots.functions.listBots);
        await userEvent.click(await canvas.findByRole("button", { name: "Tools for Docs helper" }));

        const dialog = await screen.findByRole("dialog");

        await waitFor(async () => await expect(within(dialog).getByRole("combobox", { name: "Excluded tools" })).toBeVisible());
        const excluded = within(dialog).getByRole("combobox", { name: "Excluded tools" });

        await userEvent.type(excluded, "nowhere:run");
        await userEvent.tab();
        await expect(within(dialog).getByText("No server, connector or computer matches nowhere:run.")).toBeVisible();

        await userEvent.clear(excluded);
        await userEvent.type(excluded, "docs:search{Enter}");
        await expect(within(dialog).getByRole("button", { name: "Remove docs:search" })).toBeVisible();
        await userEvent.type(excluded, "dateTime");
        await userEvent.click(within(dialog).getByRole("button", { name: "Save tools" }));

        await waitFor(
            async () =>
                await expect(savedPatches).toStrictEqual([
                    { toolSelection: { allow: ["webSearch", `${DOCS}:*`], exclude: [`${DOCS}:delete`, `${DOCS}:search`, "dateTime"] } },
                ]),
        );
    },
};

/** An exclusion naming a server the user since removed: shown as removed, with what it now costs the bot. */
export const RemovedServer: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...botFixtures(),
                    lunora(api.bots.functions.listBots, [{ ...BOT, toolSelection: { exclude: ["mcp=https%3A%2F%2Fgone.example%2Fmcp:*"] } }]),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.bots.functions.listBots);
        await userEvent.click(await canvas.findByRole("button", { name: "Tools for Docs helper" }));

        const dialog = await screen.findByRole("dialog");

        await waitFor(async () => await expect(within(dialog).getByRole("button", { name: "Remove Removed server:*" })).toBeVisible());
        await expect(within(dialog).getByText(/the bot gets none of your own servers' tools/u)).toBeVisible();
    },
};

/** The patches the toggle story below sent. */
const toggledPatches: unknown[] = [];

/** Switching "Only listed tools" or "Custom" off and on again within the dialog brings back what the lists held. */
export const TogglesKeepLists: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...botFixtures(),
                    lunora(api.bots.functions.updateBot, (args) => {
                        toggledPatches.push(args.patch);

                        return null;
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        toggledPatches.length = 0;
        await lunoraAnswered(api.bots.functions.listBots);
        await userEvent.click(await canvas.findByRole("button", { name: "Tools for Docs helper" }));

        const dialog = await screen.findByRole("dialog");

        await waitFor(async () => await expect(within(dialog).getByRole("button", { name: "Remove docs:*" })).toBeVisible());

        await userEvent.click(within(dialog).getByRole("switch", { name: "Only listed tools" }));
        await expect(within(dialog).queryByRole("button", { name: "Remove docs:*" })).toBeNull();
        await userEvent.click(within(dialog).getByRole("switch", { name: "Only listed tools" }));
        await expect(within(dialog).getByRole("button", { name: "Remove webSearch" })).toBeVisible();

        await userEvent.click(within(dialog).getByRole("radio", { name: "All tools" }));
        await userEvent.click(within(dialog).getByRole("radio", { name: "Custom" }));
        await expect(within(dialog).getByRole("button", { name: "Remove docs:delete" })).toBeVisible();
        await userEvent.click(within(dialog).getByRole("button", { name: "Save tools" }));

        await waitFor(
            async () => await expect(toggledPatches).toStrictEqual([{ toolSelection: { allow: ["webSearch", `${DOCS}:*`], exclude: [`${DOCS}:delete`] } }]),
        );
    },
};

/** The patches the refusal story below sent: none. */
const refusedPatches: unknown[] = [];

/** A typed name that matches no server is never dropped silently: the save is refused and the dialog stays open. */
export const RefusesUnaddedTool: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...botFixtures(),
                    lunora(api.bots.functions.updateBot, (args) => {
                        refusedPatches.push(args.patch);

                        return null;
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        refusedPatches.length = 0;
        await lunoraAnswered(api.bots.functions.listBots);
        await userEvent.click(await canvas.findByRole("button", { name: "Tools for Docs helper" }));

        const dialog = await screen.findByRole("dialog");

        await waitFor(async () => await expect(within(dialog).getByRole("combobox", { name: "Excluded tools" })).toBeVisible());
        await userEvent.type(within(dialog).getByRole("combobox", { name: "Excluded tools" }), "nowhere:run");
        await userEvent.click(within(dialog).getByRole("button", { name: "Save tools" }));

        await waitFor(async () => await expect(await screen.findByText("A tool you typed was not added. Add it or clear the field first.")).toBeVisible());
        await expect(screen.getByRole("dialog")).toBeVisible();
        await expect(refusedPatches).toStrictEqual([]);
    },
};
