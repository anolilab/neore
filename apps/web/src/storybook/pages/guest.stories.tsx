import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { clearGuestTokenMemory, forgetGuestToken, keepGuestToken, keepPendingPost } from "@/features/chat/guest-links/guest-token";
import { Route as GuestRoute } from "@/routes/(public)/guest";
import { HOUR, STORY_NOW as NOW } from "@/storybook/clock";
import { GUEST_LINK_TOKEN, guestAttempts, guestPageFixtures, guestPosts, resetGuestPosts, RETURNING_GUEST_TOKEN } from "@/storybook/fixtures/guest-page";
import { lunoraAnswered, lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

/**
 * The page opens on `#<token>`, the only place the link carries its token. Each story starts as a browser that never
 * opened the link (no token kept, no post pending), unless it is a returning guest's.
 */
const atFragment =
    (fragment: string, { returning = false } = {}) =>
    async (): Promise<void> => {
        resetGuestPosts();
        clearGuestTokenMemory();
        await forgetGuestToken(GUEST_LINK_TOKEN);
        await keepPendingPost(GUEST_LINK_TOKEN, undefined);

        if (returning) {
            await keepGuestToken(GUEST_LINK_TOKEN, RETURNING_GUEST_TOKEN);
        }

        globalThis.history.replaceState(null, "", `${globalThis.location.pathname}${globalThis.location.search}${fragment}`);
    };

const TOKEN_SHAPE = /^[0-9a-f]{64}$/u;

const meta = {
    args: { levels: [{ component: GuestRoute.options.component, path: "/guest" }], url: "/guest" },
    beforeEach: atFragment(`#${GUEST_LINK_TOKEN}`),
    component: StoryPage,
    parameters: { layout: "fullscreen", msw: { handlers: { lunora: lunoraHandlers(...guestPageFixtures()) } }, persona: "signed-out" },
    title: "Pages/Guest link",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A guest leaves a note: it is posted with the browser's own token and a request id, and listed as waiting. */
export const LeaveANote: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("heading", { level: 1, name: "Leave a message" })).toBeVisible();
        await userEvent.type(await canvas.findByRole("textbox", { name: "Your message" }), "Can we talk tomorrow?");
        await userEvent.click(canvas.getByRole("button", { name: "Send to the owner" }));

        await expect(await canvas.findByText("Waiting for the owner")).toBeVisible();
        await expect(guestPosts[0]?.linkToken).toBe(GUEST_LINK_TOKEN);
        await expect(guestPosts[0]?.guestToken).toMatch(TOKEN_SHAPE);
        await expect(guestPosts[0]?.guestToken).not.toBe(GUEST_LINK_TOKEN);
        await expect(guestPosts[0]?.requestId).toBeTruthy();
    },
};

/** The "Skip to content" link moves the fragment to `#main-content`: the page keeps the link it was opened with. */
export const SkipLinkKeepsTheLink: Story = {
    play: async ({ canvas }) => {
        const field = await canvas.findByRole("textbox", { name: "Your message" });

        globalThis.location.hash = "main-content";
        globalThis.dispatchEvent(new HashChangeEvent("hashchange"));
        await userEvent.type(field, "Can we talk tomorrow?");
        await userEvent.click(canvas.getByRole("button", { name: "Send to the owner" }));

        await expect(await canvas.findByText("Waiting for the owner")).toBeVisible();
        await expect(guestPosts[0]?.linkToken).toBe(GUEST_LINK_TOKEN);
        // The address carries the link again, for a reload or a copy.
        await expect(globalThis.location.hash).toBe(`#${GUEST_LINK_TOKEN}`);
    },
};

/** The first post is stored but its reply is lost: sending again carries the same request id, so the note is stored once. */
export const RetryAfterLostReply: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...guestPageFixtures({ failFirstPost: true })) } } },
    play: async ({ canvas }) => {
        await userEvent.type(await canvas.findByRole("textbox", { name: "Your message" }), "Can we talk tomorrow?");
        await userEvent.click(canvas.getByRole("button", { name: "Send to the owner" }));
        // A lost connection reads as one, not as the transport's own words.
        await expect(await canvas.findByRole("alert")).toHaveTextContent("Check your connection");
        await userEvent.click(canvas.getByRole("button", { name: "Send to the owner" }));

        const [waiting] = await canvas.findAllByText("Waiting for the owner");

        await expect(waiting).toBeVisible();
        // Every try of the one post carries one request id, so the note is stored once (`guest-post` claims).
        await expect(guestAttempts.length).toBeGreaterThan(1);
        await expect(new Set(guestAttempts.map((attempt) => attempt.requestId)).size).toBe(1);
        await expect(guestPosts).toHaveLength(1);
    },
};

