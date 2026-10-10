import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Doc, Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@neore/ui/components/collapsible";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Textarea } from "@neore/ui/components/textarea";
import { useQuery } from "@tanstack/react-query";
import type { Tag } from "emblor";
import { TagInput } from "emblor";
import { ChevronDown } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { EFFORT_LABEL_MESSAGES, ReasoningEffortSelector } from "@/features/chat/model-settings/reasoning-effort-selector";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { useAction } from "@/lib/lunora/crpc";

import validatePromptSettings from "../lib/prompt-validation";
import type { PromptVariable } from "../lib/prompt-variables";
import { syncVariablesWithContent } from "../lib/prompt-variables";
import PromptModelSelector from "./prompt-model-selector";
import VariableDefinitions from "./variable-definitions";
import VariableInsertion from "./variable-insertion";

/** Literal `{{…}}` must reach the message as a value: inside a lingui message it would parse as an ICU argument. */
const VARIABLE_PLACEHOLDER = "{{variableName}}";
const EXAMPLE_PLACEHOLDER = "{{username}}";

("use client");

interface PromptFormDialogProps {
    editingPrompt?: Doc<"prompts"> | null;
    onClose: () => void;
    onSubmit: (data: {
        content: string;
        description?: string;
        enabledFeatures?: string[];
        isFavorite?: boolean;
        model?: string;
        name: string;
        promptId?: Id<"prompts">;
        reasoningEffort?: number;
        tags?: string[];
        variables?: PromptVariable[];
    }) => Promise<void>;
    open: boolean;
}

interface FormValues {
    content: string;
    description: string;
    enabledFeatures: string[];
    isFavorite: boolean;
    model?: string;
    name: string;
    reasoningEffort?: number;
    tags: Tag[];
    variables: PromptVariable[];
}

const getDefaultValues = (editingPrompt?: Doc<"prompts"> | null): FormValues => {
    return {
        content: editingPrompt?.content || "",
        description: editingPrompt?.description || "",
        enabledFeatures: editingPrompt?.enabledFeatures || [],
        isFavorite: editingPrompt?.isFavorite || false,
        model: editingPrompt?.model ?? undefined,
        name: editingPrompt?.name || "",
        reasoningEffort: editingPrompt?.reasoningEffort ?? undefined,
        tags:
            editingPrompt?.tags?.map((tag: string, index: number) => {
                return {
                    id: String(Date.now() + index),
                    text: tag,
                };
            }) || [],
        variables: editingPrompt?.variables || [],
    };
};

type PromptFormDialogBodyProps = Omit<PromptFormDialogProps, "open">;

