import type { Meta, StoryObj } from "@storybook/react-vite";
import { HomeIcon, InboxIcon, SettingsIcon } from "lucide-react";
import { expect, screen, userEvent } from "storybook/test";

import MOBILE_BREAKPOINT_QUERY from "../utils/breakpoints";
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
    SidebarRail,
    SidebarTrigger,
} from "./sidebar";

const NAMES = ["main"] as const;

type LayoutProps = {
    collapsible?: "offcanvas" | "icon" | "none";
    defaultOpen?: "all" | (typeof NAMES)[number][];
    side?: "left" | "right";
    variant?: "sidebar" | "floating" | "inset";
    /** Puts a 4rem launcher column at the viewport's edge, with the sidebar starting beside it (the app's layout). */
    withLauncher?: boolean;
    /** Adds the rail that reopens a collapsed sidebar from the viewport's edge. */
    withRail?: boolean;
};

const Layout = ({ collapsible, defaultOpen = "all", side, variant, withLauncher = false, withRail = false }: LayoutProps) => (
    <SidebarProvider className="min-h-80" defaultOpen={defaultOpen} sidebarNames={NAMES}>
        {withLauncher && <div className="bg-sidebar relative z-20 hidden h-svh w-16 shrink-0 md:block" data-testid="launcher" />}
        <Sidebar
            aria-label="Workspace"
            className={withLauncher ? "left-16 [--sidebar-offset:4rem]" : undefined}
            collapsible={collapsible}
            name="main"
            rail={withRail ? <SidebarRail name="main" side={side ?? "left"} /> : undefined}
            side={side}
            variant={variant}
        >
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

/** The rail, once it has settled, lies inside the viewport and is the element a click there reaches. */
const expectRailReachable = async (canvasElement: HTMLElement) => {
    const rail = canvasElement.querySelector<HTMLElement>('[data-slot="sidebar-rail"]');

    await expect(rail).not.toBeNull();

    if (!rail) {
        return;
    }

    await settled(rail);

    const box = rail.getBoundingClientRect();

    await expect({ inside: box.width > 0 && box.left >= 0 && box.right <= globalThis.innerWidth }).toStrictEqual({ inside: true });
    await expect(rail.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))).toBe(true);
};

/**
 * Closing and opening an off-canvas sidebar slides it (translate, on the compositor) and moves the page's edge once: when it has slid
 * out, or at once when it opens. Animating the gap's width instead laid out and painted the page on every frame. The rail stays at the
 * viewport's edge to open it again; with reduced motion everything settles at once.
 */
