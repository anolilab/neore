import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import env from "@/lib/env";
import { Route as ThreadRoute } from "@/routes/(chat)/chat/$threadId";
import { Route as ChatLayoutRoute } from "@/routes/(chat)/route";
import { chatFixtures, THREAD_IDS } from "@/storybook/fixtures/chat";
import { chunksOf, gatewayStreamHandler } from "@/storybook/fixtures/gateway";
import { GUEST_NOTES, guestLinksFixtures, saveGuestNote } from "@/storybook/fixtures/guest-links";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraAnswered, lunoraHandlers, lunoraIdle } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// Page data arrives after the route loads; under a loaded machine that can outlast the 1 s default of `find*`.
const PAGE_WAIT = { timeout: 5000 } as const;
// A send runs the review, the gateway's start and the next read of the link before the note reads as sent.
const STATE_WAIT = { timeout: 15_000 } as const;

const HELD = GUEST_NOTES[0]?.text ?? "";
// The panel names a note's buttons by its first 40 characters.
const SEND_HELD = /^Send: Could you check the deploy tonight/u;
const DISMISS_HELD = /^Dismiss note: Could you check the deploy tonight/u;

/** The bodies the gateway's `/v1/chat` received in this story: a guest note goes out with its id. */
const sends: string[] = [];

/** The gateway's chat start: it saves the message, and with it marks the guest note sent, as the backend does. */
const gatewaySend = http.post(`${env.VITE_LLM_GATEWAY_URL}/v1/chat`, async ({ request }) => {
    const body = await request.text();
    const { guestMessageId } = JSON.parse(body) as { guestMessageId?: string };

    sends.push(body);

    if (guestMessageId !== undefined) {
        saveGuestNote(guestMessageId);
    }

    return HttpResponse.json({
        contentType: "text",
        gatewayUrl: env.VITE_LLM_GATEWAY_URL,
        messageId: "guest-note-message",
        streamId: "guest-note-stream",
        streaming: true,
        streamToken: "storybook-stream-guest-note-stream",
        threadId: THREAD_IDS.main,
    });
});

/** The held note's row in the list: its text and its state badge. */
const heldNote = (notes: HTMLElement): HTMLElement => {
    const row = within(notes).getByText(HELD).closest("li");

    if (!row) {
        throw new Error("The held note has no row.");
    }

    return row;
};

/** The owner opens the chat's share menu on the Guests tab, once the thread and its access have loaded. */
const openGuestsTab = async (canvas: { findByRole: typeof screen.findByRole }): Promise<HTMLElement> => {
    await canvas.findByRole("textbox", { name: "Message" }, PAGE_WAIT);
    await lunoraAnswered(api.chat.sharing.getThreadAccess);
    await canvas.findByRole("button", { name: "Share Thread" }, PAGE_WAIT);

    // The last story's open share panel can hold `pointer-events: none` on the page for a moment after it unmounted; the
    // header can render the button anew meanwhile, so it is looked up again for the click.
    const share = await waitFor(async () => {
        const button = screen.getByRole("button", { name: "Share Thread" });

        await expect(getComputedStyle(button).pointerEvents).not.toBe("none");

        return button;
    }, PAGE_WAIT);

    await userEvent.click(share);

    // A popover on desktop, a drawer on a phone: either way a named dialog, and its tabs fit the screen.
    const panel = await screen.findByRole("dialog", { name: "Share Thread" }, PAGE_WAIT);

    await expect(within(panel).getByRole("tablist").getBoundingClientRect().right).toBeLessThanOrEqual(globalThis.innerWidth);
    await userEvent.click(await screen.findByRole("tab", { name: "Guests" }, PAGE_WAIT));

    return await screen.findByRole("list", { name: "Guest messages" }, PAGE_WAIT);
};

/**
 * The owner's side of a guest link, on the chat page: the share menu's Guests tab, with the real send through the chat's
 * own send path. The guest's side is `Pages/Guest link`.
 */
const meta = {
    args: {
        levels: [
            { id: "/(chat)", route: ChatLayoutRoute },
            { path: "chat/$threadId", route: ThreadRoute },
        ],
        url: `/chat/${THREAD_IDS.main}`,
    },
    beforeEach: () => {
        sends.length = 0;
    },
    component: StoryPage,
    parameters: {
        layout: "fullscreen",
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...guestLinksFixtures()),
                send: gatewaySend,
                stream: gatewayStreamHandler(chunksOf("On it: the staging build failed on a missing variable.")),
            },
        },
    },
    title: "Pages/Guest link owner",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A live link with one note waiting and one sent: only the waiting one offers Send and Dismiss. */
export const NotesWaiting: Story = {
    play: async ({ canvas }) => {
        const notes = await openGuestsTab(canvas);

        await expect(within(notes).getByText(HELD)).toBeVisible();
        await expect(within(notes).getByText("Waiting")).toBeVisible();
        await expect(within(notes).getByRole("button", { name: SEND_HELD })).toBeEnabled();
        await lunoraIdle();
    },
};

/** Send hands the note to the chat's own send, with its id: it goes out alone, and once the start saved it the list reads it as sent. */
export const SendANote: Story = {
    play: async ({ canvas }) => {
        const notes = await openGuestsTab(canvas);

        await userEvent.click(within(notes).getByRole("button", { name: SEND_HELD }));
        await waitFor(async () => {
            await expect(sends).toHaveLength(1);
        }, STATE_WAIT);
        await expect(sends[0]).toContain("note-held");
        await expect(sends[0]).toContain(HELD);
        await waitFor(async () => {
            await expect(within(notes).queryByRole("button", { name: SEND_HELD })).toBeNull();
        }, STATE_WAIT);
        await expect(within(heldNote(notes)).getByText("Sent")).toBeVisible();
    },
};

/** The chat start fails: nothing saved the note, so it stays waiting with its Send, to be sent again. */
export const SendFails: Story = {
    parameters: {
        msw: {
            handlers: {
                send: http.post(`${env.VITE_LLM_GATEWAY_URL}/v1/chat`, async ({ request }) => {
                    sends.push(await request.text());

                    return HttpResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
                }),
            },
        },
    },
    play: async ({ canvas }) => {
        const notes = await openGuestsTab(canvas);

        await userEvent.click(within(notes).getByRole("button", { name: SEND_HELD }));
        await waitFor(async () => {
            await expect(sends).toHaveLength(1);
        }, STATE_WAIT);
        await waitFor(async () => {
            await expect(within(notes).getByRole("button", { name: SEND_HELD })).toBeEnabled();
        }, STATE_WAIT);
        await expect(within(heldNote(notes)).getByText("Waiting")).toBeVisible();
    },
};

/** Dismiss deletes a waiting note without sending it anywhere. */
export const DismissANote: Story = {
    play: async ({ canvas }) => {
        const notes = await openGuestsTab(canvas);

        await userEvent.click(within(notes).getByRole("button", { name: DISMISS_HELD }));
        await lunoraAnswered(api.chat.guest_links.dismissHeldGuestMessage);
        await waitFor(async () => {
            await expect(within(notes).queryByText(HELD)).toBeNull();
        }, STATE_WAIT);
        await expect(sends).toHaveLength(0);
    },
};