const PromptFormDialogBody = ({ editingPrompt, onClose, onSubmit }: PromptFormDialogBodyProps) => {
    const { i18n, t } = useLingui();
    const models = useFeatureFlaggedModels();
    const [activeTagIndex, setActiveTagIndex] = useState<number | null>(null);
    const [variablesOpen, setVariablesOpen] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Fetch user's existing tags for autocomplete. Read through useQuery so the result is
    // cached and deduplicated across dialog opens; tags are optional, so errors stay silent.
    const getPromptTags = useAction(api.prompts.functions.getPromptTags);
    const { data: existingTags } = useQuery({
        queryFn: () => getPromptTags({}),
        queryKey: ["prompts", "getPromptTags"],
    });

    // Convert existing tags to Tag[] format for autocomplete
    const autocompleteOptions: Tag[] = useMemo(() => {
        if (!existingTags) {
            return [];
        }

        return existingTags.map((tag) => {
            return {
                id: tag,
                text: tag,
            };
        });
    }, [existingTags]);

    const form = useAppForm({
        defaultValues: getDefaultValues(editingPrompt),
        onSubmit: async ({ value }) => {
            // Validate before submitting
            const validationResult = validatePromptSettings(value.model, value.reasoningEffort, value.enabledFeatures, models);

            if (!validationResult.isValid) {
                // Set errors on form fields
                const errorMap: Record<string, string> = {};

                if (validationResult.errors.model) {
                    errorMap.model = validationResult.errors.model;
                }

                if (validationResult.errors.reasoningEffort) {
                    errorMap.reasoningEffort = validationResult.errors.reasoningEffort;
                }

                if (validationResult.errors.enabledFeatures && validationResult.errors.enabledFeatures.length > 0) {
                    // Set first error for enabledFeatures
                    errorMap.enabledFeatures = validationResult.errors.enabledFeatures[0] || "";
                }

                form.setErrorMap(errorMap);

                return;
            }

            const tagsArray = value.tags.flatMap((tag) => tag.text.trim() || []);

            // Sync variables with content to ensure we only save variables that are actually used
            const syncedVariables = syncVariablesWithContent(value.content, value.variables);
            const finalVariables = syncedVariables.length > 0 ? syncedVariables : undefined;

            await onSubmit({
                content: value.content.trim(),
                description: value.description.trim() || undefined,
                enabledFeatures: value.enabledFeatures.length > 0 ? value.enabledFeatures : undefined,
                isFavorite: value.isFavorite,
                model: value.model,
                name: value.name.trim(),
                promptId: editingPrompt?._id,
                reasoningEffort: value.reasoningEffort,
                tags: tagsArray.length > 0 ? tagsArray : undefined,
                variables: finalVariables,
            });

            onClose();
        },
        validators: {
            onChange: ({ value }) => {
                const errors: Record<string, string[]> = {};

                if (!value.name.trim()) {
                    errors.name = [t`Name is required`];
                }

                if (!value.content.trim()) {
                    errors.content = [t`Content is required`];
                }

                // Validate settings
                const validationResult = validatePromptSettings(value.model, value.reasoningEffort, value.enabledFeatures, models);

                if (validationResult.errors.model) {
                    errors.model = [validationResult.errors.model];
                }

                if (validationResult.errors.reasoningEffort) {
                    errors.reasoningEffort = [validationResult.errors.reasoningEffort];
                }

                if (validationResult.errors.enabledFeatures) {
                    errors.enabledFeatures = validationResult.errors.enabledFeatures;
                }

                return Object.keys(errors).length > 0 ? errors : undefined;
            },
        },
    });

    const handleInsertVariable = useCallback(
        (variable: string) => {
            const textarea = textareaRef.current;
            const currentContent = form.state.values.content;

            if (textarea) {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const newContent = currentContent.slice(0, start) + variable + currentContent.slice(end);

                form.setFieldValue("content", newContent);

                // Set cursor position after the inserted variable
                requestAnimationFrame(() => {
                    textarea.focus();
                    const newPosition = start + variable.length;

                    textarea.setSelectionRange(newPosition, newPosition);
                });
            } else {
                form.setFieldValue("content", currentContent + variable);
            }
        },
        [form],
    );

    return (
        <form.AppForm>
            <form
                autoComplete="off"
                className="space-y-4"
                id="prompt-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    form.handleSubmit();
                }}
            >
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{editingPrompt ? t`Edit Prompt` : t`Create Prompt`}</DialogTitle>
                        <DialogDescription>
                            {editingPrompt ? t`Update your prompt details below.` : t`Create a new prompt to use as a system prompt.`}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogPanel className="max-h-[60vh] min-h-0 flex-1 overflow-y-scroll">
                        <div className="space-y-4">
                            <form.AppField name="name">
                                {(field) => (
                                    <field.FormItem required>
                                        <field.FormLabel>{t`Name`}</field.FormLabel>
                                        <field.FormControl>
                                            <Input
                                                autoComplete="off"
                                                name="prompt-name"
                                                onBlur={field.handleBlur}
                                                onChange={(e) => field.handleChange(e.target.value)}
                                                placeholder={t`e.g., Professional Writer`}
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
                                                name="prompt-description"
                                                onBlur={field.handleBlur}
                                                onChange={(e) => field.handleChange(e.target.value)}
                                                placeholder={t`Brief description of this prompt`}
                                                value={field.state.value}
                                            />
                                        </field.FormControl>
                                        <field.FormMessage />
                                    </field.FormItem>
                                )}
                            </form.AppField>

                            <form.AppField name="tags">
                                {(field) => (
                                    <field.FormItem>
                                        <field.FormLabel>{t`Tags`}</field.FormLabel>
                                        <field.FormControl>
                                            <TagInput
                                                activeTagIndex={activeTagIndex}
                                                addOnPaste
                                                autocompleteOptions={autocompleteOptions}
                                                enableAutocomplete
                                                id="tags"
                                                placeholder={t`Add a tag`}
                                                restrictTagsToAutocompleteOptions={false}
                                                setActiveTagIndex={setActiveTagIndex}
                                                setTags={field.handleChange}
                                                styleClasses={{
                                                    inlineTagsContainer:
                                                        "border-input rounded-lg bg-background shadow-sm shadow-black/5 transition-shadow focus-within:border-ring focus-within:outline-none focus-within:ring-[3px] focus-within:ring-ring/20 p-1 gap-1",
                                                    input: "w-full min-w-[80px] focus-visible:outline-none shadow-none px-2 h-7",
                                                    tag: {
                                                        body: "h-7 relative bg-background border border-input hover:bg-background rounded-md font-medium text-xs ps-2 pe-7 flex",
                                                        closeButton:
                                                            "absolute -inset-y-px -end-px p-0 rounded-e-lg flex size-7 transition-colors outline-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70 text-muted-foreground/80 hover:text-foreground",
                                                    },
                                                }}
                                                tags={field.state.value}
                                            />
                                        </field.FormControl>
                                        <field.FormMessage />
                                    </field.FormItem>
                                )}
                            </form.AppField>

                            <form.AppField name="isFavorite">
                                {(field) => (
                                    <div className="flex items-center gap-2">
                                        <Checkbox
                                            checked={field.state.value}
                                            id="favorite"
                                            onCheckedChange={(checked) => field.handleChange(checked === true)}
                                        />
                                        <Label className="cursor-pointer" htmlFor="favorite">
                                            {t`Mark as favorite`}
                                        </Label>
                                    </div>
                                )}
                            </form.AppField>
                        </div>

                        <form.AppField name="content">
                            {(field) => (
                                <form.Subscribe
                                    selector={(state) => {
                                        return {
                                            content: state.values.content,
                                            variables: state.values.variables,
                                        };
                                    }}
                                >
                                    {({ content, variables }) => {
                                        const syncedVariables = syncVariablesWithContent(content, variables);

                                        return (
                                            <field.FormItem required>
                                                <div className="flex items-center justify-between">
                                                    <field.FormLabel>{t`Content`}</field.FormLabel>
                                                    <VariableInsertion customVariables={syncedVariables} onInsert={handleInsertVariable} />
                                                </div>
                                                <field.FormControl>
                                                    <Textarea
                                                        autoComplete="off"
                                                        className="font-mono text-sm"
                                                        name="prompt-content"
                                                        onBlur={field.handleBlur}
                                                        onChange={(e) => field.handleChange(e.target.value)}
                                                        placeholder={t`Enter your prompt content here... Use ${VARIABLE_PLACEHOLDER} for dynamic content.`}
                                                        ref={textareaRef}
                                                        value={field.state.value}
                                                    />
                                                </field.FormControl>
                                                <field.FormDescription>
                                                    {t`Use ${VARIABLE_PLACEHOLDER} syntax to add dynamic content. Example: "Hello ${EXAMPLE_PLACEHOLDER}!"`}
                                                </field.FormDescription>
                                                <field.FormMessage />
                                            </field.FormItem>
                                        );
                                    }}
                                </form.Subscribe>
                            )}
                        </form.AppField>

                        <div className="space-y-4">
                            {/* Chat Settings Section */}
                            <div className="space-y-4 rounded-lg border p-4">
                                <div className="space-y-1">
                                    <Label>{t`Chat Settings (Optional)`}</Label>
                                    <p className="text-muted-foreground text-xs">
                                        {t`Configure model, reasoning effort, and features to preconfigure chat when using this prompt.`}
                                    </p>
                                </div>

                                <div className="space-y-4">
                                    <form.AppField name="model">
                                        {(field) => (
                                            <field.FormItem>
                                                <field.FormLabel>{t`Model`}</field.FormLabel>
                                                <field.FormControl>
                                                    <PromptModelSelector
                                                        errorMessage={field.state.meta.errors?.[0]}
                                                        onChange={field.handleChange}
                                                        showError={field.state.meta.errors && field.state.meta.errors.length > 0}
                                                        value={field.state.value}
                                                    />
                                                </field.FormControl>
                                                <field.FormMessage />
                                            </field.FormItem>
                                        )}
                                    </form.AppField>

                                    <form.Subscribe selector={(state) => state.values.model}>
                                        {(model) => {
                                            const selectedModel = models.find((m) => m.id === model);

                                            if (!selectedModel) {
                                                return null;
                                            }

                                            return (
                                                <>
                                                    <form.AppField name="reasoningEffort">
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

                                {/* Settings Preview */}
                                <form.Subscribe
                                    selector={(state) => {
                                        return {
                                            enabledFeatures: state.values.enabledFeatures,
                                            model: state.values.model,
                                            reasoningEffort: state.values.reasoningEffort,
                                        };
                                    }}
                                >
                                    {({ enabledFeatures, model, reasoningEffort }) => {
                                        const selectedModel = models.find((m) => m.id === model);

                                        if (!model && reasoningEffort === undefined && enabledFeatures.length === 0) {
                                            return null;
                                        }

                                        const effortMessage = reasoningEffort === undefined ? undefined : EFFORT_LABEL_MESSAGES[reasoningEffort];
                                        const effortLabel = effortMessage ? i18n._(effortMessage) : t`Custom`;

                                        return (
                                            <div className="bg-muted rounded-md p-3 text-sm">
                                                <p className="font-medium">{t`This prompt will configure:`}</p>
                                                <ul className="mt-1 list-disc space-y-1 pl-5">
                                                    {model && <li>{t`Model: ${selectedModel?.name || model}`}</li>}
                                                    {reasoningEffort !== undefined && <li>{t`Reasoning: ${effortLabel}`}</li>}
                                                    {enabledFeatures.length > 0 && <li>{t`Features: ${enabledFeatures.join(", ")}`}</li>}
                                                </ul>
                                            </div>
                                        );
                                    }}
                                </form.Subscribe>
                            </div>
                        </div>

                        {/* Variable definitions - collapsible */}
                        <form.Subscribe
                            selector={(state) => {
                                return {
                                    content: state.values.content,
                                    variables: state.values.variables,
                                };
                            }}
                        >
                            {({ content, variables }) => {
                                const syncedVariables = syncVariablesWithContent(content, variables);

                                if (syncedVariables.length === 0) {
                                    return null;
                                }

                                return (
                                    <Collapsible onOpenChange={setVariablesOpen} open={variablesOpen}>
                                        <CollapsibleTrigger
                                            render={
                                                <Button className="w-full justify-between" type="button" variant="outline">
                                                    <span>
                                                        {t`Configure Variables`} ({syncedVariables.length})
                                                    </span>
                                                    <ChevronDown className={`size-4 transition-transform ${variablesOpen ? "rotate-180" : ""}`} />
                                                </Button>
                                            }
                                        />
                                        <CollapsibleContent className="pt-3">
                                            <form.AppField name="variables">
                                                {(field) => <VariableDefinitions onChange={field.handleChange} variables={syncedVariables} />}
                                            </form.AppField>
                                        </CollapsibleContent>
                                    </Collapsible>
                                );
                            }}
                        </form.Subscribe>
                    </DialogPanel>
                    <DialogFooter>
                        <Button onClick={onClose} type="button" variant="outline">
                            {t`Cancel`}
                        </Button>
                        <form.Subscribe
                            selector={(state) => {
                                return {
                                    content: state.values.content,
                                    enabledFeatures: state.values.enabledFeatures,
                                    isSubmitting: state.isSubmitting,
                                    model: state.values.model,
                                    name: state.values.name,
                                    reasoningEffort: state.values.reasoningEffort,
                                };
                            }}
                        >
                            {({ content, enabledFeatures, isSubmitting, model, name, reasoningEffort }) => {
                                const validationResult = validatePromptSettings(model, reasoningEffort, enabledFeatures, models);
                                const submitLabel = editingPrompt ? t`Update Prompt` : t`Create Prompt`;

                                return (
                                    <Button disabled={isSubmitting || !name.trim() || !content.trim() || !validationResult.isValid} type="submit">
                                        {isSubmitting ? t`Saving...` : submitLabel}
                                    </Button>
                                );
                            }}
                        </form.Subscribe>
                    </DialogFooter>
                </DialogContent>
            </form>
        </form.AppForm>
    );
};

const PromptFormDialog = ({ editingPrompt, onClose, onSubmit, open }: PromptFormDialogProps) => (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
        <PromptFormDialogBody editingPrompt={editingPrompt} key={`${String(open)}|${editingPrompt?._id ?? "new"}`} onClose={onClose} onSubmit={onSubmit} />
    </Dialog>
);

export default PromptFormDialog;
