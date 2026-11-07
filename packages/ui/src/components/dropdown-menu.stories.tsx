import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent, waitFor } from "storybook/test";

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
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "./dropdown-menu";

const meta: Meta<typeof DropdownMenu> = {
    args: { defaultOpen: true, onOpenChange: fn() },
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
    title: "UI/Dropdown menu",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const OpensFromTrigger: Story = {
    args: { defaultOpen: false },
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Chat actions" }));
        await expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeInTheDocument();
        await expect(args.onOpenChange).toHaveBeenCalledWith(true);
    },
};

export const KeyboardNavigation: Story = {
    args: { defaultOpen: false },
    play: async ({ canvas }) => {
        canvas.getByRole("button", { name: "Chat actions" }).focus();
        await userEvent.keyboard("{Enter}");
        await screen.findByRole("menu");
        await waitFor(() => expect(screen.getByRole("menuitem", { name: /Rename/ })).toHaveFocus());
        await userEvent.keyboard("{ArrowDown}");
        await waitFor(() => expect(screen.getByRole("menuitem", { name: "Pin" })).toHaveFocus());
    },
};

export const WithCheckboxItems: Story = {
    play: async () => {
        const item = await screen.findByRole("menuitemcheckbox", { name: "Compact messages" });

        await userEvent.click(item);
    },
    render: (args) => (
        <DropdownMenu {...args}>
            <DropdownMenuTrigger render={<Button variant="outline">View</Button>} />
            <DropdownMenuContent>
                <DropdownMenuCheckboxItem defaultChecked>Show timestamps</DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem>Compact messages</DropdownMenuCheckboxItem>
            </DropdownMenuContent>
        </DropdownMenu>
    ),
};

export const WithRadioItems: Story = {
    play: async () => {
        await expect(await screen.findByRole("menuitemradio", { name: "Most recent" })).toBeChecked();
    },
    render: (args) => (
        <DropdownMenu {...args}>
            <DropdownMenuTrigger render={<Button variant="outline">Sort</Button>} />
            <DropdownMenuContent>
                <DropdownMenuRadioGroup defaultValue="recent">
                    <DropdownMenuRadioItem value="recent">Most recent</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    ),
};

export const WithSubmenu: Story = {
    render: (args) => (
        <DropdownMenu {...args}>
            <DropdownMenuTrigger render={<Button variant="outline">Move</Button>} />
            <DropdownMenuContent>
                <DropdownMenuItem>Inbox</DropdownMenuItem>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Project</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuItem>Roadmap</DropdownMenuItem>
                        <DropdownMenuItem>Research</DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </DropdownMenuContent>
        </DropdownMenu>
    ),
};
