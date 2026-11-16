import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { KeyCombo, Keys, KeySymbol, ShortcutsProvider } from "./keyboard-shortcuts";

const meta: Meta<typeof KeyCombo> = {
    args: { keyNames: [Keys.Command, Keys.Shift, "z"] },
    component: KeyCombo,
    decorators: [
        (Story) => (
            <ShortcutsProvider os="mac">
                <Story />
            </ShortcutsProvider>
        ),
    ],
    title: "UI/Keyboard shortcuts",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const MacCombo: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("⌘")).toBeInTheDocument();
        await expect(canvas.getByText("⇧")).toBeInTheDocument();
    },
};

export const WithoutTooltips: Story = { args: { disableTooltips: true } };

export const SingleKey: Story = {
    render: () => <KeySymbol keyName={Keys.Escape} />,
};

export const NavigationKeys: Story = {
    render: () => (
        <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between gap-6">
                <span>Move selection</span>
                <KeyCombo keyNames={[Keys.ArrowUp, Keys.ArrowDown]} />
            </div>
            <div className="flex items-center justify-between gap-6">
                <span>Send</span>
                <KeyCombo keyNames={[Keys.Command, Keys.Enter]} />
            </div>
            <div className="flex items-center justify-between gap-6">
                <span>Dismiss</span>
                <KeyCombo keyNames={[Keys.Escape]} />
            </div>
        </div>
    ),
};
