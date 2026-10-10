"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@neore/ui/components/collapsible";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Textarea } from "@neore/ui/components/textarea";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import PromptModelSelector from "@/features/prompts/components/prompt-model-selector";
import VariableDefinitions from "@/features/prompts/components/variable-definitions";
import { syncVariablesWithContent } from "@/features/prompts/lib/prompt-variables";
import { useCRPC } from "@/lib/lunora/crpc";

import type { EditableSkill, SkillFormMessageKey, SkillFormValues, SkillVisibility } from "../lib/skill-form";
import {
    getSkillFormDefaults,
    SKILL_CATEGORIES,
    SKILL_DESCRIPTION_MAX,
    SKILL_NAME_MAX,
    SKILL_SLUG_MAX,
    SKILL_VOICE_MAX,
    slugifySkillName,
    validateSkillForm,
} from "../lib/skill-form";
import type { SkillDraft } from "./skill-generate-panel";
import SkillGeneratePanel from "./skill-generate-panel";
import SkillToolPicker from "./skill-tool-picker";
import SkillVoiceOptions from "./skill-voice-options";

// Kept out of the message so lingui does not read the braces as ICU syntax.
const VARIABLE_PLACEHOLDER = "{{variableName}}";

const NO_CATEGORY = "__none__";

interface SkillFormDialogProps {
    /** Whether the user acts inside an organization; gates the "organization" visibility option. */
    canShareWithOrganization: boolean;
    editingSkill?: EditableSkill | null;
    /** Only the owner may change visibility (the backend enforces this too). */
    isOwner?: boolean;
    onClose: () => void;
    onSubmit: (values: SkillFormValues) => Promise<void>;
    open: boolean;
}

type SkillFormDialogBodyProps = Omit<SkillFormDialogProps, "open">;

const useMessages = () => {
    const { t } = useLingui();

    return (key: SkillFormMessageKey | undefined): string | undefined => {
        switch (key) {
            case "descriptionRequired": {
                return t`Description is required`;
            }
            case "descriptionTooLong": {
                return t`Description must be ${SKILL_DESCRIPTION_MAX} characters or less`;
            }
            case "instructionsRequired": {
                return t`Instructions are required`;
            }
            case "instructionsTooLong": {
                return t`Instructions are too long`;
            }
            case "nameRequired": {
                return t`Name is required`;
            }
            case "nameTooLong": {
                return t`Name must be ${SKILL_NAME_MAX} characters or less`;
            }
            case "slugFormat": {
                return t`Use lowercase letters, numbers and single hyphens only`;
            }
            case "slugRequired": {
                return t`Command is required`;
            }
            case "slugReserved": {
                return t`This command name is reserved`;
            }
            case "slugTooLong": {
                return t`Command must be ${SKILL_SLUG_MAX} characters or less`;
            }
            case "toolConflict": {
                return t`A tool cannot be both added and disabled`;
            }
            case "voiceTooLong": {
                return t`Voice must be ${SKILL_VOICE_MAX} characters or less`;
            }
            default: {
                return undefined;
            }
        }
    };
};

