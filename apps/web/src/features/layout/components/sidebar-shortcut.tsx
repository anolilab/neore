"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@neore/ui/components/hover-card";
import cn from "@neore/ui/utils/cn";
import { Link, useLocation } from "@tanstack/react-router";
import {
    Cog,
    File,
    FileText,
    FlaskConical,
    HelpCircle,
    House,
    ListChecks,
    MessageSquare,
    NotebookText,
    ShieldCheck,
    Sparkles,
    UserRound,
    Workflow,
    Zap,
} from "lucide-react";
import { usePostHog } from "posthog-js/react";
import type { ComponentType, FC } from "react";
import { useMemo } from "react";

import Neore from "@/assets/logo/neore.svg?react";
import { preloadSettingsTabs } from "@/components/settings/settings-modal";
import { useIsAdmin } from "@/features/admin/hooks/use-admin";
import { useSession } from "@/features/auth/hooks/session-user-management";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import useChangelog from "@/features/changelog/hooks/use-changelog";
import useChangelogStore from "@/features/changelog/stores/changelog-store";
import UsageCard from "@/features/chat/sidebar/usage-card";
import NavUser from "@/features/layout/components/nav-user";
import { useModalState, useUserPreferences } from "@/features/layout/hooks/use-ui-state";
import NotificationBell from "@/features/notifications/components/notification-bell";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";

// ---------------------------------------------------------------------------
// Static nav configuration — add / remove / reorder entries here only.
// `to` may be overridden at runtime (see `useChatLink`).
// `requiresAuth`: link is hidden for anonymous/guest users.
// ---------------------------------------------------------------------------
type NavLinkDef = {
    /** PostHog feature flag that must be enabled to show this link. */
    featureFlag?: string;
    icon: ComponentType<{ className?: string; strokeWidth?: number }>;
    /** i18n message descriptor used as the aria-label */
    labelKey: MessageDescriptor;
    matcher: (pathname: string) => boolean;
    /** Hide this link for anonymous / guest users. */
    requiresAuth?: boolean;
    to: string;
    /** Replace `to` with the user's last-opened chat URL at runtime. */
    useChatLink?: boolean;
};

const NAV_LINK_DEFS: NavLinkDef[] = [
    {
        icon: House,
        labelKey: msg`Open Home`,
        matcher: (p) => p === "/dashboard" || p === "/dashboard/",
        requiresAuth: true,
        to: "/dashboard",
    },
    {
        icon: MessageSquare,
        labelKey: msg`Open messages`,
        matcher: (p) => p.startsWith("/chat"),
        to: "/chat",
        useChatLink: true,
    },
    {
        icon: FileText,
        labelKey: msg`Open Prompts`,
        matcher: (p) => p.startsWith("/prompts"),
        to: "/prompts",
    },
    {
        icon: Zap,
        labelKey: msg`Open Skills`,
        matcher: (p) => p.startsWith("/skills"),
        to: "/skills",
    },
    {
        icon: ListChecks,
        labelKey: msg`Open Tasks`,
        matcher: (p) => p.startsWith("/tasks"),
        requiresAuth: true,
        to: "/tasks",
    },
    {
        icon: FlaskConical,
        labelKey: msg`Open Evals`,
        matcher: (p) => p.startsWith("/evals"),
        requiresAuth: true,
        to: "/evals",
    },
    {
        icon: NotebookText,
        labelKey: msg`Open Pages`,
        matcher: (p) => p.startsWith("/pages"),
        requiresAuth: true,
        to: "/pages",
    },
    {
        featureFlag: "workflow",
        icon: Workflow,
        labelKey: msg`Open Workflows`,
        matcher: (p) => p.startsWith("/workflow"),
        to: "/workflow",
    },
    {
        icon: File,
        labelKey: msg`Open Vault`,
        matcher: (p) => p.startsWith("/vault"),
        requiresAuth: true,
        to: "/vault",
    },
];

// ---------------------------------------------------------------------------

interface SidebarShortcutProps {
    /**
     * When true, clicking the user avatar opens the full user dropdown menu
     * (same as NavUser in the full sidebar footer). Use this when there is no
     * collapsible sidebar panel — e.g. vault, workflow, prompts, skills pages.
     *
     * When false (default), the avatar is rendered as a static display; the
     * full sidebar panel is expected to contain a NavUser footer instead.
     */
    userDropdown?: boolean;
}

