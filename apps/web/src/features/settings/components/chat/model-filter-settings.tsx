"use client";

import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Switch } from "@neore/ui/components/switch";
import { X } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { getCreatorDisplayName } from "@/components/model-picker/utilities";
import SettingsCard from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";
import type { ModelFilterRules } from "@/hooks/use-model-filter-rules";
import { useBlockedCreators, useUpdateModelFilterRules, withoutCreator } from "@/hooks/use-model-filter-rules";

/** The list with `value` removed when present, added when not. */
const toggled = (list: ReadonlyArray<string> | undefined, value: string) => {
    const current = list ?? [];

    return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
};

const REGIONS = [
    { code: "US", description: msg`Models hosted in US data centers`, label: msg`United States` },
    { code: "EU", description: msg`Models hosted in EU data centers (GDPR compliant)`, label: msg`European Union` },
] as const;

const PROVIDERS = [
    { id: "google", label: "Google" },
    { id: "openrouter", label: "OpenRouter" },
    { id: "groq", label: "Groq" },
    { id: "xai", label: "xAI" },
    { id: "openai", label: "OpenAI" },
    { id: "requesty", label: "Requesty" },
    { id: "cloudflare", label: "Cloudflare Workers AI" },
] as const;

const ModelFilterSettings: FC = () => {
    const { i18n, t } = useLingui();
    const { rules: storedRules, updateRules: saveRules } = useUpdateModelFilterRules();

    const [modelInput, setModelInput] = useState("");

    const rules: ModelFilterRules = storedRules ?? {};
    const { blockedCreators, isPending: blockedCreatorsPending, setBlockedCreators } = useBlockedCreators();

    const restoreCreator = async (slug: string) => {
        try {
            await setBlockedCreators((current) => withoutCreator(current, slug));
            toast.success(t`Filter rules updated`);
        } catch {
            toast.error(t`Failed to update filter rules`);
        }
    };

    // Each edit is applied to the newest saved rules, so a lab hidden in the picker a moment ago is not lost.
    const updateRules = async (update: (current: ModelFilterRules) => ModelFilterRules) => {
        try {
            await saveRules(update);

            toast.success(t`Filter rules updated`);
        } catch {
            toast.error(t`Failed to update filter rules`);
        }
    };

    const toggleRegion = (regionCode: string, listType: "allowedRegions" | "blockedRegions") => {
        updateRules((current) => {
            return { ...current, [listType]: toggled(current[listType], regionCode) };
        });
    };

    const toggleProvider = (providerId: string, listType: "allowedProviders" | "blockedProviders") => {
        updateRules((current) => {
            return { ...current, [listType]: toggled(current[listType], providerId) };
        });
    };

    const addBlockedModel = () => {
        const modelId = modelInput.trim();

        if (!modelId) return;

        if (rules.blockedModels?.includes(modelId)) {
            toast.error(t`Model already blocked`);

            return;
        }

        updateRules((current) => {
            return { ...current, blockedModels: [...(current.blockedModels ?? []).filter((m) => m !== modelId), modelId] };
        });
        setModelInput("");
    };

    const removeBlockedModel = (modelId: string) => {
        updateRules((current) => {
            return { ...current, blockedModels: (current.blockedModels ?? []).filter((m) => m !== modelId) };
        });
    };

    const resetAll = async () => {
        try {
            await saveRules(() => {
                return {};
            });
            toast.success(t`All filter rules cleared`);
        } catch {
            toast.error(t`Failed to clear filter rules`);
        }
    };

    const hasAnyRules =
        (rules.allowedRegions && rules.allowedRegions.length > 0) ||
        (rules.blockedRegions && rules.blockedRegions.length > 0) ||
        (rules.blockedModels && rules.blockedModels.length > 0) ||
        (rules.blockedCreators && rules.blockedCreators.length > 0) ||
        (rules.allowedProviders && rules.allowedProviders.length > 0) ||
        (rules.blockedProviders && rules.blockedProviders.length > 0) ||
        rules.requireZDR ||
        rules.denyDataCollection;

    return (
        <div className="space-y-6">
            <SettingsCard
                action={hasAnyRules ? resetAll : undefined}
                actionLabel={hasAnyRules ? t`Clear All` : undefined}
                description={t`Control which AI models and providers can be used based on geographic region, compliance requirements, and privacy preferences.`}
                title={t`Model Restrictions`}
            />

            {/* Region Filtering */}
            <SettingsCard
                description={
                    <>
                        {t`Restrict which regions models can be hosted in. Useful for GDPR, data residency, and compliance requirements.`}{" "}
                        {t`Cloudflare Workers AI models run wherever Cloudflare has capacity, so any region rule hides them.`}
                    </>
                }
                title={t`Region Restrictions`}
            >
                <SettingsRow
                    control={
                        <>
                            {REGIONS.map((region) => {
                                const isSelected = rules.allowedRegions?.includes(region.code) ?? false;

                                return (
                                    <Button
                                        className="h-8 text-xs"
                                        key={region.code}
                                        onClick={() => toggleRegion(region.code, "allowedRegions")}
                                        size="sm"
                                        title={i18n._(region.description)}
                                        variant={isSelected ? "default" : "outline"}
                                    >
                                        {i18n._(region.label)}
                                        {isSelected && <Badge className="bg-background text-foreground ml-1.5 h-4 px-1 text-[10px]">{t`Active`}</Badge>}
                                    </Button>
                                );
                            })}
                        </>
                    }
                    description={t`When set, only models hosted in these regions will be available.`}
                    title={t`Allowed Regions`}
                />
                <SettingsRow
                    control={
                        <>
                            {REGIONS.map((region) => {
                                const isSelected = rules.blockedRegions?.includes(region.code) ?? false;

                                return (
                                    <Button
                                        className="h-8 text-xs"
                                        key={region.code}
                                        onClick={() => toggleRegion(region.code, "blockedRegions")}
                                        size="sm"
                                        title={i18n._(region.description)}
                                        variant={isSelected ? "destructive" : "outline"}
                                    >
                                        {i18n._(region.label)}
                                        {isSelected && <Badge className="bg-background text-foreground ml-1.5 h-4 px-1 text-[10px]">{t`Blocked`}</Badge>}
                                    </Button>
                                );
                            })}
                        </>
                    }
                    description={t`Models hosted exclusively in these regions will be unavailable.`}
                    title={t`Blocked Regions`}
                />
            </SettingsCard>

            {/* Provider Filtering */}
            <SettingsCard description={t`Control which AI providers can serve your requests.`} title={t`Provider Restrictions`}>
                <SettingsRow description={t`When set, only these providers will be used. Leave empty to allow all.`} title={t`Allowed Providers`}>
                    <div className="flex flex-wrap gap-2">
                        {PROVIDERS.map((provider) => {
                            const isSelected = rules.allowedProviders?.includes(provider.id) ?? false;

                            return (
                                <Button
                                    className="h-8 text-xs"
                                    key={provider.id}
                                    onClick={() => toggleProvider(provider.id, "allowedProviders")}
                                    size="sm"
                                    variant={isSelected ? "default" : "outline"}
                                >
                                    {provider.label}
                                    {isSelected && <Badge className="bg-background text-foreground ml-1.5 h-4 px-1 text-[10px]">{t`Active`}</Badge>}
                                </Button>
                            );
                        })}
                    </div>
                </SettingsRow>
                <SettingsRow description={t`These providers will never be used for your requests.`} title={t`Blocked Providers`}>
                    <div className="flex flex-wrap gap-2">
                        {PROVIDERS.map((provider) => {
                            const isSelected = rules.blockedProviders?.includes(provider.id) ?? false;

                            return (
                                <Button
                                    className="h-8 text-xs"
                                    key={provider.id}
                                    onClick={() => toggleProvider(provider.id, "blockedProviders")}
                                    size="sm"
                                    variant={isSelected ? "destructive" : "outline"}
                                >
                                    {provider.label}
                                    {isSelected && <Badge className="bg-background text-foreground ml-1.5 h-4 px-1 text-[10px]">{t`Blocked`}</Badge>}
                                </Button>
                            );
                        })}
                    </div>
                </SettingsRow>
            </SettingsCard>

            {/* Hidden labs: written by the model picker's "Hide" action, restored here */}
            <SettingsCard
                description={t`Labs hidden from the model picker only. Models already selected or set as defaults keep working.`}
                title={t`Hidden in Model Picker`}
            >
                <div className="py-3">
                    {blockedCreators.length === 0 ? (
                        <p className="text-muted-foreground text-sm">{t`No labs are hidden.`}</p>
                    ) : (
                        <div className="flex flex-wrap gap-1.5">
                            {blockedCreators.map((slug) => {
                                const name = getCreatorDisplayName(slug);

                                return (
                                    <Badge className="gap-1 pr-1 text-xs" key={slug} variant="secondary">
                                        {name}
                                        <button
                                            aria-label={t`Show ${name} in model picker`}
                                            className="hover:bg-foreground/10 ml-0.5 rounded p-0.5"
                                            disabled={blockedCreatorsPending}
                                            onClick={() => restoreCreator(slug)}
                                            type="button"
                                        >
                                            <X aria-hidden="true" className="h-3 w-3" />
                                        </button>
                                    </Badge>
                                );
                            })}
                        </div>
                    )}
                </div>
            </SettingsCard>

            {/* Model Block List */}
            <SettingsCard description={t`Block specific models by their ID. These models will never be used.`} title={t`Blocked Models`}>
                <div className="space-y-3 py-3">
                    <div className="flex gap-2">
                        <Input
                            className="flex-1"
                            onChange={(e) => setModelInput(e.target.value)}
                            onKeyDown={(e) => {
                                // Enter also confirms an IME candidate; ignore it mid-composition.
                                if (e.nativeEvent.isComposing) {
                                    return;
                                }

                                if (e.key === "Enter") {
                                    addBlockedModel();
                                }
                            }}
                            placeholder={t`Enter model ID (e.g., "llama-4-scout")...`}
                            value={modelInput}
                        />
                        <Button disabled={!modelInput.trim()} onClick={addBlockedModel} size="sm" variant="outline">
                            {t`Block`}
                        </Button>
                    </div>

                    {rules.blockedModels && rules.blockedModels.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {rules.blockedModels.map((modelId) => (
                                <Badge className="gap-1 pr-1 text-xs" key={modelId} variant="destructive">
                                    {modelId}
                                    <button
                                        aria-label={t`Remove ${modelId} from blocked list`}
                                        className="hover:bg-destructive-foreground/20 ml-0.5 rounded p-0.5"
                                        onClick={() => removeBlockedModel(modelId)}
                                        type="button"
                                    >
                                        <X aria-hidden="true" className="size-3" />
                                    </button>
                                </Badge>
                            ))}
                        </div>
                    )}
                </div>
            </SettingsCard>

            {/* Privacy Settings */}
            <SettingsCard
                description={
                    <>
                        {t`Control data handling and retention policies for AI providers. Privacy settings are currently enforced for models routed through OpenRouter.`}{" "}
                        {t`Either setting also hides the Cloudflare Workers AI models, which cannot guarantee it.`}
                    </>
                }
                title={t`Privacy`}
            >
                <SettingsRow
                    control={
                        <Switch
                            aria-label={t`Zero Data Retention (ZDR)`}
                            checked={rules.requireZDR ?? false}
                            id="filter-require-zdr"
                            onCheckedChange={(checked) =>
                                updateRules((current) => {
                                    return { ...current, requireZDR: checked || undefined };
                                })
                            }
                        />
                    }
                    description={t`Only use providers that guarantee zero data retention — your prompts are never stored.`}
                    htmlFor="filter-require-zdr"
                    title={t`Zero Data Retention (ZDR)`}
                />
                <SettingsRow
                    control={
                        <Switch
                            aria-label={t`Deny Data Collection`}
                            checked={rules.denyDataCollection ?? false}
                            id="filter-deny-data-collection"
                            onCheckedChange={(checked) =>
                                updateRules((current) => {
                                    return { ...current, denyDataCollection: checked || undefined };
                                })
                            }
                        />
                    }
                    description={t`Block providers that may use your data for training or collect usage data.`}
                    htmlFor="filter-deny-data-collection"
                    title={t`Deny Data Collection`}
                />
            </SettingsCard>
        </div>
    );
};

export default ModelFilterSettings;
