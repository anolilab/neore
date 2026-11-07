import type { Meta, StoryObj } from "@storybook/react-vite";

import Persona from "./persona";

const meta: Meta<typeof Persona> = {
    args: { className: "size-32", state: "idle" },
    component: Persona,
    title: "Chat/Persona",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const Listening: Story = { args: { state: "listening" } };

export const Thinking: Story = { args: { state: "thinking" } };

export const Speaking: Story = { args: { state: "speaking" } };

export const Asleep: Story = { args: { state: "asleep" } };

export const Glint: Story = { args: { state: "idle", variant: "glint" } };
