"use client";

import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Separator } from "@neore/ui/components/separator";
import { Switch } from "@neore/ui/components/switch";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Globe, RotateCcw, Shield, X } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

interface ModelFilterRules {
    allowedModels?: string[];
    allowedProviders?: string[];
    allowedRegions?: string[];
    blockedModels?: string[];
    blockedProviders?: string[];
    blockedRegions?: string[];
    denyDataCollection?: boolean;
    requireZDR?: boolean;
}

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
] as const;

const ModelFilterSettings: FC = () => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const { data: aiPreferences } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const updateMutation = useMutation(crpc.auth.functions.updateAIUserPreferences.mutationOptions());

    const [modelInput, setModelInput] = useState("");

    const rules: ModelFilterRules = (aiPreferences?.modelFilterRules as ModelFilterRules) ?? {};

    const updateRules = async (newRules: ModelFilterRules) => {
        try {
            // Clean up empty arrays before saving
            const cleaned: ModelFilterRules = {};

            if (newRules.allowedRegions && newRules.allowedRegions.length > 0) cleaned.allowedRegions = newRules.allowedRegions;

            if (newRules.blockedRegions && newRules.blockedRegions.length > 0) cleaned.blockedRegions = newRules.blockedRegions;

            if (newRules.allowedModels && newRules.allowedModels.length > 0) cleaned.allowedModels = newRules.allowedModels;

            if (newRules.blockedModels && newRules.blockedModels.length > 0) cleaned.blockedModels = newRules.blockedModels;

            if (newRules.allowedProviders && newRules.allowedProviders.length > 0) cleaned.allowedProviders = newRules.allowedProviders;

            if (newRules.blockedProviders && newRules.blockedProviders.length > 0) cleaned.blockedProviders = newRules.blockedProviders;

            if (newRules.requireZDR) cleaned.requireZDR = true;

            if (newRules.denyDataCollection) cleaned.denyDataCollection = true;

            const hasRules = Object.keys(cleaned).length > 0;

            await updateMutation.mutateAsync({
                modelFilterRules: hasRules ? cleaned : undefined,
            });

            toast.success(t`Filter rules updated`);
        } catch {
            toast.error(t`Failed to update filter rules`);
        }
    };

    const toggleRegion = (regionCode: string, listType: "allowedRegions" | "blockedRegions") => {
        const current = rules[listType] ?? [];
        const updated = current.includes(regionCode) ? current.filter((r) => r !== regionCode) : [...current, regionCode];

        updateRules({ ...rules, [listType]: updated });
    };

    const toggleProvider = (providerId: string, listType: "allowedProviders" | "blockedProviders") => {
        const current = rules[listType] ?? [];
        const updated = current.includes(providerId) ? current.filter((p) => p !== providerId) : [...current, providerId];

        updateRules({ ...rules, [listType]: updated });
    };

    const addBlockedModel = () => {
        const modelId = modelInput.trim();

        if (!modelId) return;

        const current = rules.blockedModels ?? [];

        if (current.includes(modelId)) {
            toast.error(t`Model already blocked`);

            return;
        }

        updateRules({ ...rules, blockedModels: [...current, modelId] });
        setModelInput("");
    };

    const removeBlockedModel = (modelId: string) => {
        const current = rules.blockedModels ?? [];

        updateRules({ ...rules, blockedModels: current.filter((m) => m !== modelId) });
    };

    const resetAll = async () => {
        try {
            await updateMutation.mutateAsync({ modelFilterRules: undefined });
            toast.success(t`All filter rules cleared`);
        } catch {
            toast.error(t`Failed to clear filter rules`);
        }
    };

    const hasAnyRules =
        (rules.allowedRegions && rules.allowedRegions.length > 0) ||
        (rules.blockedRegions && rules.blockedRegions.length > 0) ||
        (rules.blockedModels && rules.blockedModels.length > 0) ||
        (rules.allowedProviders && rules.allowedProviders.length > 0) ||
        (rules.blockedProviders && rules.blockedProviders.length > 0) ||
        rules.requireZDR ||
        rules.denyDataCollection;

    return (
        <div className="space-y-6">
            {/* Header */}
            <Card>
                <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{t`Model Restrictions`}</CardTitle>
                            <CardDescription className="text-muted-foreground mt-1 text-xs">
                                {t`Control which AI models and providers can be used based on geographic region, compliance requirements, and privacy preferences.`}
                            </CardDescription>
                        </div>
                        {hasAnyRules && (
                            <Button onClick={resetAll} size="sm" variant="outline">
                                <RotateCcw aria-hidden="true" className="mr-2 size-4" />
                                {t`Clear All`}
                            </Button>
                        )}
                    </div>
                </CardHeader>
            </Card>

            {/* Region Filtering */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                        <Globe aria-hidden="true" className="size-4" />
                        {t`Region Restrictions`}
                    </CardTitle>
                    <CardDescription className="text-xs">
                        {t`Restrict which regions models can be hosted in. Useful for GDPR, data residency, and compliance requirements.`}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div>
                        <Label className="text-muted-foreground text-xs font-medium">{t`Allowed Regions`}</Label>
                        <p className="text-muted-foreground mb-2 text-[11px]">{t`When set, only models hosted in these regions will be available.`}</p>
                        <div className="flex flex-wrap gap-2">
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
                                        {isSelected && <Badge className="ml-1.5 h-4 bg-white/20 px-1 text-[10px] text-inherit">{t`Active`}</Badge>}
                                    </Button>
                                );
                            })}
                        </div>
                    </div>

                    <Separator />

                    <div>
                        <Label className="text-muted-foreground text-xs font-medium">{t`Blocked Regions`}</Label>
                        <p className="text-muted-foreground mb-2 text-[11px]">{t`Models hosted exclusively in these regions will be unavailable.`}</p>
                        <div className="flex flex-wrap gap-2">
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
                                        {isSelected && <Badge className="ml-1.5 h-4 bg-white/20 px-1 text-[10px] text-inherit">{t`Blocked`}</Badge>}
                                    </Button>
                                );
                            })}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Provider Filtering */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                        <Shield aria-hidden="true" className="size-4" />
                        {t`Provider Restrictions`}
                    </CardTitle>
                    <CardDescription className="text-xs">{t`Control which AI providers can serve your requests.`}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div>
                        <Label className="text-muted-foreground text-xs font-medium">{t`Allowed Providers`}</Label>
                        <p className="text-muted-foreground mb-2 text-[11px]">{t`When set, only these providers will be used. Leave empty to allow all.`}</p>
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
                                        {isSelected && <Badge className="ml-1.5 h-4 bg-white/20 px-1 text-[10px] text-inherit">{t`Active`}</Badge>}
                                    </Button>
                                );
                            })}
                        </div>
                    </div>

                    <Separator />

                    <div>
                        <Label className="text-muted-foreground text-xs font-medium">{t`Blocked Providers`}</Label>
                        <p className="text-muted-foreground mb-2 text-[11px]">{t`These providers will never be used for your requests.`}</p>
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
                                        {isSelected && <Badge className="ml-1.5 h-4 bg-white/20 px-1 text-[10px] text-inherit">{t`Blocked`}</Badge>}
                                    </Button>
                                );
                            })}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Model Block List */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-semibold">{t`Blocked Models`}</CardTitle>
                    <CardDescription className="text-xs">{t`Block specific models by their ID. These models will never be used.`}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
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
                </CardContent>
            </Card>

            {/* Privacy Settings */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                        <Shield aria-hidden="true" className="size-4" />
                        {t`Privacy`}
                    </CardTitle>
                    <CardDescription className="text-xs">
                        {t`Control data handling and retention policies for AI providers. Privacy settings are currently enforced for models routed through OpenRouter.`}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-sm font-medium">{t`Zero Data Retention (ZDR)`}</Label>
                            <p className="text-muted-foreground text-xs">
                                {t`Only use providers that guarantee zero data retention — your prompts are never stored.`}
                            </p>
                        </div>
                        <Switch
                            aria-label={t`Zero Data Retention (ZDR)`}
                            checked={rules.requireZDR ?? false}
                            onCheckedChange={(checked) => updateRules({ ...rules, requireZDR: checked || undefined })}
                        />
                    </div>

                    <Separator />

                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-sm font-medium">{t`Deny Data Collection`}</Label>
                            <p className="text-muted-foreground text-xs">{t`Block providers that may use your data for training or collect usage data.`}</p>
                        </div>
                        <Switch
                            aria-label={t`Deny Data Collection`}
                            checked={rules.denyDataCollection ?? false}
                            onCheckedChange={(checked) => updateRules({ ...rules, denyDataCollection: checked || undefined })}
                        />
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

export default ModelFilterSettings;
