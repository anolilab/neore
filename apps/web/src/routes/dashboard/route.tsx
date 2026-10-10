import type { MessageDescriptor } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { Authenticated } from "@lunora/react";
import { api } from "@neore/backend/api";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@neore/ui/components/breadcrumb";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { SidebarInset } from "@neore/ui/components/sidebar";
import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import {
    Bot,
    Brain,
    Building,
    ClipboardList,
    Filter,
    Home,
    Key,
    Keyboard,
    Laptop,
    LayoutDashboard,
    Lock,
    MessageCircle,
    MessageSquare,
    Settings,
    Shield,
    User,
    UserCog,
    Users,
    UsersRound,
} from "lucide-react";
import { Fragment } from "react";

import { useIsAdmin } from "@/features/admin/hooks/use-admin";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import AppSidebar from "@/features/layout/components/app-sidebar";
import DashboardSidebarProvider from "@/features/layout/components/dashboard-sidebar-provider";
import type { NavItem } from "@/features/layout/components/nav-items";
import NavItems from "@/features/layout/components/nav-items";
import SettingsPageOutline from "@/features/layout/components/settings-page-outline";
import SiteHeader from "@/features/layout/components/site-header";
import { breadcrumbLabel, DASHBOARD_PAGE_NAMES } from "@/features/layout/lib/dashboard-page-names";
import { requireSession } from "@/lib/auth/route-guard";
import { createLunoraQueryOptions } from "@/lib/lunora/crpc";

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
                <Trans>Dashboard</Trans>
            </span>
        </div>
    </div>
);

/** The page names, as descriptors: this runs outside a component, so the caller translates them (`i18n._`). */
const getNavigationItems = (
    translate: (descriptor: MessageDescriptor) => string,
    apiKey: unknown,
    organization: unknown,
    activeOrganization: unknown,
    isAdmin: boolean,
) => {
    return {
        admin: isAdmin
            ? [
                  {
                      icon: LayoutDashboard,
                      name: translate(DASHBOARD_PAGE_NAMES.adminDashboard),
                      url: "/dashboard/settings/admin",
                  },
                  {
                      icon: Users,
                      name: translate(DASHBOARD_PAGE_NAMES.users),
                      url: "/dashboard/settings/admin/users",
                  },
                  {
                      icon: ClipboardList,
                      name: translate(DASHBOARD_PAGE_NAMES.auditLog),
                      url: "/dashboard/settings/admin/audit-log",
                  },
              ]
            : [],
        app: [
            {
                icon: Home,
                name: translate(DASHBOARD_PAGE_NAMES.home),
                url: "/dashboard",
            },
            {
                icon: Settings,
                name: translate(DASHBOARD_PAGE_NAMES.customization),
                url: "/dashboard/settings/app/customization",
            },
            {
                icon: UserCog,
                name: translate(DASHBOARD_PAGE_NAMES.personalization),
                url: "/dashboard/settings/app/personalization",
            },
            {
                icon: Keyboard,
                name: translate(DASHBOARD_PAGE_NAMES.keyboardShortcuts),
                url: "/dashboard/settings/app/keyboard-shortcuts",
            },
        ],
        auth: [
            {
                icon: User,
                name: translate(DASHBOARD_PAGE_NAMES.account),
                url: "/dashboard/settings/auth/account",
            },
            {
                icon: Shield,
                name: translate(DASHBOARD_PAGE_NAMES.security),
                url: "/dashboard/settings/auth/security",
            },
            apiKey && {
                icon: Key,
                name: translate(DASHBOARD_PAGE_NAMES.apiKeys),
                url: "/dashboard/settings/auth/api-keys",
            },
            organization && {
                icon: Building,
                name: translate(DASHBOARD_PAGE_NAMES.organizations),
                url: "/dashboard/settings/auth/organizations",
            },
            activeOrganization && {
                icon: Building,
                name: translate(DASHBOARD_PAGE_NAMES.organization),
                url: "/dashboard/settings/auth/organization",
            },
            activeOrganization && {
                icon: Users,
                name: translate(DASHBOARD_PAGE_NAMES.members),
                url: "/dashboard/settings/auth/members",
            },
            activeOrganization && {
                icon: UsersRound,
                name: translate(DASHBOARD_PAGE_NAMES.teams),
                url: "/dashboard/settings/auth/teams",
            },
        ].filter(Boolean) as NavItem[],
        chat: [
            {
                icon: Brain,
                name: translate(DASHBOARD_PAGE_NAMES.models),
                url: "/dashboard/settings/chat/models",
            },
            {
                icon: Filter,
                name: translate(DASHBOARD_PAGE_NAMES.modelRestrictions),
                url: "/dashboard/settings/chat/model-filters",
            },
            {
                icon: Bot,
                name: translate(DASHBOARD_PAGE_NAMES.agent),
                url: "/dashboard/settings/chat/agent",
            },
            {
                icon: MessageCircle,
                name: translate(DASHBOARD_PAGE_NAMES.messenger),
                url: "/dashboard/settings/connectors/messenger",
            },
            {
                icon: Laptop,
                name: translate(DASHBOARD_PAGE_NAMES.devices),
                url: "/dashboard/settings/chat/devices",
            },
        ],
        privacy: [
            {
                icon: Lock,
                name: translate(DASHBOARD_PAGE_NAMES.privacyAndData),
                url: "/dashboard/settings/privacy",
            },
        ],
    };
};

