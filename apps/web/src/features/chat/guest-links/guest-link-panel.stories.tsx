import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { useState } from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";

import { GUEST_NOTES, guestLinksFixtures } from "@/storybook/fixtures/guest-links";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraAnswered, lunoraError, lunoraHandlers } from "@/storybook/lunora";

import GuestLinkPanel from "./guest-link-panel";
import useGuestLinkRevoke from "./use-guest-link-revoke";

/** The panel with the real revoke and its confirm beside it, as the share button holds them. */
const WithRevoke = ({ revokeLink: _unused, ...props }: ComponentProps<typeof GuestLinkPanel>) => {
    const { confirmDialog, revokeLink } = useGuestLinkRevoke(props.threadId);

    return (
        <>
            <GuestLinkPanel {...props} revokeLink={revokeLink} />
            {confirmDialog}
        </>
    );
};

const HELD = GUEST_NOTES[0]?.text ?? "";

const meta = {
    args: { revokeLink: fn(async () => true), threadId: "thread-1" },
    component: GuestLinkPanel,
    decorators: [
        (Story) => (
            <div className="w-[26rem]">
                <Story />
            </div>
        ),
    ],
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...guestLinksFixtures()) } } },
    render: (args) => <WithRevoke {...args} />,
    title: "Chat/Guest link",
} satisfies Meta<typeof GuestLinkPanel>;

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
    // Its own fixtures: the revoke ends their link, which the other stories' must keep.
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...guestLinksFixtures()) } } },
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
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Revoke link" }));
        await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        await waitFor(async () => {
            await expect(screen.queryByRole("alertdialog")).toBeNull();
        });
        await expect(canvas.getByRole("button", { name: "Revoke link" })).toBeEnabled();
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

/** Stands in for the owner moving to another chat while a new link is being made. */
const ChatChangesDuringCreate = ({ threadId: firstThreadId, ...props }: ComponentProps<typeof GuestLinkPanel>) => {
    const [threadId, setThreadId] = useState(firstThreadId);

    return (
        <>
            <button onClick={() => setThreadId("thread-2")} type="button">
                Open another chat
            </button>
            <GuestLinkPanel {...props} threadId={threadId} />
        </>
    );
};

/** A link made for one chat never shows in another, even when it comes back after the owner moved on. */
export const LinkStaysWithItsChat: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...guestLinksFixtures({ createDelayMs: 500, link: false })) } },
    },
    play: async ({ canvas }) => {
        await lunoraAnswered(api.chat.guest_links.getGuestLink);
        await userEvent.click(await canvas.findByRole("button", { name: "Create guest link" }));
        await userEvent.click(canvas.getByRole("button", { name: "Open another chat" }));
        await lunoraAnswered(api.chat.guest_links.createGuestLink);
        await expect(canvas.queryByRole("textbox", { name: "Guest link" })).toBeNull();
    },
    render: (args) => <ChatChangesDuringCreate {...args} />,
};
