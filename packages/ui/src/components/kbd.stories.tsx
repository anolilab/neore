import type { Meta, StoryObj } from "@storybook/react-vite";

import { Kbd, KbdGroup } from "./kbd";

const meta = {
    args: { children: "K" },
    component: Kbd,
    title: "UI/Kbd",
} satisfies Meta<typeof Kbd>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Combination: Story = {
    render: () => (
        <KbdGroup>
            <Kbd>Ctrl</Kbd>
            <Kbd>Shift</Kbd>
            <Kbd>P</Kbd>
        </KbdGroup>
    ),
};

export const InsideText: Story = {
    render: () => (
        <p className="text-sm">
            Press <Kbd>Esc</Kbd> to close the dialog.
        </p>
    ),
};
