import { api } from "@neore/backend/api";
import type { ToolPart } from "@neore/chat-ui/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor } from "storybook/test";

import { STORY_NOW } from "@/storybook/clock";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraAnswered, lunoraError, lunoraHandlers, lunoraPending } from "@/storybook/lunora";

import { HumanCheckCard } from "./browser-human-check";

/** A stand-in screenshot (a 1×1 grey PNG), so no story reaches the provider. */
const STAND_IN_SCREENSHOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const PART = {
    input: { action: "navigate", url: "https://shop.example.com/item" },
    output: {
        humanCheck: { browserId: "browser-1", site: "shop.example.com", status: "asked" },
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
        kind: "running" as const,
        now: STORY_NOW,
        ...overrides,
    });

/**
 * The card as the signed-in account's: it first mounts before the session query has answered and mounts again under the
 * account's key (`HumanCheckCard`), so a node found before that is gone from the page. Queried until the one on the page
 * is visible.
 */
const expectCardVisible = async (canvas: { getByRole: (role: string, options: { name: string }) => HTMLElement }) => {
    await waitFor(async () => {
        await expect(canvas.getByRole("region", { name: "Needs you" })).toBeVisible();
    });
};

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
        await expectCardVisible(canvas);
        // The page shows once the status has said the viewer reads the chat.
        await expect(await canvas.findByRole("img", { name: "What the agent's browser sees on shop.example.com" })).toBeVisible();
        await expect(await canvas.findByRole("button", { name: "Take control" })).toBeVisible();
    },
};

/**
 * The status has not answered yet (the card is on screen before the server said the viewer reads the chat): it shows
 * nothing of the site, its page or a button, only that it is loading.
 */
export const Loading: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), lunoraPending(api.browser.live_view.getThreadBrowser)) } } },
    play: async ({ canvas }) => {
        await expectCardVisible(canvas);
        await expect(canvas.getByRole("status")).toHaveTextContent("Loading this check…");
        await expect(canvas.queryByText(/shop\.example\.com/u)).toBeNull();
        await expect(canvas.queryByRole("img")).toBeNull();
        await expect(canvas.queryByRole("button")).toBeNull();
    },
};

/** No live view card took the request (the browser went idle): the card says it cannot be taken over, never that it closed. */
export const BrowserGoneOnTakeControl: Story = {
    play: async ({ canvas }) => {
        await lunoraAnswered(api.browser.live_view.getThreadBrowser);
        await userEvent.click(await canvas.findByRole("button", { name: "Take control" }));
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent("The browser cannot be taken over right now.");
        });
    },
};

/** In a comparison column, which has no live view card, the card points to the model's own chat to take control. */
export const InComparisonColumn: Story = {
    args: { liveViewHere: false },
    play: async ({ canvas }) => {
        // Queried until the card on the page shows it: the card's first mount is replaced under the account's key (see `expectCardVisible`).
        await waitFor(async () => {
            await expect(canvas.getByText(/Open this model's chat on its own/u)).toBeVisible();
        });
        await expect(canvas.queryByRole("button", { name: "Take control" })).toBeNull();
    },
};

/** The person has control: the card tells them to clear the check and hand the browser back. */
export const YouHaveControl: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), browser({ control: { byYou: true, until: STORY_NOW + 120_000 } })) } },
    },
    play: async ({ canvas }) => {
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent("You have control.");
        });
        await expect(canvas.queryByRole("button", { name: "Take control" })).toBeNull();
    },
};

/** An old card: a later reply's browser runs in the thread now, so this card offers no Take control of it. */
export const EarlierBrowser: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), browser({ browserId: "browser-2", currentUrl: "https://other.example.org/" })) } },
    },
    play: async ({ canvas }) => {
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent("This check was for an earlier browser");
        });
        await expect(canvas.queryByRole("button", { name: "Take control" })).toBeNull();
    },
};

/** The browser closed since the ask (a minute after its last action): no button, and a retry opens a new one. */
export const Closed: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), lunora(api.browser.live_view.getThreadBrowser, { kind: "none", now: STORY_NOW })) } },
    },
    play: async ({ canvas }) => {
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent(
                "The browser has closed, so this check can no longer be cleared here. Once the agent's reply has finished, ask it to try again",
            );
        });
    },
};

/** A read-only collaborator: they see the page but cannot take control. */
export const ReadOnly: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), browser({ canControl: false })) } } },
    play: async ({ canvas }) => {
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent("Only someone who can write in this chat");
        });
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
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent("could not be checked");
        });
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
                humanCheck: { browserId: "browser-1", site: "shop.example.com", status: "asked" },
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

/** A result that names its ask: the card can answer it once. */
const ASKED_PART = {
    ...PART,
    output: { ...(PART.output as object), humanCheck: { browserId: "browser-1", checkId: "check-1", run: "run-1", site: "shop.example.com", status: "asked" } },
} as unknown as ToolPart;

