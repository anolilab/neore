"use client";

import { useLingui } from "@lingui/react/macro";
import { Button, buttonVariants } from "@neore/ui/components/button";
import { HeadingLevelProvider } from "@neore/ui/components/heading";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import cn from "@neore/ui/utils/cn";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AlertTriangle, Lock, RefreshCw, Settings } from "lucide-react";
import type { FC, ReactNode } from "react";
import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { ErrorBoundary } from "@/components/error-boundary";
import { SettingsSearchField, SettingsSearchResults, useSettingsSearch } from "@/components/settings/settings-search";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useModalState } from "@/features/layout/hooks/use-ui-state";
import { jumpToSettingsRow } from "@/features/settings/lib/settings-jump";
import type { SettingsTab } from "@/features/settings/lib/settings-navigation";
import { resolveSettingsNavigation } from "@/features/settings/lib/settings-navigation";
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
const DefaultModelsSettings = lazy(() => import("@/features/settings/components/chat/default-models-settings"));
const ModelsSettings = lazy(() => import("@/features/settings/components/chat/models-settings"));
const PrivacySettings = lazy(() => import("@/features/settings/components/privacy/privacy-settings"));
const KeyboardShortcutsSettings = lazy(() => import("@/features/settings/components/keyboard/keyboard-shortcuts-settings"));
const PersonalizationSettings = lazy(() => import("@/features/settings/components/personalization/personalization-settings"));
const KnowledgeBaseSettings = lazy(() => import("@/features/settings/components/knowledge/knowledge-base-settings"));
const ProviderAPIKeysSettings = lazy(() => import("@/features/settings/components/chat/api-keys-settings"));
const SystemPromptPresetSettings = lazy(() => import("@/features/settings/components/chat/system-prompt-preset-settings"));

// Preload all tab chunks in parallel so switching tabs is instant.
// Call on settings button hover so chunks are ready before the modal opens.
// Vite deduplicates — safe to call multiple times.
export const preloadSettingsTabs = () => {
    import("@/features/auth/components/settings/account-settings-cards");
    import("@/features/auth/components/settings/security-settings-cards");
    import("@/features/auth/components/settings/api-key/api-keys-card");
    import("@/features/auth/components/organization/organizations-card");
    import("@/features/auth/components/organization/organization-settings-cards");
    import("@/features/auth/components/organization/organization-members-card");
    import("@/features/auth/components/organization/organization-invitations-card");
    import("@/features/auth/components/team/teams-card");
    import("@/features/auth/components/organization/billing-settings-card");
    import("@/features/billing/components/personal-plan-card");
    import("@/features/settings/components/account/account-settings");
    import("@/features/settings/components/chat/agent-settings");
    import("@/features/settings/components/chat/mcp-settings");
    import("@/features/settings/components/chat/tool-permissions-settings");
    import("@/features/settings/components/chat/default-models-settings");
    import("@/features/settings/components/chat/models-settings");
    import("@/features/settings/components/privacy/privacy-settings");
    import("@/features/settings/components/keyboard/keyboard-shortcuts-settings");
    import("@/features/settings/components/personalization/personalization-settings");
    import("@/features/settings/components/knowledge/knowledge-base-settings");
    import("@/features/settings/components/chat/api-keys-settings");
};

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
    "chat-personalization": () => import("@/features/settings/components/personalization/personalization-settings"),
    "chat-system-prompts": () => import("@/features/settings/components/chat/system-prompt-preset-settings"),
    privacy: () => import("@/features/settings/components/privacy/privacy-settings"),
};

// Search params the settings modal owns and strips on close.
const MODAL_SEARCH_KEYS = new Set(["settings", "settingsTab"]);

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

    return (
        <div className="flex h-64 flex-col items-center justify-center gap-4 p-6 text-center">
            <div className="bg-muted flex size-12 items-center justify-center rounded-full">
                <Lock className="text-muted-foreground size-5" />
            </div>
            <div>
                <p className="font-medium">
                    {label} {t`requires an account`}
                </p>
                <p className="text-muted-foreground mt-1 text-sm">{t`Sign up and subscribe for $8/mo to unlock all features.`}</p>
            </div>
            {/* A link styled as a button: it navigates, so it keeps link semantics. */}
            <a className={buttonVariants({ size: "sm" })} href="/auth/sign-up">
                {t`Create an account`}
            </a>
        </div>
    );
};

