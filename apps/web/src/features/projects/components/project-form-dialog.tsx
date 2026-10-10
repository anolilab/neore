"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { ColorPicker } from "@neore/ui/components/color-picker";
import { useAppForm } from "@neore/ui/components/form";
import { IconPicker } from "@neore/ui/components/icon-picker";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Textarea } from "@neore/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import { useMutation } from "@tanstack/react-query";
import type { IconName } from "lucide-react/dynamic";
import { DynamicIcon } from "lucide-react/dynamic";
import { useEffect, useEffectEvent } from "react";
import * as z from "zod";

import { ReasoningEffortSelector } from "@/features/chat/model-settings/reasoning-effort-selector";
import ProjectKnowledgeCollections from "@/features/knowledge/components/project-knowledge-collections";
import PromptModelSelector from "@/features/prompts/components/prompt-model-selector";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { useCRPC } from "@/lib/lunora/crpc";

interface ProjectFormDialogProps {
    editingProject?: {
        _id: string;
        color?: string;
        context?: string;
        defaultEnabledFeatures?: string[];
        defaultModel?: string;
        defaultReasoningEffort?: number;
        description?: string;
        icon?: string;
        title: string;
    } | null;
    onClose: () => void;
    open: boolean;
}

interface FormValues {
    color?: string;
    context: string;
    defaultEnabledFeatures: string[];
    defaultModel?: string;
    defaultReasoningEffort?: number;
    description: string;
    icon?: string;
    title: string;
}

const formSchema = z.object({
    color: z.string().optional(),
    context: z.string().optional(),
    defaultEnabledFeatures: z.array(z.string()).default([]),
    defaultModel: z.string().optional(),
    defaultReasoningEffort: z.number().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    title: z.string().min(1, "Title is required"),
});

const getDefaultValues = (editingProject?: ProjectFormDialogProps["editingProject"]): FormValues => {
    return {
        color: editingProject?.color,
        context: editingProject?.context || "",
        defaultEnabledFeatures: editingProject?.defaultEnabledFeatures || [],
        defaultModel: editingProject?.defaultModel,
        defaultReasoningEffort: editingProject?.defaultReasoningEffort,
        description: editingProject?.description || "",
        icon: editingProject?.icon,
        title: editingProject?.title || "",
    };
};

