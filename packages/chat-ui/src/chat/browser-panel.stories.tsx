import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import type { BrowserAction, BrowserSession } from "./browser-panel";
import { BrowserPanel, BrowserToolStatus } from "./browser-panel";

/** The story clock is pinned to this instant, so the relative times are stable. */
const NOW = Date.UTC(2026, 10, 5, 12);

const SESSION: BrowserSession = {
    _id: "session-1",
    currentUrl: "https://example.com/pricing",
    lastActivityAt: NOW - 10_000,
    startedAt: NOW - 120_000,
    status: "active",
    threadId: "thread-1",
};

const action = (id: string, kind: string, overrides?: Partial<BrowserAction>): BrowserAction => {
    return { _id: id, action: kind, success: true, timestamp: NOW, ...overrides };
};

const ACTIONS: BrowserAction[] = [
    action("a1", "navigate", { durationMs: 840, target: "https://example.com/pricing" }),
    action("a2", "screenshot", { durationMs: 220 }),
    action("a3", "click", { durationMs: 95, target: "button[data-plan='pro']" }),
    action("a4", "type", { durationMs: 60, target: "#email", value: "ada@example.com" }),
    action("a5", "extract", { durationMs: 1400, errorMessage: "Selector not found", success: false, target: ".price-table" }),
];

/** A 1x1 transparent PNG, so the screenshot slot has an image without a request. */
// eslint-disable-next-line no-secrets/no-secrets -- an image payload, not a secret
const SCREENSHOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

const meta: Meta<typeof BrowserPanel> = {
    args: { actions: ACTIONS, onTerminate: fn(), session: SESSION },
    component: BrowserPanel,
    decorators: [
        (Story) => (
            <div className="max-w-md">
                <Story />
            </div>
        ),
    ],
    parameters: { now: NOW },
    title: "Chat/BrowserPanel",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Active: Story = {
    play: async ({ args, canvas }) => {
        await expect(canvas.getByText("active")).toBeVisible();
        await expect(canvas.getByText(/Action Log/u)).toBeVisible();
        await expect(canvas.getByText(/Selector not found/u)).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: "Stop browser session" }));
        await expect(args.onTerminate).toHaveBeenCalledOnce();
    },
};

export const WithScreenshot: Story = {
    args: { latestScreenshot: SCREENSHOT },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("img", { name: "Browser screenshot" })).toBeVisible();
    },
};

export const Collapsed: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Collapse browser panel" }));
        await expect(canvas.getByRole("button", { name: "Expand browser panel" })).toBeVisible();
        await expect(canvas.queryByText(/Action Log/u)).toBeNull();
    },
};

export const Completed: Story = {
    args: { session: { ...SESSION, status: "completed" } },
    play: async ({ canvas }) => {
        await expect(canvas.queryByRole("button", { name: "Stop browser session" })).toBeNull();
    },
};

export const Failed: Story = {
    args: { session: { ...SESSION, errorMessage: "The page crashed.", status: "failed" } },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("The page crashed.")).toBeVisible();
    },
};

export const NoActionsYet: Story = {
    args: { actions: [], session: { ...SESSION, currentUrl: undefined, lastActivityAt: SESSION.startedAt } },
};

export const ToolStatusNavigating: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Navigate → example.com/pricing")).toBeVisible();
    },
    render: () => <BrowserToolStatus action="navigate" url="https://example.com/pricing" />,
};

export const ToolStatusClicking: Story = {
    render: () => <BrowserToolStatus action="click" url="button.submit" />,
};