export const SettingsModal: FC = () => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const search = useSearch({ strict: false }) as { settings?: boolean; settingsTab?: SettingsTab };
    const queryClient = useQueryClient();
    const crpc = useCRPC();
    const { apiKey, hooks, organization } = useAuth();
    const { data: activeOrganization } = hooks.useActiveOrganization();
    const { isAnonymous } = useIsAnonymous();

    const { close, isOpen, open } = useModalState("settings");
    // Once opened, stay mounted so the Dialog's Activity component can
    // deactivate/reactivate content without remounting.
    const [hasOpened, setHasOpened] = useState(false);

    // Local tab state for instant switching — URL is updated in the background
    // for deep-link/back-button support only.
    const [currentTab, setCurrentTab] = useState<SettingsTab>((search.settingsTab as SettingsTab) || "app-customization");
    // Incrementing this resets the error boundary for the current tab (retry).
    // Changing currentTab also resets it via the ScrollArea key below.
    const [tabRetryKey, setTabRetryKey] = useState(0);

    // Sync from URL on first mount so deep-linked ?settings=true still works.
    // `currentTab` already seeds itself from `search.settingsTab` above.
    const openIfDeepLinked = useEffectEvent(() => {
        if (search.settings === true) {
            open();
        }
    });

    useEffect(() => {
        openIfDeepLinked();
    }, []);

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

    // Runs after the destination tab's commit; the tab may still be loading its chunk, which the jump waits for.
    // Moves focus to the row's own control when it has one; a row without one leaves focus in the search field.
    useEffect(() => {
        // A closed modal cancels the wait: the row must not scroll or take focus after the dialog is gone.
        if (!isOpen || !pendingJump || !tabContentRef.current) {
            return undefined;
        }

        return jumpToSettingsRow(tabContentRef.current, pendingJump.label, (control) => control?.focus({ preventScroll: true }));
    }, [isOpen, pendingJump]);

    // The modal stays mounted, so a query left in the field would greet the next opening.
    // Cleared on any close, including ones that bypass `handleClose`.
    if (!isOpen && (searchQuery !== "" || announcement !== "")) {
        setSearchQuery("");
        setAnnouncement("");
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

        navigate({ search: stripModalSearchParams as unknown as SearchUpdater });
    };

    const handleTabChange = (tab: SettingsTab) => {
        // Update local state only — no navigation. Navigating on every tab click
        // can trigger Base UI's dialog dismiss logic during rapid re-renders.
        // The current tab is not written to the URL during a session; the initial
        // tab is read from the URL on mount so deep-links (?settingsTab=privacy) still work.
        setCurrentTab(tab);
        // A jump still waiting on the old tab is over.
        setPendingJump(null);
    };

    const handleSearchSelect = (entry: SettingsSearchEntry) => {
        const { label, tab, tabLabel } = entry;

        handleTabChange(tab);
        setPendingJump(entry.kind === "setting" ? { label } : null);
        setAnnouncement(entry.kind === "setting" ? t`Opened ${tabLabel}: ${label}` : t`Opened ${tabLabel}`);
        setSearchQuery("");
        // The chosen result unmounts with the list; keep focus in the dialog.
        searchInputRef.current?.focus();
    };

    // Pre-compute the set of auth-required tabs for O(1) lock checks.
    const lockedTabs = useMemo<Set<SettingsTab>>(() => {
        if (!isAnonymous) {
            return new Set();
        }

        const locked = new Set<SettingsTab>();

        for (const group of navigationGroups) {
            for (const item of group.items) {
                if (item.requiresAuth) {
                    locked.add(item.tab);
                }
            }
        }

        return locked;
    }, [isAnonymous, navigationGroups]);

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

    const getTabTitle = (): string => {
        for (const group of navigationGroups) {
            const item = group.items.find((i) => i.tab === currentTab);

            if (item) {
                return item.label;
            }
        }

        return t`Settings`;
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
            case "chat-default-models": {
                return <DefaultModelsSettings />;
            }
            case "chat-knowledge": {
                return <KnowledgeBaseSettings />;
            }
            case "chat-mcp": {
                return <MCPSettings />;
            }
            case "chat-models": {
                return <ModelsSettings />;
            }
            case "chat-personalization": {
                return <PersonalizationSettings />;
            }
            case "chat-system-prompts": {
                return <SystemPromptPresetSettings />;
            }
            case "chat-tools": {
                return <ToolPermissionsSettings />;
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
                className="flex h-[min(580px,calc(100vh-82px))] max-h-[95%] w-[480px] max-w-[98%] flex-row gap-0 overflow-hidden p-0 md:h-[min(672px,calc(100vh-82px))] md:w-[95vw] md:max-w-6xl"
                showCloseButton
            >
                {/* Sidebar */}
                <div className="bg-sidebar-foreground flex h-full w-64 shrink-0 flex-col border-r">
                    <DialogHeader className="px-4 pt-4 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-8">
                        {/* TODO: ADD LOGO */}
                        <DialogTitle className="flex h-6 items-center gap-2">
                            <Settings className="size-4" />
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
                            setSearchQuery(value);
                        }}
                    />
                    {/* Keyed on the mode: the results are a new list, so they start at the top instead of at the navigation's scroll offset. */}
                    <ScrollArea className="flex-1" key={settingsSearch.isSearching ? "search" : "navigation"}>
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
                            <nav className="flex flex-col gap-1 p-2">
                                {navigationGroups.map((group) => (
                                    <div className="mb-2" key={group.label}>
                                        <div className="text-muted-foreground mb-1 px-3 text-xs font-medium tracking-wider uppercase">{group.label}</div>
                                        {group.items.map((item) => {
                                            const Icon = item.icon;
                                            const isActive = currentTab === item.tab;
                                            const isLocked = isAnonymous && item.requiresAuth;

                                            let stateClassName = "text-muted-foreground hover:bg-muted hover:text-foreground";

                                            if (isActive) {
                                                stateClassName = "bg-primary text-primary-foreground";
                                            } else if (isLocked) {
                                                stateClassName = "text-muted-foreground/40 hover:bg-muted hover:text-muted-foreground";
                                            }

                                            return (
                                                <button
                                                    className={cn(
                                                        "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
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
                                                    <Icon className="h-4 w-4" />
                                                    <span className="flex-1 text-left">{item.label}</span>
                                                    {isLocked && <Lock className="h-3 w-3 shrink-0 opacity-50" />}
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
                <div className="flex min-w-0 flex-1 flex-col">
                    <div className="border-b px-4 py-2">
                        <h2 className="font-heading h-7 text-xl">{getTabTitle()}</h2>
                    </div>
                    <ScrollArea className="flex-1" key={`${currentTab}-${tabRetryKey}`}>
                        <DialogPanel className="px-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-6">
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
