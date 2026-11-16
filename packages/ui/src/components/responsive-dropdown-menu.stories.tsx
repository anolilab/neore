import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent } from "storybook/test";

import { Button } from "./button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from "./responsive-dropdown-menu";

/** A positioned menu on wide screens and a bottom sheet below 768 px; the Mobile viewport shows the sheet. */
const meta: Meta<typeof DropdownMenu> = {
    args: { onOpenChange: fn(), open: true },
    component: DropdownMenu,
    decorators: [
        (Story) => (
            <div className="min-h-72">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <DropdownMenu {...args}>
            <DropdownMenuTrigger render={<Button variant="outline">Chat actions</Button>} />
            <DropdownMenuContent>
                <DropdownMenuGroup>
                    <DropdownMenuLabel>Chat</DropdownMenuLabel>
                    <DropdownMenuItem>
                        Rename
                        <DropdownMenuShortcut>F2</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem>Pin</DropdownMenuItem>
                    <DropdownMenuItem disabled>Export</DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    ),
    title: "UI/Responsive dropdown menu",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const OpensFromTrigger: Story = {
    args: { open: undefined },
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Chat actions" }));
        await expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeInTheDocument();
    },
};

export const WithCheckboxAndRadioItems: Story = {
    render: (args) => (
        <DropdownMenu {...args}>
            <DropdownMenuTrigger render={<Button variant="outline">View</Button>} />
            <DropdownMenuContent>
                <DropdownMenuCheckboxItem defaultChecked>Show timestamps</DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup defaultValue="comfortable">
                    <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    ),
};
