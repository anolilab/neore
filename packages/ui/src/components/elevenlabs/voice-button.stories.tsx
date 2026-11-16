import type { Meta, StoryObj } from "@storybook/react-vite";
import { MicIcon } from "lucide-react";
import { expect, fn, userEvent } from "storybook/test";

import VoiceButton from "./voice-button";

const meta = {
    args: { label: "Dictate", onPress: fn(), trailing: "⌥Space" },
    argTypes: {
        size: { control: "select", options: ["default", "sm", "lg", "icon"] },
        state: { control: "select", options: ["idle", "recording", "processing", "success", "error"] },
        variant: { control: "select", options: ["default", "destructive", "outline", "secondary", "ghost", "link"] },
    },
    component: VoiceButton,
    title: "UI/Voice/VoiceButton",
} satisfies Meta<typeof VoiceButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Idle: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: /Voice Button/u }));
        await expect(args.onPress).toHaveBeenCalledOnce();
    },
};

/** The button is disabled while the transcript is being produced. */
export const Processing: Story = {
    args: { state: "processing" },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: /Processing voice input/u })).toBeDisabled();
    },
};

/** The result shows for `feedbackDuration`, then the button returns to idle. */
export const Success: Story = {
    args: { feedbackDuration: 600_000, state: "success" },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: /Voice input complete/u })).toBeEnabled();
    },
};

export const Failed: Story = {
    args: { feedbackDuration: 600_000, state: "error" },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: /Voice input failed/u })).toBeEnabled();
    },
};

export const Disabled: Story = {
    args: { disabled: true },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: /Voice Button/u })).toBeDisabled();
    },
};

export const IconOnly: Story = {
    args: { icon: <MicIcon aria-hidden="true" className="size-4" />, label: undefined, size: "icon", trailing: undefined },
};

export const Small: Story = { args: { size: "sm", trailing: undefined } };

export const Large: Story = { args: { size: "lg" } };

export const Secondary: Story = { args: { variant: "secondary" } };
