/**
 * The dashboard's page and section names, one descriptor each — the sidebar
 * nav and the breadcrumb both read them, so a page is called the same in both
 * and in every locale. Descriptors, not strings: this is module scope, and the
 * caller translates (`i18n._`).
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export const DASHBOARD_PAGE_NAMES = {
    account: msg`Account`,
    admin: msg`Admin`,
    adminDashboard: msg`Dashboard`,
    agent: msg`Agent`,
    apiKeys: msg`API Keys`,
    app: msg`App`,
    auditLog: msg`Audit Log`,
    auth: msg`Auth`,
    chat: msg`Chat`,
    connectors: msg`Connectors`,
    customization: msg`Customization`,
    devices: msg`Devices`,
    home: msg`Home`,
    keyboardShortcuts: msg`Keyboard Shortcuts`,
    knowledge: msg`Knowledge Base`,
    mcp: msg`MCP Servers`,
    members: msg`Members`,
    messenger: msg`Messenger`,
    modelRestrictions: msg`Model Restrictions`,
    models: msg`Models`,
    organization: msg`Organization`,
    organizations: msg`Organizations`,
    personalization: msg`Personalization`,
    privacy: msg`Privacy`,
    privacyAndData: msg`Privacy & Data`,
    security: msg`Security`,
    settings: msg`Settings`,
    teams: msg`Teams`,
    triggers: msg`Triggers`,
    usage: msg`Usage`,
    users: msg`Users`,
} satisfies Record<string, MessageDescriptor>;

type PageName = keyof typeof DASHBOARD_PAGE_NAMES;

/**
 * A URL segment under `/dashboard` → its page's name. The last segment of a
 * nav item's URL maps to that item's name; a segment that is only a section
 * (`app`, `auth`) maps to the section's nav label.
 */
const SEGMENT_NAMES: Record<string, PageName> = {
    account: "account",
    admin: "admin",
    agent: "agent",
    "api-keys": "apiKeys",
    app: "app",
    "audit-log": "auditLog",
    auth: "auth",
    chat: "chat",
    connectors: "connectors",
    customization: "customization",
    dashboard: "home",
    devices: "devices",
    "keyboard-shortcuts": "keyboardShortcuts",
    knowledge: "knowledge",
    mcp: "mcp",
    members: "members",
    messenger: "messenger",
    "model-filters": "modelRestrictions",
    models: "models",
    organization: "organization",
    organizations: "organizations",
    personalization: "personalization",
    privacy: "privacyAndData",
    security: "security",
    settings: "settings",
    teams: "teams",
    triggers: "triggers",
    usage: "usage",
    users: "users",
};

/** The breadcrumb label of a path segment: its page's translated name, or the segment itself (a dynamic id). */
export const breadcrumbLabel = (segment: string, translate: (descriptor: MessageDescriptor) => string): string => {
    const name = Object.hasOwn(SEGMENT_NAMES, segment) ? SEGMENT_NAMES[segment] : undefined;

    return name ? translate(DASHBOARD_PAGE_NAMES[name]) : segment;
};

/**
 * The name of the settings page at `pathname` — what its `h1` says — or
 * `undefined` off the settings tree and on a page without a name of its own
 * (the OAuth `callback`, which renders its own heading).
 */
export const settingsPageName = (pathname: string): MessageDescriptor | undefined => {
    const segments = pathname.split("/").filter(Boolean);

    if (segments.length < 3 || segments[0] !== "dashboard" || segments[1] !== "settings") {
        return undefined;
    }

    const last = segments.at(-1) ?? "";
    const name = Object.hasOwn(SEGMENT_NAMES, last) ? SEGMENT_NAMES[last] : undefined;

    return name ? DASHBOARD_PAGE_NAMES[name] : undefined;
};
