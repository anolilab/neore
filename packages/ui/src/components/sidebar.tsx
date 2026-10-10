import { useRender } from "@base-ui/react/use-render";
import { useLingui } from "@lingui/react/macro";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import { PanelLeftIcon } from "lucide-react";
import type { ComponentProps, CSSProperties, ReactElement, ReactNode } from "react";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMediaMatch } from "rooks";

import { useLazyRef } from "../hooks/use-lazy-ref";
import MOBILE_BREAKPOINT_QUERY from "../utils/breakpoints";
import cn from "../utils/cn";
import { matchesShortcut } from "../utils/keyboard-shortcuts";
import { Button } from "./button";
import { Input } from "./input";
import KeybindingTooltip from "./keybinding-tooltip";
import { Separator } from "./separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./sheet";
import { Skeleton } from "./skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_WIDTH_MOBILE = "18rem";
const SIDEBAR_WIDTH_ICON = "3rem";
const DEFAULT_KEYBOARD_SHORTCUT = "b";

type SidebarState = {
    isMobileOpen: boolean;
    isOpen: boolean;
};

type SidebarContextProperties<T extends string> = {
    isMobile: boolean;
    setSidebarState: (name: T, state: Partial<SidebarState> | ((previous: SidebarState) => Partial<SidebarState>)) => void;
    sidebars: Record<T, SidebarState>;
    toggleSidebar: (name: T) => void;
};

const SidebarContext = createContext<SidebarContextProperties<any> | null>(null);

const useSidebar = <T extends string>(name: T) => {
    const context = use(SidebarContext);

    if (!context) {
        throw new Error("useSidebar must be used within a SidebarProvider.");
    }

    const sidebarState = context.sidebars[name] ?? {
        isMobileOpen: false,
        isOpen: false,
    };

    return {
        ...sidebarState,
        isMobile: context.isMobile,
        setState: (state: Partial<SidebarState>) => context.setSidebarState(name, state),
        toggle: () => context.toggleSidebar(name),
    };
};

