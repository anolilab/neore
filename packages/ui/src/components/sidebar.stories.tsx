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

/** The sidebar's box, the gap that holds the page's room for it, and the transitions running on each. */
const sidebarParts = (canvasElement: HTMLElement) => {
    // The slide is in the layout boxes, which have no role.
    const container = canvasElement.querySelector<HTMLElement>('[data-slot="sidebar-container"]');
    const gap = canvasElement.querySelector<HTMLElement>('[data-slot="sidebar-gap"]');

    return { container, gap };
};

/** The CSS transitions on an element, by the property they animate, with the time each takes to start and to run. */
const transitionsOf = (element: HTMLElement) =>
    element
        .getAnimations()
        .filter((animation): animation is CSSTransition => animation instanceof CSSTransition)
        .map((transition) => {
            const timing = transition.effect?.getTiming();

            return { delay: Number(timing?.delay ?? 0), duration: Number(timing?.duration ?? 0), property: transition.transitionProperty };
        });

const settled = async (element: HTMLElement) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
};

/**
 * Closing and opening an off-canvas sidebar slides it (translate, on the compositor) and moves the page's edge once: when it has slid
 * out, or at once when it opens. Animating the gap's width instead laid out and painted the page on every frame.
 */
const slidePlay =
    (side: "left" | "right") =>
    async ({ canvas, canvasElement }: { canvas: { getByRole: (role: string, options: { name: string }) => HTMLElement }; canvasElement: HTMLElement }) => {
        const { container, gap } = sidebarParts(canvasElement);

        // On a phone the sidebar is a sheet: there is no gap or sliding box.
        if (!container || !gap) {
            return;
        }

        const { width } = container.getBoundingClientRect();
        const isOffScreen = () => {
            const box = container.getBoundingClientRect();

            return side === "left" ? box.right <= 0 : box.left >= globalThis.innerWidth;
        };

        await userEvent.click(canvas.getByRole("button", { name: "Toggle Sidebar" }));

        // Closing: the box slides, its resting place and the gap wait for the slide to end, and nothing animates the width.
        await expect(transitionsOf(container)).toContainEqual(expect.objectContaining({ duration: 200, property: "translate" }));
        await expect(
            transitionsOf(container)
                .filter((transition) => transition.duration > 0)
                .map((transition) => transition.property),
        ).toStrictEqual(["translate"]);
        await expect(transitionsOf(gap)).toStrictEqual([{ delay: 200, duration: 0, property: "width" }]);
        await expect(gap.getBoundingClientRect().width).toBe(width);

        await settled(container);
        await settled(gap);

        await expect(gap.getBoundingClientRect().width).toBe(0);
        await expect(isOffScreen()).toBe(true);

        await userEvent.click(canvas.getByRole("button", { name: "Toggle Sidebar" }));

        // Opening: the gap takes its width at once, and the box slides in over it.
        await expect(gap.getBoundingClientRect().width).toBe(width);
        await expect(
            transitionsOf(container)
                .filter((transition) => transition.duration > 0)
                .map((transition) => transition.property),
        ).toStrictEqual(["translate"]);

        await settled(container);

        await expect(isOffScreen()).toBe(false);
        await expect(container.getBoundingClientRect().width).toBe(width);
    };

export const SlidesClosedAndOpen: Story = { play: slidePlay("left") };

export const SlidesClosedAndOpenOnTheRight: Story = { args: { side: "right" }, play: slidePlay("right") };