const humanCheck = (overrides: Record<string, unknown> = {}) =>
    lunora(api.browser.human_check_card.getHumanCheck, {
        canResolve: true,
        expiresAt: STORY_NOW + 3_600_000,
        kind: "found" as const,
        now: STORY_NOW,
        site: "shop.example.com",
        status: "open",
        ...overrides,
    });

/**
 * The person may answer: Mark done once they cleared it, or Decline; marking it done says the agent looks again, and
 * focus moves from the button that went to the status line.
 */
export const CanAnswer: Story = {
    args: { part: ASKED_PART },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    browser(),
                    humanCheck(),
                    lunora(api.browser.human_check_card.resolveHumanCheck, (args: { resolution: "declined" | "done" }) => {
                        return { changed: true, status: args.resolution };
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.browser.human_check_card.getHumanCheck);
        await expect(await canvas.findByRole("button", { name: "Decline" })).toBeVisible();
        // The status line is exposed while empty, so a screen reader hears the answer that fills it.
        await expect(canvas.getByRole("status")).toBeEmptyDOMElement();
        await userEvent.click(await canvas.findByRole("button", { name: "Mark done" }));
        const status = await canvas.findByRole("status");

        // The status line is always there, empty until it has something to say.
        await waitFor(async () => {
            await expect(status).toHaveTextContent("You marked this check done.");
        });
        // The button that held focus went: focus moved to the status line, with a ring to show it.
        await waitFor(async () => {
            await expect(status).toHaveFocus();
        });
        await expect(getComputedStyle(status).outlineStyle).toBe("solid");
        await expect(canvas.queryByRole("button", { name: "Take control" })).toBeNull();
    },
};

/** Declined elsewhere (another tab or another person): said without "you"; no answer and no Take control again. */
export const Declined: Story = {
    args: { part: ASKED_PART },
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), browser(), humanCheck({ canResolve: false, status: "declined" })) } },
    },
    play: async ({ canvas }) => {
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent("This check was declined.");
        });
        await expect(canvas.queryByRole("button", { name: "Mark done" })).toBeNull();
    },
};

/** The browser moved on to another site while the ask is open (a sign-in that led elsewhere once cleared): it can still be marked done. */
export const MovedOnWhileOpen: Story = {
    args: { part: ASKED_PART },
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), browser({ currentUrl: "https://accounts.example.org/welcome" }), humanCheck()) } },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.browser.human_check_card.getHumanCheck);
        await expect(await canvas.findByRole("button", { name: "Mark done" })).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Decline" })).toBeVisible();
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent("Mark the check done if you cleared it, or decline it.");
        });
        await expect(canvas.queryByRole("button", { name: "Take control" })).toBeNull();
    },
};

/** Nobody answered within the hour: the ask is closed, and a retry asks again. */
export const Expired: Story = {
    args: { part: ASKED_PART },
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), browser(), humanCheck({ canResolve: false, status: "expired" })) } },
    },
    play: async ({ canvas }) => {
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent("This check is no longer open.");
        });
        await expect(canvas.queryByRole("button", { name: "Take control" })).toBeNull();
    },
};

/** A grantee whose access to the chat has ended: the card no longer shows the site, its page or any button. */
export const AccessEnded: Story = {
    args: { part: ASKED_PART },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures(), browser({ accessUntil: STORY_NOW - 1000 }), humanCheck({ accessUntil: STORY_NOW - 1000 })),
            },
        },
    },
    play: async ({ canvas }) => {
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent("Your access to this chat has ended.");
        });
        await expect(canvas.queryByText(/shop\.example\.com/u)).toBeNull();
        await expect(canvas.queryByRole("img")).toBeNull();
        await expect(canvas.queryByRole("button")).toBeNull();
    },
};

/** The ask the result names cannot be read now (no full access to the chat): no site, page or button. */
export const Unreadable: Story = {
    args: { part: ASKED_PART },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures(), browser(), lunora(api.browser.human_check_card.getHumanCheck, { kind: "none", now: STORY_NOW })),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.browser.human_check_card.getHumanCheck);
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent("This check can no longer be read here.");
        });
        await expect(canvas.queryByText(/shop\.example\.com/u)).toBeNull();
        await expect(canvas.queryByRole("button")).toBeNull();
    },
};

/** In a branched chat the copied result names the parent chat's ask: the site and page stay, with no answer to give. */
export const InBranchedChat: Story = {
    args: { part: ASKED_PART },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures(), browser(), lunora(api.browser.human_check_card.getHumanCheck, { kind: "elsewhere", now: STORY_NOW })),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.browser.human_check_card.getHumanCheck);
        await waitFor(async () => {
            await expect(canvas.getByRole("status")).toHaveTextContent("This check cannot be answered in this chat.");
        });
        await expect(canvas.getByRole("img", { name: "What the agent's browser sees on shop.example.com" })).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "Mark done" })).toBeNull();
        await expect(canvas.queryByRole("button", { name: "Decline" })).toBeNull();
    },
};