const ProjectFormDialog = ({ editingProject, onClose, open }: ProjectFormDialogProps) => {
    const { t } = useLingui();
    const models = useFeatureFlaggedModels();
    const crpc = useCRPC();
    const { mutateAsync: createProject } = useMutation(crpc.projects.functions.createProject.mutationOptions());
    const { mutateAsync: updateProject } = useMutation(crpc.projects.functions.updateProject.mutationOptions());

    const form = useAppForm({
        defaultValues: getDefaultValues(editingProject),
        onSubmit: async ({ value }) => {
            if (editingProject) {
                // `patch` fields are `v.optional(...)` nested inside a `v.object`, which
                // codegen emits as required keys with an `| undefined` value — every key
                // (including `organizationId`, which this dialog never edits) must be present.
                const patch = {
                    color: value.color || undefined, // Explicitly undefined when empty to clear it
                    context: value.context.trim() || undefined,
                    defaultEnabledFeatures: value.defaultEnabledFeatures.length > 0 ? value.defaultEnabledFeatures : undefined,
                    defaultModel: value.defaultModel || undefined,
                    defaultReasoningEffort: value.defaultReasoningEffort,
                    description: value.description.trim() || undefined,
                    icon: value.icon || undefined, // Explicitly undefined when empty to remove
                    organizationId: undefined,
                    title: value.title.trim() || undefined,
                };

                await updateProject({
                    patch,
                    // The dialog receives `_id` as a plain `string` from the thread-list
                    // store; it is always an id the backend returned for a `projects` row.
                    projectId: editingProject._id as Id<"projects">,
                });
            } else {
                const projectData = {
                    color: value.color,
                    context: value.context.trim() || undefined,
                    defaultEnabledFeatures: value.defaultEnabledFeatures.length > 0 ? value.defaultEnabledFeatures : undefined,
                    defaultModel: value.defaultModel,
                    defaultReasoningEffort: value.defaultReasoningEffort,
                    description: value.description.trim() || undefined,
                    icon: value.icon,
                    title: value.title.trim(),
                };

                await createProject(projectData);
            }

            form.reset(getDefaultValues(undefined));

            onClose();
        },
        validators: {
            onChange: ({ value }) => {
                const result = formSchema.safeParse(value);

                if (!result.success) {
                    return z.treeifyError(result.error);
                }

                return undefined;
            },
            onSubmit: ({ value }) => {
                const result = formSchema.safeParse(value);

                if (!result.success) {
                    return z.treeifyError(result.error);
                }

                return undefined;
            },
        },
    });

    const resetToProject = useEffectEvent((project: typeof editingProject) => {
        form.reset(getDefaultValues(project));
    });

    useEffect(() => {
        if (!open) {
            return;
        }

        resetToProject(editingProject);
    }, [editingProject, open]);

    return (
        <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
            <DialogContent className="max-h-screen max-w-2xl overflow-y-auto">
                <form.AppForm>
                    <form
                        autoComplete="off"
                        className="flex flex-col"
                        id="project-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            form.handleSubmit();
                        }}
                    >
                        <DialogHeader>
                            <DialogTitle>{editingProject ? t`Edit Project` : t`Create Project`}</DialogTitle>
                            <DialogDescription>
                                {editingProject ? t`Update your project details below.` : t`Create a new project to group related chats with shared context.`}
                            </DialogDescription>
                        </DialogHeader>
                        <DialogPanel className="min-h-0 flex-1 space-y-6">
                            <div className="space-y-6">
                                <div className="space-y-4">
                                    <form.AppField name="title">
                                        {(field) => (
                                            <field.FormItem required>
                                                <field.FormLabel>{t`Title`}</field.FormLabel>
                                                <field.FormControl>
                                                    <Input
                                                        autoComplete="off"
                                                        name="project-title"
                                                        onBlur={field.handleBlur}
                                                        onChange={(e) => field.handleChange(e.target.value)}
                                                        placeholder={t`e.g., Financial Planning`}
                                                        value={field.state.value}
                                                    />
                                                </field.FormControl>
                                                <field.FormMessage />
                                            </field.FormItem>
                                        )}
                                    </form.AppField>

                                    <form.AppField name="description">
                                        {(field) => (
                                            <field.FormItem>
                                                <field.FormLabel>{t`Description`}</field.FormLabel>
                                                <field.FormControl>
                                                    <Input
                                                        autoComplete="off"
                                                        name="project-description"
                                                        onBlur={field.handleBlur}
                                                        onChange={(e) => field.handleChange(e.target.value)}
                                                        placeholder={t`Brief description of this project`}
                                                        value={field.state.value}
                                                    />
                                                </field.FormControl>
                                                <field.FormMessage />
                                            </field.FormItem>
                                        )}
                                    </form.AppField>
                                </div>

                                <div className="bg-muted/30 space-y-4 rounded-lg border p-4">
                                    <div className="space-y-1">
                                        <Label className="text-sm font-medium">{t`Appearance`}</Label>
                                        <p className="text-muted-foreground text-xs">{t`Customize the visual appearance of this project.`}</p>
                                    </div>
                                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                        <form.AppField name="color">
                                            {(field) => (
                                                <div aria-labelledby="project-color-label" className="space-y-2" role="group">
                                                    <span className="text-sm font-medium" id="project-color-label">{t`Color`}</span>
                                                    <div className="flex items-center gap-2">
                                                        <ColorPicker
                                                            hideContrastRatio
                                                            onValueChange={(value) => {
                                                                field.handleChange(value.hex);
                                                            }}
                                                            swatches={["#AEDEAE", "#FFD3B6", "#FFB6B9", "#FFC0CB", "#FFD1DC"]}
                                                            value={field.state.value as `#${string}` | undefined}
                                                        >
                                                            <Button
                                                                className="border-input size-10"
                                                                style={{
                                                                    backgroundColor: field.state.value,
                                                                    borderColor: field.state.value || undefined,
                                                                }}
                                                                type="button"
                                                                variant="outline"
                                                            >
                                                                {!field.state.value && <span className="text-muted-foreground text-xs">×</span>}
                                                            </Button>
                                                        </ColorPicker>
                                                        {field.state.value && (
                                                            <Button onClick={() => field.handleChange(undefined)} size="sm" type="button" variant="ghost">
                                                                {t`Remove`}
                                                            </Button>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </form.AppField>

                                        <form.AppField name="icon">
                                            {(iconField) => (
                                                <div aria-labelledby="project-icon-label" className="space-y-2" role="group">
                                                    <span className="text-sm font-medium" id="project-icon-label">{t`Icon`}</span>
                                                    <div className="flex items-center gap-2">
                                                        <TooltipProvider>
                                                            <Tooltip>
                                                                <TooltipTrigger
                                                                    render={
                                                                        <IconPicker
                                                                            onValueChange={(value) => iconField.handleChange(value)}
                                                                            value={iconField.state.value as IconName | undefined}
                                                                        >
                                                                            <Button
                                                                                className="border-input size-10 p-0"
                                                                                title={iconField.state.value || t`Select an icon`}
                                                                                type="button"
                                                                                variant="outline"
                                                                            >
                                                                                {iconField.state.value ? (
                                                                                    <DynamicIcon className="size-4" name={iconField.state.value as IconName} />
                                                                                ) : (
                                                                                    <span className="text-muted-foreground text-xs">×</span>
                                                                                )}
                                                                            </Button>
                                                                        </IconPicker>
                                                                    }
                                                                />
                                                                <TooltipContent>{iconField.state.value || t`Select an icon`}</TooltipContent>
                                                            </Tooltip>
                                                        </TooltipProvider>
                                                        {iconField.state.value && (
                                                            <Button onClick={() => iconField.handleChange(undefined)} size="sm" type="button" variant="ghost">
                                                                {t`Remove`}
                                                            </Button>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </form.AppField>
                                    </div>
                                </div>

                                <form.AppField name="context">
                                    {(field) => (
                                        <field.FormItem>
                                            <field.FormLabel>{t`Context / Instructions`}</field.FormLabel>
                                            <field.FormControl>
                                                <Textarea
                                                    autoComplete="off"
                                                    expandable
                                                    expandableDialogTitle={t`Project Context`}
                                                    name="project-context"
                                                    onBlur={field.handleBlur}
                                                    onChange={(e) => field.handleChange(e.target.value)}
                                                    placeholder={t`This context will be automatically added to each chat in your project. You can include instructions, background information, or any shared knowledge.`}
                                                    value={field.state.value}
                                                />
                                            </field.FormControl>
                                            <field.FormDescription>
                                                {t`This context will be prepended to the system prompt for all chats in this project.`}
                                            </field.FormDescription>
                                            <field.FormMessage />
                                        </field.FormItem>
                                    )}
                                </form.AppField>
                            </div>

                            <div className="bg-muted/30 space-y-4 rounded-lg border p-4">
                                <div className="space-y-1">
                                    <Label className="text-sm font-medium">{t`Default AI Settings`}</Label>
                                    <p className="text-muted-foreground text-xs">
                                        {t`Configure default model, reasoning effort, and features for new chats created in this project.`}
                                    </p>
                                </div>

                                <div className="space-y-4">
                                    <form.AppField name="defaultModel">
                                        {(field) => (
                                            <field.FormItem>
                                                <field.FormLabel>{t`Default Model`}</field.FormLabel>
                                                <field.FormControl>
                                                    <PromptModelSelector onChange={field.handleChange} value={field.state.value} />
                                                </field.FormControl>
                                                <field.FormMessage />
                                            </field.FormItem>
                                        )}
                                    </form.AppField>

                                    <form.Subscribe selector={(state) => state.values.defaultModel}>
                                        {(defaultModel) => {
                                            const selectedModel = models.find((m) => m.id === defaultModel);

                                            if (!selectedModel) {
                                                return null;
                                            }

                                            return (
                                                <>
                                                    <form.AppField name="defaultReasoningEffort">
                                                        {(effortField) => (
                                                            <ReasoningEffortSelector
                                                                model={selectedModel}
                                                                onChange={effortField.handleChange}
                                                                value={effortField.state.value}
                                                            />
                                                        )}
                                                    </form.AppField>
                                                </>
                                            );
                                        }}
                                    </form.Subscribe>
                                </div>
                            </div>
                            {/* Links, saved as they change — only a saved project has an id to link to. */}
                            {editingProject && <ProjectKnowledgeCollections projectId={editingProject._id} />}
                        </DialogPanel>
                        <DialogFooter>
                            <Button onClick={onClose} type="button" variant="outline">
                                {t`Cancel`}
                            </Button>
                            <form.Subscribe
                                selector={(state) => {
                                    return {
                                        canSubmit: state.canSubmit,
                                        isSubmitting: state.isSubmitting,
                                        title: state.values.title,
                                    };
                                }}
                            >
                                {({ canSubmit, isSubmitting, title }) => {
                                    const isDisabled = !canSubmit || isSubmitting || !title.trim();
                                    const idleLabel = editingProject ? t`Update Project` : t`Create Project`;

                                    return (
                                        <Button disabled={isDisabled} type="submit">
                                            {isSubmitting ? t`Saving...` : idleLabel}
                                        </Button>
                                    );
                                }}
                            </form.Subscribe>
                        </DialogFooter>
                    </form>
                </form.AppForm>
            </DialogContent>
        </Dialog>
    );
};

export default ProjectFormDialog;
