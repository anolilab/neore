"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Heading, HeadingSection } from "@neore/ui/components/heading";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Separator } from "@neore/ui/components/separator";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle, Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { trackEvent } from "@/lib/analytics";
import { useCRPC } from "@/lib/lunora/crpc";

import CustomProvidersSettings from "./custom-providers-settings";
import NativeProvidersSettings from "./native-providers-settings";

interface ProviderKeyDef {
    description: MessageDescriptor;
    id: string;
    /** Brand names stay plain strings; anything with translatable words is a descriptor. */
    name: MessageDescriptor | string;
    placeholder: string;
}

const AI_PROVIDERS: ProviderKeyDef[] = [
    {
        description: msg`Access 200+ models (Claude, GPT-4, Gemini, Llama) through a single API`,
        id: "openrouter",
        name: "OpenRouter",
        placeholder: "sk-or-v1-...",
    },
    {
        description: msg`Ultra-fast inference for open-source models like Llama and Mixtral`,
        id: "groq",
        name: "Groq",
        placeholder: "gsk_...",
    },
    {
        description: msg`Grok models from xAI with real-time web access`,
        id: "xai",
        name: "xAI (Grok)",
        placeholder: "xai-...",
    },
    {
        description: msg`Unified API gateway for multiple AI providers`,
        id: "requesty",
        name: "Requesty",
        placeholder: "rq-...",
    },
    {
        description: msg`Your own Anthropic key. Required to delegate work to Claude Code.`,
        id: "anthropic",
        name: "Anthropic",
        placeholder: "sk-ant-...",
    },
    {
        description: msg`Your own OpenAI key — used for OpenAI models and required to delegate work to Codex.`,
        id: "openai",
        name: "OpenAI",
        placeholder: "sk-...",
    },
];

const TOOL_PROVIDERS: ProviderKeyDef[] = [
    {
        description: msg`AI-optimized web search for real-time information retrieval`,
        id: "tavily",
        name: "Tavily",
        placeholder: "tvly-...",
    },
    {
        description: msg`Web scraping and content extraction from any URL`,
        id: "firecrawl",
        name: "Firecrawl",
        placeholder: "fc-...",
    },
    {
        description: msg`Privacy-focused web search with independent index`,
        id: "brave",
        name: "Brave Search",
        placeholder: "BSA...",
    },
];

interface MessengerKeyDef extends ProviderKeyDef {
    platform: string;
}