const SidebarShortcut: FC<SidebarShortcutProps> = ({ userDropdown = false }) => {
    const location = useLocation();
    const { t } = useLingui();
    const { isAnonymous } = useIsAnonymous();
    const userSettings = useUserSettings();
    const { hidePersonalInfo } = useUserPreferences();
    const posthog = usePostHog();
    const { authClient } = useAuth();
    const { data: sessionData } = useSession(authClient);
    const user = sessionData?.user;

    const chatLink = userSettings?.data?.lastChatId ? `/chat/${userSettings.data.lastChatId}` : "/chat";
    const { isOpen: isSettingsOpen, open: openSettingsModal } = useModalState("settings");
    // The admin link is not something first paint has to draw.
    const afterFirstPaint = useAfterFirstPaint();
    const { data: adminStatus } = useIsAdmin({ enabled: afterFirstPaint });
    const isAdmin = adminStatus?.isAdmin ?? false;
    const { unreadCount } = useChangelog();
    const openChangelogPanel = useChangelogStore((s) => s.open);

    // Build the resolved link list from static config, injecting runtime values
    const navLinks = useMemo(
        () =>
            NAV_LINK_DEFS.filter((def) => {
                if (def.requiresAuth && isAnonymous) {
                    return false;
                }

                if (def.featureFlag && !posthog?.isFeatureEnabled(def.featureFlag)) {
                    return false;
                }

                return true;
            }).map((def) => {
                return {
                    ...def,
                    to: def.useChatLink ? chatLink : def.to,
                };
            }),
        [isAnonymous, chatLink, posthog],
    );

    const avatarElement = (
        <Avatar className={cn("size-8", hidePersonalInfo && "blur-sm")}>
            {user?.image && <AvatarImage alt={user?.name || t`User`} src={user.image} />}
            <AvatarFallback name={user?.name || user?.email || undefined} />
        </Avatar>
    );

    const userTrigger = userDropdown ? (
        <NavUser
            trigger={
                <button
                    aria-label={t`Open user menu`}
                    className="hover:bg-sidebar-accent/50 flex size-10 items-center justify-center rounded-md transition-colors duration-150"
                    type="button"
                >
                    {avatarElement}
                </button>
            }
        />
    ) : (
        <div className="flex size-10 items-center justify-center">{avatarElement}</div>
    );

    return (
        <div className="z-20 hidden h-screen w-16 shrink-0 py-1 pl-1 md:block" id="sidebar-shortcut">
            <div className="bg-sidebar dark:bg-brand-obsidian ring-sidebar-border flex h-full flex-col items-center rounded-lg ring-1">
                <Neore
                    className="fill-brand-black dark:fill-brand-white mt-3 mb-4 size-7 opacity-90 transition-opacity hover:opacity-70"
                    title={t`Neore - AI Text & Video & Audio & Image & Documents Generation Platform`}
                />

                <UsageCard />

                <div className="mt-4 flex flex-col gap-1">
                    {navLinks.map(({ icon: Icon, labelKey, matcher, to }) => {
                        const isActive = matcher(location.pathname);

                        return (
                            <Link
                                aria-label={t(labelKey)}
                                className={cn(
                                    "group relative flex size-10 items-center justify-center rounded-md transition-colors duration-150",
                                    isActive
                                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                        : "text-brand-black dark:text-brand-white hover:bg-sidebar-accent/50",
                                )}
                                key={to}
                                to={to}
                            >
                                <Icon className="text-brand-black dark:text-brand-white size-5" strokeWidth={1.5} />
                            </Link>
                        );
                    })}
                </div>

                <div className="mt-auto mb-2 flex flex-col items-center gap-1">
                    {isAdmin && (
                        <Link
                            aria-label={t`Admin`}
                            className={cn(
                                "group relative flex size-10 items-center justify-center rounded-md transition-colors duration-150",
                                location.pathname.startsWith("/admin")
                                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                    : "text-brand-black dark:text-brand-white hover:bg-sidebar-accent/50",
                            )}
                            to="/admin"
                        >
                            <ShieldCheck className="text-brand-black dark:text-brand-white size-5" strokeWidth={1.5} />
                        </Link>
                    )}
                    {!isAnonymous && <NotificationBell />}
                    <button
                        aria-label={t`Open Settings`}
                        className={cn(
                            "group relative flex size-10 items-center justify-center rounded-md transition-colors duration-150",
                            isSettingsOpen
                                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                : "text-brand-black dark:text-brand-white hover:bg-sidebar-accent/50",
                        )}
                        onClick={(e) => {
                            e.currentTarget.blur();
                            openSettingsModal();
                        }}
                        onMouseEnter={preloadSettingsTabs}
                        type="button"
                    >
                        <Cog className="size-5" strokeWidth={1.5} />
                    </button>
                    <HoverCard>
                        <HoverCardTrigger
                            className="text-brand-black dark:text-brand-white hover:bg-sidebar-accent/50 group relative flex size-10 items-center justify-center rounded-md transition-colors duration-150"
                            render={<button aria-label={t`Help`} type="button" />}
                        >
                            <HelpCircle className="size-5" strokeWidth={1.5} />
                            {unreadCount > 0 && <span className="bg-destructive absolute top-1 right-1 flex size-2 rounded-full" />}
                        </HoverCardTrigger>
                        <HoverCardContent align="end" side="right" sideOffset={8}>
                            <p className="mb-2 text-xs font-medium opacity-60">{t`Updates`}</p>
                            <button
                                className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"
                                onClick={openChangelogPanel}
                                type="button"
                            >
                                <Sparkles className="size-3.5 shrink-0 opacity-70" strokeWidth={1.5} />
                                <span className="flex-1 text-left">{t`What's New`}</span>
                                {unreadCount > 0 && (
                                    <span className="bg-destructive text-destructive-foreground flex size-4 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums">
                                        {unreadCount > 9 ? "9+" : unreadCount}
                                    </span>
                                )}
                            </button>
                        </HoverCardContent>
                    </HoverCard>

                    {isAnonymous ? (
                        <NavUser
                            trigger={
                                <button
                                    aria-label={t`Open user menu`}
                                    className="hover:bg-sidebar-accent/50 flex size-10 items-center justify-center rounded-md transition-colors duration-150"
                                    type="button"
                                >
                                    <UserRound className="text-brand-black dark:text-brand-white size-5" strokeWidth={1.5} />
                                </button>
                            }
                        />
                    ) : (
                        userTrigger
                    )}
                </div>
            </div>
        </div>
    );
};

export default SidebarShortcut;
