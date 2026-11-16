import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, screen } from "storybook/test";

import {
    ContextMenu,
    ContextMenuCheckboxItem,
    ContextMenuContent,
    ContextMenuGroup,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuRadioGroup,
    ContextMenuRadioItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
} from "./context-menu";

const meta = {
    component: ContextMenu,
    decorators: [
        (Story) => (
            <div className="min-h-72">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <ContextMenu {...args}>
            <ContextMenuTrigger className="flex h-32 w-72 items-center justify-center rounded-md border border-dashed text-sm">
                Right-click this area
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuGroup>
                    <ContextMenuLabel>Message</ContextMenuLabel>
                    <ContextMenuItem>
                        Copy
                        <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem>Quote</ContextMenuItem>
                    <ContextMenuItem disabled>Edit</ContextMenuItem>
                </ContextMenuGroup>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    ),
    title: "UI/Context menu",
} satisfies Meta<typeof ContextMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

const openMenu = async (canvas: { getByText: (text: string) => HTMLElement }) => {
    fireEvent.contextMenu(canvas.getByText("Right-click this area"), { clientX: 40, clientY: 40 });
    await screen.findByRole("menu");
};

export const Closed: Story = {};

export const Open: Story = {
    play: async ({ canvas }) => {
        await openMenu(canvas);
        await expect(screen.getByRole("menuitem", { name: /Copy/ })).toBeInTheDocument();
        await expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveAttribute("aria-disabled", "true");
    },
};

export const WithCheckboxAndRadio: Story = {
    play: async ({ canvas }) => {
        await openMenu(canvas);
        await expect(screen.getByRole("menuitemcheckbox", { name: "Show line numbers" })).toBeChecked();
        await expect(screen.getByRole("menuitemradio", { name: "Wrap lines" })).toBeChecked();
    },
    render: (args) => (
        <ContextMenu {...args}>
            <ContextMenuTrigger className="flex h-32 w-72 items-center justify-center rounded-md border border-dashed text-sm">
                Right-click this area
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuCheckboxItem defaultChecked>Show line numbers</ContextMenuCheckboxItem>
                <ContextMenuSeparator />
                <ContextMenuRadioGroup defaultValue="wrap">
                    <ContextMenuRadioItem value="wrap">Wrap lines</ContextMenuRadioItem>
                    <ContextMenuRadioItem value="scroll">Scroll sideways</ContextMenuRadioItem>
                </ContextMenuRadioGroup>
            </ContextMenuContent>
        </ContextMenu>
    ),
};

export const WithSubmenu: Story = {
    play: async ({ canvas }) => {
        await openMenu(canvas);
        await expect(screen.getByRole("menuitem", { name: "Share" })).toBeInTheDocument();
    },
    render: (args) => (
        <ContextMenu {...args}>
            <ContextMenuTrigger className="flex h-32 w-72 items-center justify-center rounded-md border border-dashed text-sm">
                Right-click this area
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem>Open</ContextMenuItem>
                <ContextMenuSub>
                    <ContextMenuSubTrigger>Share</ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        <ContextMenuItem>Copy link</ContextMenuItem>
                        <ContextMenuItem>Email</ContextMenuItem>
                    </ContextMenuSubContent>
                </ContextMenuSub>
            </ContextMenuContent>
        </ContextMenu>
    ),
};
