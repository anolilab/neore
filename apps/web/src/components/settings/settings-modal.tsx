"use client";

import { useLingui } from "@lingui/react/macro";
import { Button, buttonVariants } from "@neore/ui/components/button";
import { HeadingLevelProvider } from "@neore/ui/components/heading";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import cn from "@neore/ui/utils/cn";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
    AlertTriangle,
    BookOpen,
    Bot,
    Brain,
    Building,
    Cable,
    CreditCard,
    Key,
    Keyboard,
    Lock,
    RefreshCw,
    Settings,
    Shield,
    ShieldCheck,
    Sparkles,
    User,
    UserCog,
    Users,
} from "lucide-react";
import type { FC, ReactNode } from "react";
import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";

import { ErrorBoundary } from "@/components/error-boundary";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useModalState } from "@/features/layout/hooks/use-ui-state";
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

// Settings tab types
export type SettingsTab =
    | "app-customization"
    | "chat-personalization"
    | "chat-knowledge"
    | "app-keyboard"
    | "chat-default-models"
    | "chat-models"
    | "chat-agent"
    | "chat-mcp"
    | "chat-tools"
    | "chat-api-keys"
    | "chat-system-prompts"
    | "auth-account"
    | "auth-security"
    | "auth-api-keys"
    | "auth-organizations"
    | "auth-organization"
    | "auth-billing"
    | "auth-members"
    | "auth-teams"
    | "privacy";

interface SettingsNavItem {
    icon: typeof Settings;
    label: string;
    requiresAuth?: boolean;
    tab: SettingsTab;
}

interface SettingsNavGroup {
    items: SettingsNavItem[];
    label: string;
}

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

    const navigationGroups = useMemo<SettingsNavGroup[]>(() => {
        const groups: SettingsNavGroup[] = [
            {
                items: [
                    { icon: Settings, label: t`Customization`, tab: "app-customization" },
                    { icon: Keyboard, label: t`Keyboard Shortcuts`, tab: "app-keyboard" },
                ],
                label: t`App`,
            },
            {
                items: [
                    { icon: UserCog, label: t`Personalization`, tab: "chat-personalization" },
                    { icon: Sparkles, label: t`System Prompts`, requiresAuth: true, tab: "chat-system-prompts" },
                    { icon: BookOpen, label: t`Knowledge Base`, requiresAuth: true, tab: "chat-knowledge" },
                    { icon: Brain, label: t`Default Models`, tab: "chat-default-models" },
                    { icon: Brain, label: t`Models`, tab: "chat-models" },
                    { icon: Bot, label: t`Agent`, requiresAuth: true, tab: "chat-agent" },
                    { icon: Cable, label: t`MCP Servers`, requiresAuth: true, tab: "chat-mcp" },
                    { icon: ShieldCheck, label: t`Tool Permissions`, requiresAuth: true, tab: "chat-tools" },
                    { icon: Key, label: t`API Keys`, requiresAuth: true, tab: "chat-api-keys" },
                ],
                label: t`Chat`,
            },
            {
                items: [
                    { icon: User, label: t`Account`, tab: "auth-account" },
                    { icon: Shield, label: t`Security`, tab: "auth-security" },
                    ...(apiKey ? [{ icon: Key, label: t`API Keys`, requiresAuth: true, tab: "auth-api-keys" as const }] : []),
                    ...(organization ? [{ icon: Building, label: t`Organizations`, requiresAuth: true, tab: "auth-organizations" as const }] : []),
                    // Billing for everyone signed in: Pro is a per-user plan.
                    { icon: CreditCard, label: t`Billing`, requiresAuth: true, tab: "auth-billing" as const },
                    ...(activeOrganization
                        ? [
                              { icon: Building, label: t`Organization`, requiresAuth: true, tab: "auth-organization" as const },
                              { icon: Users, label: t`Members`, requiresAuth: true, tab: "auth-members" as const },
                          ]
                        : []),
                ],
                label: t`Account`,
            },
            {
                items: [{ icon: Lock, label: t`Privacy & Data`, tab: "privacy" }],
                label: t`Privacy`,
            },
        ];

        return groups;
    }, [t, apiKey, organization, activeOrganization]);

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
                    <ScrollArea className="flex-1">
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
                                                className={cn("flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors", stateClassName)}
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
                                    <Suspense fallback={<SettingsLoadingFallback />}>{renderContent()}</Suspense>
                                </HeadingLevelProvider>
                            </ErrorBoundary>
                        </DialogPanel>
                    </ScrollArea>
                </div>
            </DialogContent>
        </Dialog>
    );
};
