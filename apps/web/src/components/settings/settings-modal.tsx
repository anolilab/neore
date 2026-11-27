"use client";

import { useLingui } from "@lingui/react/macro";
import { Button, buttonVariants } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/dialog";
import { HeadingLevelProvider } from "@neore/ui/components/heading";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import MOBILE_BREAKPOINT_QUERY from "@neore/ui/utils/breakpoints";
import cn from "@neore/ui/utils/cn";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Lock, RefreshCw, Settings } from "lucide-react";
import type { FC, ReactNode } from "react";
import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { ErrorBoundary } from "@/components/error-boundary";
import { SettingsSearchField, SettingsSearchResults, useSettingsSearch } from "@/components/settings/settings-search";
import { useAuthActiveOrganization, useAuthSession } from "@/features/auth/hooks/use-auth-session";
import useInviteOnly from "@/features/auth/hooks/use-invite-only";
import { hasNoAccount } from "@/features/auth/lib/account-state";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useModalState } from "@/features/layout/hooks/use-ui-state";
import { jumpToSettingsRow } from "@/features/settings/lib/settings-jump";
import { scrollToAnchorWhenRendered } from "@/features/settings/lib/settings-link";
import type { SettingsTab } from "@/features/settings/lib/settings-navigation";
import { isSettingsTab, resolveSettingsNavigation, SETTINGS_NAVIGATION } from "@/features/settings/lib/settings-navigation";
import { useSettingsRequest } from "@/features/settings/lib/settings-request";
import type { SettingsSearchEntry } from "@/features/settings/lib/settings-search";
import { ErrorUtilities } from "@/lib/errors";
import { useCRPC } from "@/lib/lunora/crpc";

// Lazy load settings components
const AccountSettingsCards = lazy(() => import("@/features/auth/components/settings/account-settings-cards"));
const SecuritySettingsCards = lazy(() => import("@/features/auth/components/settings/security-settings-cards"));
const APIKeysCard = lazy(() => import("@/features/auth/components/settings/api-key/api-keys-card"));
const OrganizationsCard = lazy(() => import("@/features/auth/components/organization/organizations-card"));
const OrganizationSettingsCards = lazy(() => import("@/features/auth/components/organization/organization-settings-cards"));
const OrganizationMembersCard = lazy(() => import("@/features/auth/components/organization/organization-members-card"));
const OrganizationInvitationsCard = lazy(() => import("@/features/auth/components/organization/organization-invitations-card"));
const TeamsCard = lazy(() => import("@/features/auth/components/team/teams-card"));
const BillingSettingsCard = lazy(() => import("@/features/auth/components/organization/billing-settings-card"));
const PersonalPlanCard = lazy(() => import("@/features/billing/components/personal-plan-card"));
const AppCustomizationSettings = lazy(() => import("@/features/settings/components/account/account-settings"));
const AgentSettings = lazy(() => import("@/features/settings/components/chat/agent-settings"));
const MCPSettings = lazy(() => import("@/features/settings/components/chat/mcp-settings"));
const ToolPermissionsSettings = lazy(() => import("@/features/settings/components/chat/tool-permissions-settings"));
const SubAgentRolesSettings = lazy(() => import("@/features/settings/components/chat/sub-agent-roles-settings"));
const DefaultModelsSettings = lazy(() => import("@/features/settings/components/chat/default-models-settings"));
const ModelsSettings = lazy(() => import("@/features/settings/components/chat/models-settings"));
const PrivacySettings = lazy(() => import("@/features/settings/components/privacy/privacy-settings"));
const KeyboardShortcutsSettings = lazy(() => import("@/features/settings/components/keyboard/keyboard-shortcuts-settings"));
const PersonalizationSettings = lazy(() => import("@/features/settings/components/personalization/personalization-settings"));
const KnowledgeBaseSettings = lazy(() => import("@/features/settings/components/knowledge/knowledge-base-settings"));
const ProviderAPIKeysSettings = lazy(() => import("@/features/settings/components/chat/api-keys-settings"));
const SystemPromptPresetSettings = lazy(() => import("@/features/settings/components/chat/system-prompt-preset-settings"));
const ModelFilterSettings = lazy(() => import("@/features/settings/components/chat/model-filter-settings"));
const BotsSettings = lazy(() => import("@/features/settings/components/chat/bots-settings"));
const TriggerSettings = lazy(() => import("@/features/settings/components/chat/trigger-settings"));
const DevicesSettings = lazy(() => import("@/features/devices/components/devices-settings"));
const UsageSettings = lazy(() => import("@/features/settings/components/chat/usage-settings"));
const ConnectorsPage = lazy(() => import("@/features/settings/connectors/connectors-page"));
const MessengerPage = lazy(() => import("@/features/settings/connectors/messenger/messenger-page"));