/** Notes from an earlier visit: one waiting, one the owner sent on. */
export const EarlierNotes: Story = {
    beforeEach: atFragment(`#${GUEST_LINK_TOKEN}`, { returning: true }),
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...guestPageFixtures({
                        notes: [
                            { createdAt: NOW - 2 * HOUR, status: "sent", text: "Thanks for yesterday." },
                            { createdAt: NOW - HOUR, status: "held", text: "Is the meeting still on?" },
                        ],
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Sent by the owner")).toBeVisible();
        await expect(canvas.getByText("Waiting for the owner")).toBeVisible();
    },
};

/** A new guest's first post: while the view after it is on its way, the page never calls the link ended. */
export const FirstPost: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...guestPageFixtures({ slowViewAfterPost: true })) } } },
    play: async ({ canvas }) => {
        await userEvent.type(await canvas.findByRole("textbox", { name: "Your message" }), "Can we talk tomorrow?");
        await userEvent.click(canvas.getByRole("button", { name: "Send to the owner" }));
        await lunoraAnswered(api.chat.guest_links.postGuestMessage);

        await expect(canvas.queryByText("This link has ended.")).not.toBeInTheDocument();
        await expect(await canvas.findByText("Waiting for the owner", undefined, { timeout: 5000 })).toBeVisible();
        await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
    },
};

/** The view after a new guest's first post fails: the link is not called ended, and the form still takes a message. */
export const ViewFailsAfterPost: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...guestPageFixtures({ failViewAfterPost: true })) } } },
    play: async ({ canvas }) => {
        await userEvent.type(await canvas.findByRole("textbox", { name: "Your message" }), "Can we talk tomorrow?");
        await userEvent.click(canvas.getByRole("button", { name: "Send to the owner" }));
        await lunoraAnswered(api.chat.guest_links.postGuestMessage);
        // The failed view is shown as such (after the client's own retries), never as an ended link.
        await expect(await canvas.findByText(/Your notes could not be loaded/u, undefined, { timeout: 15_000 })).toBeVisible();
        await expect(canvas.queryByText("This link has ended.")).not.toBeInTheDocument();
        await expect(canvas.getByRole("textbox", { name: "Your message" })).toBeEnabled();
        await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
    },
};

/** The owner revoked the link after the post: the page says the link has ended and takes no more messages. */
export const LinkEnded: Story = {
    beforeEach: atFragment(`#${GUEST_LINK_TOKEN}`, { returning: true }),
    // A note from earlier first, so the view answered something before the post: only the view after it can end the link.
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...guestPageFixtures({ endAfterPost: true, notes: [{ createdAt: NOW - HOUR, status: "held", text: "Is the meeting still on?" }] }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Is the meeting still on?")).toBeVisible();
        await userEvent.type(canvas.getByRole("textbox", { name: "Your message" }), "Are you there?");
        await userEvent.click(canvas.getByRole("button", { name: "Send to the owner" }));

        await expect(await canvas.findByRole("alert")).toHaveTextContent("This link has ended.");
        await expect(canvas.getByRole("textbox", { name: "Your message" })).toBeDisabled();
    },
};

/** Another browser holds the link: the refusal is said in the page's words, not the server's. */
export const AnotherBrowser: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...guestPageFixtures({ postRefusal: "FORBIDDEN" })) } } },
    play: async ({ canvas }) => {
        await userEvent.type(await canvas.findByRole("textbox", { name: "Your message" }), "Hello?");
        await userEvent.click(canvas.getByRole("button", { name: "Send to the owner" }));

        await expect(await canvas.findByRole("alert")).toHaveTextContent("already in use in another browser");
        await expect(canvas.queryByText("The server's own words")).not.toBeInTheDocument();
    },
};

/** A link copied without its fragment carries no token. */
export const IncompleteLink: Story = {
    beforeEach: atFragment(""),
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("alert")).toHaveTextContent("This link is not complete");
    },
};
