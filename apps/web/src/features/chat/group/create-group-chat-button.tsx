"use client";

/**
 * "New group chat": start from a seeded template, or pick two or more of your
 * enabled skills as participants and how they take turns, then land in the new
 * thread.
 */
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import type { FC, FormEvent } from "react";
import { useId, useState } from "react";

import useCurrentModel from "@/features/chat/core/hooks/use-current-model";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import type { GroupChatMode, GroupModeOptions } from "./group-mode";
import { GROUP_CHAT_MODES, GROUP_MODE_COPY, GROUP_TEMPLATES, groupModeOptionsFor, isGroupChatMode } from "./group-mode";
import GroupModeOptionsFields from "./group-mode-options";
import { SpeakerAvatar } from "./speaker-label";

const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 8;

const CreateGroupChatButton: FC<{ className?: string }> = ({ className }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const navigate = useNavigate();
    const model = useCurrentModel();
    const titleId = useId();
    const modeLabelId = useId();
    const participantsLabelId = useId();
    const templatesLabelId = useId();
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [mode, setMode] = useState<GroupChatMode>("supervisor");
    const [selected, setSelected] = useState<string[]>([]);
    const [modeOptions, setModeOptions] = useState<GroupModeOptions>({});

    const { data: candidates, isPending: isLoading } = useQuery(crpc.chat.group.functions.listGroupCandidates.queryOptions(open ? {} : skipToken));
    const { isPending: isCreating, mutateAsync: createGroupChat } = useMutation(crpc.chat.group.functions.createGroupChat.mutationOptions());
    const {
        isPending: isCreatingFromTemplate,
        mutateAsync: createFromTemplate,
        variables: templateVariables,
    } = useMutation(crpc.chat.group.functions.createGroupChatFromTemplate.mutationOptions());

    const isPending = isCreating || isCreatingFromTemplate;
    const canCreate = selected.length >= MIN_PARTICIPANTS && !isPending;
    const selectedParticipants = (candidates ?? []).filter((skill) => selected.includes(skill.skillId));

    const toggleSkill = (skillId: string, checked: boolean) => {
        setSelected((previous) => (checked ? [...previous, skillId] : previous.filter((id) => id !== skillId)));
    };

    const reset = () => {
        setTitle("");
        setMode("supervisor");
        setSelected([]);
        setModeOptions({});
    };

    const openThread = async (threadId: string) => {
        setOpen(false);
        reset();
        await navigate({ params: { threadId }, to: "/chat/$threadId" });
    };

    const startFromTemplate = async (template: (typeof GROUP_TEMPLATES)[number]) => {
        try {
            const { threadId } = await createFromTemplate({ model, templateId: template.id, title: title.trim() || i18n._(template.title) });

            await openThread(threadId);
        } catch (error) {
            showError(error instanceof Error ? error : t`Could not create the group chat`);
        }
    };

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();

        if (!canCreate) {
            return;
        }

        try {
            const { threadId } = await createGroupChat({
                ...groupModeOptionsFor(mode, selected, modeOptions),
                mode,
                model,
                skillIds: selected,
                ...(title.trim() && { title: title.trim() }),
            });

            await openThread(threadId);
        } catch (error) {
            showError(error instanceof Error ? error : t`Could not create the group chat`);
        }
    };

    return (
        <>
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button aria-label={t`New group chat`} className={className} onClick={() => setOpen(true)} size="sm" variant="ghost">
                                <UsersIcon aria-hidden="true" className="h-5 w-5" />
                            </Button>
                        }
                    />
                    <TooltipContent>{t`New group chat`}</TooltipContent>
                </Tooltip>
            </TooltipProvider>

            <Dialog onOpenChange={setOpen} open={open}>
                <DialogContent className="sm:max-w-lg">
                    {/* A flex column, so the panel scrolls and the footer stays on a short screen. */}
                    <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
                        <DialogHeader>
                            <DialogTitle>{t`New group chat`}</DialogTitle>
                            <DialogDescription>{t`Several of your skills answer in one conversation. Mention one with @ to hear from it directly.`}</DialogDescription>
                        </DialogHeader>
                        <DialogPanel className="flex flex-col gap-5">
                            <div aria-labelledby={templatesLabelId} role="group">
                                <p className="mb-2 text-sm font-medium" id={templatesLabelId}>
                                    {t`Start from a template`}
                                </p>
                                <ul className="flex flex-col gap-2">
                                    {GROUP_TEMPLATES.map((template) => {
                                        const isStarting = isCreatingFromTemplate && templateVariables?.templateId === template.id;

                                        return (
                                            <li key={template.id}>
                                                <button
                                                    aria-busy={isStarting}
                                                    className="hover:bg-muted focus-visible:ring-ring flex w-full flex-col items-start rounded-md border p-2.5 text-left text-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                                                    disabled={isPending}
                                                    onClick={() => startFromTemplate(template)}
                                                    type="button"
                                                >
                                                    <span className="font-medium">{isStarting ? t`Creating…` : i18n._(template.title)}</span>
                                                    <span className="text-muted-foreground text-xs">{i18n._(template.description)}</span>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                                <p className="text-muted-foreground mt-1.5 text-xs">{t`A template adds its participants to your skills, where you can edit them.`}</p>
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium" htmlFor={titleId}>
                                    {t`Title (optional)`}
                                </label>
                                <Input
                                    id={titleId}
                                    maxLength={200}
                                    onChange={(event) => setTitle(event.target.value)}
                                    placeholder={t`Group chat`}
                                    value={title}
                                />
                            </div>

                            <div aria-labelledby={participantsLabelId} role="group">
                                <p className="mb-2 text-sm font-medium" id={participantsLabelId}>
                                    {t`Participants`}{" "}
                                    <span className="text-muted-foreground font-normal">
                                        {t`(${selected.length} of ${MAX_PARTICIPANTS}, at least ${MIN_PARTICIPANTS})`}
                                    </span>
                                </p>
                                {isLoading && <p className="text-muted-foreground text-sm">{t`Loading skills…`}</p>}
                                {!isLoading && (candidates ?? []).length < MIN_PARTICIPANTS && (
                                    <p className="text-muted-foreground text-sm">{t`Enable at least two skills in Settings → Skills to start a group chat.`}</p>
                                )}
                                <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                                    {(candidates ?? []).map((skill) => {
                                        const checked = selected.includes(skill.skillId);

                                        return (
                                            <li key={skill.skillId}>
                                                {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI control, which renders the input */}
                                                <label className="flex cursor-pointer items-start gap-2 text-sm">
                                                    <Checkbox
                                                        checked={checked}
                                                        className="mt-1"
                                                        disabled={!checked && selected.length >= MAX_PARTICIPANTS}
                                                        onCheckedChange={(value) => toggleSkill(skill.skillId, value)}
                                                    />
                                                    <SpeakerAvatar name={skill.name} />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block font-medium">{skill.name}</span>
                                                        <span className="text-muted-foreground line-clamp-2 block text-xs">{skill.description}</span>
                                                    </span>
                                                </label>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>

                            <div aria-labelledby={modeLabelId} role="group">
                                <p className="mb-2 text-sm font-medium" id={modeLabelId}>
                                    {t`Who answers`}
                                </p>
                                <RadioGroup
                                    className="gap-2"
                                    onValueChange={(value) => {
                                        if (isGroupChatMode(value)) {
                                            setMode(value);
                                        }
                                    }}
                                    value={mode}
                                >
                                    {GROUP_CHAT_MODES.map((option) => (
                                        // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI control, which renders the input
                                        <label className="flex cursor-pointer items-start gap-2 text-sm" key={option}>
                                            <RadioGroupItem className="mt-0.5" value={option} />
                                            <span>
                                                <span className="block font-medium">{i18n._(GROUP_MODE_COPY[option].label)}</span>
                                                <span className="text-muted-foreground block text-xs">{i18n._(GROUP_MODE_COPY[option].description)}</span>
                                            </span>
                                        </label>
                                    ))}
                                </RadioGroup>
                            </div>

                            <GroupModeOptionsFields mode={mode} onChange={setModeOptions} options={modeOptions} participants={selectedParticipants} />
                        </DialogPanel>
                        <DialogFooter>
                            <Button onClick={() => setOpen(false)} type="button" variant="ghost">
                                {t`Cancel`}
                            </Button>
                            <Button disabled={!canCreate} type="submit">
                                {isPending ? t`Creating…` : t`Create group chat`}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
};

export default CreateGroupChatButton;