const MESSENGER_KEYS: MessengerKeyDef[] = [
    {
        description: msg`Bot token from @BotFather for your Telegram bot`,
        id: "telegram_bot_token",
        name: msg`Telegram Bot Token`,
        placeholder: "123456:ABC-DEF...",
        platform: "Telegram",
    },
    {
        description: msg`Webhook secret for verifying incoming Telegram updates`,
        id: "telegram_webhook_secret",
        name: msg`Telegram Webhook Secret`,
        placeholder: "your-webhook-secret",
        platform: "Telegram",
    },
    {
        description: msg`Bot OAuth token from your Slack App's OAuth & Permissions page`,
        id: "slack_bot_token",
        name: msg`Slack Bot Token`,
        placeholder: "xoxb-...",
        platform: "Slack",
    },
    {
        description: msg`Signing secret from your Slack App's Basic Information page`,
        id: "slack_signing_secret",
        name: msg`Slack Signing Secret`,
        placeholder: "abc123...",
        platform: "Slack",
    },
    {
        description: msg`Bot token from the Discord Developer Portal`,
        id: "discord_bot_token",
        name: msg`Discord Bot Token`,
        placeholder: "MTk2...",
        platform: "Discord",
    },
    {
        description: msg`Public key from the Discord Developer Portal for signature verification`,
        id: "discord_public_key",
        name: msg`Discord Public Key`,
        placeholder: "abc123def456...",
        platform: "Discord",
    },
    {
        description: msg`Permanent (System User) access token for the WhatsApp Cloud API`,
        id: "whatsapp_access_token",
        name: msg`WhatsApp Access Token`,
        placeholder: "EAAG...",
        platform: "WhatsApp",
    },
    {
        description: msg`App Secret from your Meta app's App settings > Basic, used to verify X-Hub-Signature-256`,
        id: "whatsapp_app_secret",
        name: msg`WhatsApp App Secret`,
        placeholder: "abc123...",
        platform: "WhatsApp",
    },
    {
        description: msg`Phone number ID from WhatsApp > API Setup`,
        id: "whatsapp_phone_number_id",
        name: msg`WhatsApp Phone Number ID`,
        placeholder: "106540352242922",
        platform: "WhatsApp",
    },
    {
        description: msg`Any string you choose; enter the same value as the webhook Verify token in the Meta app`,
        id: "whatsapp_verify_token",
        name: msg`WhatsApp Verify Token`,
        placeholder: "your-verify-token",
        platform: "WhatsApp",
    },
    {
        description: msg`Long-lived channel access token from the Messaging API tab of your LINE channel`,
        id: "line_channel_access_token",
        name: msg`LINE Channel Access Token`,
        placeholder: "abcDEF...",
        platform: "LINE",
    },
    {
        description: msg`Channel secret from the Basic settings tab, used to verify X-Line-Signature`,
        id: "line_channel_secret",
        name: msg`LINE Channel Secret`,
        placeholder: "abc123...",
        platform: "LINE",
    },
    {
        description: msg`App ID from your Feishu/Lark app's Credentials & Basic Info page`,
        id: "feishu_app_id",
        name: msg`Feishu App ID`,
        placeholder: "cli_...",
        platform: "Feishu / Lark",
    },
    {
        description: msg`App Secret from the same page`,
        id: "feishu_app_secret",
        name: msg`Feishu App Secret`,
        placeholder: "abc123...",
        platform: "Feishu / Lark",
    },
    {
        description: msg`Verification Token from Events & Callbacks > Encryption Strategy`,
        id: "feishu_verification_token",
        name: msg`Feishu Verification Token`,
        placeholder: "abc123...",
        platform: "Feishu / Lark",
    },
    {
        description: msg`Encrypt Key from Events & Callbacks > Encryption Strategy (required — events are verified with it)`,
        id: "feishu_encrypt_key",
        name: msg`Feishu Encrypt Key`,
        placeholder: "abc123...",
        platform: "Feishu / Lark",
    },
    {
        description: msg`Optional: "lark" for Lark (open.larksuite.com); leave unset for Feishu (open.feishu.cn)`,
        id: "feishu_domain",
        name: msg`Feishu Domain`,
        placeholder: "lark",
        platform: "Feishu / Lark",
    },
    {
        description: msg`Microsoft App ID of your Azure Bot`,
        id: "teams_app_id",
        name: msg`Teams App ID`,
        placeholder: "00000000-0000-0000-0000-000000000000",
        platform: "Microsoft Teams",
    },
    {
        description: msg`Client secret (App password) of the bot's app registration`,
        id: "teams_app_password",
        name: msg`Teams App Password`,
        placeholder: "abc~123...",
        platform: "Microsoft Teams",
    },
    {
        description: msg`Directory (tenant) ID — required for single-tenant bots, leave unset for multi-tenant`,
        id: "teams_tenant_id",
        name: msg`Teams Tenant ID`,
        placeholder: "00000000-0000-0000-0000-000000000000",
        platform: "Microsoft Teams",
    },
    {
        description: msg`AppID from Basic configuration of your Official Account`,
        id: "wechat_app_id",
        name: msg`WeChat AppID`,
        placeholder: "wx...",
        platform: "WeChat (beta)",
    },
    {
        description: msg`AppSecret from the same page`,
        id: "wechat_app_secret",
        name: msg`WeChat AppSecret`,
        placeholder: "abc123...",
        platform: "WeChat (beta)",
    },
    {
        description: msg`The Token you entered in the server configuration`,
        id: "wechat_token",
        name: msg`WeChat Token`,
        placeholder: "your-token",
        platform: "WeChat (beta)",
    },
    {
        description: msg`The 43-character EncodingAESKey (message encryption must be set to safe mode)`,
        id: "wechat_encoding_aes_key",
        name: msg`WeChat EncodingAESKey`,
        placeholder: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
        platform: "WeChat (beta)",
    },
];

