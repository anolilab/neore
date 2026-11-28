"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Heading } from "@neore/ui/components/heading";
import { Input } from "@neore/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Pencil, Sparkles, Trash2 } from "lucide-react";
import type { FC } from "react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";
import SystemPromptOptimizerDialog from "@/features/chat/prompt-improvement/components/system-prompt-optimizer-dialog";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { useCRPC } from "@/lib/lunora/crpc";

interface PresetFormState {
    description: string;
    modelId: string;
    name: string;
    prompt: string;
}

const EMPTY_FORM: PresetFormState = { description: "", modelId: "", name: "", prompt: "" };
const ANY_MODEL_VALUE = "__any__";

const SystemPromptPresetSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const flaggedModels = useFeatureFlaggedModels();

    const { data: presets, isLoading, refetch } = useQuery(crpc.system_prompts.functions.listPresets.queryOptions({}));

    const createMutation = useMutation(crpc.system_prompts.functions.createPreset.mutationOptions());
    const updateMutation = useMutation(crpc.system_prompts.functions.updatePreset.mutationOptions());
    const deleteMutation = useMutation(crpc.system_prompts.functions.deletePreset.mutationOptions());
    const { mutateAsync: createPreset } = createMutation;
    const { mutateAsync: updatePreset } = updateMutation;
    const { mutateAsync: deletePreset } = deleteMutation;

    const [showCreateForm, setShowCreateForm] = useState(false);
    const [formData, setFormData] = useState<PresetFormState>(EMPTY_FORM);
    const [editingId, setEditingId] = useState<null | string>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<null | string>(null);
    const [optimizerTargetField, setOptimizerTargetField] = useState<"create" | "edit" | null>(null);

    const modelLabel = useMemo(() => {
        const map = new Map<string, string>();

        for (const m of flaggedModels) {
            map.set(m.id, m.id);
        }

        return map;
    }, [flaggedModels]);

    const resetForm = useCallback(() => {
        setFormData(EMPTY_FORM);
        setShowCreateForm(false);
        setEditingId(null);
    }, []);

    const handleCreate = useCallback(async () => {
        const trimmedName = formData.name.trim();
        const trimmedPrompt = formData.prompt.trim();

        if (!trimmedName || !trimmedPrompt) {
            toast.error(t`Name and prompt are required`);

            return;
        }

        try {
            await createPreset({
                description: formData.description.trim() || undefined,
                modelId: formData.modelId.trim() || undefined,
                name: trimmedName,
                prompt: trimmedPrompt,
            });
            toast.success(t`Preset created`);
            resetForm();
            await refetch();
        } catch (error: any) {
            toast.error(error?.message ?? t`Failed to create preset`);
        }
    }, [createPreset, formData, refetch, resetForm, t]);

    const handleSaveEdit = useCallback(async () => {
        if (!editingId) {
            return;
        }

        try {
            await updatePreset({
                description: formData.description.trim() || undefined,
                modelId: formData.modelId.trim() || null,
                name: formData.name.trim(),
                presetId: editingId,
                prompt: formData.prompt.trim(),
            });
            toast.success(t`Preset updated`);
            resetForm();
            await refetch();
        } catch (error: any) {
            toast.error(error?.message ?? t`Failed to update preset`);
        }
    }, [editingId, formData, refetch, resetForm, t, updatePreset]);

    const handleDelete = useCallback(async () => {
        if (!confirmDeleteId) {
            return;
        }

        try {
            await deletePreset({ presetId: confirmDeleteId });
            toast.success(t`Preset deleted`);
            await refetch();
        } catch (error: any) {
            toast.error(error?.message ?? t`Failed to delete preset`);
        }

        setConfirmDeleteId(null);
    }, [confirmDeleteId, deletePreset, refetch, t]);

    const handleStartEdit = useCallback((preset: { _id: string; description: string | null; modelId: string | null; name: string; prompt: string }) => {
        setEditingId(preset._id);
        setShowCreateForm(false);
        setFormData({
            description: preset.description ?? "",
            modelId: preset.modelId ?? "",
            name: preset.name,
            prompt: preset.prompt,
        });
    }, []);

    const isOptimizerOpen = optimizerTargetField !== null;

    const handleOptimizedPrompt = useCallback((optimized: string) => {
        setFormData((current) => {
            return { ...current, prompt: optimized.trim() };
        });
        setOptimizerTargetField(null);
    }, []);

    const renderForm = (mode: "create" | "edit") => (
        <div className="border-border/50 py-3 not-first:border-t">
            <Heading className="text-sm font-medium" fallbackLevel={3}>
                {mode === "create" ? t`New preset` : t`Edit preset`}
            </Heading>
            <SettingsRow htmlFor={`${mode}-preset-name`} title={t`Name`}>
                <Input
                    id={`${mode}-preset-name`}
                    maxLength={80}
                    onChange={(e) =>
                        setFormData((current) => {
                            return { ...current, name: e.target.value };
                        })
                    }
                    placeholder={t`e.g., Strict JSON coder`}
                    type="text"
                    value={formData.name}
                />
            </SettingsRow>

            <SettingsRow htmlFor={`${mode}-preset-description`} title={t`Description (optional)`}>
                <Input
                    id={`${mode}-preset-description`}
                    maxLength={280}
                    onChange={(e) =>
                        setFormData((current) => {
                            return { ...current, description: e.target.value };
                        })
                    }
                    placeholder={t`Short description of when to use this preset`}
                    type="text"
                    value={formData.description}
                />
            </SettingsRow>

            <SettingsRow
                control={
                    <Select<string>
                        items={[{ label: t`Any model`, value: ANY_MODEL_VALUE }]}
                        onValueChange={(value) =>
                            setFormData((current) => {
                                return {
                                    ...current,
                                    modelId: value === ANY_MODEL_VALUE || value === null ? "" : value,
                                };
                            })
                        }
                        value={formData.modelId || ANY_MODEL_VALUE}
                    >
                        <SelectTrigger id={`${mode}-preset-model`}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={ANY_MODEL_VALUE}>{t`Any model`}</SelectItem>
                            {flaggedModels.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                    {m.id}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                }
                description={t`Leave empty for "any model".`}
                htmlFor={`${mode}-preset-model`}
                title={t`Target model (optional)`}
            />

            <SettingsRow
                control={
                    <Button onClick={() => setOptimizerTargetField(mode)} size="sm" type="button" variant="outline">
                        <Sparkles aria-hidden="true" className="mr-1.5 size-3.5" />
                        {t`Optimize`}
                    </Button>
                }
                htmlFor={`${mode}-preset-prompt`}
                title={t`System prompt`}
            >
                <Textarea
                    expandable
                    expandableDialogTitle={t`System prompt`}
                    id={`${mode}-preset-prompt`}
                    maxLength={20_000}
                    onChange={(e) =>
                        setFormData((current) => {
                            return { ...current, prompt: e.target.value };
                        })
                    }
                    placeholder={t`The full system prompt to send to the model...`}
                    value={formData.prompt}
                />
                <div className="text-muted-foreground mt-1 text-right text-xs">{formData.prompt.length} / 20000</div>
            </SettingsRow>

            <div className="border-border/50 flex justify-end gap-2 border-t pt-3">
                <Button onClick={resetForm} type="button" variant="ghost">
                    {t`Cancel`}
                </Button>
                {mode === "create" ? (
                    <Button disabled={createMutation.isPending} onClick={handleCreate} type="button">
                        {createMutation.isPending ? t`Saving...` : t`Save preset`}
                    </Button>
                ) : (
                    <Button disabled={updateMutation.isPending} onClick={handleSaveEdit} type="button">
                        {updateMutation.isPending ? t`Saving...` : t`Save changes`}
                    </Button>
                )}
            </div>
        </div>
    );

    const canCreate = !showCreateForm && editingId === null;

    return (
        <div className="space-y-6">
            <SettingsCard
                action={
                    canCreate
                        ? () => {
                              setShowCreateForm(true);
                              setFormData(EMPTY_FORM);
                          }
                        : undefined
                }
                actionLabel={canCreate ? t`New preset` : undefined}
                description={t`Save reusable system prompts and tie them to specific models. Use the Optimize button to refine each preset with the prompt-optimizer.`}
                title={t`System Prompt Presets`}
            >
                {showCreateForm && renderForm("create")}

                {isLoading && <p className="text-muted-foreground py-3 text-sm">{t`Loading presets...`}</p>}
                {!isLoading && (!presets || presets.length === 0) && (
                    <p className="text-muted-foreground py-3 text-sm">{t`No presets yet. Create one to get started.`}</p>
                )}
                {presets?.map((preset) =>
                    editingId === preset._id ? (
                        <div key={preset._id}>{renderForm("edit")}</div>
                    ) : (
                        <SettingsRow
                            control={
                                <div className="flex gap-1">
                                    <Button aria-label={t`Edit preset`} onClick={() => handleStartEdit(preset)} size="sm" variant="ghost">
                                        <Pencil aria-hidden="true" className="size-4" />
                                    </Button>
                                    <Button aria-label={t`Delete preset`} onClick={() => setConfirmDeleteId(preset._id)} size="sm" variant="ghost">
                                        <Trash2 aria-hidden="true" className="size-4" />
                                    </Button>
                                </div>
                            }
                            description={
                                <>
                                    {preset.description && <span className="block">{preset.description}</span>}
                                    <span className="mt-1.5 flex flex-wrap items-center gap-2">
                                        {preset.modelId ? (
                                            <Badge variant="outline">{modelLabel.get(preset.modelId) ?? preset.modelId}</Badge>
                                        ) : (
                                            <Badge variant="secondary">{t`Any model`}</Badge>
                                        )}
                                        <span>
                                            {preset.prompt.length} {t`chars`}
                                        </span>
                                    </span>
                                </>
                            }
                            key={preset._id}
                            title={preset.name}
                        />
                    ),
                )}
            </SettingsCard>

            <SystemPromptOptimizerDialog
                initialPrompt={formData.prompt}
                modelId={formData.modelId || undefined}
                onApply={handleOptimizedPrompt}
                onOpenChange={(open: boolean) => {
                    if (!open) {
                        setOptimizerTargetField(null);
                    }
                }}
                open={isOptimizerOpen}
                title={t`Optimize preset prompt`}
            />

            <ConfirmDialog
                confirmLabel={t`Delete`}
                description={t`This preset will be permanently removed.`}
                onConfirm={handleDelete}
                onOpenChange={(open: boolean) => {
                    if (!open) {
                        setConfirmDeleteId(null);
                    }
                }}
                open={confirmDeleteId !== null}
                title={t`Delete preset?`}
            />
        </div>
    );
};

export default SystemPromptPresetSettings;
