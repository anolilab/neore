import { api } from "@neore/backend/api";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@neore/ui/components/sidebar";
import cn from "@neore/ui/utils/cn";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { useCallback } from "react";

import { createLunoraQueryOptions, useLunora } from "@/lib/lunora/crpc";
import type { FileRouteTypes } from "@/routeTree.gen";

const colorModeClasses = {
    dark: {
        button: "text-white/80 hover:text-white hover:bg-white/10 data-[state=open]:bg-white/10",
        buttonActive: "bg-white/20 text-white",
        group: "group-data-[collapsible=icon]:hidden",
        icon: "text-white/70",
        iconActive: "text-white",
        label: "text-white/90",
    },
    light: {
        button: "text-gray-700 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-white dark:hover:bg-gray-800",
        buttonActive: "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-white",
        group: "group-data-[collapsible=icon]:hidden",
        icon: "text-gray-600 dark:text-gray-400",
        iconActive: "text-gray-900 dark:text-white",
        label: "text-gray-700 dark:text-gray-300",
    },
};

export type NavItem = {
    icon: LucideIcon;
    name: string;
    url: string;
};

export type ColorMode = "light" | "dark";

const NavItems = ({
    classes: classNames,
    colorMode = "light",
    items,
    label,
}: {
    classes?: { button?: string; buttonActive?: string; group?: string; icon?: string; iconActive?: string; label?: string };
    colorMode?: ColorMode;
    items: NavItem[];
    label: string;
}) => {
    const classes = colorModeClasses[colorMode];
    const router = useRouter();
    const queryClient = useQueryClient();
    const lunoraClient = useLunora();

    // Prefetch route and user settings on hover for faster navigation
    const handleMouseEnter = useCallback(
        (url: string) => {
            // Prefetch the route
            router
                .preloadRoute({
                    // `url` comes from the runtime `NavItem` list, so it has to be narrowed to the
                    // generated route-path union before the router will accept it.
                    to: url as FileRouteTypes["to"],
                })
                .catch(() => {
                    // Prefetch functions never throw errors, but catch just in case
                });

            // If it's a settings route, prefetch user settings
            // This ensures settings data is ready when the user navigates
            if (url.includes("/settings")) {
                queryClient
                    .prefetchQuery({
                        ...createLunoraQueryOptions(lunoraClient, api.auth.functions.getUserSettings, {}),
                        staleTime: 30_000, // 30 seconds - settings don't change frequently
                    })
                    .catch(() => {
                        // Silently handle errors - component will fetch on mount if this fails
                    });
            }
        },
        [router, queryClient, lunoraClient],
    );

    return (
        <SidebarGroup className={cn(classes.group, classNames?.group)}>
            <SidebarGroupLabel className={cn(classes.label, classNames?.label)}>{label}</SidebarGroupLabel>
            <SidebarMenu>
                {items.map((item) => (
                    <SidebarMenuItem key={item.name}>
                        <SidebarMenuButton
                            className={cn(classes.button, classNames?.button)}
                            name={item.name}
                            onMouseEnter={() => handleMouseEnter(item.url)}
                            render={
                                <Link
                                    activeOptions={{
                                        // Match exact path for main routes, and include sub-paths for settings
                                        exact: !item.url.includes("/settings"),
                                    }}
                                    activeProps={{
                                        className: cn(classes.buttonActive, classNames?.buttonActive),
                                    }}
                                    from="/dashboard"
                                    to={item.url}
                                >
                                    {({ isActive }) => (
                                        <>
                                            <item.icon className={cn(isActive ? classes.iconActive : classes.icon, classNames?.icon)} />
                                            <span>{item.name}</span>
                                        </>
                                    )}
                                </Link>
                            }
                        />
                    </SidebarMenuItem>
                ))}
            </SidebarMenu>
        </SidebarGroup>
    );
};

export default NavItems;
