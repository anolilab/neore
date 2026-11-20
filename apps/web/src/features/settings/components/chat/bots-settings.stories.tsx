import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { ago, DAY } from "@/storybook/clock";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { userFixtures } from "@/storybook/fixtures/user";
import type { LunoraFixture } from "@/storybook/lunora";
import { lunora, lunoraAnswered, lunoraError, lunoraHandlers, lunoraIdle, lunoraPending } from "@/storybook/lunora";

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

/**
 * Clicks the bot's Tools button once it takes clicks: while a dialog opens or closes (a sheet on a phone) the page under it
 * has `pointer-events: none`, and a click then would fail instead of opening the dialog.
 */
const openTools = async (canvas: ReturnType<typeof within>): Promise<HTMLElement> => {
    const button = await canvas.findByRole("button", { name: "Tools for Docs helper" });

    await waitFor(async () => await expect(getComputedStyle(button).pointerEvents).not.toBe("none"));
    await userEvent.click(button);

    return await screen.findByRole("dialog");
};

/** A bot with a custom tool pick; the new-bot form starts on all tools and opens the lists under Custom. */
export const CustomTools: Story = {
    play: async ({ canvas }) => {
        await lunoraAnswered(api.bots.functions.listBots);
        await lunoraAnswered(api.chat.tool_permissions.getToolPermissionSettings);
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
        const dialog = await openTools(canvas);

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

                        return { toolSelection: args.patch.toolSelection ?? null };
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        savedPatches.length = 0;
        await lunoraAnswered(api.bots.functions.listBots);
        await lunoraAnswered(api.chat.tool_permissions.getToolPermissionSettings);
        const dialog = await openTools(canvas);

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
        const dialog = await openTools(canvas);

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

                        return { toolSelection: args.patch.toolSelection ?? null };
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        toggledPatches.length = 0;
        await lunoraAnswered(api.bots.functions.listBots);
        const dialog = await openTools(canvas);

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

                        return { toolSelection: args.patch.toolSelection ?? null };
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        refusedPatches.length = 0;
        await lunoraAnswered(api.bots.functions.listBots);
        const dialog = await openTools(canvas);

        await waitFor(async () => await expect(within(dialog).getByRole("combobox", { name: "Excluded tools" })).toBeVisible());
        await userEvent.type(within(dialog).getByRole("combobox", { name: "Excluded tools" }), "nowhere:run");
        await userEvent.click(within(dialog).getByRole("button", { name: "Save tools" }));

        await waitFor(async () => await expect(await screen.findByText("A tool you typed was not added. Add it or clear the field first.")).toBeVisible());
        await expect(screen.getByRole("dialog")).toBeVisible();
        await expect(refusedPatches).toStrictEqual([]);
    },
};

/** The patches the unknown built-in story below sent: none. */
const unknownBuiltInPatches: unknown[] = [];

/** A mistyped built-in tool would exclude nothing: it is kept in the field with the reason and the save is refused. */
export const RefusesUnknownBuiltIn: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...botFixtures(),
                    lunora(api.bots.functions.updateBot, (args) => {
                        unknownBuiltInPatches.push(args.patch);

                        return { toolSelection: args.patch.toolSelection ?? null };
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        unknownBuiltInPatches.length = 0;
        await lunoraAnswered(api.bots.functions.listBots);
        // The field checks a bare name against the built-in tools once they are read.
        await lunoraAnswered(api.chat.tool_permissions.getToolPermissionSettings);
        const dialog = await openTools(canvas);

        await waitFor(async () => await expect(within(dialog).getByRole("combobox", { name: "Excluded tools" })).toBeVisible());
        const excluded = within(dialog).getByRole("combobox", { name: "Excluded tools" });

        await userEvent.type(excluded, "webSerch{Enter}");
        await expect(within(dialog).getByText("No built-in tool is named webSerch.")).toBeVisible();
        await expect(excluded).toHaveAttribute("aria-invalid", "true");
        await userEvent.click(within(dialog).getByRole("button", { name: "Save tools" }));
        await lunoraIdle();

        await expect(screen.getByRole("dialog")).toBeVisible();
        await expect(unknownBuiltInPatches).toStrictEqual([]);
    },
};

/** Lets the slow save below finish once the dialog was closed and opened again. */
const slowSave: { finish?: () => void } = {};

/**
 * A save that ends after the dialog was closed and reopened leaves the reopened dialog open, and the reopened copy, read
 * before the save landed, takes the saved pick instead of writing the old one back.
 */
