import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Authenticated } from "@lunora/react";
import { api } from "@neore/backend/api";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@neore/ui/components/breadcrumb";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { SidebarInset, SidebarTrigger } from "@neore/ui/components/sidebar";
import ModeToggle from "@neore/ui/components/theme-toggle";
import { createFileRoute, isRedirect, Outlet, redirect, useLocation } from "@tanstack/react-router";
import { ClipboardList, LayoutDashboard, MessageSquare, ShieldAlert, Trash2, Users } from "lucide-react";
import { Fragment } from "react";

import AppSidebar from "@/features/layout/components/app-sidebar";
import DashboardSidebarProvider from "@/features/layout/components/dashboard-sidebar-provider";
import NavItems from "@/features/layout/components/nav-items";
import SiteHeader from "@/features/layout/components/site-header";
import { requireSession } from "@/lib/auth/route-guard";

/** Descriptors, not strings: module scope — the component translates them (`i18n._`). */
const ADMIN_NAV_ITEMS: { icon: typeof LayoutDashboard; name: MessageDescriptor; url: string }[] = [
    {
        icon: LayoutDashboard,
        name: msg`Dashboard`,
        url: "/admin",
    },
    {
        icon: Users,
        name: msg`Users`,
        url: "/admin/users",
    },
    {
        icon: ClipboardList,
        name: msg`Audit Log`,
        url: "/admin/audit-log",
    },
    {
        icon: ShieldAlert,
        name: msg`NSFW Review`,
        url: "/admin/nsfw-review",
    },
    {
        icon: Trash2,
        name: msg`Cleanup`,
        url: "/admin/cleanup",
    },
];

/** Breadcrumb names of the admin path segments; any other segment is shown capitalised, as it is. */
const ADMIN_SEGMENT_NAMES: Record<string, MessageDescriptor> = {
    admin: msg`Admin`,
    "audit-log": msg`Audit Log`,
    cleanup: msg`Cleanup`,
    gateway: msg`Gateway`,
    keys: msg`API Keys`,
    "nsfw-review": msg`NSFW Review`,
    users: msg`Users`,
};

const sidebarHeader = (
    <div className="flex items-center gap-2 px-4 py-2">
        <div className="dark:bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
            <MessageSquare className="size-4" />
        </div>
        <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">
                <Trans>AI Chat</Trans>
            </span>
            <span className="truncate text-xs">
                <Trans>Admin</Trans>
            </span>
        </div>
    </div>
);

const RouteComponent = () => {
    const { i18n } = useLingui();
    const adminNavItems = ADMIN_NAV_ITEMS.map((item) => {
        return { ...item, name: i18n._(item.name) };
    });
    const sidebarContent = <NavItems classes={{ group: "pl-2" }} colorMode="dark" items={adminNavItems} label={i18n._(msg`Admin`)} />;
    const location = useLocation();
    const { pathname } = location;

    const pathSegments = pathname.split("/").filter(Boolean);

    const breadcrumbItems = pathSegments.map((segment, index) => {
        const href = `/${pathSegments.slice(0, index + 1).join("/")}`;

        return {
            href,
            isLast: index === pathSegments.length - 1,
            label: Object.hasOwn(ADMIN_SEGMENT_NAMES, segment)
                ? i18n._(ADMIN_SEGMENT_NAMES[segment] as MessageDescriptor)
                : segment.charAt(0).toUpperCase() + segment.slice(1),
        };
    });

    return (
        <Authenticated>
            <DashboardSidebarProvider
                sidebarNames={["left", "right"]}
                style={
                    {
                        "--header-height": "calc(var(--spacing) * 8.5)",
                        "--sidebar-width": "calc(var(--spacing) * 66)",
                    } as React.CSSProperties
                }
            >
                <div className="flex h-dvh w-full">
                    <AppSidebar content={sidebarContent} header={sidebarHeader} name="overlay" />
                    <SidebarInset className="dark:bg-sidebar-foreground bg-white md:peer-data-[variant=inset]:m-1">
                        <SiteHeader themeToggle={<ModeToggle className="text-foreground" />} trigger={<SidebarTrigger className="ml-2" name="left" />}>
                            <Breadcrumb>
                                <BreadcrumbList>
                                    {breadcrumbItems.map((item, index) => (
                                        <Fragment key={item.href}>
                                            <BreadcrumbItem>
                                                {item.isLast ? (
                                                    <BreadcrumbPage className="text-foreground font-medium">{item.label}</BreadcrumbPage>
                                                ) : (
                                                    <BreadcrumbLink
                                                        className="hover:text-muted-foreground hover:dark:text-muted-foreground text-sm text-black capitalize transition-colors dark:text-white"
                                                        href={item.href}
                                                    >
                                                        {item.label}
                                                    </BreadcrumbLink>
                                                )}
                                            </BreadcrumbItem>
                                            {index < breadcrumbItems.length - 1 && <BreadcrumbSeparator className="text-muted-foreground mx-2" />}
                                        </Fragment>
                                    ))}
                                </BreadcrumbList>
                            </Breadcrumb>
                        </SiteHeader>

                        <ScrollArea className="h-full w-full overflow-hidden p-4">
                            <Outlet />
                        </ScrollArea>
                    </SidebarInset>
                </div>
            </DashboardSidebarProvider>
        </Authenticated>
    );
};

export const Route = createFileRoute("/admin")({
    beforeLoad: async ({ context }) => {
        requireSession(context);

        try {
            const result = await context.lunoraClient.query(api.auth.admin.isCurrentUserAdmin, {});

            if (!result?.isAdmin) {
                throw redirect({ to: "/dashboard/settings/auth/account" });
            }
        } catch (error) {
            if (isRedirect(error)) {
                throw error;
            }

            throw redirect({ to: "/dashboard/settings/auth/account" });
        }
    },
    component: RouteComponent,
});
