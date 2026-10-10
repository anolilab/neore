"use client";

import { Plural, useLingui } from "@lingui/react/macro";
import { LM_STUDIO_DEFAULT_BASE_URL, OLLAMA_DEFAULT_BASE_URL, validateLocalEndpointUrl } from "@neore/ai/models";
import { api } from "@neore/backend/api";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
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
import { AlertTriangle, CheckCircle2, Globe, HardDrive, Loader2, Pencil, PlugZap, Plus, RefreshCw, Server, SlidersHorizontal, Trash2, X } from "lucide-react";
import type { FC } from "react";
import { useCallback, useId, useMemo, useState } from "react";
import { toast } from "sonner";

import LocalSetupGuide from "@/features/local-models/components/local-setup-guide";
import OllamaModelManager from "@/features/local-models/components/ollama-model-manager";
import { listLocalModels } from "@/features/local-models/lib/local-client";
import { describeLocalError, diagnoseLocalError } from "@/features/local-models/lib/local-errors";
import type { CustomProviderView } from "@/features/settings/lib/custom-models";
import { isNativeProviderView, parseModelListInput } from "@/features/settings/lib/custom-models";
import { useAction, useCRPC } from "@/lib/lunora/crpc";

/** A compatible endpoint; provider-native accounts have their own card (`native-providers-settings.tsx`). */
type EndpointView = CustomProviderView & { type: "anthropic" | "local-browser" | "openai" };

type EndpointType = EndpointView["type"];

const isEndpointView = (provider: CustomProviderView): provider is EndpointView => !isNativeProviderView(provider);

interface FormState {
    apiKey: string;
    baseUrl: string;
    /** Set when editing; `undefined` = adding a new endpoint. */
    id?: string;
    /** The saved key should be deleted on save. */
    isClearingKey: boolean;
    modelsText: string;
    name: string;
    supportsTools: boolean;
    type: EndpointType;
}

type ProbeState = { error: string; status: "error" } | { latencyMs: number; modelCount: number; status: "ok" } | { status: "idle" };

const EMPTY_FORM: FormState = { apiKey: "", baseUrl: "", isClearingKey: false, modelsText: "", name: "", supportsTools: false, type: "openai" };

const toForm = (provider: EndpointView): FormState => {
    return {
        apiKey: "",
        baseUrl: provider.baseUrl,
        id: provider.id,
        isClearingKey: false,
        modelsText: provider.models.map((m) => m.id).join("\n"),
        name: provider.name,
        supportsTools: provider.supportsTools,
        type: provider.type,
    };
};

const URL_PLACEHOLDERS: Record<EndpointType, string> = {
    anthropic: "https://api.example.com/anthropic",
    "local-browser": OLLAMA_DEFAULT_BASE_URL,
    openai: "https://ollama.example.com/v1",
};

const errorMessage = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

