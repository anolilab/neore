import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { ago } from "@/storybook/clock";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraError, lunoraHandlers } from "@/storybook/lunora";

import ComputerRuleFileImport from "./computer-rule-file-import";

const desktop = {
    _id: "desk",
    createdAt: ago(86_400_000),
    lastSeenAt: ago(5000),
    name: "Studio",
    platform: "macos" as const,
    toolNames: [],
    updateRequired: false,
};

const devices = (list: ReadonlyArray<typeof desktop>) => lunora(api.devices.functions.listDevices, [...list]);

const LISTED = [
    { id: "claude" as const, name: "CLAUDE.md", path: "~/.claude/CLAUDE.md", size: 2048, status: "found" as const },
    { id: "codex" as const, name: "AGENTS.md", path: "~/.codex/AGENTS.md", size: 640, status: "found" as const },
    { id: "gemini" as const, name: "GEMINI.md", path: "~/.gemini/GEMINI.md", status: "missing" as const },
    { id: "windsurf" as const, name: "global_rules.md", path: "~/.codeium/windsurf/memories/global_rules.md", size: 90_000, status: "too_large" as const },
];

const started = lunora(api.devices.global_instructions.startGlobalInstructionsCall, { callId: "call-1" });

const meta = {
    // The editor's import, run at once and always still wanted.
    args: {
        disabled: false,
        runImport: fn((read: (isCurrent: () => boolean, discarded: AbortSignal) => Promise<unknown>) => {
            read(() => true, new AbortController().signal).catch(() => undefined);
        }),
    },
    component: ComputerRuleFileImport,
    decorators: [
        (Story) => (
            <div className="w-[40rem] max-w-full">
                <Story />
            </div>
        ),
    ],
    parameters: {
        layout: "padded",
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    devices([desktop]),
                    started,
                    lunora(api.devices.global_instructions.getGlobalInstructionsCall, { files: LISTED, status: "completed" }),
                ),
            },
        },
    },
    title: "Projects/Rule files/Import from this computer",
} satisfies Meta<typeof ComputerRuleFileImport>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Closed: one button, and nothing has been asked of any computer. */
export const Closed: Story = {
    play: async ({ canvasElement }) => {
        await expect(within(canvasElement).getByRole("button", { name: "Import from this computer" })).toBeEnabled();
    },
};

/** The computer said which files exist: those found are ticked, a missing or too large one cannot be. */
export const FilesFound: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Import from this computer" }));
        await userEvent.click(await canvas.findByRole("button", { name: "Find files" }));

        const list = within(await canvas.findByRole("list", { name: "Instruction files" }));

        await expect(list.getByRole("checkbox", { name: /CLAUDE\.md/u })).toBeChecked();
        await expect(list.getByText("(not on this computer)")).toBeInTheDocument();
        await expect(list.getByText("(too large)")).toBeInTheDocument();
        await expect(canvas.getByRole("button", { name: "Import selected" })).toBeEnabled();
    },
};

/** Waiting on the person at the desktop. */
export const WaitingForApproval: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    devices([desktop]),
                    started,
                    lunora(api.devices.global_instructions.getGlobalInstructionsCall, { phase: "prompting" as const, status: "claimed" as const }),
                ),
            },
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Import from this computer" }));
        await userEvent.click(await canvas.findByRole("button", { name: "Find files" }));

        await expect(await canvas.findByText("Approve the request in the desktop app on Studio.")).toBeInTheDocument();
    },
};

/** The paired computer is offline: the request is refused and said. */
export const Offline: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    devices([desktop]),
                    lunoraError(api.devices.global_instructions.startGlobalInstructionsCall, "CONFLICT", "This computer is offline", 409, {
                        code: "DEVICE_OFFLINE",
                    }),
                ),
            },
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Import from this computer" }));
        await userEvent.click(await canvas.findByRole("button", { name: "Find files" }));

        await expect(await canvas.findByRole("alert")).toHaveTextContent("Studio is offline. Open the desktop app on it and try again.");
    },
};