const SidebarProvider = <T extends string>({
    children,
    className,
    defaultOpen = "all",
    keyboardShortcuts,
    onOpenChange: setOpenProperty,
    open: openProperty,
    sidebarNames,
    style,
    ...properties
}: ComponentProps<"div"> & {
    defaultOpen?: "all" | T[];
    keyboardShortcuts?: Partial<Record<T, string>>;
    onOpenChange?: (open: Record<T, SidebarState>) => void;
    open?: Record<T, SidebarState>;
    sidebarNames: ReadonlyArray<T>;
}) => {
    const isMobile = useMediaMatch(MOBILE_BREAKPOINT_QUERY);

    // Initialize sidebar states from props
    const initialSidebars = useMemo(() => {
        const defaultOpenState = defaultOpen === "all" ? sidebarNames : defaultOpen;
        const states: Record<T, SidebarState> = {} as Record<T, SidebarState>;

        sidebarNames.forEach((name) => {
            states[name] = {
                isMobileOpen: false,
                isOpen: !!defaultOpenState.includes(name),
            };
        });

        return states;
    }, [defaultOpen, sidebarNames]);

    const [sidebars, setSidebars] = useState<Record<T, SidebarState>>(initialSidebars);
    // Track whether the state change was triggered internally (vs from parent prop)
    const isInternalChangeRef = useRef(false);

    // Sync controlled value from parent
    useEffect(() => {
        if (openProperty) {
            setSidebars((previous) => {
                return { ...previous, ...openProperty };
            });
        }
    }, [openProperty]);

    // Notify parent of state changes (after render to avoid setState during render)
    // Only notify for internal changes to prevent infinite loops
    useEffect(() => {
        if (!isInternalChangeRef.current) {
            return;
        }

        isInternalChangeRef.current = false;
        setOpenProperty?.(sidebars);
    }, [sidebars, setOpenProperty]);

    const setSidebarState = useCallback((name: T, state: Partial<SidebarState> | ((previous: SidebarState) => Partial<SidebarState>)) => {
        isInternalChangeRef.current = true;
        setSidebars((previous) => {
            const next = { ...previous };
            const currentState = next[name] ?? {
                isMobileOpen: false,
                isOpen: false,
            };

            const newState = typeof state === "function" ? state(currentState) : state;

            next[name] = { ...currentState, ...newState };

            return next;
        });
    }, []);

    const toggleSidebar = useCallback(
        (name: T) => {
            setSidebarState(name, (previous: SidebarState) => {
                return {
                    ...previous,
                    isMobileOpen: isMobile ? !previous.isMobileOpen : previous.isMobileOpen,
                    isOpen: isMobile ? previous.isMobileOpen : !previous.isOpen,
                };
            });
        },
        [isMobile, setSidebarState],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            // Don't handle shortcuts if user is typing in an input
            const target = event.target as HTMLElement | null;
            const activeElement = document.activeElement as HTMLElement | null;

            const isInInput =
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target?.isContentEditable === true ||
                activeElement instanceof HTMLInputElement ||
                activeElement instanceof HTMLTextAreaElement ||
                activeElement?.isContentEditable === true ||
                !!target?.closest("input, textarea, [contenteditable], [data-composer-input]") ||
                !!activeElement?.closest("input, textarea, [contenteditable], [data-composer-input]");

            if (isInInput) {
                // Don't interfere with typing
                return;
            }

            // Check each sidebar's shortcut
            const shortcutEntries = Object.entries(keyboardShortcuts ?? {});

            for (const [name, shortcut] of shortcutEntries) {
                if (!matchesShortcut(event, shortcut as string)) {
                    continue;
                }

                event.preventDefault();
                toggleSidebar(name as T);
            }

            // If no specific shortcuts are provided, use the default shortcut for all sidebars
            if (!keyboardShortcuts && matchesShortcut(event, DEFAULT_KEYBOARD_SHORTCUT)) {
                event.preventDefault();

                for (const name of sidebarNames) {
                    toggleSidebar(name);
                }
            }
        };

        globalThis.addEventListener("keydown", handleKeyDown);

        return () => globalThis.removeEventListener("keydown", handleKeyDown);
    }, [toggleSidebar, keyboardShortcuts, sidebarNames]);

    const contextValue = useMemo<SidebarContextProperties<T>>(() => {
        return {
            isMobile,
            setSidebarState,
            sidebars,
            toggleSidebar,
        };
    }, [sidebars, setSidebarState, toggleSidebar, isMobile]);

    return (
        <SidebarContext value={contextValue}>
            <TooltipProvider delayDuration={0}>
                <div
                    className={cn("group/sidebar-wrapper has-data-[variant=inset]:dark:bg-sidebar flex min-h-svh w-full", className)}
                    data-slot="sidebar-wrapper"
                    style={
                        {
                            "--sidebar-width": SIDEBAR_WIDTH,
                            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
                            ...style,
                        } as CSSProperties
                    }
                    {...properties}
                >
                    {children}
                </div>
            </TooltipProvider>
        </SidebarContext>
    );
};