const RouteComponent = () => {
    const { i18n } = useLingui();
    const location = useLocation();
    const { pathname } = location;

    // Generate breadcrumb items from pathname, filtering out empty strings
    const pathSegments = pathname.split("/").filter(Boolean);

    const breadcrumbItems = pathSegments.map((segment, index) => {
        // Build the href by joining all segments up to current index
        const href = `/${pathSegments.slice(0, index + 1).join("/")}`;

        return {
            href,
            isLast: index === pathSegments.length - 1,
            // The page's translated name, as in the nav; a dynamic id stays as it is.
            label: breadcrumbLabel(segment, (descriptor) => i18n._(descriptor)),
        };
    });

    const { apiKey, authClient, organization } = useAuth();
    const { data: activeOrganization } = useActiveOrganization(authClient);
    const { data: adminStatus } = useIsAdmin();
    const isAdmin = adminStatus?.isAdmin ?? false;
    const navigationItems = getNavigationItems((descriptor) => i18n._(descriptor), apiKey, organization, activeOrganization, isAdmin);

    const sidebarContent = (
        <>
            {isAdmin && navigationItems.admin.length > 0 && (
                <NavItems classes={{ group: "pl-2" }} colorMode="dark" items={navigationItems.admin} label={i18n._(DASHBOARD_PAGE_NAMES.admin)} />
            )}
            <NavItems classes={{ group: "pl-2" }} colorMode="dark" items={navigationItems.app} label={i18n._(DASHBOARD_PAGE_NAMES.app)} />
            <NavItems classes={{ group: "pl-2" }} colorMode="dark" items={navigationItems.chat} label={i18n._(DASHBOARD_PAGE_NAMES.chat)} />
            <NavItems classes={{ group: "pl-2" }} colorMode="dark" items={navigationItems.auth} label={i18n._(DASHBOARD_PAGE_NAMES.auth)} />
            <NavItems classes={{ group: "pl-2" }} colorMode="dark" items={navigationItems.privacy} label={i18n._(DASHBOARD_PAGE_NAMES.privacy)} />
        </>
    );

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
                        <SiteHeader>
                            <Breadcrumb>
                                <BreadcrumbList>
                                    {breadcrumbItems.map((item, index) => (
                                        <Fragment key={item.href}>
                                            <BreadcrumbItem>
                                                {item.isLast ? (
                                                    <BreadcrumbPage className="text-foreground font-medium">{item.label}</BreadcrumbPage>
                                                ) : (
                                                    <BreadcrumbLink
                                                        className="hover:text-muted-foreground hover:dark:text-muted-foreground text-sm text-black transition-colors dark:text-white"
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
                            <SettingsPageOutline pathname={pathname}>
                                <Outlet />
                            </SettingsPageOutline>
                        </ScrollArea>
                    </SidebarInset>
                </div>
            </DashboardSidebarProvider>
        </Authenticated>
    );
};

export const Route = createFileRoute("/dashboard")({
    staleTime: 60_000, // 1 minute - dashboard data changes infrequently
    gcTime: 10 * 60 * 1000, // 10 minutes - keep dashboard data cached
    beforeLoad: ({ context }) => {
        requireSession(context);
    },
    loader: async ({ context }) => {
        // No token yet (the session read failed and the guard let the page render):
        // these would fail unauthenticated. The page's own queries fetch once
        // `AuthRecovery` hands the client its token.
        if (!context.isAuthenticated) {
            return;
        }

        await Promise.all([
            context.queryClient.ensureQueryData(createLunoraQueryOptions(context.lunoraClient, api.auth.functions.getCurrentUser, {})),
            context.queryClient.ensureQueryData(createLunoraQueryOptions(context.lunoraClient, api.auth.functions.hasPassword, {})),
        ]);
    },
    component: RouteComponent,
});
