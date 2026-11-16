import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import {
    Confirmation,
    ConfirmationAccepted,
    ConfirmationAction,
    ConfirmationActions,
    ConfirmationRejected,
    ConfirmationRequest,
    ConfirmationTitle,
} from "./confirmation";

const meta = {
    args: { state: "approval-requested" },
    component: Confirmation,
    decorators: [
        (Story) => (
            <div className="w-[28rem]">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Confirmation",
} satisfies Meta<typeof Confirmation>;

export default meta;

type Story = StoryObj<typeof meta>;

const Body = () => (
    <>
        <ConfirmationTitle>
            <ConfirmationRequest>This tool wants to delete 3 files. Allow it?</ConfirmationRequest>
            <ConfirmationAccepted>You approved this action.</ConfirmationAccepted>
            <ConfirmationRejected>You rejected this action.</ConfirmationRejected>
        </ConfirmationTitle>
        <ConfirmationActions>
            <ConfirmationAction variant="outline">Deny</ConfirmationAction>
            <ConfirmationAction>Approve</ConfirmationAction>
        </ConfirmationActions>
    </>
);

export const Requested: Story = {
    args: { approval: { id: "a1" }, children: <Body /> },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("This tool wants to delete 3 files. Allow it?")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Approve" })).toBeVisible();
    },
};

export const RequestedWithHandlers: Story = {
    args: {
        approval: { id: "a1" },
        children: (
            <ConfirmationActions>
                <ConfirmationAction onClick={fn()} variant="outline">
                    Deny
                </ConfirmationAction>
                <ConfirmationAction onClick={fn()}>Approve</ConfirmationAction>
            </ConfirmationActions>
        ),
    },
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Deny" }));
    },
};

export const Accepted: Story = {
    args: { approval: { approved: true, id: "a1" }, children: <Body />, state: "approval-responded" },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("You approved this action.")).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "Approve" })).toBeNull();
    },
};

export const Rejected: Story = {
    args: { approval: { approved: false, id: "a1" }, children: <Body />, state: "output-denied" },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("You rejected this action.")).toBeVisible();
    },
};

export const HiddenWhileInputStreams: Story = {
    args: { approval: { id: "a1" }, children: <Body />, state: "input-streaming" },
    play: async ({ canvas }) => {
        await expect(canvas.queryByRole("alert")).toBeNull();
    },
};
