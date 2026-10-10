import { v } from "lunorash/server";

import { MAX_LENGTH } from "../lib/validators";

/**
 * Every user-writable setting. `userId` is NOT here: `updateUserSettings` takes
 * this record verbatim and derives the owner from the caller's identity.
 *
 * This is the literal, and `userSettingsFields` below spreads it — the inverse
 * of the `const { userId: _, ...rest } = userSettingsFields` destructure it
 * replaces. Codegen resolves `.input()` from an object literal or a `const`
 * object literal the chain names; a destructuring REST is neither, so the old
 * shape generated `FunctionReference<"mutation", {}, void>` for a PUBLIC
 * mutation — arguments nothing type-checked at the client boundary. Reported as
 * `WARN procedure_arguments_unreadable`. See `vThreadCreateFields` in
 * `agent/validators.ts`.
 */
export const userSettingsFieldsWithoutUserId = {
    aboutMe: v.optional(v.string().max(MAX_LENGTH.long)), // User's background, preferences, or location to help AI understand them better (max 2000 chars)
    // Appearance: UI accent preset (`apps/web/src/features/appearance/lib/accent-presets.ts`).
    accentColor: v.optional(
        v.union(v.literal("default"), v.literal("blue"), v.literal("violet"), v.literal("green"), v.literal("orange"), v.literal("rose"), v.literal("teal")),
    ),
    autoReadReplies: v.optional(v.boolean()), // Speak every finished assistant reply aloud. OPT-IN: absent means off.
    codeFont: v.optional(v.union(v.literal("fira-code"), v.literal("mono"), v.literal("consolas"), v.literal("jetbrains"), v.literal("source-code-pro"))),
    // Appearance: Shiki theme pair for code blocks (`apps/web/src/features/appearance/lib/code-themes.ts`).
    codeHighlightTheme: v.optional(
        v.union(
            v.literal("default"),
            v.literal("github"),
            v.literal("one"),
            v.literal("vitesse"),
            v.literal("catppuccin"),
            v.literal("min"),
            v.literal("solarized"),
        ),
    ),
    composerAutocompleteEnabled: v.optional(v.boolean()), // Ghost-text completions in the chat composer. OPT-IN: absent means off.
    customInstructions: v.optional(v.string().max(MAX_LENGTH.document)), // Custom instructions for how AI should respond (max 3000 chars)
    dailyBriefEnabled: v.optional(v.boolean()), // Opt-in morning summary notification. OPT-IN: absent means off.
    dictationLanguage: v.optional(v.string().max(MAX_LENGTH.short)), // Default dictation language for new threads (BCP 47 code, e.g., "en-US", "es-ES")
    disableExternalLinkWarning: v.optional(v.boolean()),
    enableFollowupSuggestions: v.optional(v.boolean()), // Enable/disable follow-up suggestions after assistant messages
    favoriteModels: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
    hidePersonalInfo: v.optional(v.boolean()),
    id: v.optional(v.string().max(MAX_LENGTH.id)),
    isAdvancedUser: v.optional(v.boolean()),
    keyboardShortcuts: v.optional(
        v.object({
            archiveThread: v.optional(v.string().max(MAX_LENGTH.short)),
            audioRecord: v.optional(v.string().max(MAX_LENGTH.short)),
            commandPalette: v.optional(v.string().max(MAX_LENGTH.short)),
            createBranch: v.optional(v.string().max(MAX_LENGTH.short)),
            deleteThread: v.optional(v.string().max(MAX_LENGTH.short)),
            escape: v.optional(v.string().max(MAX_LENGTH.short)),
            firstItem: v.optional(v.string().max(MAX_LENGTH.short)),
            focusSearch: v.optional(v.string().max(MAX_LENGTH.short)),
            help: v.optional(v.string().max(MAX_LENGTH.short)),
            lastItem: v.optional(v.string().max(MAX_LENGTH.short)),
            newChat: v.optional(v.string().max(MAX_LENGTH.short)),
            newTemporaryChat: v.optional(v.string().max(MAX_LENGTH.short)),
            nextItem: v.optional(v.string().max(MAX_LENGTH.short)),
            pinThread: v.optional(v.string().max(MAX_LENGTH.short)),
            prevItem: v.optional(v.string().max(MAX_LENGTH.short)),
            search: v.optional(v.string().max(MAX_LENGTH.short)),
            sidebarLeft: v.optional(v.string().max(MAX_LENGTH.short)),
            sidebarRight: v.optional(v.string().max(MAX_LENGTH.short)),
        }),
    ),
    language: v.optional(v.string().max(MAX_LENGTH.short)), // Default language for AI responses in new threads (BCP 47 code, e.g., "en-US", "es-ES")
    lastChatId: v.optional(v.string().max(MAX_LENGTH.id)),
    location: v.optional(v.string().max(MAX_LENGTH.short)), // User's location (e.g., "New York, USA", "Berlin, Germany")
    mainFont: v.optional(v.union(v.literal("inter"), v.literal("system"), v.literal("serif"), v.literal("mono"), v.literal("roboto-slab"))),
    memoryEnabled: v.optional(v.boolean()), // Automatic memory extraction and retrieval. OPT-IN: absent means off.
    // Appearance: Mermaid diagram theme.
    mermaidTheme: v.optional(v.union(v.literal("default"), v.literal("neutral"), v.literal("dark"), v.literal("forest"), v.literal("base"))),
    nickname: v.optional(v.string().max(MAX_LENGTH.short)), // User's preferred name for the AI to call them (max 50 chars)
    onboardingCompleted: v.optional(v.boolean()),
    profession: v.optional(v.string().max(MAX_LENGTH.short)), // User's profession (e.g., "Product Designer", "Software Developer") (max 100 chars)
    sendBehavior: v.optional(v.union(v.literal("enter"), v.literal("shiftEnter"), v.literal("button"))),
    temporaryChatRetentionHours: v.optional(v.number()), // Default: 24 hours
    timezone: v.optional(v.string().max(MAX_LENGTH.short)), // IANA timezone identifier (e.g., "America/New_York", "Europe/Berlin")
    voiceModeVoice: v.optional(v.string().max(100)), // Default voice for spoken replies — a preset of the speech model; a skill's own voice wins
};