// Per-tab preload map — each nav item hover triggers only its own chunk.
const preloadTab: Record<string, () => void> = {
    "app-customization": () => import("@/features/settings/components/account/account-settings"),
    "app-keyboard": () => import("@/features/settings/components/keyboard/keyboard-shortcuts-settings"),
    "auth-account": () => import("@/features/auth/components/settings/account-settings-cards"),
    "auth-api-keys": () => import("@/features/auth/components/settings/api-key/api-keys-card"),
    "auth-billing": () => {
        import("@/features/auth/components/organization/billing-settings-card");
        import("@/features/billing/components/personal-plan-card");
    },
    "auth-members": () => {
        import("@/features/auth/components/organization/organization-members-card");
        import("@/features/auth/components/organization/organization-invitations-card");
    },
    "auth-organization": () => import("@/features/auth/components/organization/organization-settings-cards"),
    "auth-organizations": () => import("@/features/auth/components/organization/organizations-card"),
    "auth-security": () => import("@/features/auth/components/settings/security-settings-cards"),
    "auth-teams": () => import("@/features/auth/components/team/teams-card"),
    "chat-agent": () => import("@/features/settings/components/chat/agent-settings"),
    "chat-api-keys": () => import("@/features/settings/components/chat/api-keys-settings"),
    "chat-default-models": () => import("@/features/settings/components/chat/default-models-settings"),
    "chat-knowledge": () => import("@/features/settings/components/knowledge/knowledge-base-settings"),
    "chat-mcp": () => import("@/features/settings/components/chat/mcp-settings"),
    "chat-models": () => import("@/features/settings/components/chat/models-settings"),
    "chat-tools": () => import("@/features/settings/components/chat/tool-permissions-settings"),
    "chat-sub-agent-roles": () => import("@/features/settings/components/chat/sub-agent-roles-settings"),
    "chat-personalization": () => import("@/features/settings/components/personalization/personalization-settings"),
    "chat-system-prompts": () => import("@/features/settings/components/chat/system-prompt-preset-settings"),
    "chat-bots": () => import("@/features/settings/components/chat/bots-settings"),
    "chat-devices": () => import("@/features/devices/components/devices-settings"),
    "chat-model-filters": () => import("@/features/settings/components/chat/model-filter-settings"),
    "chat-triggers": () => import("@/features/settings/components/chat/trigger-settings"),
    "chat-usage": () => import("@/features/settings/components/chat/usage-settings"),
    connectors: () => import("@/features/settings/connectors/connectors-page"),
    "connectors-messenger": () => import("@/features/settings/connectors/messenger/messenger-page"),
    privacy: () => import("@/features/settings/components/privacy/privacy-settings"),
};

// Preload all tab chunks in parallel so switching tabs is instant.
// Call on settings button hover so chunks are ready before the modal opens.
// Vite deduplicates — safe to call multiple times.
export const preloadSettingsTabs = () => {
    for (const load of Object.values(preloadTab)) {
        load();
    }
};

// Search params the settings modal owns and strips on close.
const MODAL_SEARCH_KEYS = new Set(["settings", "settingsAnchor", "settingsTab"]);

