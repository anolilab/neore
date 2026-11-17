import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent, waitFor } from "storybook/test";

import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraError, lunoraHandlers } from "@/storybook/lunora";

import SendFeedbackDialog from "./send-feedback-dialog";

const submitted = fn((args: unknown) => args);

const meta = {
    args: { onOpenChange: fn(), open: true },
    component: SendFeedbackDialog,
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    lunora(api.feedback.functions.submitFeedback, (args) => {
                        submitted(args);

                        return { feedbackId: "feedback-1" as never };
                    }),
                ),
            },
        },
        route: "/chat/thread-1",
    },
    title: "Feedback/Send feedback",
} satisfies Meta<typeof SendFeedbackDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Open and empty: nothing to send yet, and the page that would go with it is shown. */
export const Empty: Story = {
    play: async () => {
        await expect(await screen.findByRole("dialog", { name: "Send feedback" })).toBeVisible();
        await expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        await expect(screen.getByRole("checkbox", { name: /Include the page you are on/u })).toBeChecked();
        await expect(screen.getByText("/chat/thread-1")).toBeVisible();
    },
};

/** A problem written and sent with the page path; the dialog closes. */
export const Sent: Story = {
    play: async ({ args }) => {
        submitted.mockClear();
        await userEvent.click(await screen.findByRole("radio", { name: "Problem" }));
        await userEvent.type(screen.getByRole("textbox", { name: "Your feedback" }), "The menu does not open.");
        await userEvent.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => expect(args.onOpenChange).toHaveBeenCalledWith(false));
        await expect(submitted).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "problem", message: "The menu does not open.", pagePath: "/chat/thread-1", uploadIds: [] }),
        );
    },
};

/** The server refused (rate limited): the dialog says so, stays open and keeps the text. */
export const Refused: Story = {
    parameters: {
        msw: {
            handlers: { lunora: lunoraHandlers(...userFixtures(), lunoraError(api.feedback.functions.submitFeedback, "TOO_MANY_REQUESTS", "Slow down", 429)) },
        },
    },
    play: async ({ args }) => {
        await userEvent.type(await screen.findByRole("textbox", { name: "Your feedback" }), "Hello");
        await userEvent.click(screen.getByRole("button", { name: "Send" }));

        await expect(await screen.findByRole("alert")).toHaveTextContent("You have sent a lot of feedback recently. Please try again in an hour.");
        await expect(args.onOpenChange).not.toHaveBeenCalledWith(false);
        await expect(screen.getByRole("textbox", { name: "Your feedback" })).toHaveValue("Hello");
    },
};
