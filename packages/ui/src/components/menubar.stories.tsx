import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent } from "storybook/test";

import {
    Menubar,
    MenubarCheckboxItem,
    MenubarContent,
    MenubarItem,
    MenubarMenu,
    MenubarRadioGroup,
    MenubarRadioItem,
    MenubarSeparator,
    MenubarShortcut,
    MenubarTrigger,
} from "./menubar";

const meta = {
    component: Menubar,
    decorators: [
        (Story) => (
            <div className="min-h-64">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <Menubar {...args}>
            <MenubarMenu>
                <MenubarTrigger>File</MenubarTrigger>
                <MenubarContent>
                    <MenubarItem>
                        New chat
                        <MenubarShortcut>Ctrl+N</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem disabled>Export</MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem variant="destructive">Delete all</MenubarItem>
                </MenubarContent>
            </MenubarMenu>
            <MenubarMenu>
                <MenubarTrigger>View</MenubarTrigger>
                <MenubarContent>
                    <MenubarCheckboxItem defaultChecked>Show sidebar</MenubarCheckboxItem>
                    <MenubarSeparator />
                    <MenubarRadioGroup defaultValue="comfortable">
                        <MenubarRadioItem value="comfortable">Comfortable</MenubarRadioItem>
                        <MenubarRadioItem value="compact">Compact</MenubarRadioItem>
                    </MenubarRadioGroup>
                </MenubarContent>
            </MenubarMenu>
        </Menubar>
    ),
    title: "UI/Menubar",
} satisfies Meta<typeof Menubar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const FileMenuOpen: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("menuitem", { name: "File" }));
        await expect(await screen.findByRole("menuitem", { name: /New chat/ })).toBeInTheDocument();
    },
};

export const ViewMenuOpen: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("menuitem", { name: "View" }));
        await expect(await screen.findByRole("menuitemcheckbox", { name: "Show sidebar" })).toBeChecked();
        await expect(screen.getByRole("menuitemradio", { name: "Comfortable" })).toBeChecked();
    },
};
