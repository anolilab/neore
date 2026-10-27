import type { MessageDescriptor } from "@lingui/core";

import type { SettingsTab } from "./settings-navigation";

/** One searchable setting inside a tab. */
export interface SettingsKeywordEntry {
    keywords: ReadonlyArray<MessageDescriptor>;
    label: MessageDescriptor;
    /** The heading the setting sits under in its tab. */
    section?: MessageDescriptor;
}

/**
 * What the settings search can find inside each tab, beyond the tab's own name. Kept apart from the tab
 * components, which are lazy-loaded: importing a list from one would load its chunk with the modal.
 *
 * Every tab needs a list; an empty one means "nothing beyond the tab's name". `settings-keywords.test.ts`
 * fails for a tab in the navigation without one.
 */
export const SETTINGS_KEYWORDS: Record<SettingsTab, ReadonlyArray<SettingsKeywordEntry>> = {
    "app-customization": [],
    "app-keyboard": [],
    "auth-account": [],
    "auth-api-keys": [],
    "auth-billing": [],
    "auth-members": [],
    "auth-organization": [],
    "auth-organizations": [],
    "auth-security": [],
    "auth-teams": [],
    "chat-agent": [],
    "chat-api-keys": [],
    "chat-default-models": [],
    "chat-knowledge": [],
    "chat-mcp": [],
    "chat-models": [],
    "chat-personalization": [],
    "chat-system-prompts": [],
    "chat-tools": [],
    privacy: [],
};