export const EarlierSaveKeepsReopenedDialog: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...botFixtures(),
                    lunora(
                        api.bots.functions.updateBot,
                        async () =>
                            await new Promise<{ toolSelection: null }>((resolve) => {
                                slowSave.finish = () => resolve({ toolSelection: null });
                            }),
                    ),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.bots.functions.listBots);
        const first = await openTools(canvas);

        await waitFor(async () => await expect(within(first).getByRole("button", { name: "Save tools" })).toBeVisible());
        await userEvent.click(within(first).getByRole("radio", { name: "All tools" }));
        await userEvent.click(within(first).getByRole("button", { name: "Save tools" }));
        await userEvent.click(within(first).getByRole("button", { name: "Cancel" }));
        await waitFor(async () => await expect(screen.queryByRole("dialog")).toBeNull());

        await openTools(canvas);
        await waitFor(async () => await expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Save tools" })).toBeVisible());
        await expect(within(screen.getByRole("dialog")).getByRole("radio", { name: "Custom" })).toBeChecked();
        slowSave.finish?.();
        await lunoraAnswered(api.bots.functions.updateBot);
        // The save then refreshes the bots list before it would close a dialog.
        await lunoraIdle();

        await expect(screen.getByRole("dialog")).toBeVisible();
        await expect(within(screen.getByRole("dialog")).getByRole("radio", { name: "All tools" })).toBeChecked();
    },
};

/** The bots list after the save below: held until the story released it, then the server's stored bot. */
const heldList: { held: boolean; waiting: (() => void)[] } = { held: false, waiting: [] };
/** The patches the reopen story below sent. */
const reopenedPatches: unknown[] = [];

/** A dialog reopened before the bots list refreshed starts from the pick just saved, and saving it again keeps that pick. */
export const ReopenBeforeRefresh: Story = {
    beforeEach: () => {
        // Reads a failed run left held are answered, so they do not keep the mock backend busy.
        for (const release of heldList.waiting) {
            release();
        }

        heldList.held = false;
        heldList.waiting = [];
        reopenedPatches.length = 0;
    },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...botFixtures(),
                    lunora(api.bots.functions.listBots, async () => {
                        if (heldList.held) {
                            await new Promise<void>((resolve) => {
                                heldList.waiting.push(resolve);
                            });

                            return [{ ...BOT, toolSelection: undefined }];
                        }

                        return [BOT];
                    }),
                    lunora(api.bots.functions.updateBot, (args) => {
                        reopenedPatches.push(args.patch);
                        heldList.held = true;

                        return { toolSelection: args.patch.toolSelection ?? null };
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.bots.functions.listBots);

        const first = await openTools(canvas);

        await waitFor(async () => await expect(within(first).getByRole("radio", { name: "Custom" })).toBeChecked());
        await userEvent.click(within(first).getByRole("radio", { name: "All tools" }));
        await userEvent.click(within(first).getByRole("button", { name: "Save tools" }));
        await waitFor(async () => await expect(screen.queryByRole("dialog")).toBeNull());

        // The list refresh is still held: the reopened dialog reads the pick the save stored.
        const reopened = await openTools(canvas);

        await waitFor(async () => await expect(within(reopened).getByRole("radio", { name: "All tools" })).toBeChecked());
        await userEvent.click(within(reopened).getByRole("button", { name: "Save tools" }));
        await waitFor(async () => await expect(reopenedPatches).toStrictEqual([{ toolSelection: null }, { toolSelection: null }]));

        heldList.held = false;

        for (const release of heldList.waiting) {
            release();
        }
    },
};

/** Lets the slow create below finish once the story checked the form is locked. */
const slowCreate: { finish?: () => void } = {};

