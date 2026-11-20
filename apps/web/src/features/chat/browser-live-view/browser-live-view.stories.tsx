import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { STORY_NOW } from "@/storybook/clock";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraAnswered, lunoraError, lunoraHandlers } from "@/storybook/lunora";

import BrowserLiveView from "./browser-live-view";

/** What the live view shows in a story: a stand-in page, so no story reaches the provider. */
const STAND_IN_VIEW = `data:text/html,${encodeURIComponent("<!doctype html><title>Sign in</title><body style='font:14px system-ui;padding:24px'><h1>Sign in</h1><p>Read-only view</p>")}`;

const running = lunora(api.browser.live_view.getThreadBrowser, {
    browserId: "browser-1",
    currentUrl: "https://example.com/account/login",
    idleUntil: STORY_NOW + 60_000,
});

const meta = {
    args: { threadId: "thread-1" as never },
    component: BrowserLiveView,
    decorators: [
        (Story) => (
            <div className="w-[36rem] max-w-full">
                <Story />
            </div>
        ),
    ],
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    running,
                    lunora(api.browser.live_view.openLiveView, { connectBy: STORY_NOW + 60_000, status: "ok" as const, url: STAND_IN_VIEW }),
                ),
            },
        },
    },
    title: "Chat/Browser live view",
} satisfies Meta<typeof BrowserLiveView>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A browser is running: the card names its page, and the view stays closed until asked for. */
export const Running: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("region", { name: "Browser" })).toBeVisible();
        await expect(canvas.getByText("https://example.com/account/login")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Watch live" })).toHaveAttribute("aria-expanded", "false");
    },
};

/** Watching: the read-only view opens under the card. */
export const Watching: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Watch live" }));
        await lunoraAnswered(api.browser.live_view.openLiveView);
        await expect(await canvas.findByTitle("Live view of the agent's browser (read-only)")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Hide live view" })).toHaveAttribute("aria-expanded", "true");
    },
};

/** The deploy has no token for the view, or the provider refused: the card says so. */
export const Unavailable: Story = {
    parameters: {
        msw: {
            handlers: { lunora: lunoraHandlers(...userFixtures(), running, lunora(api.browser.live_view.openLiveView, { status: "unavailable" as const })) },
        },
    },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Watch live" }));
        await expect(await canvas.findByText("The live view is not available right now.")).toBeVisible();
    },
};

/** The person opened too many views this hour: an error that says waiting helps, not "not available". */
export const RateLimited: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    running,
                    lunoraError(api.browser.live_view.openLiveView, "TOO_MANY_REQUESTS", "Rate limit exceeded", 429),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Watch live" }));
        await expect(await canvas.findByRole("alert")).toHaveTextContent("Too many live views were opened. Try again later.");
    },
};

/** No browser runs for the thread: nothing is shown. */
export const NoBrowser: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), lunora(api.browser.live_view.getThreadBrowser, null)) } } },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.browser.live_view.getThreadBrowser);
        await expect(canvas.queryByRole("region", { name: "Browser" })).toBeNull();
        await expect(canvas.queryByRole("button", { name: "Watch live" })).toBeNull();
    },
};
