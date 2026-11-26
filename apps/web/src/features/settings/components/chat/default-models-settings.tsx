"use client";

import { useLingui } from "@lingui/react/macro";
import {
    DEFAULT_IMAGE_TO_IMAGE_MODEL,
    DEFAULT_IMAGE_TO_TEXT_MODEL,
    DEFAULT_IMAGE_TO_VIDEO_MODEL,
    DEFAULT_IMAGES_TO_IMAGE_MODEL,
    DEFAULT_IMAGES_TO_VIDEO_MODEL,
    DEFAULT_MIXED_TO_VIDEO_MODEL,
    DEFAULT_TEXT_TO_IMAGE_MODEL,
    DEFAULT_TEXT_TO_TEXT_MODEL,
    DEFAULT_TEXT_TO_VIDEO_MODEL,
    DEFAULT_VIDEO_TO_TEXT_MODEL,
    DEFAULT_VIDEO_TO_VIDEO_MODEL,
} from "@neore/ai/constants";
import type { GatewayModel } from "@neore/ai/models";
import { MAX_BACKUP_MODELS, storedBackupModels } from "@neore/backend/chat/backup-models";
import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Separator } from "@neore/ui/components/separator";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { moveBackupModel, offerableBackupModels } from "@/features/settings/lib/backup-model-options";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { useGatewayModels, useGatewayModelsLoaded } from "@/hooks/use-gateway-models";
import { useFilteredModels } from "@/hooks/use-model-filter-rules";
import { trackEvent } from "@/lib/analytics";
import { useCRPC } from "@/lib/lunora/crpc";

type DefaultModels = {
    imagesToImage?: string;
    imagesToVideo?: string;
    imageToImage?: string;
    imageToText?: string;
    imageToVideo?: string;
    mixedToVideo?: string;
    textToImage?: string;
    textToText?: string;
    textToVideo?: string;
    videoToText?: string;
    videoToVideo?: string;
};

type DefaultModelKey = keyof DefaultModels;

interface ModelSelectProps<Field extends string> {
    description: string;
    disabled?: boolean;
    /** Shown for "no model" when there is no system default to name. */
    emptyLabel?: string;
    field: Field;
    label: string;
    models: GatewayModel[];
    onChange: (field: Field, modelId: string | null) => void;
    /** The system fallback model ID shown in the "System default" option */
    systemDefaultId?: string;
    value: string | undefined;
}

