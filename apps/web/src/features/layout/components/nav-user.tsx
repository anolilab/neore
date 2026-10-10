"use client";

import { useLingui } from "@lingui/react/macro";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@neore/ui/components/responsive-dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@neore/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Globe, LogIn, LogOut, PlusCircleIcon, Sparkles, UserRound } from "lucide-react";
import type { FC } from "react";
import { Fragment, useCallback, useMemo, useState } from "react";

import UserView from "@/features/auth/components/user-view";
import { useListDeviceSessions } from "@/features/auth/hooks/device-session-management";
import { useSession } from "@/features/auth/hooks/session-user-management";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { getLocalizedError } from "@/features/auth/lib/utilities";
import useCheckout from "@/features/billing/hooks/use-checkout";
import { useUserPreferences } from "@/features/layout/hooks/use-ui-state";
import { useReleasePushOnSignOut } from "@/features/notifications/hooks/use-release-push-on-sign-out";
import updateLocale, { isSupportedLocale } from "@/functions/update-locale";
import type { AuthClient } from "@/lib/auth/client";
import { DEFAULT_LOCALE, deLocalizeUrl, dynamicActivate, locales as appLocales, shouldIgnorePath } from "@/lib/intl/client";

const LOCALE_DISPLAY_NAMES: Record<string, string> = {
    de: "Deutsch",
    en: "English",
    es: "Español",
    fr: "Français",
    it: "Italiano",
    ja: "日本語",
    pl: "Polski",
    pt: "Português",
    zh: "中文",
};

// Static — no closure variables, safe to hoist outside the component.
const DROPDOWN_CONTENT_PROPS = {
    align: "end" as const,
    className: "w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg",
    onCloseAutoFocus: (e: Event) => e.preventDefault(),
    side: "right" as const,
    sideOffset: 4,
};

export interface NavUserProperties {
    className?: string;
    disableDefaultLinks?: boolean;
    size?: "default" | "sm" | "lg" | "icon";

    /**
     * Custom trigger element. When provided, renders a bare DropdownMenu without the
     *  SidebarMenu wrapper — use this outside of a Sidebar context (e.g. AppSidebarMinimal).
     */
    trigger?: React.ReactElement;
}

/**
 * The other-accounts section of the menu.
 *
 * Its own component so `useListDeviceSessions()` is called unconditionally: in
 * `NavUser` it sat behind `if (multiSession)`, which changes the hook order
 * between renders.
 */
const DeviceSessionItems: FC<{
    authClient: AuthClient;
    currentUserId: string;
    isPending: boolean;
    onSwitchAccount: (sessionToken: string) => void;
}> = ({ authClient, currentUserId, isPending, onSwitchAccount }) => {
    const { data: deviceSessions, isPending: deviceSessionsPending } = useListDeviceSessions(authClient);

    return (
        <>
            {!deviceSessions && deviceSessionsPending && (
                <>
                    <DropdownMenuItem disabled>
                        <UserView isPending={isPending} />
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                </>
            )}
            {deviceSessions?.flatMap(({ session, user: sessionUser }) =>
                sessionUser.id === currentUserId
                    ? []
                    : [
                          <Fragment key={session.id}>
                              <DropdownMenuItem onClick={() => onSwitchAccount(session.token)}>
                                  <UserView user={sessionUser} />
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                          </Fragment>,
                      ],
            )}
        </>
    );
};

