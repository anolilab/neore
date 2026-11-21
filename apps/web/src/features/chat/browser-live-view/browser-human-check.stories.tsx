import { api } from "@neore/backend/api";
import type { ToolPart } from "@neore/chat-ui/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { STORY_NOW } from "@/storybook/clock";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraAnswered, lunoraError, lunoraHandlers } from "@/storybook/lunora";

import { HumanCheckCard } from "./browser-human-check";

/** A stand-in screenshot (a 1×1 grey PNG), so no story reaches the provider. */
const STAND_IN_SCREENSHOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const PART = {
    input: { action: "navigate", url: "https://shop.example.com/item" },
    output: {
        humanCheck: { site: "shop.example.com", status: "asked" },
        screenshot: STAND_IN_SCREENSHOT,
        screenshotFormat: "png",
        success: false,
        title: "Just a moment...",
        url: "https://shop.example.com/item",
    },
    state: "output-available",
    toolCallId: "call-1",
    type: "tool-browser",
} as unknown as ToolPart;

const browser = (overrides: Record<string, unknown> = {}) =>
    lunora(api.browser.live_view.getThreadBrowser, {
        browserId: "browser-1",
        canControl: true,
        currentUrl: "https://shop.example.com/item",
        idleUntil: STORY_NOW + 60_000,
        now: STORY_NOW,
        ...overrides,
    });

const meta = {
    args: { part: PART, threadId: "thread-1" },
    component: HumanCheckCard,
    decorators: [
        (Story) => (
            <div className="w-[36rem] max-w-full">
                <Story />
            </div>
        ),
    ],
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), browser()) } } },
    title: "Chat/Browser human check",
} satisfies Meta<typeof HumanCheckCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The page needs a person: the card names the site, shows the page and offers to take control. */
export const NeedsYou: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("region", { name: "Needs you" })).toBeVisible();
        await expect(canvas.getByRole("img", { name: "What the agent's browser sees on shop.example.com" })).toBeVisible();
        await expect(await canvas.findByRole("button", { name: "Take control" })).toBeVisible();
    },
};

/** No live view card took the request (the browser went idle): the card says it cannot be taken over, never that it closed. */
export const BrowserGoneOnTakeControl: Story = {
    play: async ({ canvas }) => {
        await lunoraAnswered(api.browser.live_view.getThreadBrowser);
        await userEvent.click(await canvas.findByRole("button", { name: "Take control" }));
        await expect(await canvas.findByRole("status")).toHaveTextContent("The browser cannot be taken over right now.");
    },
};

/** In a comparison column, which has no live view card, the card points to the model's own chat to take control. */
export const InComparisonColumn: Story = {
    args: { liveViewHere: false },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(/Open this model's chat on its own/u)).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "Take control" })).toBeNull();
    },
};

/** The person has control: the card tells them to clear the check and hand the browser back. */
export const YouHaveControl: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), browser({ control: { byYou: true, until: STORY_NOW + 120_000 } })) } },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("status")).toHaveTextContent("You have control.");
        await expect(canvas.queryByRole("button", { name: "Take control" })).toBeNull();
    },
};

/** The browser closed since the ask: no button. */
export const Closed: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), lunora(api.browser.live_view.getThreadBrowser, null)) } } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("status")).toHaveTextContent("The browser has closed.");
    },
};

/** A read-only collaborator: they see the page but cannot take control. */
export const ReadOnly: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), browser({ canControl: false })) } } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("status")).toHaveTextContent("Only someone who can write in this chat");
    },
};

/** The browser's status could not be read: the card does not call it closed, and can ask again. */
export const StatusUnreadable: Story = {
    parameters: {
        msw: {
            handlers: { lunora: lunoraHandlers(...userFixtures(), lunoraError(api.browser.live_view.getThreadBrowser, "INTERNAL", "Status read failed", 500)) },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("status")).toHaveTextContent("could not be checked");
        await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
    },
};

/** A check found in the page's text, with no picture: the card says so in words. */
export const NoPicture: Story = {
    args: {
        part: {
            ...PART,
            output: {
                content: "Verifying you are human.",
                humanCheck: { site: "shop.example.com", status: "asked" },
                success: false,
                url: "https://shop.example.com/",
            },
        } as unknown as ToolPart,
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(/No picture of the page could be taken/u)).toBeVisible();
        await expect(await canvas.findByRole("button", { name: "Take control" })).toBeVisible();
    },
};