const SettingsLoadingFallback: FC = () => (
    <div className="flex h-64 items-center justify-center">
        <div className="border-primary h-8 w-8 animate-spin rounded-full border-2 border-t-transparent" />
    </div>
);

const SettingsTabError: FC<{ error: Error; onRetry: () => void }> = ({ error, onRetry }) => {
    const { i18n, t } = useLingui();
    const userMessage = ErrorUtilities.getUserMessage(error, i18n);

    return (
        <div className="flex h-64 flex-col items-center justify-center gap-4 p-6 text-center">
            <AlertTriangle className="text-destructive h-8 w-8" />
            <div>
                <p className="font-medium">{t`Something went wrong`}</p>
                <p className="text-muted-foreground mt-1 text-sm">{userMessage}</p>
            </div>
            <Button onClick={onRetry} size="sm" variant="outline">
                <RefreshCw className="mr-2 h-4 w-4" />
                {t`Try Again`}
            </Button>
        </div>
    );
};

const AnonymousUpgradeGate: FC<{ label: string }> = ({ label }) => {
    const { t } = useLingui();
    // Under invite-only an account comes from an invitation, so a visitor without one is sent to sign in instead.
    const { canSignUp, signUpHref } = useInviteOnly();

    return (
        <div className="flex h-64 flex-col items-center justify-center gap-4 p-6 text-center">
            <div className="bg-muted flex size-12 items-center justify-center rounded-full">
                <Lock className="text-muted-foreground size-5" />
            </div>
            <div>
                <p className="font-medium">
                    {label} {t`requires an account`}
                </p>
                <p className="text-muted-foreground mt-1 text-sm">
                    {canSignUp ? t`Sign up and subscribe for $8/mo to unlock all features.` : t`Sign in to your account to use it.`}
                </p>
            </div>
            {/* A link styled as a button: it navigates, so it keeps link semantics. */}
            {canSignUp ? (
                <a className={buttonVariants({ size: "sm" })} href={signUpHref}>
                    {t`Create an account`}
                </a>
            ) : (
                <a className={buttonVariants({ size: "sm" })} href="/auth/sign-in">
                    {t`Sign in`}
                </a>
            )}
        </div>
    );
};

/** The tabs a guest may use but a visitor with no session may not: there is no account behind them to show. */
const SESSION_TABS: ReadonlyArray<SettingsTab> = ["auth-account", "auth-security"];

