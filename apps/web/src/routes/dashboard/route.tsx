import type { MessageDescriptor } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { Authenticated } from "@lunora/react";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@neore/ui/components/breadcrumb";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { SidebarInset } from "@neore/ui/components/sidebar";
import { createFileRoute, Outlet, redirect, useLocation } from "@tanstack/react-router";
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
    Settings,
    Shield,
    Sparkles,
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
import SiteHeader from "@/features/layout/components/site-header";
import { breadcrumbLabel, DASHBOARD_PAGE_NAMES } from "@/features/layout/lib/dashboard-page-names";
import { settingsLocation, settingsTabForPath } from "@/features/settings/lib/settings-link";
import { requireSession } from "@/lib/auth/route-guard";

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
                      url: "/admin",
                  },
                  {
                      icon: Users,
                      name: translate(DASHBOARD_PAGE_NAMES.users),
                      url: "/admin/users",
                  },
                  {
                      icon: ClipboardList,
                      name: translate(DASHBOARD_PAGE_NAMES.auditLog),
                      url: "/admin/audit-log",
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
                settingsTab: "app-customization" as const,
            },
            {
                icon: UserCog,
                name: translate(DASHBOARD_PAGE_NAMES.personalization),
                settingsTab: "chat-personalization" as const,
            },
            {
                icon: Keyboard,
                name: translate(DASHBOARD_PAGE_NAMES.keyboardShortcuts),
                settingsTab: "app-keyboard" as const,
            },
        ],
        auth: [
            {
                icon: User,
                name: translate(DASHBOARD_PAGE_NAMES.account),
                settingsTab: "auth-account" as const,
            },
            {
                icon: Shield,
                name: translate(DASHBOARD_PAGE_NAMES.security),
                settingsTab: "auth-security" as const,
            },
            apiKey && {
                icon: Key,
                name: translate(DASHBOARD_PAGE_NAMES.apiKeys),
                settingsTab: "auth-api-keys" as const,
            },
            organization && {
                icon: Building,
                name: translate(DASHBOARD_PAGE_NAMES.organizations),
                settingsTab: "auth-organizations" as const,
            },
            activeOrganization && {
                icon: Building,
                name: translate(DASHBOARD_PAGE_NAMES.organization),
                settingsTab: "auth-organization" as const,
            },
            activeOrganization && {
                icon: Users,
                name: translate(DASHBOARD_PAGE_NAMES.members),
                settingsTab: "auth-members" as const,
            },
            activeOrganization && {
                icon: UsersRound,
                name: translate(DASHBOARD_PAGE_NAMES.teams),
                settingsTab: "auth-teams" as const,
            },
        ].filter(Boolean) as NavItem[],
        chat: [
            {
                icon: Brain,
                name: translate(DASHBOARD_PAGE_NAMES.models),
                settingsTab: "chat-models" as const,
            },
            {
                icon: Filter,
                name: translate(DASHBOARD_PAGE_NAMES.modelRestrictions),
                settingsTab: "chat-model-filters" as const,
            },
            {
                icon: Bot,
                name: translate(DASHBOARD_PAGE_NAMES.agent),
                settingsTab: "chat-agent" as const,
            },
            {
                icon: Sparkles,
                name: translate(DASHBOARD_PAGE_NAMES.bots),
                settingsTab: "chat-bots" as const,
            },
            {
                icon: MessageCircle,
                name: translate(DASHBOARD_PAGE_NAMES.messenger),
                settingsTab: "connectors-messenger" as const,
            },
            {
                icon: Laptop,
                name: translate(DASHBOARD_PAGE_NAMES.devices),
                settingsTab: "chat-devices" as const,
            },
        ],
        privacy: [
            {
                icon: Lock,
                name: translate(DASHBOARD_PAGE_NAMES.privacyAndData),
                settingsTab: "privacy" as const,
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
                <NavItems classes={{ group: "pl-2" }} colorMode="light" items={navigationItems.admin} label={i18n._(DASHBOARD_PAGE_NAMES.admin)} />
            )}
            <NavItems classes={{ group: "pl-2" }} colorMode="light" items={navigationItems.app} label={i18n._(DASHBOARD_PAGE_NAMES.app)} />
            <NavItems classes={{ group: "pl-2" }} colorMode="light" items={navigationItems.chat} label={i18n._(DASHBOARD_PAGE_NAMES.chat)} />
            <NavItems classes={{ group: "pl-2" }} colorMode="light" items={navigationItems.auth} label={i18n._(DASHBOARD_PAGE_NAMES.auth)} />
            <NavItems classes={{ group: "pl-2" }} colorMode="light" items={navigationItems.privacy} label={i18n._(DASHBOARD_PAGE_NAMES.privacy)} />
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
                {/* The inset's margins sit inside the viewport height; clip them so the page does not scroll. */}
                <div className="flex h-dvh w-full overflow-hidden">
                    <AppSidebar content={sidebarContent} name="overlay" />
                    <SidebarInset className="bg-surface-main">
                        <SiteHeader>
                            <Breadcrumb>
                                <BreadcrumbList className="gap-1 text-sm">
                                    {breadcrumbItems.map((item, index) => (
                                        <Fragment key={item.href}>
                                            <BreadcrumbItem>
                                                {item.isLast ? (
                                                    <BreadcrumbPage className="font-medium">{item.label}</BreadcrumbPage>
                                                ) : (
                                                    <BreadcrumbLink href={item.href}>{item.label}</BreadcrumbLink>
                                                )}
                                            </BreadcrumbItem>
                                            {index < breadcrumbItems.length - 1 && (
                                                <BreadcrumbSeparator className="text-muted-foreground/60 mx-0.5 [&>svg]:size-3" />
                                            )}
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

export const Route = createFileRoute("/dashboard")({
    beforeLoad: ({ context, location }) => {
        requireSession(context, location);

        // Settings are a modal now. An old settings URL (a bookmark, an email, a notification) opens it over the chat.
        const settingsTab = settingsTabForPath(location.pathname);

        if (settingsTab) {
            throw redirect(settingsLocation(settingsTab, location.hash || undefined));
        }
    },
    component: RouteComponent,
});