export const ModelSelect = <Field extends string>({
    description,
    disabled,
    emptyLabel,
    field,
    label,
    models,
    onChange,
    systemDefaultId,
    value,
}: ModelSelectProps<Field>) => {
    const { t } = useLingui();
    const labelId = useId();
    const selectedModel = models.find((m) => m.id === value);
    const allModels = useFeatureFlaggedModels();
    const systemDefaultModel = systemDefaultId ? allModels.find((m) => m.id === systemDefaultId) : undefined;

    const systemDefaultLabel = systemDefaultModel ? systemDefaultModel.name : (emptyLabel ?? t`System default`);

    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-0.5">
                <Label className="text-sm font-medium" id={labelId}>
                    {label}
                </Label>
                <p className="text-muted-foreground text-xs">{description}</p>
            </div>
            <Select<string> disabled={disabled || models.length === 0} onValueChange={(v) => onChange(field, v)} value={value ?? null}>
                <SelectTrigger aria-labelledby={labelId} className="w-48 shrink-0">
                    <SelectValue placeholder={models.length === 0 ? t`No models available` : systemDefaultLabel}>
                        {selectedModel && (
                            <span className="flex items-center gap-1.5 truncate">
                                <ProviderIcon
                                    className="size-3 shrink-0"
                                    provider={selectedModel.provider ?? selectedModel.displayProvider ?? ""}
                                    providerIcon={selectedModel.id.split("/", 1)[0] ?? selectedModel.displayProvider ?? ""}
                                />
                                <span className="truncate">{selectedModel.name}</span>
                            </span>
                        )}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent align="end" className="max-h-64">
                    <SelectItem value={null as unknown as string}>
                        {systemDefaultModel ? (
                            <span className="flex items-center gap-1.5">
                                <ProviderIcon
                                    className="size-3 shrink-0"
                                    provider={systemDefaultModel.provider ?? systemDefaultModel.displayProvider ?? ""}
                                    providerIcon={systemDefaultModel.id.split("/", 1)[0] ?? systemDefaultModel.displayProvider ?? ""}
                                />
                                <span className="text-muted-foreground truncate">{systemDefaultModel.name}</span>
                                <span className="text-muted-foreground/60 text-xs">{t`(default)`}</span>
                            </span>
                        ) : (
                            <span className="text-muted-foreground">{emptyLabel ?? t`System default`}</span>
                        )}
                    </SelectItem>
                    {models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                            <span className="flex items-center gap-1.5">
                                <ProviderIcon
                                    className="size-3 shrink-0"
                                    provider={m.provider ?? m.displayProvider ?? ""}
                                    providerIcon={m.id.split("/", 1)[0] ?? m.displayProvider ?? ""}
                                />
                                <span className="truncate">{m.name}</span>
                            </span>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
};

/**
 * The models a reply is retried on, in order, when the chosen model fails with an infrastructure error. A saved model
 * the list no longer offers (retired, or now outside the plan) stays listed as unavailable, so it can still be removed.
 */
const controlKey = (id: string, control: "down" | "remove" | "up"): string => `${control}:${id}`;

export const BackupModelsSetting: FC<{ disabled?: boolean; models: GatewayModel[]; providersWithKey: ReadonlySet<string> }> = ({
    disabled,
    models: allModels,
    providersWithKey,
}) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const labelId = useId();
    const { data: access } = useQuery(crpc.auth.functions.getPaidModelAccess.queryOptions({}, { live: false }));
    // The backend's own answer, not a client-side guess; the save re-checks it.
    const canRunPaidModels = access?.canRunPaidModels === true;
    // A retry skips what is not a text model, outside the plan, or excluded by the user's filters. A feature flag only
    // hides a model from the picker, so a saved one it hides still answers and is not marked unavailable.
    const catalog = useGatewayModels();
    const candidates = offerableBackupModels(
        catalog.filter((m) => (m.mode ?? "text") === "text"),
        canRunPaidModels,
        providersWithKey,
    );
    const usable = new Set(useFilteredModels(candidates).map((m) => m.id));
    // The filters read as none until the preferences load (or when they fail to), so they must be read too.
    const { data: aiPreferences } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const filtersRead = aiPreferences !== undefined;
    // Without the catalog, the plan answer or the filters, nothing is known to be unusable: no entry is marked until all are read.
    const availabilityKnown = useGatewayModelsLoaded() && access !== undefined && filtersRead;
    const { data: userSettings } = useUserSettings();
    const { updateLatest } = useUpdateUserSettings();
    // This list's own save, from the edit until it settles. The mutation's own pending flag is not enough: a write can
    // wait behind another settings write before it is sent.
    const [saving, setSaving] = useState(false);
    const chosen = storedBackupModels(userSettings);
    // Until the settings load, the list only looks empty: an edit then would replace the saved one. While a save runs,
    // another edit would be built on its unconfirmed value and could save it even if it fails.
    const locked = disabled === true || userSettings === undefined || saving;
    const chosenKey = chosen.join("\n");
    const limit = MAX_BACKUP_MODELS;
    // Each entry's buttons by `controlKey`, so focus can be put back once the list has changed.
    const controls = useRef(new Map<string, HTMLButtonElement>());
    const addRow = useRef<HTMLDivElement>(null);
    const section = useRef<HTMLDivElement>(null);
    // The control that takes focus once the save is over and the controls are enabled again, or "" for the add picker:
    // a disabled control drops focus, and the one used may be gone (its entry removed, the picker after the last add).
    const focusAfter = useRef<string | null>(null);
    // Bumped to place focus after a refused save: its rollback changes the list before the refusal is seen.
    const [focusRequest, setFocusRequest] = useState(0);

    useEffect(() => {
        const target = focusAfter.current;

        if (target === null || locked) {
            return;
        }

        // The add picker is disabled when nothing can be added: the section then holds focus.
        const picker = addRow.current?.querySelector("button");
        const pickerOrSection = picker && !picker.disabled ? picker : section.current;
        const element = target === "" ? pickerOrSection : controls.current.get(target);

        if (element && !(element instanceof HTMLButtonElement && element.disabled)) {
            focusAfter.current = null;
            element.focus();
        }
    }, [chosenKey, focusRequest, locked]);

    const register = (key: string) => (element: HTMLButtonElement | null) => {
        if (element) {
            controls.current.set(key, element);
        } else {
            controls.current.delete(key);
        }
    };

    /**
     * Saves `edit` with the list it was built on: the server refuses it when the stored list has changed since (another
     * tab), and the rollback and re-read then show the stored one. Focus goes to `focusOnSuccess`, or to `focusOnFailure`
     * once a refused save's rollback has put the old list back.
     */
    const save = (edit: (backupModels: string[]) => string[], focusOnSuccess: string, focusOnFailure: string) => {
        focusAfter.current = focusOnSuccess;
        setSaving(true);
        updateLatest((current) => {
            const base = storedBackupModels(current);

            return { backupModels: edit(base), backupModelsBase: base };
        })
            .finally(() => setSaving(false))
            .catch((error: unknown) => {
                toast.error(
                    (error as { code?: unknown } | null)?.code === "CONFLICT"
                        ? t`Your backup models were changed in another tab. The saved list is shown again.`
                        : t`Failed to update backup models`,
                );
                focusAfter.current = focusOnFailure;
                setFocusRequest((count) => count + 1);
            });
    };

    return (
        <div aria-labelledby={labelId} className="space-y-3 outline-none" ref={section} role="group" tabIndex={-1}>
            <div className="space-y-0.5">
                <Label className="text-sm font-medium" id={labelId}>
                    {t`Backup models`}
                </Label>
                <p className="text-muted-foreground text-xs">{t`If your chosen model is unavailable, the reply is retried on these models in order`}</p>
            </div>
            {chosen.length > 0 && (
                <ol aria-labelledby={labelId} className="space-y-1">
                    {chosen.map((id, index) => {
                        const model = catalog.find((m) => m.id === id);
                        const name = model?.name ?? id;

                        return (
                            <li className="flex items-center gap-2" key={id}>
                                <span className="text-muted-foreground w-4 shrink-0 text-xs tabular-nums">{index + 1}.</span>
                                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                                    {model && (
                                        <ProviderIcon
                                            className="size-3 shrink-0"
                                            provider={model.provider ?? model.displayProvider ?? ""}
                                            providerIcon={model.id.split("/", 1)[0] ?? model.displayProvider ?? ""}
                                        />
                                    )}
                                    <span className="truncate">{name}</span>
                                    {availabilityKnown && !usable.has(id) && <span className="text-muted-foreground shrink-0 text-xs">{t`Unavailable`}</span>}
                                </span>
                                <Button
                                    aria-label={t`Move ${name} up`}
                                    disabled={locked || index === 0}
                                    onClick={() =>
                                        // At the top, "up" is disabled: focus moves to "down". A refused move puts the entry back, and "up" with it.
                                        save((list) => moveBackupModel(list, id, -1), controlKey(id, index === 1 ? "down" : "up"), controlKey(id, "up"))
                                    }
                                    ref={register(controlKey(id, "up"))}
                                    size="icon-sm"
                                    variant="ghost"
                                >
                                    <ArrowUp aria-hidden />
                                </Button>
                                <Button
                                    aria-label={t`Move ${name} down`}
                                    disabled={locked || index === chosen.length - 1}
                                    onClick={() =>
                                        save(
                                            (list) => moveBackupModel(list, id, 1),
                                            controlKey(id, index === chosen.length - 2 ? "up" : "down"),
                                            controlKey(id, "down"),
                                        )
                                    }
                                    ref={register(controlKey(id, "down"))}
                                    size="icon-sm"
                                    variant="ghost"
                                >
                                    <ArrowDown aria-hidden />
                                </Button>
                                <Button
                                    aria-label={t`Remove ${name}`}
                                    disabled={locked}
                                    onClick={() => {
                                        const next = chosen[index + 1] ?? chosen[index - 1];

                                        save(
                                            (list) => list.filter((entry) => entry !== id),
                                            next === undefined ? "" : controlKey(next, "remove"),
                                            controlKey(id, "remove"),
                                        );
                                    }}
                                    ref={register(controlKey(id, "remove"))}
                                    size="icon-sm"
                                    variant="ghost"
                                >
                                    <X aria-hidden />
                                </Button>
                            </li>
                        );
                    })}
                </ol>
            )}
            {chosen.length < limit && (
                <div ref={addRow}>
                    <ModelSelect
                        description={t`Up to ${limit}, tried in the order listed`}
                        // Not disabled while a save runs, so it keeps focus; a pick made then is ignored below.
                        disabled={disabled === true || userSettings === undefined}
                        emptyLabel={t`Choose a model`}
                        field="backupModels"
                        label={chosen.length === 0 ? t`Add a backup model` : t`Add another backup model`}
                        // Unread filters look like none, so nothing is offered until they are read.
                        models={filtersRead ? allModels.filter((m) => usable.has(m.id) && !chosen.includes(m.id)) : []}
                        onChange={(_field, modelId) => {
                            if (!modelId || locked) {
                                return;
                            }

                            const fills = chosen.length + 1 >= limit;

                            // The picker stays unless this add fills the list; then the new entry's remove button takes focus. A refused
                            // add rolls its entry back and brings the picker back, so focus returns to it.
                            save(
                                (list) => (list.includes(modelId) || list.length >= limit ? list : [...list, modelId]),
                                fills ? controlKey(modelId, "remove") : "",
                                "",
                            );
                        }}
                        value={undefined}
                    />
                </div>
            )}
        </div>
    );
};

const DefaultModelsSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data: aiPreferences, isLoading } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const updateMutation = useMutation(crpc.auth.functions.updateAIUserPreferences.mutationOptions());

    // Feature-flag-aware model lists — models behind a disabled flag are hidden
    const flaggedModels = useFeatureFlaggedModels();

    if (isLoading) {
        return <div className="text-muted-foreground text-sm">{t`Loading...`}</div>;
    }

    const defaults = (aiPreferences?.defaultModels ?? {}) as DefaultModels;
    const providersWithKey = new Set(
        Object.entries((aiPreferences?.providerApiKeys ?? {}) as Record<string, { enabled?: boolean; hasKey?: boolean }>)
            .filter(([, entry]) => entry.enabled && entry.hasKey)
            .map(([provider]) => provider),
    );

    const flaggedIds = new Set(flaggedModels.map((m) => m.id));
    const ff = (list: GatewayModel[]) => list.filter((m) => flaggedIds.has(m.id));

    const textModels = flaggedModels.filter((m) => m.enabled && (m.mode === "text" || !m.mode));
    const visionModels = flaggedModels.filter((m) => m.enabled && (m.mode === "text" || !m.mode) && m.filterCapabilities?.includes("vision"));
    const imageGenModels = ff(flaggedModels.filter((m) => m.enabled && m.filterCapabilities?.includes("image_generation")));
    const img2imgModels = ff(flaggedModels.filter((m) => m.enabled && m.supportsImg2Img));
    const charRefModels = ff(flaggedModels.filter((m) => m.enabled && m.supportsCharacterRef));
    const textToVideoModels = ff(flaggedModels.filter((m) => m.enabled && m.supportsTextToVideo));
    const imageToVideoModels = ff(flaggedModels.filter((m) => m.enabled && m.supportsImageToVideo));
    const videoModels = flaggedModels.filter((m) => m.enabled && m.mode === "video");

    const handleChange = (field: DefaultModelKey, modelId: string | null) => {
        const updated = { ...defaults };

        if (modelId === null) {
            delete updated[field];
        } else {
            updated[field] = modelId;
        }

        updateMutation.mutate(
            { defaultModels: updated },
            {
                onError: () => toast.error(t`Failed to update default model`),
                onSuccess: () => {
                    if (modelId) {
                        trackEvent("default_model_changed", { mode: field, model: modelId });
                    }

                    toast.success(t`Default model updated`);
                },
            },
        );
    };

    const { isPending } = updateMutation;

    return (
        <div className="space-y-6 pb-6">
            {/* Text */}
            <Card>
                <CardHeader>
                    <CardTitle>{t`Text`}</CardTitle>
                    <CardDescription>{t`Choose default text models`}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <ModelSelect
                        description={t`Default model for chat and text generation`}
                        disabled={isPending}
                        field="textToText"
                        label={t`Text to text`}
                        models={textModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_TEXT_TO_TEXT_MODEL}
                        value={defaults.textToText}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for image understanding and analysis`}
                        disabled={isPending}
                        field="imageToText"
                        label={t`Image to text`}
                        models={visionModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_IMAGE_TO_TEXT_MODEL}
                        value={defaults.imageToText}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for video understanding and transcription`}
                        disabled={isPending}
                        field="videoToText"
                        label={t`Video to text`}
                        models={textModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_VIDEO_TO_TEXT_MODEL}
                        value={defaults.videoToText}
                    />
                    <Separator />
                    <BackupModelsSetting disabled={isPending} models={textModels} providersWithKey={providersWithKey} />
                </CardContent>
            </Card>

            {/* Image */}
            <Card>
                <CardHeader>
                    <CardTitle>{t`Image`}</CardTitle>
                    <CardDescription>{t`Choose default image models`}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <ModelSelect
                        description={t`Default model for generating images from text prompts`}
                        disabled={isPending}
                        field="textToImage"
                        label={t`Text to image`}
                        models={imageGenModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_TEXT_TO_IMAGE_MODEL}
                        value={defaults.textToImage}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for transforming existing images`}
                        disabled={isPending}
                        field="imageToImage"
                        label={t`Image to image`}
                        models={img2imgModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_IMAGE_TO_IMAGE_MODEL}
                        value={defaults.imageToImage}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for combining multiple reference images`}
                        disabled={isPending}
                        field="imagesToImage"
                        label={t`Images to image`}
                        models={charRefModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_IMAGES_TO_IMAGE_MODEL}
                        value={defaults.imagesToImage}
                    />
                </CardContent>
            </Card>

            {/* Video */}
            <Card>
                <CardHeader>
                    <CardTitle>{t`Video`}</CardTitle>
                    <CardDescription>{t`Choose default video models`}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <ModelSelect
                        description={t`Default model for generating video from text prompts`}
                        disabled={isPending}
                        field="textToVideo"
                        label={t`Text to video`}
                        models={textToVideoModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_TEXT_TO_VIDEO_MODEL}
                        value={defaults.textToVideo}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for animating a single image`}
                        disabled={isPending}
                        field="imageToVideo"
                        label={t`Image to video`}
                        models={imageToVideoModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_IMAGE_TO_VIDEO_MODEL}
                        value={defaults.imageToVideo}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for generating video from multiple images`}
                        disabled={isPending}
                        field="imagesToVideo"
                        label={t`Images to video`}
                        models={videoModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_IMAGES_TO_VIDEO_MODEL}
                        value={defaults.imagesToVideo}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for editing or transforming existing video`}
                        disabled={isPending}
                        field="videoToVideo"
                        label={t`Video to video`}
                        models={videoModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_VIDEO_TO_VIDEO_MODEL}
                        value={defaults.videoToVideo}
                    />
                    <Separator />
                    <ModelSelect
                        description={t`Default model for video generation from mixed inputs`}
                        disabled={isPending}
                        field="mixedToVideo"
                        label={t`Mixed to video`}
                        models={videoModels}
                        onChange={handleChange}
                        systemDefaultId={DEFAULT_MIXED_TO_VIDEO_MODEL}
                        value={defaults.mixedToVideo}
                    />
                </CardContent>
            </Card>
        </div>
    );
};

export default DefaultModelsSettings;
