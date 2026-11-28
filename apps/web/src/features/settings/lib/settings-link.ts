import type { SettingsTab } from "./settings-navigation";

/** Where the settings pages used to live. Notifications, emails and bookmarks still link here. */
const SETTINGS_PATH_PREFIX = "/dashboard/settings";

/** The old settings pages and the modal tab that shows each now. */
const TAB_BY_SETTINGS_PATH: Readonly<Record<string, SettingsTab>> = {
    "app/customization": "app-customization",
    "app/keyboard-shortcuts": "app-keyboard",
    "app/personalization": "chat-personalization",
    "auth/account": "auth-account",
    "auth/api-keys": "auth-api-keys",
    "auth/members": "auth-members",
    "auth/organization": "auth-organization",
    "auth/organizations": "auth-organizations",
    "auth/security": "auth-security",
    "auth/teams": "auth-teams",
    "chat/agent": "chat-agent",
    "chat/bots": "chat-bots",
    "chat/devices": "chat-devices",
    "chat/knowledge": "chat-knowledge",
    "chat/mcp": "chat-mcp",
    "chat/model-filters": "chat-model-filters",
    "chat/models": "chat-models",
    "chat/triggers": "chat-triggers",
    "chat/usage": "chat-usage",
    // Paths the LLM gateway's error actions link to.
    "api-keys": "chat-api-keys",
    "billing/limits": "auth-billing",
    "chat/model": "chat-models",
    "compliance/model-filters": "chat-model-filters",
    // The gateway's error actions. There is no page of PII rules: Privacy & Data is the nearest.
    "chat/compression": "app-customization",
    "compliance/pii": "privacy",
    connectors: "connectors",
    "connectors/messenger": "connectors-messenger",
    privacy: "privacy",
};

/** The one settings path that stays a page: the OAuth providers return to it. Nothing lives under it. */
const CALLBACK_PATH = "connectors/callback";

/** Admin has its own area: its paths and everything under them are not settings tabs (`adminPathFor`). */
const ADMIN_PATH = "admin";

const DEFAULT_TAB: SettingsTab = "app-customization";

/** The /admin page an old admin settings path stands for (`/dashboard/settings/admin/users` → `/admin/users`), or `undefined`. */
export const adminPathFor = (pathname: string): string | undefined => {
    const prefix = `${SETTINGS_PATH_PREFIX}/admin`;

    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
        return undefined;
    }

    const rest = pathname.slice(prefix.length);

    return rest === "" || rest === "/" ? "/admin" : `/admin${rest}`;
};

/** The row an old settings path points at inside its tab, for a path that names one setting rather than a page. */
const ANCHOR_BY_SETTINGS_PATH: Record<string, string> = {
    "chat/compression": "auto-compact-threshold",
};

/** The element id an old settings path points at in its tab, or `undefined`. */
export const settingsAnchorForPath = (pathname: string): string | undefined => {
    let path = pathname;

    while (path.endsWith("/")) {
        path = path.slice(0, -1);
    }

    return path.startsWith(`${SETTINGS_PATH_PREFIX}/`) ? ANCHOR_BY_SETTINGS_PATH[path.slice(SETTINGS_PATH_PREFIX.length + 1)] : undefined;
};

/**
 * The modal tab an old settings path stands for, or `undefined` for a path that is not a settings page. An unknown
 * page under the settings path opens the first tab rather than a 404.
 */
export const settingsTabForPath = (pathname: string): SettingsTab | undefined => {
    let path = pathname;

    while (path.endsWith("/")) {
        path = path.slice(0, -1);
    }

    if (path !== SETTINGS_PATH_PREFIX && !path.startsWith(`${SETTINGS_PATH_PREFIX}/`)) {
        return undefined;
    }

    const rest = path.slice(SETTINGS_PATH_PREFIX.length + 1);

    if (rest === CALLBACK_PATH || rest === ADMIN_PATH || rest.startsWith(`${ADMIN_PATH}/`)) {
        return undefined;
    }

    return TAB_BY_SETTINGS_PATH[rest] ?? DEFAULT_TAB;
};

/** The search keys that open the settings modal at a tab, on top of whatever the page already has. */

/**
 * The element id a URL fragment names, for a settings anchor: without its "#" and percent-decoded, since a link may
 * encode it (`#voice-mode%2Dvoice`). A malformed escape is kept as written rather than failing the navigation.
 */
export const anchorFromHash = (hash: string): string | undefined => {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;

    if (!raw) {
        return undefined;
    }

    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
};

export interface SettingsSearch {
    settings: true;
    settingsAnchor?: string;
    settingsTab: SettingsTab;
}

/** A search updater that opens settings at `tab` and keeps the page and its own search. */
export const settingsLinkSearch =
    (tab: SettingsTab, anchor?: string) =>
    (previous: Record<string, unknown>): Record<string, unknown> & SettingsSearch => {
        // An anchor from an earlier settings link must not carry over to this one.
        const next: Record<string, unknown> = { ...previous, settings: true, settingsTab: tab };

        delete next.settingsAnchor;

        return { ...next, ...(anchor && { settingsAnchor: anchor }) } as Record<string, unknown> & SettingsSearch;
    };

/**
 * Where settings open when there is no page to stay on: an old settings URL, the OAuth callback, a page the user may
 * not see. The chat, with the modal over it.
 */
export const settingsLocation = (tab: SettingsTab, anchor?: string): { search: SettingsSearch; to: "/chat" } => {
    return { search: settingsLinkSearch(tab, anchor)({}), to: "/chat" };
};

const ANCHOR_WAIT_MS = 5000;

/**
 * Scrolls to the element `id` inside the tab once it is there: the tab is lazy, so the element can arrive after the
 * modal opens. Calls `done` once it has scrolled, or after a few seconds without it. Returns a cancel.
 */
export const scrollToAnchorWhenRendered = (getRoot: () => HTMLElement | null, id: string, done: () => void): (() => void) => {
    const startedAt = performance.now();
    let frame = 0;

    const look = () => {
        const target = getRoot()?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);

        if (target) {
            target.scrollIntoView({ block: "start" });
            done();

            return;
        }

        if (performance.now() - startedAt > ANCHOR_WAIT_MS) {
            done();

            return;
        }

        frame = requestAnimationFrame(look);
    };

    frame = requestAnimationFrame(look);

    return () => cancelAnimationFrame(frame);
};
