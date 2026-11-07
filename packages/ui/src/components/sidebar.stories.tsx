import type { Meta, StoryObj } from "@storybook/react-vite";
import { HomeIcon, InboxIcon, SettingsIcon } from "lucide-react";
import { expect, userEvent } from "storybook/test";

import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarTrigger,
} from "./sidebar";

const NAMES = ["main"] as const;

type LayoutProps = {
    collapsible?: "offcanvas" | "icon" | "none";
    defaultOpen?: "all" | (typeof NAMES)[number][];
    side?: "left" | "right";
    variant?: "sidebar" | "floating" | "inset";
};

const Layout = ({ collapsible, defaultOpen = "all", side, variant }: LayoutProps) => (
    <SidebarProvider className="min-h-80" defaultOpen={defaultOpen} sidebarNames={NAMES}>
        <Sidebar aria-label="Workspace" collapsible={collapsible} name="main" side={side} variant={variant}>
            <SidebarHeader>
                <p className="px-2 text-sm font-medium">Workspace</p>
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupLabel>Navigate</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <SidebarMenuButton isActive name="main">
                                    <HomeIcon />
                                    <span>Home</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                            <SidebarMenuItem>
                                <SidebarMenuButton name="main">
                                    <InboxIcon />
                                    <span>Inbox</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton name="main">
                            <SettingsIcon />
                            <span>Settings</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
        </Sidebar>
        <SidebarInset>
            <header className="flex items-center gap-2 p-2">
                <SidebarTrigger name="main" />
                <span className="text-sm">Page content</span>
            </header>
        </SidebarInset>
    </SidebarProvider>
);

const meta = {
    component: Layout,
    parameters: { layout: "fullscreen" },
    title: "UI/Sidebar",
} satisfies Meta<typeof Layout>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Open: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Home" })).toBeVisible();
    },
};

export const CollapseWithTrigger: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Toggle Sidebar" }));
        await expect(canvas.getByRole("button", { name: "Toggle Sidebar" })).toBeVisible();
    },
};

export const Closed: Story = { args: { defaultOpen: [] } };

export const IconCollapsible: Story = { args: { collapsible: "icon" } };

export const RightSide: Story = { args: { side: "right" } };

export const Floating: Story = { args: { variant: "floating" } };
