import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

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
 * A setting's `label` is the text its row shows (the same message as the tab's own label or heading), because opening a
 * result finds the row by that text. A label the tab does not show opens the tab at the top instead.
 *
 * Every tab needs a list; an empty one means "nothing beyond the tab's name". `settings-keywords.test.ts`
 * fails for a tab in the navigation without one.
 */
export const SETTINGS_KEYWORDS: Record<SettingsTab, ReadonlyArray<SettingsKeywordEntry>> = {
    "app-customization": [
        { keywords: [msg`privacy`, msg`name`, msg`email`, msg`mask`], label: msg`Hide Personal Information`, section: msg`Privacy` },
        { keywords: [msg`rtl`, msg`ltr`, msg`right to left`, msg`layout`], label: msg`Text Direction`, section: msg`Appearance` },
        { keywords: [msg`enter`, msg`submit`, msg`shift+enter`, msg`send button`], label: msg`Send Message Behavior`, section: msg`Behavior` },
        { keywords: [msg`language`, msg`locale`, msg`translation`], label: msg`Default AI Response Language`, section: msg`Language & Localization` },
        { keywords: [msg`voice`, msg`speech`, msg`microphone`], label: msg`Default Dictation Language`, section: msg`Language & Localization` },
        { keywords: [msg`city`, msg`country`, msg`place`], label: msg`Location`, section: msg`Language & Localization` },
        { keywords: [msg`time zone`, msg`clock`, msg`utc`], label: msg`Timezone`, section: msg`Language & Localization` },
        { keywords: [msg`suggestions`, msg`follow up`, msg`next question`], label: msg`Enable Follow-up Suggestions`, section: msg`Chat` },
    ],
    "app-keyboard": [
        { keywords: [msg`hotkey`, msg`shortcut`, msg`search`], label: msg`Command Palette`, section: msg`Keyboard Shortcuts` },
        { keywords: [msg`hotkey`, msg`shortcut`, msg`thread`], label: msg`New Chat`, section: msg`Keyboard Shortcuts` },
        { keywords: [msg`hotkey`, msg`shortcut`, msg`incognito`, msg`private`], label: msg`New Temporary Chat`, section: msg`Keyboard Shortcuts` },
        { keywords: [msg`hotkey`, msg`shortcut`, msg`switch model`], label: msg`Open Model Picker`, section: msg`Keyboard Shortcuts` },
        { keywords: [msg`hotkey`, msg`shortcut`], label: msg`Focus Search`, section: msg`Keyboard Shortcuts` },
        { keywords: [msg`hotkey`, msg`shortcut`, msg`clipboard`], label: msg`Copy Last Code Block`, section: msg`Keyboard Shortcuts` },
        { keywords: [msg`hotkey`, msg`shortcut`, msg`thinking`], label: msg`Increase Reasoning Effort`, section: msg`Keyboard Shortcuts` },
        { keywords: [msg`hotkey`, msg`shortcut`, msg`thinking`], label: msg`Decrease Reasoning Effort`, section: msg`Keyboard Shortcuts` },
        { keywords: [msg`hotkey`, msg`shortcut`, msg`toggle`], label: msg`Sidebar Left`, section: msg`Keyboard Shortcuts` },
        { keywords: [msg`hotkey`, msg`shortcut`, msg`toggle`], label: msg`Sidebar Right`, section: msg`Keyboard Shortcuts` },
    ],
    "auth-account": [],
    "auth-api-keys": [],
    "auth-billing": [],
    "auth-members": [],
    "auth-organization": [],
    "auth-organizations": [],
    "auth-security": [],
    "auth-teams": [],
    "chat-agent": [
        { keywords: [msg`planner`, msg`plan`, msg`steps`], label: msg`Task Planning Module`, section: msg`Agent Modules` },
        { keywords: [msg`documents`, msg`retrieval`, msg`rag`], label: msg`Knowledge Module`, section: msg`Agent Modules` },
        { keywords: [msg`database`, msg`datasource`, msg`sql`], label: msg`Data Source Module`, section: msg`Agent Modules` },
        { keywords: [msg`images`, msg`video`, msg`media`], label: msg`Auto Media Enrichment`, section: msg`Agent Modules` },
        { keywords: [msg`automation`, msg`automatic`, msg`modules`], label: msg`Auto-Detect Task Complexity`, section: msg`Automation` },
    ],
    "chat-api-keys": [
        { keywords: [msg`byok`, msg`openai`, msg`anthropic`, msg`token`, msg`secret`], label: msg`AI Provider Keys` },
        { keywords: [msg`byok`, msg`search`, msg`token`, msg`secret`], label: msg`Tool Provider Keys` },
        { keywords: [msg`telegram`, msg`slack`, msg`discord`, msg`bot token`], label: msg`Messenger Bot Keys` },
        { keywords: [msg`openai compatible`, msg`base url`, msg`ollama`, msg`lm studio`, msg`local`], label: msg`Custom Endpoints` },
        { keywords: [msg`azure`, msg`bedrock`, msg`vertex`, msg`aws`, msg`region`], label: msg`Cloud Provider Accounts` },
    ],
    "chat-default-models": [
        { keywords: [msg`chat model`, msg`default model`, msg`llm`], label: msg`Text to text`, section: msg`Text` },
        { keywords: [msg`vision`, msg`image understanding`], label: msg`Image to text`, section: msg`Text` },
        { keywords: [msg`transcription`, msg`video understanding`], label: msg`Video to text`, section: msg`Text` },
        { keywords: [msg`fallback`, msg`failover`, msg`retry`], label: msg`Backup model`, section: msg`Text` },
        { keywords: [msg`image generation`, msg`picture`], label: msg`Text to image`, section: msg`Image` },
        { keywords: [msg`edit image`, msg`transform`], label: msg`Image to image`, section: msg`Image` },
        { keywords: [msg`video generation`, msg`clip`], label: msg`Text to video`, section: msg`Video` },
        { keywords: [msg`animate`, msg`animation`], label: msg`Image to video`, section: msg`Video` },
    ],
    "chat-knowledge": [],
    "chat-mcp": [{ keywords: [msg`catalog`, msg`browse`, msg`install`, msg`connectors`, msg`integrations`], label: msg`MCP Registry` }],
    "chat-models": [{ keywords: [msg`pinned`, msg`starred`, msg`picker`], label: msg`Favorite models` }],
    "chat-personalization": [
        { keywords: [msg`name`, msg`call me`], label: msg`Nickname`, section: msg`About You` },
        { keywords: [msg`job`, msg`occupation`, msg`work`], label: msg`Profession`, section: msg`About You` },
        { keywords: [msg`bio`, msg`about me`, msg`background`], label: msg`More About You`, section: msg`About You` },
        {
            keywords: [msg`custom instructions`, msg`tone`, msg`style`, msg`system prompt`],
            label: msg`How would you like the AI to respond?`,
            section: msg`Custom Instructions`,
        },
        { keywords: [msg`thread titles`, msg`naming`, msg`chat titles`], label: msg`How should titles be written?`, section: msg`Thread Titles` },
        { keywords: [msg`remember`, msg`memories`, msg`forget`], label: msg`Memory` },
        { keywords: [msg`welcome tour`, msg`tutorial`, msg`intro`], label: msg`Onboarding` },
    ],
    "chat-system-prompts": [{ keywords: [msg`instructions`, msg`persona`, msg`prompt`], label: msg`System Prompt Presets` }],
    "chat-tools": [
        { keywords: [msg`permissions`, msg`ask`, msg`auto`, msg`off`, msg`approval`], label: msg`Built-in tools` },
        { keywords: [msg`permissions`, msg`servers`, msg`approval`], label: msg`MCP tools` },
    ],
    privacy: [
        { keywords: [msg`download`, msg`gdpr`, msg`backup`, msg`my data`], label: msg`Data Export` },
        { keywords: [msg`chatgpt`, msg`claude`, msg`gemini`, msg`migrate`, msg`upload`], label: msg`Import Conversations` },
        { keywords: [msg`gdpr`, msg`profile`, msg`what we store`], label: msg`Data Access Summary` },
        { keywords: [msg`cookies`, msg`tracking`, msg`analytics`], label: msg`Consent Preferences` },
        { keywords: [msg`terms`, msg`legal`], label: msg`Privacy Policy` },
    ],
};
