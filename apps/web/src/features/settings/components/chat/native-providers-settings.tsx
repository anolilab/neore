"use client";

import { Plural, useLingui } from "@lingui/react/macro";
import type { NativeProviderFormat } from "@neore/ai/gateway";
import {
    AZURE_DEFAULT_API_VERSION,
    bedrockRuntimeUrl,
    isAwsAccessKeyId,
    isAwsRegion,
    isAzureApiVersion,
    NATIVE_PROVIDER_BASE_URLS,
    parseAzureOpenAIEndpoint,
    validateNativeProviderKey,
} from "@neore/ai/gateway";
import { api } from "@neore/backend/api";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Heading } from "@neore/ui/components/heading";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Separator } from "@neore/ui/components/separator";
import { Switch } from "@neore/ui/components/switch";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Cloud, Loader2, Pencil, PlugZap, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { FC } from "react";
import { useCallback, useId, useMemo, useState } from "react";
import { toast } from "sonner";

import type { CustomProviderView } from "@/features/settings/lib/custom-models";
import { isNativeProviderView, parseModelListInput } from "@/features/settings/lib/custom-models";
import { useAction, useCRPC } from "@/lib/lunora/crpc";

type BedrockAuth = "access-keys" | "api-key";

interface FormState {
    accessKeyId: string;
    apiKey: string;
    apiVersion: string;
    bedrockAuth: BedrockAuth;
    endpoint: string;
    /** Set when editing; `undefined` = adding. */
    id?: string;
    modelsText: string;
    name: string;
    region: string;
    supportsTools: boolean;
    type: NativeProviderFormat;
}

type ProbeState = { error: string; status: "error" } | { latencyMs: number; modelCount: number; status: "ok" } | { status: "idle" };

const emptyForm = (type: NativeProviderFormat, name: string): FormState => {
    return {
        accessKeyId: "",
        apiKey: "",
        apiVersion: AZURE_DEFAULT_API_VERSION,
        bedrockAuth: "api-key",
        endpoint: "",
        modelsText: "",
        name,
        region: "us-east-1",
        supportsTools: true,
        type,
    };
};

const toForm = (provider: CustomProviderView & { type: NativeProviderFormat }): FormState => {
    return {
        accessKeyId: provider.accessKeyId ?? "",
        apiKey: "",
        apiVersion: provider.apiVersion ?? AZURE_DEFAULT_API_VERSION,
        bedrockAuth: provider.accessKeyId ? "access-keys" : "api-key",
        endpoint: provider.type === "azure" ? provider.baseUrl : "",
        id: provider.id,
        modelsText: provider.models.map((m) => m.id).join("\n"),
        name: provider.name,
        region: provider.region ?? "us-east-1",
        supportsTools: provider.supportsTools,
        type: provider.type,
    };
};

/** The URL the backend derives for a form — sent so the request carries the same value the server will store. */
const baseUrlFor = (form: FormState): { error: string } | { url: string } => {
    switch (form.type) {
        case "azure": {
            return parseAzureOpenAIEndpoint(form.endpoint);
        }
        case "bedrock": {
            return isAwsRegion(form.region.trim()) ? { url: bedrockRuntimeUrl(form.region.trim()) } : { error: "invalid-region" };
        }
        default: {
            return { url: NATIVE_PROVIDER_BASE_URLS[form.type] };
        }
    }
};

const errorMessage = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

const NativeProvidersSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const formId = useId();
    const { data: allProviders = [], isLoading } = useQuery(crpc.chat.custom_providers.listCustomProviders.queryOptions({}));
    const providers = useMemo(() => allProviders.filter(isNativeProviderView), [allProviders]);
    const { mutateAsync: saveProvider } = useMutation(crpc.chat.custom_providers.saveCustomProvider.mutationOptions());
    const { isPending: isDeleting, mutateAsync: deleteProvider } = useMutation(crpc.chat.custom_providers.deleteCustomProvider.mutationOptions());
    const probeAction = useAction(api.chat.custom_providers.probeCustomProvider);
    const { isPending: isProbing, mutateAsync: probe } = useMutation({ mutationFn: probeAction });

    const [form, setForm] = useState<FormState | null>(null);
    const [probeState, setProbeState] = useState<ProbeState>({ status: "idle" });
    const [isSaving, setIsSaving] = useState(false);
    const [deleting, setDeleting] = useState<CustomProviderView | null>(null);

    const editing = form?.id ? providers.find((p) => p.id === form.id) : undefined;
    const hasSavedKey = Boolean(editing?.hasApiKey);

    const labels: Record<NativeProviderFormat, string> = useMemo(() => {
        return { azure: t`Azure OpenAI`, bedrock: t`Amazon Bedrock`, google: t`Google Gemini`, mistral: t`Mistral` };
    }, [t]);

    const descriptions: Record<NativeProviderFormat, string> = useMemo(() => {
        return {
            azure: t`Your Azure OpenAI resource: endpoint, API version and deployment names.`,
            bedrock: t`Models enabled in your AWS account, in one region. Bedrock API key or IAM access keys.`,
            google: t`Gemini models on your Google AI Studio API key.`,
            mistral: t`Mistral models on your La Plateforme API key.`,
        };
    }, [t]);

    const closeForm = useCallback(() => {
        setForm(null);
        setProbeState({ status: "idle" });
    }, []);

    const update = useCallback((patch: Partial<FormState>) => {
        setForm((previous) => (previous ? { ...previous, ...patch } : previous));
    }, []);

    /** The key as typed, checked against the provider's shape; `undefined` = keep the saved one. */
    const checkTypedKey = useCallback(
        (state: FormState): { error: string } | { key: string | undefined } => {
            const typed = state.apiKey.trim();

            if (!typed) {
                return hasSavedKey ? { key: undefined } : { error: t`Enter the API key` };
            }

            const accessKeyId = state.type === "bedrock" && state.bedrockAuth === "access-keys" ? state.accessKeyId.trim() : undefined;
            const problem = validateNativeProviderKey(state.type, typed, { accessKeyId });

            return problem ? { error: problem } : { key: typed };
        },
        [hasSavedKey, t],
    );

    const runProbe = useCallback(
        async (shouldFillModels: boolean) => {
            if (!form) {
                return;
            }

            const url = baseUrlFor(form);

            if ("error" in url) {
                setProbeState({ error: url.error === "invalid-region" ? t`Enter a valid AWS region, e.g. us-east-1` : url.error, status: "error" });

                return;
            }

            const typed = form.apiKey.trim();

            if (typed) {
                const checked = checkTypedKey(form);

                if ("error" in checked) {
                    setProbeState({ error: checked.error, status: "error" });

                    return;
                }
            }

            try {
                const result = await probe({
                    apiKey: typed || undefined,
                    apiVersion: form.type === "azure" ? form.apiVersion.trim() : undefined,
                    baseUrl: url.url,
                    id: typed ? undefined : form.id,
                    type: form.type,
                });

                if (!result.ok) {
                    setProbeState({ error: result.error, status: "error" });

                    return;
                }

                setProbeState({ latencyMs: result.latencyMs, modelCount: result.models.length, status: "ok" });

                if (shouldFillModels && result.models.length > 0) {
                    update({ modelsText: result.models.map((m) => m.id).join("\n") });
                }
            } catch (error) {
                setProbeState({ error: errorMessage(error, t`Connection test failed`), status: "error" });
            }
        },
        [checkTypedKey, form, probe, t, update],
    );

    const handleSave = useCallback(async () => {
        if (!form) {
            return;
        }

        const name = form.name.trim();

        if (!name) {
            toast.error(t`Name is required`);

            return;
        }

        const url = baseUrlFor(form);

        if ("error" in url) {
            toast.error(url.error === "invalid-region" ? t`Enter a valid AWS region, e.g. us-east-1` : url.error);

            return;
        }

        if (form.type === "azure" && !isAzureApiVersion(form.apiVersion.trim())) {
            toast.error(t`Enter an API version such as v1 or 2024-10-21`);

            return;
        }

        const accessKeyId = form.type === "bedrock" && form.bedrockAuth === "access-keys" ? form.accessKeyId.trim() : undefined;

        if (accessKeyId !== undefined && !isAwsAccessKeyId(accessKeyId)) {
            toast.error(t`An access key id starts with AKIA and is 20 characters`);

            return;
        }

        const key = checkTypedKey(form);

        if ("error" in key) {
            toast.error(key.error);

            return;
        }

        const models = parseModelListInput(form.modelsText);

        if (models.length === 0) {
            toast.error(form.type === "azure" ? t`Add at least one deployment name` : t`Add at least one model id`);

            return;
        }

        const existingNames = new Map((editing?.models ?? []).map((m) => [m.id, m.name]));

        setIsSaving(true);

        try {
            await saveProvider({
                ...(form.type === "bedrock" && { accessKeyId: accessKeyId ?? "", region: form.region.trim() }),
                ...(form.type === "azure" && { apiVersion: form.apiVersion.trim() }),
                apiKey: key.key,
                baseUrl: url.url,
                enabled: editing?.enabled ?? true,
                id: form.id,
                models: models.map((m) => {
                    return { id: m.id, name: existingNames.get(m.id) };
                }),
                name,
                supportsTools: form.supportsTools,
                type: form.type,
            });
            toast.success(form.id ? t`Provider updated` : t`Provider added — its models are now in the model picker`);
            closeForm();
        } catch (error) {
            toast.error(errorMessage(error, t`Failed to save provider`));
        } finally {
            setIsSaving(false);
        }
    }, [checkTypedKey, closeForm, editing, form, saveProvider, t]);

    const handleToggle = useCallback(
        async (provider: CustomProviderView, enabled: boolean) => {
            try {
                await saveProvider({
                    ...(provider.accessKeyId !== undefined && { accessKeyId: provider.accessKeyId }),
                    ...(provider.apiVersion !== undefined && { apiVersion: provider.apiVersion }),
                    ...(provider.region !== undefined && { region: provider.region }),
                    baseUrl: provider.baseUrl,
                    enabled,
                    id: provider.id,
                    models: provider.models,
                    name: provider.name,
                    supportsTools: provider.supportsTools,
                    type: provider.type,
                });
            } catch (error) {
                toast.error(errorMessage(error, t`Failed to update provider`));
            }
        },
        [saveProvider, t],
    );

    const handleConfirmDelete = useCallback(async () => {
        if (!deleting) {
            return;
        }

        try {
            await deleteProvider({ id: deleting.id });
            toast.success(t`Provider removed`);

            if (form?.id === deleting.id) {
                closeForm();
            }
        } catch (error) {
            toast.error(errorMessage(error, t`Failed to remove provider`));
        } finally {
            setDeleting(null);
        }
    }, [closeForm, deleteProvider, deleting, form, t]);

    const fieldId = (name: string) => `${formId}-${name}`;
    const canFetchModels = form?.type === "google" || form?.type === "mistral";
    const canTest = form !== null && form.type !== "bedrock";

    const keyLabel = (() => {
        if (form?.type === "bedrock") {
            return form.bedrockAuth === "access-keys" ? t`Secret access key` : t`Bedrock API key`;
        }

        return t`API key`;
    })();

    const keyHint = (() => {
        if (hasSavedKey) {
            return t`A key is saved. Leave blank to keep it. Changing the endpoint, region or access key id requires entering it again.`;
        }

        switch (form?.type) {
            case "azure": {
                return t`Azure portal → your OpenAI resource → Keys and Endpoint. Encrypted at rest and never shown again.`;
            }
            case "bedrock": {
                return form.bedrockAuth === "access-keys"
                    ? t`An IAM user's secret access key with bedrock:InvokeModel. Encrypted at rest and never shown again.`
                    : t`Bedrock console → API keys. Encrypted at rest and never shown again.`;
            }
            case "google": {
                return t`Google AI Studio → Get API key. Encrypted at rest and never shown again.`;
            }
            default: {
                return t`console.mistral.ai → API keys. Encrypted at rest and never shown again.`;
            }
        }
    })();

    const modelsPlaceholder: Record<NativeProviderFormat, string> = {
        azure: "gpt-4o\ngpt-4o-mini",
        bedrock: "us.anthropic.claude-sonnet-4-20250514-v1:0\namazon.nova-pro-v1:0",
        google: "gemini-2.5-flash\ngemini-2.5-pro",
        mistral: "mistral-large-latest\nmistral-small-latest",
    };

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <CardTitle className="text-base">{t`Cloud Provider Accounts`}</CardTitle>
                        <CardDescription>
                            {t`Use your own Google Gemini, Azure OpenAI, Amazon Bedrock or Mistral account. Requests go to that provider on your key, and its models appear in the chat model picker.`}
                        </CardDescription>
                    </div>
                    {!form && (
                        <Button onClick={() => setForm(emptyForm("google", labels.google))} size="sm" variant="outline">
                            <Plus aria-hidden="true" className="mr-1 size-4" />
                            {t`Add Provider`}
                        </Button>
                    )}
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {isLoading && <p className="text-muted-foreground text-sm">{t`Loading...`}</p>}

                {!isLoading && providers.length === 0 && !form && <p className="text-muted-foreground text-sm">{t`No provider accounts connected yet.`}</p>}

                {providers.length > 0 && (
                    <ul aria-label={t`Provider accounts`} className="space-y-3">
                        {providers.map((provider, index) => (
                            <li key={provider.id}>
                                {index > 0 && <Separator className="mb-3" />}
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Cloud aria-hidden="true" className="text-muted-foreground size-4" />
                                            <span className="text-sm font-medium">{provider.name}</span>
                                            <Badge className="text-xs" variant="outline">
                                                {labels[provider.type]}
                                            </Badge>
                                            <Badge className="text-xs" variant="secondary">
                                                <Plural one="# model" other="# models" value={provider.models.length} />
                                            </Badge>
                                        </div>
                                        <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
                                            {provider.type === "bedrock" ? provider.region : provider.baseUrl}
                                            {provider.last4 ? ` · ••••${provider.last4}` : ""}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        <Switch
                                            aria-label={t`Enable ${provider.name}`}
                                            checked={provider.enabled}
                                            onCheckedChange={(checked) => handleToggle(provider, checked)}
                                        />
                                        <Button
                                            aria-label={t`Edit ${provider.name}`}
                                            onClick={() => {
                                                setProbeState({ status: "idle" });
                                                setForm(toForm(provider));
                                            }}
                                            size="sm"
                                            variant="ghost"
                                        >
                                            <Pencil aria-hidden="true" className="size-4" />
                                        </Button>
                                        <Button aria-label={t`Remove ${provider.name}`} onClick={() => setDeleting(provider)} size="sm" variant="ghost">
                                            <Trash2 aria-hidden="true" className="text-destructive size-4" />
                                        </Button>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}

                {form && (
                    <form
                        aria-labelledby={fieldId("title")}
                        className="space-y-4 rounded-lg border p-4"
                        noValidate
                        onSubmit={(event) => {
                            event.preventDefault();
                            void handleSave();
                        }}
                    >
                        <div className="flex items-center justify-between">
                            <Heading className="text-sm font-medium" fallbackLevel={4} id={fieldId("title")}>
                                {form.id ? t`Edit Provider` : t`Add Provider`}
                            </Heading>
                            <Button aria-label={t`Close`} onClick={closeForm} size="sm" type="button" variant="ghost">
                                <X aria-hidden="true" className="size-4" />
                            </Button>
                        </div>

                        {!form.id && (
                            <div aria-labelledby={fieldId("type-label")} className="space-y-2" role="group">
                                <p className="text-xs font-medium" id={fieldId("type-label")}>
                                    {t`Provider`}
                                </p>
                                <RadioGroup
                                    aria-labelledby={fieldId("type-label")}
                                    className="sm:grid-cols-2"
                                    onValueChange={(value) => {
                                        const type = value as NativeProviderFormat;

                                        setProbeState({ status: "idle" });
                                        // Keep a name the user typed; replace the default of the previous provider.
                                        update({
                                            apiKey: "",
                                            modelsText: "",
                                            name: form.name === labels[form.type] || !form.name.trim() ? labels[type] : form.name,
                                            type,
                                        });
                                    }}
                                    value={form.type}
                                >
                                    {(["google", "azure", "bedrock", "mistral"] as const).map((value) => (
                                        // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI radio, which renders the control
                                        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3" key={value}>
                                            <RadioGroupItem value={value} />
                                            <span className="grid gap-0.5">
                                                <span className="text-sm font-medium">{labels[value]}</span>
                                                <span className="text-muted-foreground text-xs">{descriptions[value]}</span>
                                            </span>
                                        </label>
                                    ))}
                                </RadioGroup>
                            </div>
                        )}

                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label className="text-xs" htmlFor={fieldId("name")}>
                                    {t`Name`}
                                </Label>
                                <Input id={fieldId("name")} maxLength={60} onChange={(e) => update({ name: e.target.value })} value={form.name} />
                            </div>

                            {form.type === "azure" && (
                                <div className="space-y-2">
                                    <Label className="text-xs" htmlFor={fieldId("endpoint")}>
                                        {t`Endpoint`}
                                    </Label>
                                    <Input
                                        aria-describedby={fieldId("endpoint-hint")}
                                        className="font-mono text-sm"
                                        id={fieldId("endpoint")}
                                        inputMode="url"
                                        onChange={(e) => update({ endpoint: e.target.value })}
                                        placeholder="https://my-resource.openai.azure.com"
                                        type="url"
                                        value={form.endpoint}
                                    />
                                    <p className="text-muted-foreground text-xs" id={fieldId("endpoint-hint")}>
                                        {t`The resource endpoint from Keys and Endpoint — *.openai.azure.com or *.cognitiveservices.azure.com.`}
                                    </p>
                                </div>
                            )}

                            {form.type === "bedrock" && (
                                <div className="space-y-2">
                                    <Label className="text-xs" htmlFor={fieldId("region")}>
                                        {t`AWS region`}
                                    </Label>
                                    <Input
                                        aria-describedby={fieldId("region-hint")}
                                        className="font-mono text-sm"
                                        id={fieldId("region")}
                                        onChange={(e) => update({ region: e.target.value })}
                                        placeholder="us-east-1"
                                        value={form.region}
                                    />
                                    <p className="text-muted-foreground text-xs" id={fieldId("region-hint")}>
                                        {t`The region where you enabled model access in the Bedrock console.`}
                                    </p>
                                </div>
                            )}
                        </div>

                        {form.type === "azure" && (
                            <div className="space-y-2">
                                <Label className="text-xs" htmlFor={fieldId("api-version")}>
                                    {t`API version`}
                                </Label>
                                <Input
                                    aria-describedby={fieldId("api-version-hint")}
                                    className="font-mono text-sm sm:max-w-xs"
                                    id={fieldId("api-version")}
                                    onChange={(e) => update({ apiVersion: e.target.value })}
                                    placeholder={AZURE_DEFAULT_API_VERSION}
                                    value={form.apiVersion}
                                />
                                <p className="text-muted-foreground text-xs" id={fieldId("api-version-hint")}>
                                    {t`"v1" for the current Azure OpenAI API. A dated version such as 2024-10-21 uses the older per-deployment URLs.`}
                                </p>
                            </div>
                        )}

                        {form.type === "bedrock" && (
                            <div aria-labelledby={fieldId("auth-label")} className="space-y-2" role="group">
                                <p className="text-xs font-medium" id={fieldId("auth-label")}>
                                    {t`Authentication`}
                                </p>
                                <RadioGroup
                                    aria-labelledby={fieldId("auth-label")}
                                    className="sm:grid-cols-2"
                                    onValueChange={(value) => update({ apiKey: "", bedrockAuth: value as BedrockAuth })}
                                    value={form.bedrockAuth}
                                >
                                    {(
                                        [
                                            { label: t`Bedrock API key`, value: "api-key" },
                                            { label: t`IAM access keys`, value: "access-keys" },
                                        ] satisfies { label: string; value: BedrockAuth }[]
                                    ).map((option) => (
                                        // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI radio, which renders the control
                                        <label className="flex cursor-pointer items-center gap-3 rounded-md border p-3" key={option.value}>
                                            <RadioGroupItem value={option.value} />
                                            <span className="text-sm">{option.label}</span>
                                        </label>
                                    ))}
                                </RadioGroup>
                            </div>
                        )}

                        {form.type === "bedrock" && form.bedrockAuth === "access-keys" && (
                            <div className="space-y-2">
                                <Label className="text-xs" htmlFor={fieldId("access-key-id")}>
                                    {t`Access key ID`}
                                </Label>
                                <Input
                                    autoComplete="off"
                                    className="font-mono text-sm sm:max-w-sm"
                                    id={fieldId("access-key-id")}
                                    onChange={(e) => update({ accessKeyId: e.target.value })}
                                    placeholder="AKIA..."
                                    value={form.accessKeyId}
                                />
                            </div>
                        )}

                        <div className="space-y-2">
                            <Label className="text-xs" htmlFor={fieldId("key")}>
                                {keyLabel}
                            </Label>
                            <Input
                                aria-describedby={fieldId("key-hint")}
                                autoComplete="off"
                                className="font-mono text-sm"
                                id={fieldId("key")}
                                onChange={(e) => update({ apiKey: e.target.value })}
                                placeholder={hasSavedKey ? "••••••••" : undefined}
                                type="password"
                                value={form.apiKey}
                            />
                            <p className="text-muted-foreground text-xs" id={fieldId("key-hint")}>
                                {keyHint}
                            </p>
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <Label className="text-xs" htmlFor={fieldId("models")}>
                                    {form.type === "azure" ? t`Deployment names` : t`Models`}
                                </Label>
                                {canFetchModels && (
                                    <Button disabled={isProbing} onClick={() => runProbe(true)} size="sm" type="button" variant="outline">
                                        {isProbing ? (
                                            <Loader2 aria-hidden="true" className="mr-1 size-4 animate-spin" />
                                        ) : (
                                            <RefreshCw aria-hidden="true" className="mr-1 size-4" />
                                        )}
                                        {t`Fetch models`}
                                    </Button>
                                )}
                            </div>
                            <Textarea
                                aria-describedby={fieldId("models-hint")}
                                className="min-h-24 font-mono text-sm"
                                id={fieldId("models")}
                                onChange={(e) => update({ modelsText: e.target.value })}
                                placeholder={modelsPlaceholder[form.type]}
                                value={form.modelsText}
                            />
                            <p className="text-muted-foreground text-xs" id={fieldId("models-hint")}>
                                {form.type === "azure" && t`One deployment name per line, exactly as in Azure AI Foundry → Deployments.`}
                                {form.type === "bedrock" &&
                                    t`One model or inference-profile id per line, e.g. us.anthropic.claude-sonnet-4-20250514-v1:0. The model must be enabled in this region.`}
                                {canFetchModels && t`One model id per line — or fetch the list with your key.`}
                            </p>
                        </div>

                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <Label className="text-sm" htmlFor={fieldId("tools")}>
                                    {t`Models support tool calling`}
                                </Label>
                                <p className="text-muted-foreground text-xs" id={fieldId("tools-hint")}>
                                    {t`Enables web search, MCP and other tools. Turn off for models that reject tool definitions.`}
                                </p>
                            </div>
                            <Switch
                                aria-describedby={fieldId("tools-hint")}
                                checked={form.supportsTools}
                                id={fieldId("tools")}
                                onCheckedChange={(checked) => update({ supportsTools: checked })}
                            />
                        </div>

                        <div aria-live="polite" role="status">
                            {probeState.status === "ok" && (
                                <p className="flex items-center gap-2 text-xs text-green-700 dark:text-green-400">
                                    <CheckCircle2 aria-hidden="true" className="size-3.5" />
                                    {canFetchModels
                                        ? t`Connected — ${probeState.modelCount} models listed (${probeState.latencyMs}ms)`
                                        : t`Connected (${probeState.latencyMs}ms)`}
                                </p>
                            )}
                            {probeState.status === "error" && (
                                <p className="text-destructive flex items-center gap-2 text-xs">
                                    <AlertTriangle aria-hidden="true" className="size-3.5" />
                                    {probeState.error}
                                </p>
                            )}
                        </div>

                        <div className="flex flex-wrap items-center justify-end gap-2">
                            {canTest && (
                                <Button disabled={isProbing} onClick={() => runProbe(false)} size="sm" type="button" variant="outline">
                                    <PlugZap aria-hidden="true" className="mr-1 size-4" />
                                    {t`Test connection`}
                                </Button>
                            )}
                            <Button onClick={closeForm} size="sm" type="button" variant="ghost">
                                {t`Cancel`}
                            </Button>
                            <Button aria-busy={isSaving} disabled={isSaving} size="sm" type="submit">
                                {isSaving ? t`Saving...` : t`Save`}
                            </Button>
                        </div>
                    </form>
                )}

                <p className="text-muted-foreground text-xs">
                    {t`The provider bills you directly for these requests. Where we know the model's price, the usual platform fee for your own keys is charged in credits.`}
                </p>
            </CardContent>

            <ConfirmDialog
                confirmLabel={t`Remove`}
                description={t`Chats that use its models will stop working until you pick another model.`}
                loading={isDeleting}
                onConfirm={handleConfirmDelete}
                onOpenChange={(open) => !open && !isDeleting && setDeleting(null)}
                open={deleting !== null}
                title={deleting ? t`Remove "${deleting.name}"?` : t`Remove provider?`}
            />
        </Card>
    );
};

export default NativeProvidersSettings;