const NavUser: FC<NavUserProperties> = ({ trigger }) => {
    const { i18n, t } = useLingui();
    const { hidePersonalInfo } = useUserPreferences();
    const { isAnonymous } = useIsAnonymous();

    const {
        authClient,
        basePath = "/auth",
        multiSession = false,
        mutators: { setActiveSession },
        onSessionChange,
        toast,
        viewPaths = {
            SIGN_IN: "sign-in",
            SIGN_OUT: "sign-out",
            SIGN_UP: "sign-up",
        },
    } = useAuth();

    const { data: sessionData, isPending: sessionPending } = useSession(authClient);
    const user = sessionData?.user;
    const releasePush = useReleasePushOnSignOut();
    const { isPending: checkoutPending, startCheckout } = useCheckout();
    const [activeSessionPending, setActiveSessionPending] = useState(false);

    const isPending = sessionPending || activeSessionPending;

    const switchAccount = useCallback(
        async (sessionToken: string) => {
            setActiveSessionPending(true);

            try {
                await setActiveSession({ sessionToken });
                onSessionChange?.();
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });
                setActiveSessionPending(false);
            }
        },
        [setActiveSession, onSessionChange, toast, t],
    );

    // Clearing the pending flag is derived from the session data changing, so it is
    // adjusted during render rather than in an effect.
    const [previousSession, setPreviousSession] = useState<{ multiSession: boolean; sessionData: typeof sessionData }>();

    if (!previousSession || sessionData !== previousSession.sessionData || multiSession !== previousSession.multiSession) {
        setPreviousSession({ multiSession, sessionData });

        if (multiSession) {
            setActiveSessionPending(false);
        }
    }

    const handleLocaleChange = useCallback(
        async (locale: string) => {
            // Instantly swap translations in-place — no page reload
            await dynamicActivate(i18n, locale);

            // Persist choice to cookie in the background. `locale` arrives as a plain
            // string (keys of the `locales` record), so it is narrowed against the same
            // list the server fn validates with — an unsupported value would be rejected
            // there anyway, so skipping the round-trip is the correct behaviour.
            if (isSupportedLocale(locale)) {
                void updateLocale({ data: locale });
            }

            // Reflect the locale in the URL (e.g. /de/...) without a reload.
            // Skip for paths that don't use locale prefixes (chat, workflow, dashboard, api)
            // and for shared URLs — those should never have their path modified.
            const currentUrl = new URL(globalThis.location.href);
            const delocalized = deLocalizeUrl({ url: currentUrl });
            const currentPath = delocalized ? delocalized.pathname : currentUrl.pathname;

            if (shouldIgnorePath(currentPath)) {
                return;
            }

            const localizedBasePath = currentPath === "/" ? "" : currentPath;
            const newPath = locale === DEFAULT_LOCALE ? currentPath + currentUrl.search : `/${locale}${localizedBasePath}${currentUrl.search}`;

            globalThis.history.replaceState(null, "", newPath);
        },
        [i18n],
    );

    const currentLocale = i18n.locale ?? DEFAULT_LOCALE;

    const languageSubmenu = useMemo(
        () => (
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <Globe />
                    {LOCALE_DISPLAY_NAMES[currentLocale] ?? currentLocale.toUpperCase()}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                    {Object.keys(appLocales).map((locale) => (
                        <DropdownMenuItem
                            key={locale}
                            onClick={() => {
                                void handleLocaleChange(locale);
                            }}
                        >
                            {LOCALE_DISPLAY_NAMES[locale] ?? locale}
                            {currentLocale === locale ? <Check className="ml-auto" /> : null}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuSubContent>
            </DropdownMenuSub>
        ),
        [currentLocale, handleLocaleChange],
    );

    const menuContent = isAnonymous ? (
        <DropdownMenuContent {...DROPDOWN_CONTENT_PROPS}>
            {languageSubmenu}
            <DropdownMenuSeparator />
            {/* The responsive `DropdownMenuItem` renders a plain <button> on mobile and has
                no Base UI `render` prop, so navigation goes through a wrapping <Link> — the
                same shape as the "Add Account" item below. */}
            <Link to="/auth/sign-in">
                <DropdownMenuItem>
                    <LogIn />
                    {t`Sign in`}
                </DropdownMenuItem>
            </Link>
        </DropdownMenuContent>
    ) : (
        <DropdownMenuContent {...DROPDOWN_CONTENT_PROPS}>
            <DropdownMenuGroup>
                <DropdownMenuLabel className="p-0 font-normal">
                    <UserView isPending={isPending} user={user} />
                </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
                <DropdownMenuItem
                    disabled={checkoutPending}
                    onClick={() => {
                        void startCheckout("pro");
                    }}
                >
                    <Sparkles />
                    {t`Upgrade to Pro`}
                </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {user && multiSession ? (
                <>
                    <DeviceSessionItems authClient={authClient} currentUserId={user.id} isPending={isPending} onSwitchAccount={switchAccount} />
                    <Link from="/dashboard" to={`${basePath}/${viewPaths.SIGN_IN}`}>
                        <DropdownMenuItem>
                            <PlusCircleIcon />
                            {t`Add Account`}
                        </DropdownMenuItem>
                    </Link>
                    <DropdownMenuSeparator />
                </>
            ) : null}
            {languageSubmenu}
            <DropdownMenuSeparator />
            <DropdownMenuItem
                onClick={async () => {
                    // Push first, while the session still authenticates the server call.
                    await releasePush();
                    await authClient.signOut({
                        fetchOptions: {
                            onSuccess: () => {
                                globalThis.location.reload();
                            },
                        },
                    });
                }}
            >
                <LogOut />
                {t`Log out`}
            </DropdownMenuItem>
        </DropdownMenuContent>
    );

    // When a custom trigger is provided, render without SidebarMenu context
    if (trigger) {
        return (
            <DropdownMenu>
                <DropdownMenuTrigger render={trigger} />
                {menuContent}
            </DropdownMenu>
        );
    }

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger
                        className="text-brand-black dark:text-brand-white"
                        render={
                            isAnonymous ? (
                                <SidebarMenuButton className="hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent" name="login" size="lg">
                                    <UserRound className="size-5 shrink-0" />
                                    <div className="grid flex-1 text-left text-sm leading-tight">
                                        <span className="truncate font-medium">{t`Guest`}</span>
                                    </div>
                                    <ChevronsUpDown className="text-brand-black/60 dark:text-brand-white/50 ml-auto size-4" />
                                </SidebarMenuButton>
                            ) : (
                                <SidebarMenuButton className="hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent" name="login" size="lg">
                                    <div className="grid flex-1 text-left text-sm leading-tight">
                                        <span className="truncate font-medium">{hidePersonalInfo ? t`User` : user?.name || t`User`}</span>
                                        <span className="text-brand-black/60 dark:text-brand-white/60 truncate text-xs">
                                            {hidePersonalInfo ? "" : user?.email}
                                        </span>
                                    </div>
                                    <ChevronsUpDown className="text-brand-black/60 dark:text-brand-white/50 ml-auto size-4" />
                                </SidebarMenuButton>
                            )
                        }
                    />
                    {menuContent}
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
};

export default NavUser;