const slidePlay =
    (side: "left" | "right") =>
    async ({ canvasElement }: { canvasElement: HTMLElement }) => {
        const { container, gap } = sidebarParts(canvasElement);
        const trigger = canvasElement.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');
        const sidebar = canvasElement.querySelector<HTMLElement>('[data-slot="sidebar"]');

        await expect(trigger).not.toBeNull();

        if (!trigger) {
            return;
        }

        // On a phone the sidebar is a sheet, opened by the trigger: it slides in as a dialog, with no gap or sliding box.
        if (globalThis.matchMedia(MOBILE_BREAKPOINT_QUERY).matches) {
            await expect(container).toBeNull();
            await userEvent.click(trigger);
            await expect(await screen.findByRole("dialog", { name: "Sidebar" })).toBeVisible();

            return;
        }

        // On a wider screen both boxes must be there: a missing one is a broken layout, not a phone.
        await expect(container).not.toBeNull();
        await expect(gap).not.toBeNull();

        if (!container || !gap) {
            return;
        }

        const { width } = container.getBoundingClientRect();
        const isOffScreen = () => {
            const box = container.getBoundingClientRect();

            return side === "left" ? box.right <= 0 : box.left >= globalThis.innerWidth;
        };
        const moving = (element: HTMLElement) =>
            transitionsOf(element)
                .filter((transition) => transition.duration > 0.01)
                .map((transition) => transition.property);
        // Under reduced motion nothing may run or wait: a delayed resting place would hold the page's edge for the slide's length.
        const movingOrWaiting = (element: HTMLElement) =>
            transitionsOf(element)
                .filter((transition) => transition.duration > 0.01 || transition.delay > 0)
                .map((transition) => transition.property);

        // Reduced motion: nothing slides; the box and the page's edge reach their places at once, together.
        if (globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            await userEvent.click(trigger);
            await expect(movingOrWaiting(container)).toStrictEqual([]);
            await expect(movingOrWaiting(gap)).toStrictEqual([]);
            await settled(container);
            await settled(gap);
            await expect(gap.getBoundingClientRect().width).toBe(0);
            await expect(isOffScreen()).toBe(true);
            await expectRailReachable(canvasElement);

            await userEvent.click(trigger);
            await expect(movingOrWaiting(container)).toStrictEqual([]);
            await expect(movingOrWaiting(gap)).toStrictEqual([]);
            // The global reduced-motion rule leaves a 0.01 ms transition: settled within a frame.
            await settled(container);
            await settled(gap);
            await expect(gap.getBoundingClientRect().width).toBe(width);
            await expect(isOffScreen()).toBe(false);

            return;
        }

        await userEvent.click(trigger);

        // Closing: the box slides, its resting place and the gap wait for the slide to end, and nothing animates the width.
        await expect(transitionsOf(container)).toContainEqual(expect.objectContaining({ duration: 200, property: "translate" }));
        await expect(moving(container)).toStrictEqual(["translate"]);
        await expect(transitionsOf(gap)).toStrictEqual([{ delay: 200, duration: 0, property: "width" }]);
        await expect(gap.getBoundingClientRect().width).toBe(width);

        await settled(container);
        await settled(gap);

        await expect(gap.getBoundingClientRect().width).toBe(0);
        await expect(isOffScreen()).toBe(true);

        // The rail stays at the viewport's edge, and a click on it opens the sidebar again.
        await expectRailReachable(canvasElement);
        await userEvent.click(canvasElement.querySelector<HTMLElement>('[data-slot="sidebar-rail"]') ?? trigger);
        await expect(sidebar?.dataset.state).toBe("expanded");

        // Opening: the gap takes its width at once, and the box slides in over it.
        await expect(gap.getBoundingClientRect().width).toBe(width);
        await expect(moving(container)).toStrictEqual(["translate"]);

        await settled(container);

        await expect(isOffScreen()).toBe(false);
        await expect(container.getBoundingClientRect().width).toBe(width);
    };

export const SlidesClosedAndOpen: Story = { args: { withRail: true }, play: slidePlay("left"), tags: ["reduced-motion"] };

export const SlidesClosedAndOpenOnTheRight: Story = { args: { side: "right", withRail: true }, play: slidePlay("right"), tags: ["reduced-motion"] };

/**
 * A sidebar that starts beside a launcher slides far enough to clear it: by its width plus the launcher's, so its last frames before
 * it settles off screen do not sit over the launcher.
 */
export const SlidesClearOfTheLauncher: Story = {
    args: { withLauncher: true },
    play: async ({ canvasElement }) => {
        if (globalThis.matchMedia(MOBILE_BREAKPOINT_QUERY).matches) {
            return;
        }

        const { container } = sidebarParts(canvasElement);
        const launcher = canvasElement.querySelector<HTMLElement>('[data-testid="launcher"]');
        const trigger = canvasElement.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');

        await expect(container).not.toBeNull();
        await expect(launcher).not.toBeNull();
        await expect(trigger).not.toBeNull();

        if (!container || !launcher || !trigger) {
            return;
        }

        const { width } = container.getBoundingClientRect();
        const launcherBox = launcher.getBoundingClientRect();

        await userEvent.click(trigger);

        // Held a frame before the slide ends, with the box's resting place still to come: the box's last frame of the slide.
        const transitions = container.getAnimations().filter((animation): animation is CSSTransition => animation instanceof CSSTransition);
        const slide = transitions.find((transition) => transition.transitionProperty === "translate");

        await expect(slide).toBeDefined();

        for (const transition of transitions) {
            transition.pause();
            transition.currentTime = transition === slide ? 199 : 0;
        }

        // Within a few pixels of the end: the box's right edge has cleared the launcher, not stopped on its right edge.
        await expect(container.getBoundingClientRect().right).toBeLessThanOrEqual(launcherBox.left + 4);

        for (const transition of transitions) {
            transition.finish();
        }

        await expect(container.getBoundingClientRect().right).toBeLessThanOrEqual(launcherBox.left);
        await expect(width).toBeGreaterThan(0);
    },
};
