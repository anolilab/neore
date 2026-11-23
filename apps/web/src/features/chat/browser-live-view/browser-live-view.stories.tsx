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
    canControl: true,
    currentUrl: "https://example.com/account/login",
    idleUntil: STORY_NOW + 60_000,
    now: STORY_NOW,
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

/** The browser status could not be read: the card says so and can ask again, rather than looking like no browser. */
export const StatusFailed: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures(), lunoraError(api.browser.live_view.getThreadBrowser, "INTERNAL", "Status read failed", 500)),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("alert")).toHaveTextContent("Whether the agent is using a browser could not be checked.");
        await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
    },
};

/** Opening the view failed (or its one renewal did not connect either): an error with a retry, never a dead view. */
export const OpenFailed: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures(), running, lunoraError(api.browser.live_view.openLiveView, "INTERNAL", "Provider failed", 500)),
            },
        },
    },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Watch live" }));
        await expect(await canvas.findByRole("alert")).toHaveTextContent("The live view could not be opened.");
        await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
    },
};

const CONTROL_VIEW = `data:text/html,${encodeURIComponent("<!doctype html><title>Sign in</title><body style='font:14px system-ui;padding:24px'><h1>Sign in</h1><p>You have control</p>")}`;
const CONTROL_TITLE = "Live view of the agent's browser (you have control)";

/** The status while a person holds control until `until` (story time); `byYou`: the person viewing the story. */
const controlledBy = (byYou: boolean, until = STORY_NOW + 120_000) =>
    lunora(api.browser.live_view.getThreadBrowser, {
        browserId: "browser-1",
        canControl: true,
        control: { byYou, until },
        currentUrl: "https://example.com/account/login",
        idleUntil: until,
        now: STORY_NOW,
    });

/** `takeControl` gives the lease until `until` (story time). */
const tookControl = (until = STORY_NOW + 120_000) =>
    lunora(api.browser.live_view.takeControl, {
        claim: "claim-1",
        claimId: "claim-id-1",
        connectBy: STORY_NOW + 60_000,
        status: "ok" as const,
        until,
        url: CONTROL_VIEW,
    });

const controlHandlers = (status: ReturnType<typeof controlledBy>, ...overrides: ReturnType<typeof lunora>[]) =>
    lunoraHandlers(
        ...userFixtures(),
        status,
        tookControl(),
        lunora(api.browser.live_view.openLiveView, { connectBy: STORY_NOW + 60_000, status: "ok" as const, url: STAND_IN_VIEW }),
        lunora(api.browser.live_view.keepControl, { until: STORY_NOW + 120_000 }),
        lunora(api.browser.live_view.handBack, true),
        lunora(api.browser.live_view.navigateInControl, { status: "ok" as const }),
        ...overrides,
    );

/** The person took control: the interactive view, an address field, and "Hand back" next to the toggle. */
export const InControl: Story = {
    parameters: { msw: { handlers: { lunora: controlHandlers(controlledBy(true)) } } },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Take control" }));
        await expect(await canvas.findByTitle(CONTROL_TITLE)).toBeVisible();
        await expect(canvas.getByRole("textbox", { name: "Page address" })).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Hand back" })).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "Take control" })).toBeNull();
    },
};

/** Control is about to return for lack of input: a warning, with a button that keeps it. */
export const IdleWarning: Story = {
    parameters: { msw: { handlers: { lunora: controlHandlers(controlledBy(true, STORY_NOW + 20_000), tookControl(STORY_NOW + 20_000)) } } },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Take control" }));
        await expect(await canvas.findByText("No input for a while: control goes back to the agent in under a minute.")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Keep control" })).toBeVisible();
    },
};

/** Someone else drives the browser: no view of it, and no way to take it from them. */
export const SomeoneElseInControl: Story = {
    parameters: { msw: { handlers: { lunora: controlHandlers(controlledBy(false)) } } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Someone else has control of this browser.")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Watch live" })).toBeDisabled();
        await expect(canvas.queryByRole("button", { name: "Take control" })).toBeNull();
    },
};

/** An agent action still holds the browser (up to about 75 s): control is not given yet, and the card says why. */
export const AgentBusy: Story = {
    parameters: { msw: { handlers: { lunora: controlHandlers(running, lunora(api.browser.live_view.takeControl, { status: "busy" as const })) } } },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Take control" }));
        await expect(await canvas.findByText("The agent is finishing a browser action, which can take over a minute. Try again shortly.")).toBeVisible();
    },
};

/** Control was refused outright (an admin impersonating, or no write access any more): an error, with no retry. */
export const ControlForbidden: Story = {
    parameters: {
        msw: { handlers: { lunora: controlHandlers(running, lunoraError(api.browser.live_view.takeControl, "FORBIDDEN", "Refused", 403)) } },
    },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Take control" }));
        await expect(await canvas.findByRole("alert")).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "Try again" })).toBeNull();
    },
};

/** Opens a page from the address field of a story that holds control. */
const openPage = async (canvas: { findByRole: (role: string, options: { name: string }) => Promise<HTMLElement> }): Promise<void> => {
    await userEvent.click(await canvas.findByRole("button", { name: "Take control" }));
    const address = await canvas.findByRole("textbox", { name: "Page address" });

    // The field starts with the browser's page: the new address replaces it.
    await userEvent.clear(address);
    await userEvent.type(address, "https://example.com/next");
    await userEvent.click(await canvas.findByRole("button", { name: "Go" }));
};

/** The page the person asked for is still loading after a load that timed out: the card says so for a while. */
export const PageStillLoading: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: controlHandlers(
                    controlledBy(true),
                    lunora(api.browser.live_view.navigateInControl, { error: "The page you opened is still loading.", status: "refused" as const }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await openPage(canvas);
        await expect(await canvas.findByText("The page you opened is still loading.")).toBeVisible();
    },
};

/** The page could not be opened (the owner's domain lists, or the renderer refused it): the reason, under the field. */
export const PageRefused: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: controlHandlers(
                    controlledBy(true),
                    lunora(api.browser.live_view.navigateInControl, { error: "Domain is blocked", status: "refused" as const }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await openPage(canvas);
        await expect(await canvas.findByRole("alert")).toHaveTextContent("That page could not be opened: Domain is blocked");
    },
};

/** The browser closed while the page loaded: the interactive view goes, and the card says why. */
export const BrowserClosedWhileLoading: Story = {
    parameters: {
        msw: { handlers: { lunora: controlHandlers(controlledBy(true), lunora(api.browser.live_view.navigateInControl, { status: "closed" as const })) } },
    },
    play: async ({ canvas }) => {
        await openPage(canvas);
        await expect(await canvas.findByText("The agent's browser closed while the page loaded.")).toBeVisible();
        await expect(canvas.queryByTitle(CONTROL_TITLE)).toBeNull();
    },
};