/** Format a timestamp as relative time (e.g. "3 days ago", "2 months ago"). */
const formatKeyAge = (timestamp: number | undefined): MessageDescriptor | null => {
    if (!timestamp) {
        return null;
    }

    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60_000);

    if (minutes < 1) {
        return msg`just now`;
    }

    if (minutes < 60) return msg`${minutes}m ago`;

    const hours = Math.floor(diff / 3_600_000);

    if (hours < 24) return msg`${hours}h ago`;

    const days = Math.floor(diff / 86_400_000);

    if (days < 30) return msg`${days}d ago`;

    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (days < 365) return msg`${months}mo ago`;

    return msg`${years}y ago`;
};

/**
 * A key entry as `getAIUserPreferences` returns it: the server never sends
 * ciphertext, only whether a key is stored and (for long keys) its last four.
 */
interface KeyEntryView {
    [field: string]: unknown;
    createdAt?: number;
    enabled: boolean;
    hasKey?: boolean;
    last4?: string;
    lastRotatedAt?: number;
}

/** What the update mutation accepts per entry: `key` sets (`""` clears), omitted keeps the stored key. */
type KeyEntryInput = Record<string, unknown> & { enabled: boolean; key?: string };

/** Drop the read-only fields of each entry so the rest (e.g. brave.country) round-trips unchanged. */
const toKeyInputs = (entries: Record<string, KeyEntryView>): Record<string, KeyEntryInput> =>
    Object.fromEntries(
        Object.entries(entries).map(([id, { createdAt: _c, hasKey: _h, last4: _l, lastRotatedAt: _r, ...rest }]) => [id, rest as KeyEntryInput]),
    );

interface ProviderKeyRowProps {
    createdAt?: number;
    def: ProviderKeyDef;
    isSet: boolean;
    last4?: string;
    lastRotatedAt?: number;
    onClear: () => Promise<void>;
    onSave: (key: string) => Promise<void>;
}

const ProviderKeyRow: FC<ProviderKeyRowProps> = ({ createdAt, def, isSet, last4, lastRotatedAt, onClear, onSave }) => {
    const { i18n, t } = useLingui();
    const name = typeof def.name === "string" ? def.name : i18n._(def.name);
    const age = (timestamp: number | undefined): string => {
        const descriptor = formatKeyAge(timestamp);

        return descriptor ? i18n._(descriptor) : "";
    };
    const [inputValue, setInputValue] = useState("");
    const [showInput, setShowInput] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isClearing, setIsClearing] = useState(false);

    const handleSave = async () => {
        if (!inputValue.trim()) {
            return;
        }

        setIsSaving(true);

        try {
            await onSave(inputValue.trim());
            setInputValue("");
            setShowInput(false);
        } finally {
            setIsSaving(false);
        }
    };

    const handleClear = async () => {
        setIsClearing(true);

        try {
            await onClear();
        } finally {
            setIsClearing(false);
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <Label className="text-sm font-medium">{name}</Label>
                        {isSet && (
                            <Badge className="gap-1 text-xs" variant="secondary">
                                <CheckCircle aria-hidden="true" className="h-3 w-3 text-green-500" />
                                {t`Configured`}
                            </Badge>
                        )}
                        {isSet && (lastRotatedAt || createdAt) && (
                            <span className="text-muted-foreground text-xs">
                                {lastRotatedAt && lastRotatedAt !== createdAt ? t`rotated ${age(lastRotatedAt)}` : t`added ${age(createdAt)}`}
                            </span>
                        )}
                    </div>
                    <p className="text-muted-foreground mt-0.5 text-xs">{i18n._(def.description)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {isSet && !showInput && (
                        <>
                            <span className="text-muted-foreground font-mono text-sm">{last4 ? `••••${last4}` : "••••••••"}</span>
                            <Button onClick={() => setShowInput(true)} size="sm" variant="ghost">
                                <Eye aria-hidden="true" className="mr-1 h-4 w-4" />
                                {t`Replace`}
                            </Button>
                            <Button disabled={isClearing} onClick={handleClear} size="sm" variant="ghost">
                                <Trash2 aria-hidden="true" className="text-destructive mr-1 h-4 w-4" />
                                {t`Clear`}
                            </Button>
                        </>
                    )}
                    {!isSet && !showInput && (
                        <Button onClick={() => setShowInput(true)} size="sm" variant="outline">
                            <KeyRound aria-hidden="true" className="mr-1 h-4 w-4" />
                            {t`Add Key`}
                        </Button>
                    )}
                </div>
            </div>

            {showInput && (
                <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                        <Input
                            aria-label={name}
                            autoFocus
                            className="font-mono text-sm"
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    handleSave();
                                } else if (e.key === "Escape") {
                                    setShowInput(false);
                                    setInputValue("");
                                }
                            }}
                            placeholder={def.placeholder}
                            type="password"
                            value={inputValue}
                        />
                    </div>
                    <Button disabled={!inputValue.trim() || isSaving} onClick={handleSave} size="sm">
                        {isSaving ? t`Saving...` : t`Save`}
                    </Button>
                    <Button
                        aria-label={t`Cancel`}
                        onClick={() => {
                            setShowInput(false);
                            setInputValue("");
                        }}
                        size="sm"
                        variant="ghost"
                    >
                        <EyeOff aria-hidden="true" className="h-4 w-4" />
                    </Button>
                </div>
            )}
        </div>
    );
};

const APIKeysSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data: aiPreferences, isLoading } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const updateAIUserPreferencesMutation = useMutation(crpc.auth.functions.updateAIUserPreferences.mutationOptions());

    if (isLoading) {
        return <div className="text-muted-foreground text-sm">{t`Loading...`}</div>;
    }

    const providerApiKeys = (aiPreferences?.providerApiKeys ?? {}) as Record<string, KeyEntryView>;
    const generalProviders = (aiPreferences?.generalProviders ?? {}) as Record<string, KeyEntryView>;
    const messengerKeys = (aiPreferences?.messengerKeys ?? {}) as Record<string, KeyEntryView>;

    const isAIKeySet = (providerId: string) => !!(providerApiKeys[providerId]?.enabled && providerApiKeys[providerId].hasKey);
    const isToolKeySet = (toolId: string) => !!(generalProviders[toolId]?.enabled && generalProviders[toolId].hasKey);
    const isMessengerKeySet = (keyId: string) => !!(messengerKeys[keyId]?.enabled && messengerKeys[keyId].hasKey);

    const handleSaveAIKey = async (providerId: string, key: string) => {
        const updated = { ...toKeyInputs(providerApiKeys), [providerId]: { enabled: true, key } };

        await updateAIUserPreferencesMutation.mutateAsync(
            { providerApiKeys: updated },
            {
                onError: () => toast.error(t`Failed to save ${providerId} API key`),
                onSuccess: () => {
                    trackEvent("api_key_added", { provider: providerId });
                    toast.success(t`${providerId} API key saved`);
                },
            },
        );
    };

    const handleClearAIKey = async (providerId: string) => {
        const updated = Object.fromEntries(Object.entries(toKeyInputs(providerApiKeys)).filter(([k]) => k !== providerId));

        await updateAIUserPreferencesMutation.mutateAsync(
            { providerApiKeys: updated },
            {
                onError: () => toast.error(t`Failed to remove ${providerId} API key`),
                onSuccess: () => toast.success(t`${providerId} API key removed`),
            },
        );
    };

    const handleSaveToolKey = async (toolId: string, key: string) => {
        // Merge with existing entry to preserve extra fields (e.g. brave.country, brave.safesearch)
        const inputs = toKeyInputs(generalProviders);
        const updated = { ...inputs, [toolId]: { ...inputs[toolId], enabled: true, key } };

        await updateAIUserPreferencesMutation.mutateAsync(
            { generalProviders: updated },
            {
                onError: () => toast.error(t`Failed to save ${toolId} API key`),
                onSuccess: () => toast.success(t`${toolId} API key saved`),
            },
        );
    };

    const handleClearToolKey = async (toolId: string) => {
        const inputs = toKeyInputs(generalProviders);
        const updated = { ...inputs, [toolId]: { ...inputs[toolId], enabled: false, key: "" } };

        await updateAIUserPreferencesMutation.mutateAsync(
            { generalProviders: updated },
            {
                onError: () => toast.error(t`Failed to remove ${toolId} API key`),
                onSuccess: () => toast.success(t`${toolId} API key removed`),
            },
        );
    };

    const handleSaveMessengerKey = async (keyId: string, key: string) => {
        const updated = { ...toKeyInputs(messengerKeys), [keyId]: { enabled: true, key } };

        await updateAIUserPreferencesMutation.mutateAsync(
            { messengerKeys: updated },
            {
                onError: () => toast.error(t`Failed to save messenger key`),
                onSuccess: () => toast.success(t`Messenger key saved`),
            },
        );
    };

    const handleClearMessengerKey = async (keyId: string) => {
        const updated = { ...toKeyInputs(messengerKeys), [keyId]: { enabled: false, key: "" } };

        await updateAIUserPreferencesMutation.mutateAsync(
            { messengerKeys: updated },
            {
                onError: () => toast.error(t`Failed to remove messenger key`),
                onSuccess: () => toast.success(t`Messenger key removed`),
            },
        );
    };

    return (
        <div className="space-y-6">
            <div>
                <Heading className="text-2xl font-bold tracking-tight">{t`API Keys`}</Heading>
                <p className="text-muted-foreground">{t`Bring your own API keys to use your own accounts and rate limits.`}</p>
            </div>

            <HeadingSection>
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">{t`AI Provider Keys`}</CardTitle>
                        <CardDescription>
                            {t`Override the default AI provider with your own API key. Your key will be used for all requests on models from that provider.`}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {AI_PROVIDERS.map((provider, index) => (
                            <div key={provider.id}>
                                {index > 0 && <Separator className="mb-6" />}
                                <ProviderKeyRow
                                    createdAt={providerApiKeys[provider.id]?.createdAt}
                                    def={provider}
                                    isSet={isAIKeySet(provider.id)}
                                    last4={providerApiKeys[provider.id]?.last4}
                                    lastRotatedAt={providerApiKeys[provider.id]?.lastRotatedAt}
                                    onClear={() => handleClearAIKey(provider.id)}
                                    onSave={(key) => handleSaveAIKey(provider.id, key)}
                                />
                            </div>
                        ))}
                    </CardContent>
                </Card>

                <NativeProvidersSettings />

                <CustomProvidersSettings />

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">{t`Tool Provider Keys`}</CardTitle>
                        <CardDescription>
                            {t`Override the default search and retrieval providers with your own API keys for web search and URL content extraction.`}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {TOOL_PROVIDERS.map((provider, index) => (
                            <div key={provider.id}>
                                {index > 0 && <Separator className="mb-6" />}
                                <ProviderKeyRow
                                    createdAt={generalProviders[provider.id]?.createdAt}
                                    def={provider}
                                    isSet={isToolKeySet(provider.id)}
                                    last4={generalProviders[provider.id]?.last4}
                                    lastRotatedAt={generalProviders[provider.id]?.lastRotatedAt}
                                    onClear={() => handleClearToolKey(provider.id)}
                                    onSave={(key) => handleSaveToolKey(provider.id, key)}
                                />
                            </div>
                        ))}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">{t`Messenger Bot Keys`}</CardTitle>
                        <CardDescription>
                            {t`Bring your own bot tokens for Telegram, Slack, Discord, WhatsApp, LINE, Feishu/Lark, Microsoft Teams and WeChat messenger integration. Your bot tokens are used to receive and send messages on your behalf.`}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {MESSENGER_KEYS.map((keyDef, index) => (
                            <div key={keyDef.id}>
                                {index > 0 && <Separator className="mb-6" />}
                                <ProviderKeyRow
                                    createdAt={messengerKeys[keyDef.id]?.createdAt}
                                    def={keyDef}
                                    isSet={isMessengerKeySet(keyDef.id)}
                                    last4={messengerKeys[keyDef.id]?.last4}
                                    lastRotatedAt={messengerKeys[keyDef.id]?.lastRotatedAt}
                                    onClear={() => handleClearMessengerKey(keyDef.id)}
                                    onSave={(key) => handleSaveMessengerKey(keyDef.id, key)}
                                />
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </HeadingSection>

            <p className="text-muted-foreground text-xs">
                {t`Keys are encrypted at rest using AES-256-GCM with HKDF-derived per-purpose keys. They are never exposed to the client after being saved. All key operations are audit-logged and rate-limited.`}
            </p>
        </div>
    );
};

export default APIKeysSettings;