const Sidebar = <T extends string>({
    children,
    className,
    collapsible = "offcanvas",
    name,
    side = "left",
    variant = "sidebar",
    ...properties
}: ComponentProps<"div"> & {
    collapsible?: "offcanvas" | "icon" | "none";
    name: T;
    side?: "left" | "right";
    variant?: "sidebar" | "floating" | "inset";
}) => {
    const { t } = useLingui();
    const { isMobile, isMobileOpen, isOpen, setState } = useSidebar(name);

    if (collapsible === "none") {
        return (
            <div
                className={cn("dark:bg-sidebar text-brand-black dark:text-brand-white flex h-full w-(--sidebar-width) flex-col", className)}
                data-slot="sidebar"
                {...properties}
            >
                {children}
            </div>
        );
    }

    if (isMobile) {
        return (
            <Sheet onOpenChange={(open) => setState({ isMobileOpen: open })} open={isMobileOpen} {...properties}>
                <SheetContent
                    className="dark:bg-sidebar text-brand-black dark:text-brand-white w-(--sidebar-width) p-0 [&>button]:hidden"
                    data-mobile="true"
                    data-sidebar="sidebar"
                    data-slot="sidebar"
                    side={side}
                    style={
                        {
                            "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
                        } as CSSProperties
                    }
                >
                    <SheetHeader className="sr-only">
                        <SheetTitle>{t`Sidebar`}</SheetTitle>
                        <SheetDescription>{t`Displays the mobile sidebar.`}</SheetDescription>
                    </SheetHeader>
                    <div className="flex h-full w-full flex-col">{children}</div>
                </SheetContent>
            </Sheet>
        );
    }

    return (
        <div
            className="group peer text-brand-black dark:text-brand-white hidden md:block"
            data-collapsible={isOpen ? "" : collapsible}
            data-side={side}
            data-slot="sidebar"
            data-state={isOpen ? "expanded" : "collapsed"}
            data-variant={variant}
        >
            {/* This is what handles the sidebar gap on desktop */}
            <div
                className={cn(
                    "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear",
                    "group-data-[collapsible=offcanvas]:w-0",
                    "group-data-[side=right]:rotate-180",
                    variant === "floating" || variant === "inset"
                        ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
                        : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
                )}
                data-slot="sidebar-gap"
            />
            <div
                className={cn(
                    "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear md:flex",
                    side === "left"
                        ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
                        : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
                    // Adjust the padding for floating and inset variants.
                    variant === "floating" || variant === "inset"
                        ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
                        : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=right]:border-l",
                    // group-data-[side=left]:border-r
                    className,
                )}
                data-slot="sidebar-container"
                {...properties}
            >
                <div
                    className="dark:bg-sidebar group-data-[variant=floating]:border-sidebar-border flex h-full w-full flex-col group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:shadow-sm"
                    data-sidebar="sidebar"
                    data-slot="sidebar-inner"
                >
                    {children}
                </div>
            </div>
        </div>
    );
};

const SidebarTrigger = <T extends string>({
    className,
    icon,
    name,
    onClick,
    ...properties
}: ComponentProps<typeof Button> & {
    icon?: ReactNode;
    name: T;
}) => {
    const { t } = useLingui();
    const { toggle } = useSidebar(name);

    return (
        <Button
            className={cn("size-6", className)}
            data-sidebar="trigger"
            data-slot="sidebar-trigger"
            onClick={(event) => {
                onClick?.(event);
                toggle();
            }}
            size="icon"
            variant="ghost"
            {...properties}
        >
            {icon ?? <PanelLeftIcon />}
            <span className="sr-only">{t`Toggle Sidebar`}</span>
        </Button>
    );
};