export const SettingsModal: FC = () => {
    const { i18n, t } = useLingui();
    const navigate = useNavigate();
    const search = useSearch({ strict: false }) as { settings?: boolean; settingsAnchor?: string; settingsTab?: string };
    const queryClient = useQueryClient();
    const crpc = useCRPC();
    const { apiKey, organization } = useAuth();
    const { data: activeOrganization } = useAuthActiveOrganization();
    // A guest, or signed out (the chat is reachable signed out under invite-only), locks the account tabs. A session
    // read still pending or failed is unknown, not signed out, so it locks nothing.
    const session = useAuthSession();
    const isAnonymous = hasNoAccount(session);
    // A guest has an account to manage (its sessions, deleting its data); signed out there is none, so those tabs lock too.
    const isSignedOut = isAnonymous && !session.data?.user;

    const { close, isOpen, open } = useModalState("settings");
    // Once opened, stay mounted so the Dialog's Activity component can
    // deactivate/reactivate content without remounting.
    const [hasOpened, setHasOpened] = useState(false);

    // Local tab state for instant switching — URL is updated in the background
    // for deep-link/back-button support only.
    const [currentTab, setCurrentTab] = useState<SettingsTab>(isSettingsTab(search.settingsTab) ? search.settingsTab : "app-customization");
    // Incrementing this resets the error boundary for the current tab (retry).
    // Changing currentTab also resets it via the ScrollArea key below.
    const [tabRetryKey, setTabRetryKey] = useState(0);
    // Below md the sidebar and the tab content do not fit side by side, so the modal shows one at a time.
    const [mobileView, setMobileView] = useState<"detail" | "list">("list");
    // The element id a link asked for (`#daily-brief`), scrolled to once its lazy tab has rendered it.
    const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
    const backButtonRef = useRef<HTMLButtonElement>(null);
    const navRef = useRef<HTMLElement>(null);

    // The URL opens it: a deep link on load, and a settings link anywhere (`settingsLinkSearch`), which keeps the page
    // and only sets these keys. A later link to another tab switches to it.
    const openFromUrl = useEffectEvent((tab: string | undefined, anchor: string | undefined) => {
        if (isSettingsTab(tab)) {
            setCurrentTab(tab);
            // A link to a section shows that section on a phone, not the list; the closed-modal reset below runs first.
            setMobileView("detail");
        }

        setPendingAnchor(anchor ?? null);
        open();
    });
    const closeFromUrl = useEffectEvent(() => {
        if (isOpen) {
            close();
        }
    });
    // Whether the URL is what opened it: Back past that link closes it, while one the gear opened never set the key.
    const isOpenInUrl = useRef(false);

    useEffect(() => {
        if (search.settings === true) {
            isOpenInUrl.current = true;
            openFromUrl(search.settingsTab, search.settingsAnchor);

            return;
        }

        if (isOpenInUrl.current) {
            isOpenInUrl.current = false;
            closeFromUrl();
        }
    }, [search.settings, search.settingsTab, search.settingsAnchor]);

    // A link to the tab the URL already names leaves the search as it was, so the effect above does not run: the link's
    // own request switches the tab then (`settings-request.ts`).
    const requestId = useSettingsRequest((state) => state.request?.id);
    // A request made before this modal mounted (a link clicked, the modal closed, the page left) is not one for it.
    const handledRequestId = useRef(requestId);

    useEffect(() => {
        const { request } = useSettingsRequest.getState();

        if (request && request.id !== handledRequestId.current) {
            handledRequestId.current = request.id;
            openFromUrl(request.tab, request.anchor);
        }
    }, [requestId]);

    // Latch the first open during render: React documents adjusting state directly
    // in the render pass instead of in an effect, which avoids the extra pass.
    if (isOpen && !hasOpened) {
        setHasOpened(true);
    }

    // The flags are built before the call: the Lingui macro reads `fn({ … }, t)` as a call to `t` itself and compiles the whole call away.
    const navigationGroups = useMemo(() => {
        const flags = { activeOrganization: Boolean(activeOrganization), apiKey: Boolean(apiKey), organization: Boolean(organization) };

        return resolveSettingsNavigation(flags, t);
    }, [t, apiKey, organization, activeOrganization]);
    const settingsSearch = useSettingsSearch(navigationGroups);
    const { query: searchQuery, setQuery: setSearchQuery } = settingsSearch;
    const searchInputRef = useRef<HTMLInputElement>(null);
    const tabContentRef = useRef<HTMLDivElement>(null);
    // The setting a search result asked to scroll to; a new object per pick, so choosing the same one again jumps again.
    const [pendingJump, setPendingJump] = useState<{ label: string } | null>(null);
    // Where the last pick led, for the live region: the field is empty after a pick, so nothing else tells a screen reader it worked.
    const [announcement, setAnnouncement] = useState("");

    // The current tab stays in view in the list: a link can open one far down (Account, Privacy).
    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        // The dialog renders its list after this commit, so the scroll waits a frame for it.
        const frame = requestAnimationFrame(() => {
            navRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
        });

        return () => cancelAnimationFrame(frame);
    }, [isOpen, currentTab]);

    // "/" jumps to the search, as the hint in the field says; typed into a field it is just a slash.
    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            const field = searchInputRef.current;

            // Shift stays allowed: on some layouts "/" is Shift+7. A key that is part of an IME composition is not a slash yet.
            if (event.key !== "/" || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || !field || field.offsetParent === null) {
                return;
            }

            const target = event.target as HTMLElement | null;

            if (target?.closest("input, textarea, select, [contenteditable='true']")) {
                return;
            }

            event.preventDefault();
            field.focus();
        };

        document.addEventListener("keydown", onKeyDown);

        return () => document.removeEventListener("keydown", onKeyDown);
    }, [isOpen]);

    // Runs after the destination tab's commit; the tab may still be loading its chunk, which the jump waits for.
    // Moves focus to the row's own control when it has one; a row without one leaves focus in the search field.
    useEffect(() => {
        // A closed modal cancels the wait: the row must not scroll or take focus after the dialog is gone.
        if (!isOpen || !pendingJump || !tabContentRef.current) {
            return undefined;
        }

        return jumpToSettingsRow(tabContentRef.current, pendingJump.label, (control) => control?.focus({ preventScroll: true }));
    }, [isOpen, pendingJump]);

    useEffect(() => {
        if (!isOpen || !pendingAnchor) {
            return undefined;
        }

        return scrollToAnchorWhenRendered(
            () => tabContentRef.current,
            pendingAnchor,
            () => setPendingAnchor(null),
        );
    }, [isOpen, pendingAnchor, currentTab]);

    // The modal stays mounted, so a query left in the field would greet the next opening.
    // Cleared on any close, including ones that bypass `handleClose`.
    if (!isOpen && (searchQuery !== "" || announcement !== "" || pendingJump !== null || pendingAnchor !== null || mobileView !== "list")) {
        setMobileView("list");
        setSearchQuery("");
        setAnnouncement("");
        // A jump that was cancelled by closing must not replay when the dialog opens again.
        setPendingJump(null);
        setPendingAnchor(null);
    }

    // Compute query options at render time — queryOptions() calls hooks internally
    // and cannot be invoked inside event handlers.
    const userSettingsOptions = crpc.auth.functions.getUserSettings.queryOptions({});
    const aiPrefsOptions = crpc.auth.functions.getAIUserPreferences.queryOptions({});
    const gdprStatusOptions = crpc.gdpr.functions.getGdprStatus.queryOptions({});
    const importStatusOptions = crpc.chat_import.functions.getImportStatus.queryOptions({});
    const systemPromptPresetsOptions = crpc.system_prompts.functions.listPresets.queryOptions({});

    const prefetchTabData = useCallback(
        (tab: SettingsTab) => {
            switch (tab) {
                case "app-customization":
                case "chat-personalization": {
                    void queryClient.prefetchQuery(userSettingsOptions);
                    break;
                }
                case "chat-agent":
                case "chat-api-keys":
                case "chat-default-models":
                case "chat-mcp":
                case "chat-models":
                case "chat-tools": {
                    void queryClient.prefetchQuery(aiPrefsOptions);
                    break;
                }
                case "chat-system-prompts": {
                    void queryClient.prefetchQuery(systemPromptPresetsOptions);
                    break;
                }
                case "privacy": {
                    void queryClient.prefetchQuery(gdprStatusOptions);
                    void queryClient.prefetchQuery(importStatusOptions);
                    break;
                }
                default: {
                    break;
                }
            }
        },
        [queryClient, userSettingsOptions, aiPrefsOptions, systemPromptPresetsOptions, gdprStatusOptions, importStatusOptions],
    );

    const handleClose = () => {
        close(); // Instant via Zustand — no navigation delay
        // Clean up URL params in the background
        // The registered router type is the widened `createTanstackRouter` return (see the
        // `Register` declaration in `src/router.tsx`), which collapses the search-updater type to
        // `never` — no updater literal can satisfy it. The updater itself is sound: with no `to`,
        // it stays on the current route and strips only the modal's own two keys.
        type SearchUpdater = NonNullable<Parameters<typeof navigate>[0]>["search"];
        const stripModalSearchParams = (previous: Record<string, unknown>): Record<string, unknown> =>
            Object.fromEntries(Object.entries(previous).filter(([key]) => !MODAL_SEARCH_KEYS.has(key)));

        // Replaced, not pushed: Back from here must go to the page before the settings link, not to the link again.
        navigate({ replace: true, search: stripModalSearchParams as unknown as SearchUpdater });
    };

    // The control that switched the view is hidden by it, so on a phone focus moves to the view that appeared. Never on desktop, never on close.
    const focusAfterViewChange = (target: () => HTMLElement | null | undefined) => {
        if (globalThis.matchMedia(MOBILE_BREAKPOINT_QUERY).matches) {
            requestAnimationFrame(() => target()?.focus());
        }
    };

    const handleTabChange = (tab: SettingsTab) => {
        // Update local state only — no navigation. Navigating on every tab click
        // can trigger Base UI's dialog dismiss logic during rapid re-renders.
        // The current tab is not written to the URL during a session; the initial
        // tab is read from the URL on mount so deep-links (?settingsTab=privacy) still work.
        setCurrentTab(tab);
        setMobileView("detail");
        focusAfterViewChange(() => backButtonRef.current);
        // A jump still waiting on the old tab is over.
        setPendingJump(null);
    };

    const handleSearchSelect = (entry: SettingsSearchEntry) => {
        const { label, tab, tabLabel } = entry;

        handleTabChange(tab);
        setPendingJump(entry.kind === "setting" ? { label } : null);
        setAnnouncement(entry.kind === "setting" ? t`Opened ${tabLabel}: ${label}` : t`Opened ${tabLabel}`);
        setSearchQuery("");

        // The chosen result unmounts with the list; keep focus in the dialog. On a phone the content takes over instead, and the keyboard stays down.
        if (!globalThis.matchMedia(MOBILE_BREAKPOINT_QUERY).matches) {
            searchInputRef.current?.focus();
        }
    };

    // Pre-compute the set of auth-required tabs for O(1) lock checks.
    const lockedTabs = useMemo<Set<SettingsTab>>(() => {
        if (!isAnonymous) {
            return new Set();
        }

        const locked = new Set<SettingsTab>(isSignedOut ? SESSION_TABS : []);

        for (const group of navigationGroups) {
            for (const item of group.items) {
                if (item.requiresAuth) {
                    locked.add(item.tab);
                }
            }
        }

        return locked;
    }, [isAnonymous, isSignedOut, navigationGroups]);

    // Loads a tab's chunk and data ahead of opening it; a tab the navigation locks for a guest loads nothing.
    const previewTab = (tab: SettingsTab) => {
        if (lockedTabs.has(tab)) {
            return;
        }

        preloadTab[tab]?.();
        prefetchTabData(tab);
    };

    // The selected result is the one Enter opens, whether it is on top after typing, reached with the arrow keys or hovered.
    const activeResultTab = settingsSearch.activeEntry?.tab;
    const previewActiveResult = useEffectEvent(() => {
        if (activeResultTab) {
            previewTab(activeResultTab);
        }
    });

    useEffect(() => {
        previewActiveResult();
    }, [activeResultTab]);

    // Don't mount until first opened; once mounted, keep alive so the Dialog's
    // Activity component can deactivate/reactivate content without remounting.
    if (!isOpen && !hasOpened) {
        return null;
    }

    // From every tab, not only the listed ones: a link can open a tab whose nav entry is hidden (API keys without the plugin).
    const getTabTitle = (): string => {
        const item = SETTINGS_NAVIGATION.flatMap((group) => group.items).find((i) => i.tab === currentTab);

        return item ? i18n._(item.label) : t`Settings`;
    };

    const renderContent = (): ReactNode => {
        if (lockedTabs.has(currentTab)) {
            return <AnonymousUpgradeGate label={getTabTitle()} />;
        }

        switch (currentTab) {
            case "app-customization": {
                return <AppCustomizationSettings />;
            }
            case "app-keyboard": {
                return <KeyboardShortcutsSettings />;
            }
            case "auth-account": {
                return <AccountSettingsCards />;
            }
            case "auth-api-keys": {
                return <APIKeysCard />;
            }
            case "auth-billing": {
                return (
                    <div className="space-y-6">
                        <PersonalPlanCard />
                        <BillingSettingsCard />
                    </div>
                );
            }
            case "auth-members": {
                return (
                    <div className="space-y-6">
                        <OrganizationMembersCard />
                        <OrganizationInvitationsCard />
                    </div>
                );
            }
            case "auth-organization": {
                return <OrganizationSettingsCards />;
            }
            case "auth-organizations": {
                return <OrganizationsCard />;
            }
            case "auth-security": {
                return <SecuritySettingsCards />;
            }
            case "auth-teams": {
                return <TeamsCard />;
            }
            case "chat-agent": {
                return <AgentSettings />;
            }
            case "chat-api-keys": {
                return <ProviderAPIKeysSettings />;
            }
            case "chat-bots": {
                return <BotsSettings />;
            }
            case "chat-default-models": {
                return <DefaultModelsSettings />;
            }
            case "chat-devices": {
                return <DevicesSettings />;
            }
            case "chat-knowledge": {
                return <KnowledgeBaseSettings />;
            }
            case "chat-mcp": {
                return <MCPSettings />;
            }
            case "chat-model-filters": {
                return <ModelFilterSettings />;
            }
            case "chat-models": {
                return <ModelsSettings />;
            }
            case "chat-personalization": {
                return <PersonalizationSettings />;
            }
            case "chat-sub-agent-roles": {
                return <SubAgentRolesSettings />;
            }
            case "chat-system-prompts": {
                return <SystemPromptPresetSettings />;
            }
            case "chat-tools": {
                return <ToolPermissionsSettings />;
            }
            case "chat-triggers": {
                return <TriggerSettings />;
            }
            case "chat-usage": {
                return <UsageSettings />;
            }
            case "connectors": {
                return <ConnectorsPage />;
            }
            case "connectors-messenger": {
                return <MessengerPage />;
            }
            case "privacy": {
                return <PrivacySettings />;
            }
            default: {
                return <AppCustomizationSettings />;
            }
        }
    };

    return (
        <Dialog onOpenChange={(nextOpen) => !nextOpen && handleClose()} open={isOpen}>
            <DialogContent
                bottomStickOnMobile={false}
                className="-m-4 flex h-dvh max-h-none w-[calc(100%+2rem)] max-w-none flex-row gap-0 overflow-hidden rounded-none border-0 p-0 md:m-0 md:h-[calc(100dvh-4rem)] md:max-h-none md:w-[95vw] md:max-w-6xl md:rounded-2xl md:border"
                showCloseButton
            >
                {/* Sidebar */}
                <div className={cn("bg-sidebar h-full w-full shrink-0 flex-col border-r md:flex md:w-60", mobileView === "detail" ? "hidden" : "flex")}>
                    {/* The dialog's name. On a phone the list is a screen of its own, so it shows there; from md the content header says it. */}
                    <DialogHeader className="px-4 pt-4 pb-1 md:sr-only">
                        <DialogTitle className="flex h-6 items-center gap-2">
                            <Settings aria-hidden="true" className="size-4" />
                            {t`Settings`}
                        </DialogTitle>
                        <DialogDescription className="sr-only">{t`Configure your application settings`}</DialogDescription>
                    </DialogHeader>
                    <SettingsSearchField
                        activeOptionId={settingsSearch.activeOptionId}
                        announcement={announcement}
                        inputRef={searchInputRef}
                        isSearching={settingsSearch.isSearching}
                        listboxId={settingsSearch.listboxId}
                        onActivate={() => settingsSearch.activeEntry && handleSearchSelect(settingsSearch.activeEntry)}
                        onMove={settingsSearch.moveActive}
                        query={searchQuery}
                        resultCount={settingsSearch.resultCount}
                        setQuery={(value) => {
                            setAnnouncement("");
                            // Typing starts a new search: a row still being waited for must not take focus meanwhile.
                            setPendingJump(null);
                            setSearchQuery(value);
                        }}
                    />
                    {/* Keyed on the mode: the results are a new list, so they start at the top instead of at the navigation's scroll offset. */}
                    <ScrollArea className="flex-1" key={settingsSearch.isSearching ? `search-${searchQuery}` : "navigation"}>
                        <SettingsSearchResults
                            activeIndex={settingsSearch.activeIndex}
                            groups={settingsSearch.groups}
                            isSearching={settingsSearch.isSearching}
                            listboxId={settingsSearch.listboxId}
                            lockedTabs={lockedTabs}
                            onSelect={handleSearchSelect}
                            optionId={settingsSearch.optionId}
                            setActive={settingsSearch.setActive}
                        />
                        {!settingsSearch.isSearching && (
                            <nav className="flex flex-col px-3 pb-3" ref={navRef}>
                                {navigationGroups.map((group, index) => (
                                    <div className={cn("flex flex-col gap-px", index > 0 && "mt-4")} key={group.label}>
                                        <div className="text-muted-foreground mb-1 px-2 font-mono text-xs">{group.label}</div>
                                        {group.items.map((item) => {
                                            const Icon = item.icon;
                                            const isActive = currentTab === item.tab;
                                            const isLocked = lockedTabs.has(item.tab);

                                            // The light nav is white like the row-active fill, so light uses the pressed-in well instead.
                                            const stateClassName = isActive
                                                ? "bg-surface-well dark:bg-surface-row-active text-foreground"
                                                : "text-muted-foreground web:hover:bg-surface-row-hover hover:text-foreground";

                                            return (
                                                <button
                                                    aria-current={isActive ? "true" : undefined}
                                                    className={cn(
                                                        "flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-sm transition-colors md:h-8 md:py-0",
                                                        stateClassName,
                                                    )}
                                                    key={item.tab}
                                                    onClick={() => handleTabChange(item.tab)}
                                                    onMouseEnter={() => {
                                                        if (isLocked) {
                                                            return;
                                                        }

                                                        preloadTab[item.tab]?.();
                                                        prefetchTabData(item.tab);
                                                    }}
                                                    type="button"
                                                >
                                                    <Icon aria-hidden="true" className="size-4" />
                                                    <span className="flex-1 text-left">{item.label}</span>
                                                    {/* The lock marks it; the label stays readable, since it still opens the tab's sign-in prompt. */}
                                                    {isLocked && <Lock aria-hidden="true" className="h-3 w-3 shrink-0" />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                ))}
                            </nav>
                        )}
                    </ScrollArea>
                </div>

                {/* Content */}
                <div className={cn("min-w-0 flex-1 flex-col md:flex", mobileView === "detail" ? "flex" : "hidden")}>
                    <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4 pe-14">
                        <Button
                            aria-label={t`Back to settings sections`}
                            className="-ms-2 shrink-0 md:hidden"
                            onClick={() => {
                                setMobileView("list");
                                focusAfterViewChange(() => navRef.current?.querySelector<HTMLElement>('[aria-current="true"]'));
                            }}
                            ref={backButtonRef}
                            size="icon"
                            variant="ghost"
                        >
                            <ArrowLeft aria-hidden="true" />
                        </Button>
                        <p aria-hidden="true" className="text-muted-foreground hidden shrink-0 text-sm md:block">
                            {t`Settings`}
                            <span className="text-muted-foreground/60 px-2">/</span>
                        </p>
                        <h2 className="min-w-0 truncate text-sm font-medium">{getTabTitle()}</h2>
                    </div>
                    <ScrollArea className="flex-1" key={`${currentTab}-${tabRetryKey}`}>
                        <DialogPanel className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-8">
                            <ErrorBoundary
                                fallback={(error) => <SettingsTabError error={error} onRetry={() => setTabRetryKey((k) => k + 1)} />}
                                showToast={false}
                            >
                                {/* Under the dialog title and this tab's h2: a card title in the tab is an h3. */}
                                <HeadingLevelProvider level={3}>
                                    <div ref={tabContentRef}>
                                        <Suspense fallback={<SettingsLoadingFallback />}>{renderContent()}</Suspense>
                                    </div>
                                </HeadingLevelProvider>
                            </ErrorBoundary>
                        </DialogPanel>
                    </ScrollArea>
                </div>
            </DialogContent>
        </Dialog>
    );
};