/** The create sends the form as it was when clicked, so the form is locked until it ends and then starts empty. */
export const CreateLocksForm: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...botFixtures(),
                    lunora(
                        api.bots.functions.createBot,
                        async () =>
                            await new Promise<string>((resolve) => {
                                slowCreate.finish = () => resolve("bot-2");
                            }),
                    ),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.bots.functions.listBots);
        await userEvent.type(canvas.getByRole("textbox", { name: "Name" }), "Researcher");
        await userEvent.type(canvas.getByRole("textbox", { name: "Instructions" }), "Cite sources.");
        await userEvent.click(canvas.getByRole("button", { name: "Create bot" }));

        await waitFor(async () => await expect(canvas.getByRole("textbox", { name: "Name" })).toBeDisabled());
        await expect(canvas.getByRole("textbox", { name: "Instructions" })).toBeDisabled();
        await expect(canvas.getByRole("radio", { name: "Custom" })).toHaveAttribute("aria-disabled", "true");
        await expect(canvas.getByRole("switch", { name: "Computer" })).toHaveAttribute("aria-disabled", "true");

        slowCreate.finish?.();
        await waitFor(async () => await expect(canvas.getByRole("textbox", { name: "Name" })).toBeEnabled());
        await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue("");
        await expect(canvas.getByRole("radio", { name: "Custom" })).not.toHaveAttribute("aria-disabled", "true");
    },
};

/** Until the user's servers are read, a selector naming one is shown by its key, never as a removed server. */
export const ServersLoading: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...botFixtures(), lunoraPending(api.auth.functions.getAIUserPreferences)),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.bots.functions.listBots);
        const dialog = await openTools(canvas);

        await waitFor(async () => await expect(within(dialog).getByText("Loading your servers, connectors and computers…")).toBeVisible());
        await expect(within(dialog).getByRole("button", { name: `Remove ${DOCS}:delete` })).toBeVisible();
        await expect(within(dialog).queryByText(/Removed server/u)).toBeNull();
        await expect(within(dialog).queryByText(/the bot gets none of your own servers' tools/u)).toBeNull();
    },
};

/** Whether the read of the user's servers below fails: until the story is about to retry. */
const preferencesRead = { fails: true };
/** The user's servers: failing to read until `preferencesRead.fails` is cleared. */
const failingPreferences = (): LunoraFixture => {
    const failed = lunoraError(api.auth.functions.getAIUserPreferences, "INTERNAL_ERROR", "Read failed", 500);
    const read = botFixtures().find((fixture) => fixture.functionPath === failed.functionPath);

    return {
        answer: async (args) => (read === undefined || preferencesRead.fails ? await failed.answer(args) : await read.answer(args)),
        functionPath: failed.functionPath,
    };
};

/** A failed read of the user's servers says so, offers a retry, and shows no selector as removed meanwhile. */
export const ServersLoadFails: Story = {
    beforeEach: () => {
        preferencesRead.fails = true;
    },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...botFixtures(), failingPreferences()),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.bots.functions.listBots);
        const dialog = await openTools(canvas);

        await waitFor(async () => await expect(within(dialog).getByText("Your servers, connectors and computers could not be loaded.")).toBeVisible());
        await expect(within(dialog).getByRole("button", { name: `Remove ${DOCS}:delete` })).toBeVisible();
        await expect(within(dialog).queryByText(/Removed server/u)).toBeNull();

        // A server's name cannot be resolved meanwhile; once the retry read the servers, the reason goes and the name can be added.
        const excluded = within(dialog).getByRole("combobox", { name: "Excluded tools" });

        await userEvent.type(excluded, "docs:search{Enter}");
        await expect(within(dialog).getByText(/could not be loaded. Retry above to add one by name/u)).toBeVisible();

        preferencesRead.fails = false;
        await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));

        await waitFor(async () => await expect(within(dialog).getByRole("button", { name: "Remove docs:delete" })).toBeVisible());
        await expect(within(dialog).queryByText("Your servers, connectors and computers could not be loaded.")).toBeNull();
        await expect(within(dialog).queryByText(/No server, connector or computer matches/u)).toBeNull();
        await userEvent.type(excluded, "{Enter}");
        await expect(within(dialog).getByRole("button", { name: "Remove docs:search" })).toBeVisible();
    },
};

/** A stored built-in that is no longer one marks the list's field invalid and says why, so a screen reader hears it too. */
export const StaleBuiltIn: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...botFixtures(), lunora(api.bots.functions.listBots, [{ ...BOT, toolSelection: { exclude: ["oldTool"] } }])),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.bots.functions.listBots);
        await lunoraAnswered(api.chat.tool_permissions.getToolPermissionSettings);
        const dialog = await openTools(canvas);

        await waitFor(async () => await expect(within(dialog).getByRole("combobox", { name: "Excluded tools" })).toBeVisible());
        const excluded = within(dialog).getByRole("combobox", { name: "Excluded tools" });

        await expect(excluded).toHaveAttribute("aria-invalid", "true");
        await expect(excluded).toHaveAccessibleDescription(/A listed built-in tool no longer exists/u);
    },
};