const SidebarRail = <T extends string>({
    className,
    name,
    side = "left",
    ...properties
}: ComponentProps<"button"> & {
    name: T;
    side: "left" | "right";
}) => {
    const { t } = useLingui();
    const { isOpen, toggle } = useSidebar(name);

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <button
                        aria-label={t`Toggle Sidebar`}
                        className={cn(
                            "fixed top-1/2 h-20 w-8 -translate-y-1/2 cursor-pointer transition-[left,right,translate] duration-300 ease-in-out in-data-[side=left]:left-(--sidebar-width) in-data-[side=left]:group-data-[collapsible=icon]:left-(--sidebar-width-icon) in-data-[side=left]:group-data-[collapsible=offcanvas]:left-16 in-data-[side=right]:right-(--sidebar-width) in-data-[side=right]:group-data-[collapsible=icon]:right-(--sidebar-width-icon) in-data-[side=right]:group-data-[collapsible=offcanvas]:right-0 max-md:hidden",
                            {
                                "in-data-[side=left]:-translate-x-2 hover:in-data-[side=left]:translate-x-1 in-data-[side=right]:translate-x-1 hover:in-data-[side=right]:-translate-x-2":
                                    isOpen,
                                "in-data-[side=left]:translate-x-1 in-data-[side=right]:-translate-x-1": !isOpen,
                            },
                            className,
                        )}
                        data-sidebar="rail"
                        data-slot="sidebar-rail"
                        onClick={toggle}
                        tabIndex={-1}
                        title={t`Toggle Sidebar`}
                        type="button"
                        {...properties}
                    >
                        <div
                            aria-hidden="true"
                            className="before:bg-muted-foreground after:bg-muted-foreground pointer-events-none h-6 w-4 opacity-50 transition-all ease-in-out group-data-[state=collapsed]:translate-x-0 before:absolute before:top-[calc(50%-7px)] before:h-[9px] before:w-0.5 before:rounded-full before:transition-all after:absolute after:bottom-[calc(50%-7px)] after:h-[9px] after:w-0.5 after:rounded-full after:transition-all in-data-[side=left]:translate-x-2 in-data-[side=left]:before:left-[calc(50%-1px)] in-data-[side=left]:after:left-[calc(50%-1px)] in-data-[side=right]:ml-auto in-data-[side=right]:-translate-x-2 in-data-[side=right]:before:left-[calc(50%+1)] in-data-[side=right]:after:left-[calc(50%+1)] in-[[data-slot=sidebar-rail]:hover]:opacity-100 in-data-[side=left]:in-[[data-slot=sidebar-rail]:hover]:translate-x-1 group-data-[state=collapsed]:in-data-[side=left]:in-[[data-slot=sidebar-rail]:hover]:translate-x-3 group-data-[state=collapsed]:group-data-[collapsible=icon]:in-data-[side=left]:in-[[data-slot=sidebar-rail]:hover]:translate-x-1 in-data-[side=left]:in-[[data-slot=sidebar-rail]:hover]:before:rotate-45 group-data-[state=collapsed]:in-data-[side=left]:in-[[data-slot=sidebar-rail]:hover]:before:-rotate-45 in-data-[side=left]:in-[[data-slot=sidebar-rail]:hover]:after:-rotate-45 group-data-[state=collapsed]:in-data-[side=left]:in-[[data-slot=sidebar-rail]:hover]:after:rotate-45 in-data-[side=right]:in-[[data-slot=sidebar-rail]:hover]:-translate-x-1 group-data-[state=collapsed]:in-data-[side=right]:in-[[data-slot=sidebar-rail]:hover]:-translate-x-3 group-data-[state=collapsed]:group-data-[collapsible=icon]:in-data-[side=right]:in-[[data-slot=sidebar-rail]:hover]:-translate-x-1 in-data-[side=right]:in-[[data-slot=sidebar-rail]:hover]:before:-rotate-45 group-data-[state=collapsed]:in-data-[side=right]:in-[[data-slot=sidebar-rail]:hover]:before:rotate-45 in-data-[side=right]:in-[[data-slot=sidebar-rail]:hover]:after:rotate-45 group-data-[state=collapsed]:in-data-[side=right]:in-[[data-slot=sidebar-rail]:hover]:after:-rotate-45"
                        />
                    </button>
                }
            />
            <TooltipContent className="[&_span]:hidden" side={side === "right" ? "left" : "right"}>
                {isOpen ? t`Collapse` : t`Expand`}
            </TooltipContent>
        </Tooltip>
    );
};

const SidebarInset = ({ className, ...properties }: ComponentProps<"main">) => (
    <main
        className={cn(
            "bg-sidebar relative flex w-full flex-1 flex-col",
            "md:peer-data-[variant=inset]:ring-sidebar-border md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:ring-1 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-1",
            className,
        )}
        data-slot="sidebar-inset"
        id="main-content"
        {...properties}
    />
);

const SidebarInput = ({ className, ...properties }: ComponentProps<typeof Input>) => (
    <Input className={cn("bg-background h-8 w-full shadow-none", className)} data-sidebar="input" data-slot="sidebar-input" {...properties} />
);

const SidebarHeader = ({ className, ...properties }: ComponentProps<"div">) => (
    <div className={cn("flex flex-col gap-2 p-2", className)} data-sidebar="header" data-slot="sidebar-header" {...properties} />
);

const SidebarFooter = ({ className, ...properties }: ComponentProps<"div">) => (
    <div className={cn("flex flex-col items-center gap-2 p-2 pb-1", className)} data-sidebar="footer" data-slot="sidebar-footer" {...properties} />
);

const SidebarSeparator = ({ className, ...properties }: ComponentProps<typeof Separator>) => (
    <Separator className={cn("dark:bg-sidebar-border mx-2 w-auto", className)} data-sidebar="separator" data-slot="sidebar-separator" {...properties} />
);

const SidebarContent = ({ className, ...properties }: ComponentProps<"div">) => (
    <div
        className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden", className)}
        data-sidebar="content"
        data-slot="sidebar-content"
        {...properties}
    />
);

