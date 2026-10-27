import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { LucideIcon } from "lucide-react";
import {
    BookOpen,
    Bot,
    Brain,
    Building,
    Cable,
    CreditCard,
    Key,
    Keyboard,
    Lock,
    Settings,
    Shield,
    ShieldCheck,
    Sparkles,
    User,
    UserCog,
    Users,
} from "lucide-react";

export const SETTINGS_TABS = [
    "app-customization",
    "chat-personalization",
    "chat-knowledge",
    "app-keyboard",
    "chat-default-models",
    "chat-models",
    "chat-agent",
    "chat-mcp",
    "chat-tools",
    "chat-api-keys",
    "chat-system-prompts",
    "auth-account",
    "auth-security",
    "auth-api-keys",
    "auth-organizations",
    "auth-organization",
    "auth-billing",
    "auth-members",
    "auth-teams",
    "privacy",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** What the signed-in session must offer for a tab to be listed. */
export type SettingsNavCondition = "activeOrganization" | "apiKey" | "organization";

export type SettingsNavFlags = Record<SettingsNavCondition, boolean>;

interface SettingsNavItemDefinition {
    icon: LucideIcon;
    label: MessageDescriptor;
    requiresAuth?: boolean;
    tab: SettingsTab;
    when?: SettingsNavCondition;
}

interface SettingsNavGroupDefinition {
    items: ReadonlyArray<SettingsNavItemDefinition>;
    label: MessageDescriptor;
}

export interface SettingsNavItem {
    icon: LucideIcon;
    label: string;
    requiresAuth?: boolean;
    tab: SettingsTab;
}

export interface SettingsNavGroup {
    items: SettingsNavItem[];
    label: string;
}

export const SETTINGS_NAVIGATION: ReadonlyArray<SettingsNavGroupDefinition> = [
    {
        items: [
            { icon: Settings, label: msg`Customization`, tab: "app-customization" },
            { icon: Keyboard, label: msg`Keyboard Shortcuts`, tab: "app-keyboard" },
        ],
        label: msg`App`,
    },
    {
        items: [
            { icon: UserCog, label: msg`Personalization`, tab: "chat-personalization" },
            { icon: Sparkles, label: msg`System Prompts`, requiresAuth: true, tab: "chat-system-prompts" },
            { icon: BookOpen, label: msg`Knowledge Base`, requiresAuth: true, tab: "chat-knowledge" },
            { icon: Brain, label: msg`Default Models`, tab: "chat-default-models" },
            { icon: Brain, label: msg`Models`, tab: "chat-models" },
            { icon: Bot, label: msg`Agent`, requiresAuth: true, tab: "chat-agent" },
            { icon: Cable, label: msg`MCP Servers`, requiresAuth: true, tab: "chat-mcp" },
            { icon: ShieldCheck, label: msg`Tool Permissions`, requiresAuth: true, tab: "chat-tools" },
            { icon: Key, label: msg`API Keys`, requiresAuth: true, tab: "chat-api-keys" },
        ],
        label: msg`Chat`,
    },
    {
        items: [
            { icon: User, label: msg`Account`, tab: "auth-account" },
            { icon: Shield, label: msg`Security`, tab: "auth-security" },
            { icon: Key, label: msg`API Keys`, requiresAuth: true, tab: "auth-api-keys", when: "apiKey" },
            { icon: Building, label: msg`Organizations`, requiresAuth: true, tab: "auth-organizations", when: "organization" },
            // Billing for everyone signed in: Pro is a per-user plan.
            { icon: CreditCard, label: msg`Billing`, requiresAuth: true, tab: "auth-billing" },
            { icon: Building, label: msg`Organization`, requiresAuth: true, tab: "auth-organization", when: "activeOrganization" },
            { icon: Users, label: msg`Members`, requiresAuth: true, tab: "auth-members", when: "activeOrganization" },
        ],
        label: msg`Account`,
    },
    {
        items: [{ icon: Lock, label: msg`Privacy & Data`, tab: "privacy" }],
        label: msg`Privacy`,
    },
];

/** The navigation as the signed-in user sees it: tabs whose condition does not hold are left out, labels are translated. */
export const resolveSettingsNavigation = (flags: SettingsNavFlags, translate: (descriptor: MessageDescriptor) => string): SettingsNavGroup[] =>
    SETTINGS_NAVIGATION.map((group) => {
        return {
            items: group.items
                .filter((item) => !item.when || flags[item.when])
                .map(({ icon, label, requiresAuth, tab }) => {
                    return { icon, label: translate(label), requiresAuth, tab };
                }),
            label: translate(group.label),
        };
    });