const SkillFormDialogBody = ({ canShareWithOrganization, editingSkill, isOwner = true, onClose, onSubmit }: SkillFormDialogBodyProps) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const messageFor = useMessages();
    const visibilityLabelId = useId();
    const modelLabelId = useId();
    const voiceOptionsId = useId();
    const [toolsOpen, setToolsOpen] = useState(() => !!(editingSkill?.config?.additionalTools?.length || editingSkill?.config?.disabledTools?.length));
    // The command is derived from the name until the user edits it themselves.
    const [slugTouched, setSlugTouched] = useState(!!editingSkill);

    const { data: tools = [] } = useQuery(crpc.skills.functions.getAvailableSkillTools.queryOptions({}));

    const categoryLabels: Record<(typeof SKILL_CATEGORIES)[number], string> = {
        automation: t`Automation`,
        coding: t`Coding`,
        communication: t`Communication`,
        data: t`Data`,
        research: t`Research`,
    };

    const form = useAppForm({
        defaultValues: getSkillFormDefaults(editingSkill),
        onSubmit: async ({ value }) => {
            try {
                await onSubmit({ ...value, variables: syncVariablesWithContent(value.instructions, value.variables) });
                onClose();
            } catch (error) {
                toast.error(error instanceof Error && error.message ? error.message : t`Failed to save skill`);
            }
        },
        validators: {
            onChange: ({ value }) => {
                const errors = validateSkillForm(value);
                const mapped = Object.fromEntries(Object.entries(errors).map(([field, key]) => [field, [messageFor(key)]]));

                return Object.keys(mapped).length > 0 ? mapped : undefined;
            },
            onSubmit: ({ value }) => {
                const errors = validateSkillForm(value);
                const mapped = Object.fromEntries(Object.entries(errors).map(([field, key]) => [field, [messageFor(key)]]));

                return Object.keys(mapped).length > 0 ? mapped : undefined;
            },
        },
    });

    const submitLabel = editingSkill ? t`Save changes` : t`Create skill`;

    const applyDraft = (draft: SkillDraft) => {
        form.setFieldValue("name", draft.name);
        form.setFieldValue("slug", draft.slug);
        form.setFieldValue("description", draft.description);
        form.setFieldValue("instructions", draft.instructions);
        form.setFieldValue("category", draft.category ?? "");
        form.setFieldValue("tags", draft.tags.join(", "));
        form.setFieldValue("variables", draft.variables);
        form.setFieldValue("additionalTools", draft.additionalTools);
        setSlugTouched(true);

        if (draft.additionalTools.length > 0) {
            setToolsOpen(true);
        }
    };

    return (
        <form.AppForm>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{editingSkill ? t`Edit skill` : t`Create skill`}</DialogTitle>
                    <DialogDescription>
                        {editingSkill
                            ? t`Update the instructions and settings for this skill.`
                            : t`A skill is a reusable set of instructions you can run with a slash command.`}
                    </DialogDescription>
                </DialogHeader>
                {/* The form sits INSIDE the portalled popup: a <form> wrapping
                    DialogContent is not the submit button's DOM ancestor. */}
                <form
                    autoComplete="off"
                    className="contents"
                    noValidate
                    onSubmit={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void form.handleSubmit();
                    }}
                >
                    <DialogPanel className="max-h-[65vh] min-h-0 flex-1 overflow-y-auto">
                        <div className="space-y-5">
                            {!editingSkill && <SkillGeneratePanel onDraft={applyDraft} />}

                            <div className="grid gap-4 sm:grid-cols-2">
                                <form.AppField name="name">
                                    {(field) => (
                                        <field.FormItem required>
                                            <field.FormLabel>{t`Name`}</field.FormLabel>
                                            <field.FormControl>
                                                <Input
                                                    maxLength={SKILL_NAME_MAX}
                                                    onBlur={field.handleBlur}
                                                    onChange={(event) => {
                                                        field.handleChange(event.target.value);

                                                        if (!slugTouched) {
                                                            form.setFieldValue("slug", slugifySkillName(event.target.value));
                                                        }
                                                    }}
                                                    placeholder={t`e.g. Code reviewer`}
                                                    value={field.state.value}
                                                />
                                            </field.FormControl>
                                            <field.FormMessage />
                                        </field.FormItem>
                                    )}
                                </form.AppField>

                                <form.AppField name="slug">
                                    {(field) => (
                                        <field.FormItem required>
                                            <field.FormLabel>{t`Command`}</field.FormLabel>
                                            <div className="flex items-center gap-1">
                                                <span aria-hidden="true" className="text-muted-foreground font-mono text-sm">
                                                    /
                                                </span>
                                                <field.FormControl>
                                                    <Input
                                                        className="font-mono"
                                                        maxLength={SKILL_SLUG_MAX}
                                                        onBlur={field.handleBlur}
                                                        onChange={(event) => {
                                                            setSlugTouched(true);
                                                            field.handleChange(event.target.value.toLowerCase());
                                                        }}
                                                        placeholder="code-reviewer"
                                                        spellCheck={false}
                                                        value={field.state.value}
                                                    />
                                                </field.FormControl>
                                            </div>
                                            <field.FormDescription>{t`Run the skill by typing /command in chat.`}</field.FormDescription>
                                            <field.FormMessage />
                                        </field.FormItem>
                                    )}
                                </form.AppField>
                            </div>

                            <form.AppField name="description">
                                {(field) => (
                                    <field.FormItem required>
                                        <field.FormLabel>{t`Description`}</field.FormLabel>
                                        <field.FormControl>
                                            <Input
                                                maxLength={SKILL_DESCRIPTION_MAX}
                                                onBlur={field.handleBlur}
                                                onChange={(event) => field.handleChange(event.target.value)}
                                                placeholder={t`When should the assistant use this skill?`}
                                                value={field.state.value}
                                            />
                                        </field.FormControl>
                                        <field.FormDescription>{t`Shown to the assistant so it knows when the skill applies.`}</field.FormDescription>
                                        <field.FormMessage />
                                    </field.FormItem>
                                )}
                            </form.AppField>

                            <form.AppField name="instructions">
                                {(field) => (
                                    <field.FormItem required>
                                        <field.FormLabel>{t`Instructions`}</field.FormLabel>
                                        <field.FormControl>
                                            <Textarea
                                                className="min-h-40 font-mono text-sm"
                                                onBlur={field.handleBlur}
                                                onChange={(event) => field.handleChange(event.target.value)}
                                                placeholder={t`Tell the assistant exactly what to do. Use ${VARIABLE_PLACEHOLDER} for inputs.`}
                                                value={field.state.value}
                                            />
                                        </field.FormControl>
                                        <field.FormDescription>{t`Use ${VARIABLE_PLACEHOLDER} for values supplied when the skill runs.`}</field.FormDescription>
                                        <field.FormMessage />
                                    </field.FormItem>
                                )}
                            </form.AppField>

                            <form.Subscribe
                                selector={(state) => {
                                    return { instructions: state.values.instructions, variables: state.values.variables };
                                }}
                            >
                                {({ instructions, variables }) => {
                                    const synced = syncVariablesWithContent(instructions, variables);

                                    if (synced.length === 0) {
                                        return null;
                                    }

                                    return (
                                        <div className="space-y-2">
                                            <p className="text-sm font-medium">{t`Variables (${synced.length})`}</p>
                                            <form.AppField name="variables">
                                                {(field) => <VariableDefinitions onChange={field.handleChange} variables={synced} />}
                                            </form.AppField>
                                        </div>
                                    );
                                }}
                            </form.Subscribe>

                            <div className="grid gap-4 sm:grid-cols-2">
                                <form.AppField name="category">
                                    {(field) => (
                                        <field.FormItem>
                                            <field.FormLabel>{t`Category`}</field.FormLabel>
                                            <Select
                                                items={[
                                                    { label: t`None`, value: NO_CATEGORY },
                                                    ...SKILL_CATEGORIES.map((category) => {
                                                        return { label: categoryLabels[category], value: category };
                                                    }),
                                                ]}
                                                onValueChange={(value) => field.handleChange(value === NO_CATEGORY || !value ? "" : String(value))}
                                                value={field.state.value || NO_CATEGORY}
                                            >
                                                <field.FormControl>
                                                    <SelectTrigger>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                </field.FormControl>
                                                <SelectContent>
                                                    <SelectItem value={NO_CATEGORY}>{t`None`}</SelectItem>
                                                    {SKILL_CATEGORIES.map((category) => (
                                                        <SelectItem key={category} value={category}>
                                                            {categoryLabels[category]}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </field.FormItem>
                                    )}
                                </form.AppField>

                                <form.AppField name="tags">
                                    {(field) => (
                                        <field.FormItem>
                                            <field.FormLabel>{t`Tags`}</field.FormLabel>
                                            <field.FormControl>
                                                <Input
                                                    onBlur={field.handleBlur}
                                                    onChange={(event) => field.handleChange(event.target.value)}
                                                    placeholder={t`review, security`}
                                                    value={field.state.value}
                                                />
                                            </field.FormControl>
                                            <field.FormDescription>{t`Separate tags with commas.`}</field.FormDescription>
                                        </field.FormItem>
                                    )}
                                </form.AppField>
                            </div>

                            <form.AppField name="preferredModel">
                                {(field) => (
                                    <div aria-labelledby={modelLabelId} className="space-y-2" role="group">
                                        <Label id={modelLabelId}>{t`Preferred model`}</Label>
                                        <PromptModelSelector onChange={field.handleChange} value={field.state.value} />
                                        <div className="flex items-center justify-between gap-2">
                                            <p className="text-muted-foreground text-xs">{t`Optional. Used when the skill runs.`}</p>
                                            {field.state.value && (
                                                <Button onClick={() => field.handleChange(undefined)} size="sm" type="button" variant="ghost">
                                                    {t`Clear model`}
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </form.AppField>

                            <form.AppField name="voice">
                                {(field) => (
                                    <field.FormItem>
                                        <field.FormLabel>{t`Voice`}</field.FormLabel>
                                        <field.FormControl>
                                            <Input
                                                list={voiceOptionsId}
                                                maxLength={SKILL_VOICE_MAX}
                                                onBlur={field.handleBlur}
                                                onChange={(event) => field.handleChange(event.target.value)}
                                                placeholder={t`Default voice`}
                                                value={field.state.value}
                                            />
                                        </field.FormControl>
                                        <SkillVoiceOptions id={voiceOptionsId} />
                                        <field.FormDescription>
                                            {t`Optional. The voice this skill's replies are read aloud in — a voice name from the list, or a language code such as de-DE.`}
                                        </field.FormDescription>
                                        <field.FormMessage />
                                    </field.FormItem>
                                )}
                            </form.AppField>

                            <Collapsible onOpenChange={setToolsOpen} open={toolsOpen}>
                                <CollapsibleTrigger
                                    render={
                                        <Button className="w-full justify-between" type="button" variant="outline">
                                            <span>{t`Tools`}</span>
                                            <ChevronDown aria-hidden="true" className={`size-4 transition-transform ${toolsOpen ? "rotate-180" : ""}`} />
                                        </Button>
                                    }
                                />
                                <CollapsibleContent className="space-y-6 pt-4">
                                    <form.Subscribe
                                        selector={(state) => {
                                            return {
                                                additionalTools: state.values.additionalTools,
                                                disabledTools: state.values.disabledTools,
                                            };
                                        }}
                                    >
                                        {({ additionalTools, disabledTools }) => (
                                            <>
                                                <form.AppField name="additionalTools">
                                                    {(field) => (
                                                        <SkillToolPicker
                                                            conflicting={disabledTools}
                                                            description={t`Tools the skill needs even when the current chat mode would not load them.`}
                                                            legend={t`Extra tools`}
                                                            onChange={field.handleChange}
                                                            tools={tools}
                                                            value={field.state.value}
                                                        />
                                                    )}
                                                </form.AppField>
                                                <form.AppField name="disabledTools">
                                                    {(field) => (
                                                        <SkillToolPicker
                                                            conflicting={additionalTools}
                                                            description={t`Tools the assistant must not use while this skill runs.`}
                                                            errorMessage={field.state.meta.errors[0] ? String(field.state.meta.errors[0]) : undefined}
                                                            legend={t`Disabled tools`}
                                                            onChange={field.handleChange}
                                                            tools={tools}
                                                            value={field.state.value}
                                                        />
                                                    )}
                                                </form.AppField>
                                            </>
                                        )}
                                    </form.Subscribe>
                                </CollapsibleContent>
                            </Collapsible>

                            <form.AppField name="visibility">
                                {(field) => (
                                    <div aria-labelledby={visibilityLabelId} className="space-y-2" role="group">
                                        <p className="text-sm font-medium" id={visibilityLabelId}>
                                            {t`Visibility`}
                                        </p>
                                        {!isOwner && <p className="text-muted-foreground text-xs">{t`Only the owner can change who sees this skill.`}</p>}
                                        <RadioGroup
                                            aria-labelledby={visibilityLabelId}
                                            disabled={!isOwner}
                                            onValueChange={(value) => field.handleChange(value as SkillVisibility)}
                                            value={field.state.value}
                                        >
                                            {(
                                                [
                                                    { description: t`Only you can see and use it.`, label: t`Private`, value: "private" },
                                                    {
                                                        description: canShareWithOrganization
                                                            ? t`Members of your active organization can use it.`
                                                            : t`Switch to an organization to share with it.`,
                                                        disabled: !canShareWithOrganization && field.state.value !== "organization",
                                                        label: t`Organization`,
                                                        value: "organization",
                                                    },
                                                    {
                                                        description: t`Listed in the marketplace; anyone can install or fork it.`,
                                                        label: t`Public`,
                                                        value: "public",
                                                    },
                                                ] satisfies { description: string; disabled?: boolean; label: string; value: SkillVisibility }[]
                                            ).map((option) => (
                                                // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI radio, which renders the control
                                                <label
                                                    className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[[data-disabled]]:opacity-60"
                                                    key={option.value}
                                                >
                                                    <RadioGroupItem disabled={option.disabled} value={option.value} />
                                                    <span className="grid gap-0.5">
                                                        <span className="text-sm font-medium">{option.label}</span>
                                                        <span className="text-muted-foreground text-xs">{option.description}</span>
                                                    </span>
                                                </label>
                                            ))}
                                        </RadioGroup>
                                    </div>
                                )}
                            </form.AppField>
                        </div>
                    </DialogPanel>
                    <DialogFooter>
                        <Button onClick={onClose} type="button" variant="outline">
                            {t`Cancel`}
                        </Button>
                        <form.Subscribe
                            selector={(state) => {
                                return { canSubmit: state.canSubmit, isSubmitting: state.isSubmitting };
                            }}
                        >
                            {({ canSubmit, isSubmitting }) => (
                                <Button aria-busy={isSubmitting} disabled={isSubmitting || !canSubmit} type="submit">
                                    {isSubmitting ? t`Saving…` : submitLabel}
                                </Button>
                            )}
                        </form.Subscribe>
                    </DialogFooter>
                </form>
            </DialogContent>
        </form.AppForm>
    );
};

const SkillFormDialog = ({ open, ...props }: SkillFormDialogProps) => (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && props.onClose()} open={open}>
        {open && <SkillFormDialogBody key={props.editingSkill ? props.editingSkill.slug : "new"} {...props} />}
    </Dialog>
);

export default SkillFormDialog;