const SidebarGroup = ({ className, ...properties }: ComponentProps<"div">) => (
    <div className={cn("relative flex w-full min-w-0 flex-col items-center", className)} data-sidebar="group" data-slot="sidebar-group" {...properties} />
);

const SidebarGroupLabel = ({ className, render, ...properties }: ComponentProps<"div"> & { render?: ReactElement }) =>
    useRender({
        defaultTagName: "div",
        props: {
            className: cn(
                "text-brand-black/70 dark:text-brand-white/70 ring-sidebar-ring flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
                "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
                className,
            ),
            "data-sidebar": "group-label",
            "data-slot": "sidebar-group-label",
            ...properties,
        },
        render,
    });

const SidebarGroupAction = ({ className, render, ...properties }: ComponentProps<"button"> & { render?: ReactElement }) =>
    useRender({
        defaultTagName: "button",
        props: {
            className: cn(
                "text-brand-black dark:text-brand-white ring-sidebar-ring hover:dark:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 outline-hidden transition-transform focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
                // Increases the hit area of the button on mobile.
                "after:absolute after:-inset-2 md:after:hidden",
                "group-data-[collapsible=icon]:hidden",
                className,
            ),
            "data-sidebar": "group-action",
            "data-slot": "sidebar-group-action",
            ...properties,
        },
        render,
    });

const SidebarGroupContent = ({ className, ...properties }: ComponentProps<"div">) => (
    <div className={cn("w-full text-sm", className)} data-sidebar="group-content" data-slot="sidebar-group-content" {...properties} />
);

const SidebarMenu = ({ className, ...properties }: ComponentProps<"ul">) => (
    <ul className={cn("flex w-full min-w-0 flex-col gap-1", className)} data-sidebar="menu" data-slot="sidebar-menu" {...properties} />
);

const SidebarMenuItem = ({ className, ...properties }: ComponentProps<"li">) => (
    <li className={cn("group/menu-item relative", className)} data-sidebar="menu-item" data-slot="sidebar-menu-item" {...properties} />
);

const sidebarMenuButtonVariants = cva(
    "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding] hover:dark:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:dark:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:dark:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-gray-200 data-[state=open]:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
    {
        defaultVariants: {
            size: "default",
            variant: "default",
        },
        variants: {
            size: {
                default: "h-8 text-sm",
                lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!",
                sm: "h-7 text-xs",
            },
            variant: {
                default: "hover:dark:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                outline:
                    "bg-background shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:dark:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]",
            },
        },
    },
);

const SidebarMenuButton = <T extends string>({
    className,
    isActive = false,
    name,
    render,
    size = "default",
    tooltip,
    variant = "default",
    ...properties
}: ComponentProps<"button"> &
    VariantProps<typeof sidebarMenuButtonVariants> & {
        isActive?: boolean;
        name: T;
        render?: ReactElement;
        tooltip?: string | ComponentProps<typeof TooltipContent>;
    }): ReactElement => {
    const { isMobile, isOpen } = useSidebar(name);

    const button = useRender({
        defaultTagName: "button",
        props: {
            className: cn(sidebarMenuButtonVariants({ size, variant }), className),
            "data-active": isActive,
            "data-sidebar": "menu-button",
            "data-size": size,
            "data-slot": "sidebar-menu-button",
            ...properties,
        },
        render,
    });

    if (!tooltip) {
        return button;
    }

    const tooltipProps = typeof tooltip === "string" ? { children: tooltip } : tooltip;

    return (
        <KeybindingTooltip
            align="center"
            className="mx-1 ml-1 rounded p-1 hover:bg-gray-200"
            hidden={!isOpen || isMobile}
            side="right"
            text={tooltipProps.children}
        >
            {button}
        </KeybindingTooltip>
    );
};

