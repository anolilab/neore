import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";

import { GUEST_NOTES, guestLinksFixtures } from "@/storybook/fixtures/guest-links";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraAnswered, lunoraError, lunoraHandlers, lunoraIdle, lunoraPending } from "@/storybook/lunora";

import GuestLinkPanel from "./guest-link-panel";
import useGuestLinkRevoke from "./use-guest-link-revoke";

/** The panel with the real revoke and its confirm beside it, as the share button holds them. */
const WithRevoke = ({ threadId, ...props }: Omit<ComponentProps<typeof GuestLinkPanel>, "revokeLink">) => {
    const { confirmDialog, revokeLink } = useGuestLinkRevoke(threadId);

    return (
        <>
            <GuestLinkPanel {...props} revokeLink={revokeLink} threadId={threadId} />
            {confirmDialog}
        </>
    );
};

const HELD = GUEST_NOTES[0]?.text ?? "";
/** `RevokeDeclined`'s revoke: a Cancel must never reach it. */
const revokeCalled = fn(() => null);
/** The meta's backend, shared with `RevokeDeclined`: it starts over before each story, so a revoke in one never shows in the next. */
const FIXTURES = guestLinksFixtures();

const meta = {
    args: { threadId: "thread-1" },
    component: WithRevoke,
    decorators: [
        (Story) => (
            <div className="w-[26rem]">
                <Story />
            </div>
        ),
    ],
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...FIXTURES) } } },
    title: "Chat/Guest link",
} satisfies Meta<typeof WithRevoke>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A live link with a note waiting and one already sent, each with its state; nothing here acts on a note. */
export const NotesWaiting: Story = {
    play: async ({ canvas }) => {
        const notes = await canvas.findByRole("list", { name: "Guest messages" });

        await expect(await canvas.findByText(HELD)).toBeVisible();
        await expect(canvas.getByText("Waiting")).toBeVisible();
        await expect(canvas.getByText("Sent")).toBeVisible();
        await expect(within(notes).queryAllByRole("button")).toHaveLength(0);
    },
};

/** No live link yet: making one shows its address once, to copy. */
export const NoLink: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...guestLinksFixtures({ link: false })) } } },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.chat.guest_links.getGuestLink);
        await userEvent.click(await canvas.findByRole("button", { name: "Create guest link" }));
        const field = (await canvas.findByRole("textbox", { name: "Guest link" })) as HTMLInputElement;

        // The token rides in the fragment, never the path or the query.
        await expect(new URL(field.value).hash).toMatch(/^#[0-9a-f]{64}$/u);
        // The read now holds the new link: it is live, not offered again.
        await waitFor(async () => {
            await expect(canvas.queryByRole("button", { name: "Create guest link" })).toBeNull();
        });
    },
};

/** The first read is still out: Create waits, and says why. */
export const Loading: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), lunoraPending(api.chat.guest_links.getGuestLink)) } } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("status")).toHaveTextContent("Loading the guest link…");
        await expect(canvas.getByRole("button", { name: "Create guest link" })).toBeDisabled();
    },
};

/** The link could not be read: an error, not an empty "make a link" state. */
export const LoadError: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...guestLinksFixtures(),
                    lunoraError(api.chat.guest_links.getGuestLink, "INTERNAL", "The database is unavailable.", 500),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("alert")).toHaveTextContent("could not be loaded");
        await expect(canvas.getByRole("button", { name: "Create guest link" })).toBeDisabled();
    },
};

/** A locked chat holds no guest link: its notes are shown, but no link is made. */
export const LockedChat: Story = {
    args: { locked: true },
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...guestLinksFixtures({ link: false })) } } },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.chat.guest_links.getGuestLink);
        await expect(await canvas.findByRole("button", { name: "Create guest link" })).toBeDisabled();
    },
};

/** Revoking deletes the notes still waiting: the owner confirms first, then focus goes to "Create guest link". */
export const RevokeWithWaitingNotes: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Revoke link" }));
        await expect(await screen.findByRole("alertdialog")).toHaveTextContent("deletes the 1 guest message still waiting");
        await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
        await lunoraAnswered(api.chat.guest_links.revokeGuestLink);
        await waitFor(async () => {
            await expect(canvas.getByRole("button", { name: "Create guest link" })).toHaveFocus();
        });
    },
};

/** Cancelling the confirm revokes nothing. */
export const RevokeDeclined: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...FIXTURES, lunora(api.chat.guest_links.revokeGuestLink, revokeCalled)) } },
    },
    play: async ({ canvas }) => {
        revokeCalled.mockClear();
        await userEvent.click(await canvas.findByRole("button", { name: "Revoke link" }));
        await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        await waitFor(async () => {
            await expect(screen.queryByRole("alertdialog")).toBeNull();
        });
        await lunoraIdle();
        await expect(revokeCalled).not.toHaveBeenCalled();
        await expect(canvas.getByRole("button", { name: "Revoke link" })).toBeEnabled();
    },
};

/** The link was replaced from another tab since the owner looked: the revoke is refused, nothing is deleted, and they are told. */
export const RevokeReplacedElsewhere: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...guestLinksFixtures({ messages: [] }),
                    lunoraError(api.chat.guest_links.revokeGuestLink, "NOT_FOUND", "That guest link has ended.", 404, { code: "GUEST_LINK_ENDED" }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Revoke link" }));
        await expect(await screen.findByText("The guest link was replaced or has ended.")).toBeInTheDocument();
    },
};

/** A refusal reads in the app's words, from its code, not the server's English. */
export const RefusalInAppWords: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...guestLinksFixtures({ link: false }),
                    lunoraError(api.chat.guest_links.createGuestLink, "BAD_REQUEST", "server words", 400, { code: "GUEST_NOTES_WAITING" }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.chat.guest_links.getGuestLink);
        await userEvent.click(await canvas.findByRole("button", { name: "Create guest link" }));
        await expect(await screen.findByText("Guest messages from an earlier link are still waiting.")).toBeInTheDocument();
        await expect(screen.queryByText("server words")).toBeNull();
    },
};