/** The computer answered with something this side cannot read: said in the person's language, nothing imported. */
export const AnswerUnreadable: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    devices([desktop]),
                    started,
                    lunora(api.devices.global_instructions.getGlobalInstructionsCall, {
                        code: "ANSWER_UNREADABLE" as const,
                        error: "The computer's answer could not be read",
                        status: "failed" as const,
                    }),
                ),
            },
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Import from this computer" }));
        await userEvent.click(await canvas.findByRole("button", { name: "Find files" }));

        await expect(await canvas.findByRole("alert")).toHaveTextContent(
            "The computer's answer could not be read. Try again, or update the desktop app on Studio.",
        );
    },
};

/** The list of computers could not be loaded: said, with a way to try again. */
export const DevicesFailed: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures(), lunoraError(api.devices.functions.listDevices, "INTERNAL", "The database is unavailable.", 500)),
            },
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Import from this computer" }));

        await expect(await canvas.findByRole("alert")).toHaveTextContent("Your computers could not be loaded.");
        await expect(canvas.getByRole("button", { name: "Try again" })).toBeEnabled();
    },
};

/** The request's status could not be read: it waits no more, says so, and can be sent again. */
export const RequestLost: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    devices([desktop]),
                    started,
                    lunoraError(api.devices.global_instructions.getGlobalInstructionsCall, "INTERNAL", "The database is unavailable.", 500),
                ),
            },
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Import from this computer" }));
        await userEvent.click(await canvas.findByRole("button", { name: "Find files" }));

        await expect(await canvas.findByRole("alert")).toHaveTextContent("Lost track of the request to Studio. Try again.");
        await expect(canvas.getByRole("button", { name: "Find files" })).toBeEnabled();
    },
};

/** The one paired computer has stopped checking in: Find files cannot be clicked, and the panel says why. */
export const ComputerOffline: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), devices([{ ...desktop, lastSeenAt: ago(3_600_000) }])) } } },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Import from this computer" }));

        const find = await canvas.findByRole("button", { name: "Find files" });

        await expect(find.hasAttribute("disabled") || find.getAttribute("aria-disabled") === "true").toBe(true);
        await expect(find).toHaveAccessibleDescription("Studio is offline. Open the desktop app on it to continue.");
    },
};

/** The read's answer left a ticked file out: what came is imported, the one left out stays ticked with a note. */
export const FileLeftOut: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    devices([desktop]),
                    lunora(api.devices.global_instructions.startGlobalInstructionsCall, ({ files }) => {
                        return { callId: files ? "read-1" : "list-1" };
                    }),
                    lunora(api.devices.global_instructions.getGlobalInstructionsCall, ({ callId }) =>
                        callId === "read-1"
                            ? {
                                  files: [
                                      {
                                          id: "claude" as const,
                                          name: "CLAUDE.md",
                                          path: "~/.claude/CLAUDE.md",
                                          status: "read" as const,
                                          text: "# Global rules",
                                      },
                                  ],
                                  status: "completed" as const,
                              }
                            : { files: LISTED, status: "completed" as const },
                    ),
                ),
            },
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Import from this computer" }));
        await userEvent.click(await canvas.findByRole("button", { name: "Find files" }));
        await userEvent.click(await canvas.findByRole("button", { name: "Import selected" }));

        const left = within(await canvas.findByRole("list", { name: "Files not imported" }));

        await expect(left.getByText("~/.codex/AGENTS.md")).toBeInTheDocument();
        await expect(left.getByText("(not in the computer's answer: try again)")).toBeInTheDocument();
    },
};

/** No desktop is paired: the panel says how to pair one. */
export const NoComputer: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), devices([])) } } },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Import from this computer" }));

        await expect(await canvas.findByText("Pair the desktop app in Settings → Devices to import from a computer.")).toBeInTheDocument();
    },
};