const CustomProvidersSettings: FC = () => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const formId = useId();
    const { data: allProviders = [], isLoading } = useQuery(crpc.chat.custom_providers.listCustomProviders.queryOptions({}));
    const providers = useMemo(() => allProviders.filter(isEndpointView), [allProviders]);
    const { mutateAsync: saveProvider } = useMutation(crpc.chat.custom_providers.saveCustomProvider.mutationOptions());
    const { isPending: isDeleting, mutateAsync: deleteProvider } = useMutation(crpc.chat.custom_providers.deleteCustomProvider.mutationOptions());
    const probeAction = useAction(api.chat.custom_providers.probeCustomProvider);
    const { isPending: isProbing, mutateAsync: probe } = useMutation({ mutationFn: probeAction });

    const [form, setForm] = useState<FormState | null>(null);
    const [probeState, setProbeState] = useState<ProbeState>({ status: "idle" });
    const [isSaving, setIsSaving] = useState(false);
    const [deleting, setDeleting] = useState<CustomProviderView | null>(null);
    /** The local endpoint whose Ollama model manager is open. */
    const [managingId, setManagingId] = useState<string | null>(null);
    const [isProbingLocal, setIsProbingLocal] = useState(false);
    const isTesting = isProbing || isProbingLocal;

    const editing = form?.id ? providers.find((p) => p.id === form.id) : undefined;
    const hasSavedKey = Boolean(editing?.hasApiKey) && !form?.isClearingKey;

    const closeForm = useCallback(() => {
        setForm(null);
        setProbeState({ status: "idle" });
    }, []);

    const update = useCallback((patch: Partial<FormState>) => {
        setForm((previous) => (previous ? { ...previous, ...patch } : previous));
    }, []);

    /** "Test connection" and "Fetch models" are the same request; fetching also fills the list. */
    const runProbe = useCallback(
        async (shouldFillModels: boolean) => {
            if (!form?.baseUrl.trim()) {
                toast.error(t`Enter the endpoint URL first`);

                return;
            }

            const typedKey = form.apiKey.trim();

            // A local endpoint is probed from this browser: the server cannot reach it.
            if (form.type === "local-browser") {
                // Anything but loopback would be blocked by the CSP with no useful error.
                const checked = validateLocalEndpointUrl(form.baseUrl);

                if ("error" in checked) {
                    setProbeState({ error: checked.error, status: "error" });

                    return;
                }

                const started = performance.now();

                setIsProbingLocal(true);

                try {
                    const ids = await listLocalModels(checked.url);

                    setProbeState({ latencyMs: Math.round(performance.now() - started), modelCount: ids.length, status: "ok" });

                    if (shouldFillModels) {
                        if (ids.length === 0) {
                            toast.warning(t`The server lists no models yet — pull or load one first`);
                        } else {
                            update({ modelsText: ids.join("\n") });
                        }
                    }
                } catch (error) {
                    const info = await diagnoseLocalError(error, checked.url);

                    setProbeState({ error: i18n._(describeLocalError(info)), status: "error" });
                } finally {
                    setIsProbingLocal(false);
                }

                return;
            }

            try {
                const result = await probe({
                    apiKey: typedKey || (form.isClearingKey ? "" : undefined),
                    baseUrl: form.baseUrl.trim(),
                    id: typedKey ? undefined : form.id,
                    type: form.type,
                });

                if (!result.ok) {
                    setProbeState({ error: result.error, status: "error" });

                    return;
                }

                setProbeState({ latencyMs: result.latencyMs, modelCount: result.models.length, status: "ok" });

                if (shouldFillModels) {
                    if (result.models.length === 0) {
                        toast.warning(t`The endpoint listed no models — add model ids by hand`);
                    } else {
                        update({ modelsText: result.models.map((m) => m.id).join("\n") });
                    }
                }
            } catch (error) {
                setProbeState({ error: errorMessage(error, t`Connection test failed`), status: "error" });
            }
        },
        [form, i18n, probe, t, update],
    );

    const handleSave = useCallback(async () => {
        if (!form) {
            return;
        }

        if (!form.name.trim()) {
            toast.error(t`Name is required`);

            return;
        }

        if (!form.baseUrl.trim()) {
            toast.error(t`Endpoint URL is required`);

            return;
        }

        const models = parseModelListInput(form.modelsText);

        if (models.length === 0) {
            toast.error(t`Add at least one model — use "Fetch models" or type the ids`);

            return;
        }

        const typedKey = form.apiKey.trim();
        const existingNames = new Map((editing?.models ?? []).map((m) => [m.id, m.name]));

        setIsSaving(true);

        try {
            const isLocal = form.type === "local-browser";
            // Local endpoints take no key; elsewhere `undefined` keeps the saved one and `""` removes it.
            let apiKey: string | undefined;

            if (!isLocal) {
                apiKey = typedKey || (form.isClearingKey ? "" : undefined);
            }

            await saveProvider({
                apiKey,
                baseUrl: form.baseUrl.trim(),
                enabled: editing?.enabled ?? true,
                id: form.id,
                // Keep display names the server reported for ids that survived the edit.
                models: models.map((m) => {
                    return { id: m.id, name: existingNames.get(m.id) };
                }),
                name: form.name.trim(),
                supportsTools: isLocal ? false : form.supportsTools,
                type: form.type,
            });
            toast.success(form.id ? t`Endpoint updated` : t`Endpoint added — its models are now in the model picker`);
            closeForm();
        } catch (error) {
            toast.error(errorMessage(error, t`Failed to save endpoint`));
        } finally {
            setIsSaving(false);
        }
    }, [closeForm, editing, form, saveProvider, t]);

    const handleToggle = useCallback(
        async (provider: CustomProviderView, enabled: boolean) => {
            try {
                await saveProvider({
                    baseUrl: provider.baseUrl,
                    enabled,
                    id: provider.id,
                    models: provider.models,
                    name: provider.name,
                    supportsTools: provider.supportsTools,
                    type: provider.type,
                });
            } catch (error) {
                toast.error(errorMessage(error, t`Failed to update endpoint`));
            }
        },
        [saveProvider, t],
    );

    /** The Ollama manager's "show installed models in picker": replace the endpoint's list. */
    const syncPickerModels = useCallback(
        async (provider: CustomProviderView, modelIds: string[]) => {
            const names = new Map(provider.models.map((m) => [m.id, m.name]));

            try {
                await saveProvider({
                    baseUrl: provider.baseUrl,
                    enabled: provider.enabled,
                    id: provider.id,
                    models: modelIds.map((id) => {
                        return { id, name: names.get(id) };
                    }),
                    name: provider.name,
                    supportsTools: false,
                    type: provider.type,
                });
                toast.success(t`The model picker now lists ${modelIds.length} models from ${provider.name}`);
            } catch (error) {
                toast.error(errorMessage(error, t`Failed to update endpoint`));
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
            toast.success(t`Endpoint removed`);

            if (form?.id === deleting.id) {
                closeForm();
            }
        } catch (error) {
            toast.error(errorMessage(error, t`Failed to remove endpoint`));
        } finally {
            setDeleting(null);
        }
    }, [closeForm, deleteProvider, deleting, form, t]);

    const fieldId = (name: string) => `${formId}-${name}`;
    const keyPlaceholder = form?.type === "anthropic" ? "sk-ant-..." : "sk-...";
    const isLocalForm = form?.type === "local-browser";

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <CardTitle className="text-base">{t`Custom Endpoints`}</CardTitle>
                        <CardDescription>
                            {t`Connect any OpenAI- or Anthropic-compatible server — Ollama, LM Studio, vLLM or a hosted proxy. Its models appear in the chat model picker.`}
                        </CardDescription>
                    </div>
                    {!form && (
                        <Button onClick={() => setForm(EMPTY_FORM)} size="sm" variant="outline">
                            <Plus aria-hidden="true" className="mr-1 size-4" />
                            {t`Add Endpoint`}
                        </Button>
                    )}
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                <Alert>
                    <Globe aria-hidden="true" />
                    <AlertTitle>{t`Two ways to connect`}</AlertTitle>
                    <AlertDescription>
                        {t`OpenAI- and Anthropic-compatible endpoints are called from our servers, so they must be public HTTPS URLs. For Ollama or LM Studio on this computer, choose "On this computer": your browser then talks to it directly — text only, not billed, and only in this browser.`}
                    </AlertDescription>
                </Alert>

                {isLoading && <p className="text-muted-foreground text-sm">{t`Loading...`}</p>}

                {!isLoading && providers.length === 0 && !form && <p className="text-muted-foreground text-sm">{t`No custom endpoints yet.`}</p>}

                {providers.length > 0 && (
                    <ul aria-label={t`Custom endpoints`} className="space-y-3">
                        {providers.map((provider, index) => (
                            <li key={provider.id}>
                                {index > 0 && <Separator className="mb-3" />}
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Server aria-hidden="true" className="text-muted-foreground size-4" />
                                            <span className="text-sm font-medium">{provider.name}</span>
                                            <Badge className="text-xs" variant="secondary">
                                                <Plural one="# model" other="# models" value={provider.models.length} />
                                            </Badge>
                                            {provider.type === "anthropic" && (
                                                <Badge className="text-xs" variant="outline">
                                                    {t`Anthropic API`}
                                                </Badge>
                                            )}
                                            {provider.type === "local-browser" && (
                                                <Badge className="text-xs" variant="outline">
                                                    <HardDrive aria-hidden="true" className="mr-1 size-3" />
                                                    {t`This computer`}
                                                </Badge>
                                            )}
                                            {provider.supportsTools && (
                                                <Badge className="text-xs" variant="outline">
                                                    {t`Tools`}
                                                </Badge>
                                            )}
                                        </div>
                                        <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">{provider.baseUrl}</p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {provider.type === "local-browser" && (
                                            <Button
                                                aria-controls={fieldId(`manage-${provider.id}`)}
                                                aria-expanded={managingId === provider.id}
                                                aria-label={t`Manage models on ${provider.name}`}
                                                onClick={() => setManagingId((current) => (current === provider.id ? null : provider.id))}
                                                size="sm"
                                                variant="ghost"
                                            >
                                                <SlidersHorizontal aria-hidden="true" className="size-4" />
                                            </Button>
                                        )}
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
                                {provider.type === "local-browser" && managingId === provider.id && (
                                    <div className="mt-3 rounded-md border p-3" id={fieldId(`manage-${provider.id}`)}>
                                        <OllamaModelManager
                                            baseUrl={provider.baseUrl}
                                            onSyncPicker={async (modelIds) => await syncPickerModels(provider, modelIds)}
                                            pickerModelIds={provider.models.map((m) => m.id)}
                                        />
                                    </div>
                                )}
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
                                {form.id ? t`Edit Endpoint` : t`Add Endpoint`}
                            </Heading>
                            <Button aria-label={t`Close`} onClick={closeForm} size="sm" type="button" variant="ghost">
                                <X aria-hidden="true" className="size-4" />
                            </Button>
                        </div>

                        <div aria-labelledby={fieldId("type-label")} className="space-y-2" role="group">
                            <p className="text-xs font-medium" id={fieldId("type-label")}>
                                {t`API format`}
                            </p>
                            <RadioGroup
                                aria-labelledby={fieldId("type-label")}
                                className="sm:grid-cols-3"
                                onValueChange={(value) => {
                                    // A probe result belongs to the format it was run with.
                                    setProbeState({ status: "idle" });
                                    update({ type: value as EndpointType });
                                }}
                                value={form.type}
                            >
                                {(
                                    [
                                        {
                                            description: t`Chat Completions (/v1/chat/completions) — Ollama, LM Studio, vLLM and most proxies.`,
                                            label: t`OpenAI-compatible`,
                                            value: "openai",
                                        },
                                        {
                                            description: t`Messages API (/v1/messages) — Anthropic and services that mirror it.`,
                                            label: t`Anthropic-compatible`,
                                            value: "anthropic",
                                        },
                                        {
                                            description: t`Ollama or LM Studio on localhost, called by your browser. Text only, not billed.`,
                                            label: t`On this computer`,
                                            value: "local-browser",
                                        },
                                    ] satisfies { description: string; label: string; value: EndpointType }[]
                                ).map((option) => (
                                    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI radio, which renders the control
                                    <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3" key={option.value}>
                                        <RadioGroupItem value={option.value} />
                                        <span className="grid gap-0.5">
                                            <span className="text-sm font-medium">{option.label}</span>
                                            <span className="text-muted-foreground text-xs">{option.description}</span>
                                        </span>
                                    </label>
                                ))}
                            </RadioGroup>
                        </div>

                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label className="text-xs" htmlFor={fieldId("name")}>
                                    {t`Name`}
                                </Label>
                                <Input
                                    id={fieldId("name")}
                                    maxLength={60}
                                    onChange={(e) => update({ name: e.target.value })}
                                    placeholder={t`Home Ollama`}
                                    value={form.name}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label className="text-xs" htmlFor={fieldId("url")}>
                                    {t`Base URL`}
                                </Label>
                                <Input
                                    aria-describedby={fieldId("url-hint")}
                                    className="font-mono text-sm"
                                    id={fieldId("url")}
                                    inputMode="url"
                                    onChange={(e) => update({ baseUrl: e.target.value })}
                                    placeholder={URL_PLACEHOLDERS[form.type]}
                                    type="url"
                                    value={form.baseUrl}
                                />
                                <p className="text-muted-foreground text-xs" id={fieldId("url-hint")}>
                                    {isLocalForm &&
                                        t`localhost or 127.0.0.1 only. Ollama: ${OLLAMA_DEFAULT_BASE_URL} · LM Studio: ${LM_STUDIO_DEFAULT_BASE_URL}`}
                                    {!isLocalForm && hasSavedKey && t`Changing the URL requires entering the API key again.`}
                                    {!isLocalForm &&
                                        !hasSavedKey &&
                                        (form.type === "anthropic"
                                            ? t`HTTPS only. The server root, as in ANTHROPIC_BASE_URL — /v1 is added for you.`
                                            : t`HTTPS only. Usually ends in /v1.`)}
                                </p>
                            </div>
                        </div>

                        {!isLocalForm && (
                            <div className="space-y-2">
                                <Label className="text-xs" htmlFor={fieldId("key")}>
                                    {t`API key (optional)`}
                                </Label>
                                <div className="flex items-center gap-2">
                                    <Input
                                        aria-describedby={fieldId("key-hint")}
                                        autoComplete="off"
                                        className="font-mono text-sm"
                                        id={fieldId("key")}
                                        onChange={(e) => update({ apiKey: e.target.value })}
                                        placeholder={hasSavedKey ? "••••••••" : keyPlaceholder}
                                        type="password"
                                        value={form.apiKey}
                                    />
                                    {hasSavedKey && (
                                        <Button onClick={() => update({ apiKey: "", isClearingKey: true })} size="sm" type="button" variant="ghost">
                                            {t`Remove key`}
                                        </Button>
                                    )}
                                </div>
                                <p className="text-muted-foreground text-xs" id={fieldId("key-hint")}>
                                    {hasSavedKey
                                        ? t`A key is saved. Leave blank to keep it.`
                                        : t`Encrypted at rest and never shown again. Local servers such as Ollama usually need none.`}
                                </p>
                            </div>
                        )}

                        <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <Label className="text-xs" htmlFor={fieldId("models")}>
                                    {t`Models`}
                                </Label>
                                <Button disabled={isTesting} onClick={() => runProbe(true)} size="sm" type="button" variant="outline">
                                    {isTesting ? (
                                        <Loader2 aria-hidden="true" className="mr-1 size-4 animate-spin" />
                                    ) : (
                                        <RefreshCw aria-hidden="true" className="mr-1 size-4" />
                                    )}
                                    {t`Fetch models`}
                                </Button>
                            </div>
                            <Textarea
                                aria-describedby={fieldId("models-hint")}
                                className="min-h-24 font-mono text-sm"
                                id={fieldId("models")}
                                onChange={(e) => update({ modelsText: e.target.value })}
                                placeholder={form.type === "anthropic" ? "claude-sonnet-4-5\nclaude-haiku-4-5" : "llama3.1:8b\nqwen2.5:14b"}
                                value={form.modelsText}
                            />
                            <p className="text-muted-foreground text-xs" id={fieldId("models-hint")}>
                                {t`One model id per line, exactly as the server names it.`}
                            </p>
                        </div>

                        {!isLocalForm && (
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <Label className="text-sm" htmlFor={fieldId("tools")}>
                                        {t`Models support tool calling`}
                                    </Label>
                                    <p className="text-muted-foreground text-xs" id={fieldId("tools-hint")}>
                                        {t`Enables web search, MCP and other tools. Leave off unless you know the models handle function calls — many local models reject requests that include tools.`}
                                    </p>
                                </div>
                                <Switch
                                    aria-describedby={fieldId("tools-hint")}
                                    checked={form.supportsTools}
                                    id={fieldId("tools")}
                                    onCheckedChange={(checked) => update({ supportsTools: checked })}
                                />
                            </div>
                        )}

                        {isLocalForm && (
                            <details className="rounded-md border p-3" open={!form.id}>
                                <summary className="cursor-pointer text-sm font-medium">{t`Setup guide: Ollama and LM Studio`}</summary>
                                <div className="pt-3">
                                    <LocalSetupGuide />
                                </div>
                            </details>
                        )}

                        <div aria-live="polite" role="status">
                            {probeState.status === "ok" && (
                                <p className="flex items-center gap-2 text-xs text-green-700 dark:text-green-400">
                                    <CheckCircle2 aria-hidden="true" className="size-3.5" />
                                    {t`Connected — ${probeState.modelCount} models listed (${probeState.latencyMs}ms)`}
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
                            <Button disabled={isTesting} onClick={() => runProbe(false)} size="sm" type="button" variant="outline">
                                <PlugZap aria-hidden="true" className="mr-1 size-4" />
                                {t`Test connection`}
                            </Button>
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
                    {t`Tokens used on your own endpoint are not charged as credits. Daily message limits still apply.`}
                </p>
            </CardContent>

            <ConfirmDialog
                confirmLabel={t`Remove`}
                description={t`Chats that use its models will stop working until you pick another model.`}
                loading={isDeleting}
                onConfirm={handleConfirmDelete}
                onOpenChange={(open) => !open && !isDeleting && setDeleting(null)}
                open={deleting !== null}
                title={deleting ? t`Remove "${deleting.name}"?` : t`Remove endpoint?`}
            />
        </Card>
    );
};

export default CustomProvidersSettings;