export const userSettingsFields = {
    ...userSettingsFieldsWithoutUserId,
    userId: v.string(),
};

export const userSettingsStandardSchema = v.object(userSettingsFields);
export type UserSettings = typeof userSettingsStandardSchema;

/*
 * BYOK keys below take `key` — plaintext to set (`""` clears), omitted keeps the
 * stored key. There is deliberately no `encryptedKey` input: `v.object` strips
 * it, so ciphertext echoed back from a read is ignored. Written inline, not via
 * a shared const: codegen degrades a bare const reference to `unknown`.
 * See `auth/lib/byok-keys.ts`.
 */
export const aiUserPreferencesFields = {
    autoDetectComplexity: v.optional(v.boolean()), // Automatically enable appropriate modules based on detected task complexity
    // `customAIProviders` is deliberately absent: only `chat/custom-providers.ts`
    // writes it, because saving an endpoint also validates its URL (SSRF) and
    // binds the stored key to that URL.
    customization: v.optional(
        v.object({
            additionalContext: v.optional(v.string().max(MAX_LENGTH.document)),
            aiPersonality: v.optional(v.string().max(MAX_LENGTH.long)),
            name: v.optional(v.string().max(MAX_LENGTH.short)),
            traits: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
        }),
    ),
    customModels: v.optional(
        v.record(
            v.string().max(MAX_LENGTH.short),
            v.object({
                abilities: v.array(
                    v.union(
                        v.literal("text"),
                        v.literal("image"),
                        v.literal("audio"),
                        v.literal("video"),
                        v.literal("document"),
                        v.literal("function_calling"),
                        v.literal("code"),
                        v.literal("reasoning"),
                    ),
                ),
                contextLength: v.number(),
                enabled: v.boolean(),
                maxTokens: v.number(),
                modelId: v.string().max(MAX_LENGTH.short),
                name: v.optional(v.string().max(MAX_LENGTH.short)),
                providerId: v.union(
                    ...["openai", "anthropic", "google", "groq", "fal"].map((p) => v.literal(p)),
                    v.literal("openrouter"),
                    v.string().max(MAX_LENGTH.short),
                ),
            }),
        ),
    ),
    defaultModels: v.optional(
        v.object({
            firstLastFrameToVideo: v.optional(v.string().max(MAX_LENGTH.short)),
            imagesToImage: v.optional(v.string().max(MAX_LENGTH.short)),
            imagesToVideo: v.optional(v.string().max(MAX_LENGTH.short)),
            imageToImage: v.optional(v.string().max(MAX_LENGTH.short)),
            imageToText: v.optional(v.string().max(MAX_LENGTH.short)),
            imageToVideo: v.optional(v.string().max(MAX_LENGTH.short)),
            mixedToVideo: v.optional(v.string().max(MAX_LENGTH.short)),
            // Image
            textToImage: v.optional(v.string().max(MAX_LENGTH.short)),
            // Text
            textToText: v.optional(v.string().max(MAX_LENGTH.short)),
            // Video
            textToVideo: v.optional(v.string().max(MAX_LENGTH.short)),
            videoToText: v.optional(v.string().max(MAX_LENGTH.short)),
            videoToVideo: v.optional(v.string().max(MAX_LENGTH.short)),
        }),
    ),
    enableDatasource: v.optional(v.boolean()), // Enable data source module: validates data quality and prioritizes authoritative sources
    enableKnowledge: v.optional(v.boolean()), // Enable knowledge module: applies best practices, patterns, and domain-specific guidelines
    // Agent module preferences
    // Agent loop is always enabled - these control additional specialized modules
    enablePlanner: v.optional(v.boolean()), // Enable task planning module: breaks complex tasks into numbered steps with progress tracking
    generalProviders: v.optional(
        v.object({
            brave: v.optional(
                v.object({
                    country: v.optional(v.string().max(MAX_LENGTH.short)),
                    enabled: v.boolean(),
                    key: v.optional(v.string().max(MAX_LENGTH.short)),
                    safesearch: v.optional(v.union(v.literal("off"), v.literal("moderate"), v.literal("strict"))),
                    searchLang: v.optional(v.string().max(MAX_LENGTH.short)),
                }),
            ),
            firecrawl: v.optional(v.object({ enabled: v.boolean(), key: v.optional(v.string().max(MAX_LENGTH.short)) })),
            serper: v.optional(
                v.object({
                    country: v.optional(v.string().max(MAX_LENGTH.short)),
                    enabled: v.boolean(),
                    key: v.optional(v.string().max(MAX_LENGTH.short)),
                    language: v.optional(v.string().max(MAX_LENGTH.short)),
                }),
            ),
            supermemory: v.optional(v.object({ enabled: v.boolean(), key: v.optional(v.string().max(MAX_LENGTH.short)) })),
            tavily: v.optional(v.object({ enabled: v.boolean(), key: v.optional(v.string().max(MAX_LENGTH.short)) })),
        }),
    ),
    mcpServers: v.optional(
        v.array(
            v.object({
                enabled: v.boolean(),
                headers: v.optional(
                    v.array(
                        v.object({
                            key: v.string().max(MAX_LENGTH.short),
                            value: v.string().max(MAX_LENGTH.long),
                        }),
                    ),
                ),
                icon: v.optional(v.string().max(MAX_LENGTH.url)),
                name: v.string().max(MAX_LENGTH.short),
                protocol: v.union(v.literal("sse"), v.literal("http")),
                url: v.string().max(MAX_LENGTH.url),
            }),
        ),
    ),
    // Messenger bot keys (BYOK — per-user bot tokens and webhook secrets for Telegram, Slack,
    // Discord, WhatsApp, LINE, Feishu/Lark, Teams and WeChat; ids are `<platform>_<name>`)
    // Same `{ enabled, key }` input as providerApiKeys; stored as `{ enabled, encryptedKey }`
    messengerKeys: v.optional(
        v.record(
            v.string().max(MAX_LENGTH.short), // "telegram_bot_token" | "telegram_webhook_secret" | "slack_bot_token" | "slack_signing_secret" | "discord_bot_token" | "discord_public_key"
            v.object({
                enabled: v.boolean(),
                key: v.optional(v.string().max(MAX_LENGTH.short)),
            }),
        ),
    ),
    // Model filter rules — geographic/compliance/privacy restrictions
    modelFilterRules: v.optional(
        v.object({
            allowedModels: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
            allowedProviders: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
            allowedRegions: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
            blockedModels: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
            blockedProviders: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
            blockedRegions: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
            denyDataCollection: v.optional(v.boolean()),
            requireZDR: v.optional(v.boolean()),
        }),
    ),

    modelOverrides: v.optional(v.record(v.string().max(MAX_LENGTH.short), v.boolean())),
    providerApiKeys: v.optional(
        v.record(
            v.string().max(MAX_LENGTH.short), // "openrouter" | "groq" | "xai" | "requesty"
            v.object({
                enabled: v.boolean(),
                key: v.optional(v.string().max(MAX_LENGTH.short)),
            }),
        ),
    ),
    searchIncludeSourcesByDefault: v.optional(v.boolean()),
    searchProvider: v.optional(v.union(v.literal("firecrawl"), v.literal("brave"), v.literal("tavily"), v.literal("serper"))),

    selectedModel: v.optional(v.string().max(MAX_LENGTH.short)),

    showTimestamps: v.optional(v.boolean()),

    // Per-tool permission overrides — see chat/lib/tool-permissions.ts.
    toolPermissions: v.optional(v.record(v.string().max(MAX_LENGTH.short), v.union(v.literal("auto"), v.literal("ask"), v.literal("off")))),
};
