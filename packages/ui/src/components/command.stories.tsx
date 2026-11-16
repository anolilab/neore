import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Command, CommandFooter, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandSeparator } from "./command";

const meta = {
    component: Command,
    decorators: [
        (Story) => (
            <div className="bg-popover w-96 rounded-xl border">
                <Story />
            </div>
        ),
    ],
    title: "UI/Command",
} satisfies Meta<typeof Command>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("combobox", { name: "Search commands" })).toBeVisible();
        await expect(canvas.getAllByRole("option")).toHaveLength(4);
    },
    render: (args) => (
        <Command {...args}>
            <CommandInput aria-label="Search commands" placeholder="Search commands..." />
            <CommandList>
                <CommandGroup>
                    <CommandGroupLabel>Chat</CommandGroupLabel>
                    <CommandItem value="new-chat">New chat</CommandItem>
                    <CommandItem value="search">Search chats</CommandItem>
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup>
                    <CommandGroupLabel>Account</CommandGroupLabel>
                    <CommandItem value="settings">Settings</CommandItem>
                    <CommandItem disabled value="billing">
                        Billing
                    </CommandItem>
                </CommandGroup>
            </CommandList>
            <CommandFooter>
                <span>Enter to select</span>
                <span>Esc to close</span>
            </CommandFooter>
        </Command>
    ),
};