const SidebarMenuAction = ({
    className,
    render,
    showOnHover = false,
    ...properties
}: ComponentProps<"button"> & {
    render?: ReactElement;
    showOnHover?: boolean;
}) =>
    useRender({
        defaultTagName: "button",
        props: {
            className: cn(
                "text-brand-black dark:text-brand-white ring-sidebar-ring hover:dark:bg-sidebar-accent hover:text-sidebar-accent-foreground peer-hover/menu-button:text-sidebar-accent-foreground absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 outline-hidden transition-transform focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
                // Increases the hit area of the button on mobile.
                "after:absolute after:-inset-2 md:after:hidden",
                "peer-data-[size=sm]/menu-button:top-1",
                "peer-data-[size=default]/menu-button:top-1.5",
                "peer-data-[size=lg]/menu-button:top-2.5",
                "group-data-[collapsible=icon]:hidden",
                showOnHover &&
                    "peer-data-[active=true]/menu-button:text-sidebar-accent-foreground group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 md:opacity-0",
                className,
            ),
            "data-sidebar": "menu-action",
            "data-slot": "sidebar-menu-action",
            ...properties,
        },
        render,
    });

const SidebarMenuBadge = ({ className, ...properties }: ComponentProps<"div">) => (
    <div
        className={cn(
            "text-brand-black dark:text-brand-white pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums select-none",
            "peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground",
            "peer-data-[size=sm]/menu-button:top-1",
            "peer-data-[size=default]/menu-button:top-1.5",
            "peer-data-[size=lg]/menu-button:top-2.5",
            "group-data-[collapsible=icon]:hidden",
            className,
        )}
        data-sidebar="menu-badge"
        data-slot="sidebar-menu-badge"
        {...properties}
    />
);

const SidebarMenuSkeleton = ({
    className,
    showIcon = false,
    ...properties
}: ComponentProps<"div"> & {
    showIcon?: boolean;
}) => {
    // Random width between 50 to 90%.
    const width = useLazyRef(() => `${Math.floor(Math.random() * 40) + 50}%`).current;

    return (
        <div
            className={cn("flex h-8 items-center gap-2 rounded-md px-2", className)}
            data-sidebar="menu-skeleton"
            data-slot="sidebar-menu-skeleton"
            {...properties}
        >
            {showIcon && <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />}
            <Skeleton
                className="h-4 max-w-(--skeleton-width) flex-1"
                data-sidebar="menu-skeleton-text"
                style={
                    {
                        "--skeleton-width": width,
                    } as CSSProperties
                }
            />
        </div>
    );
};

const SidebarMenuSub = ({ className, ...properties }: ComponentProps<"ul">) => (
    <ul
        className={cn(
            "border-sidebar-border mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l px-2.5 py-0.5",
            "group-data-[collapsible=icon]:hidden",
            className,
        )}
        data-sidebar="menu-sub"
        data-slot="sidebar-menu-sub"
        {...properties}
    />
);

const SidebarMenuSubItem = ({ className, ...properties }: ComponentProps<"li">) => (
    <li className={cn("group/menu-sub-item relative", className)} data-sidebar="menu-sub-item" data-slot="sidebar-menu-sub-item" {...properties} />
);

const SidebarMenuSubButton = ({
    className,
    isActive = false,
    render,
    size = "md",
    ...properties
}: ComponentProps<"a"> & {
    isActive?: boolean;
    render?: ReactElement;
    size?: "sm" | "md";
}) =>
    useRender({
        defaultTagName: "a",
        props: {
            className: cn(
                "text-brand-black dark:text-brand-white ring-sidebar-ring hover:-accent hover:text-sidebar-accent-foreground active:dark:bg-sidebar-accent active:text-sidebar-accent-foreground [&>svg]:text-sidebar-accent-foreground flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 outline-hidden focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
                "data-[active=true]:dark:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground",
                size === "sm" && "text-xs",
                size === "md" && "text-sm",
                "group-data-[collapsible=icon]:hidden",
                className,
            ),
            "data-active": isActive,
            "data-sidebar": "menu-sub-button",
            "data-size": size,
            "data-slot": "sidebar-menu-sub-button",
            ...properties,
        },
        render,
    });

export {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupAction,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInput,
    SidebarInset,
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSkeleton,
    SidebarMenuSub,
    SidebarMenuSubButton,
    SidebarMenuSubItem,
    SidebarProvider,
    SidebarRail,
    SidebarSeparator,
    SidebarTrigger,
    useSidebar,
};
