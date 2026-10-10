"use client";

/**
 * Participant bar for a group-chat thread, shown in the thread header: who is
 * in the room, how they take turns, and — for the owner — adding and removing
 * participants. While a turn is running it offers "Stop", which lets the
 * participant already speaking finish and skips everyone after it.
 *
 * Renders nothing for an ordinary thread.
 */
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@neore/ui/components/popover";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { SquareIcon, UsersIcon, XIcon } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import type { GroupChatMode, GroupModeOptions } from "./group-mode";
import { GROUP_CHAT_MODES, GROUP_MODE_COPY, groupModeOptionsFor, isGroupChatMode } from "./group-mode";
import GroupModeOptionsFields from "./group-mode-options";
import { SpeakerAvatar } from "./speaker-label";
import type { GroupChatData } from "./use-group-chat";
import { useGroupChat } from "./use-group-chat";

interface GroupParticipantBarProps {
    /** The thread is generating a reply right now — offers "Stop". */
    isRunning?: boolean;
    threadId: Id<"threads"> | undefined;
}

const MAX_PARTICIPANTS = 8;

/** `updateGroupChat` replaces the whole setup, so every change carries the options still valid for it. */
const groupUpdate = (group: GroupChatData, threadId: Id<"threads">, change: { mode?: GroupChatMode; options?: GroupModeOptions; skillIds?: string[] }) => {
    const mode = change.mode ?? group.mode;
    const skillIds = change.skillIds ?? group.participants.map((p) => p.skillId);
    const current: GroupModeOptions = {
        ...(group.debateRounds !== undefined && { debateRounds: group.debateRounds }),
        ...(group.synthesizerSkillId !== undefined && { synthesizerSkillId: group.synthesizerSkillId }),
    };

    return { ...groupModeOptionsFor(mode, skillIds, change.options ?? current), mode, skillIds, threadId };
};

const ManageParticipants: FC<{ group: GroupChatData; threadId: Id<"threads"> }> = ({ group, threadId }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const modeLabelId = useId();
    const participantsLabelId = useId();
    const [open, setOpen] = useState(false);
    const { data: candidates = [] } = useQuery(crpc.chat.group.functions.listGroupCandidates.queryOptions(open ? {} : skipToken));
    const { isPending, mutateAsync: updateGroupChat } = useMutation(crpc.chat.group.functions.updateGroupChat.mutationOptions());

    const current = group.participants.map((p) => p.skillId);
    const currentSet = new Set(current);
    // Participants no longer in the candidate list (made private, left the
    // organization) still show, so they can be removed.
    const rows = [...candidates, ...group.participants.filter((p) => candidates.every((c) => c.skillId !== p.skillId))];

    const save = async (change: { mode?: GroupChatMode; options?: GroupModeOptions; skillIds?: string[] }) => {
        try {
            await updateGroupChat(groupUpdate(group, threadId, change));
        } catch (error) {
            showError(error instanceof Error ? error : t`Could not update the participants`);
        }
    };

    const toggle = (skillId: string, checked: boolean) => {
        const next = checked ? [...current, skillId] : current.filter((id) => id !== skillId);

        if (next.length === 0) {
            return;
        }

        save({ skillIds: next });
    };

    return (
        <Popover onOpenChange={setOpen} open={open}>
            <PopoverTrigger
                render={
                    <Button aria-label={t`Manage participants`} className="h-7 gap-1 px-2 text-xs" size="sm" variant="ghost">
                        <UsersIcon aria-hidden="true" className="size-3.5" />
                        <span className="hidden sm:inline">{i18n._(GROUP_MODE_COPY[group.mode].label)}</span>
                    </Button>
                }
            />
            <PopoverContent align="start" className="w-80 p-3">
                <div className="flex flex-col gap-4">
                    <div aria-labelledby={modeLabelId} role="group">
                        <p className="mb-2 text-sm font-medium" id={modeLabelId}>
                            {t`Who answers`}
                        </p>
                        <RadioGroup
                            className="gap-2"
                            disabled={isPending}
                            onValueChange={(value) => {
                                if (isGroupChatMode(value) && value !== group.mode) {
                                    save({ mode: value });
                                }
                            }}
                            value={group.mode}
                        >
                            {GROUP_CHAT_MODES.map((mode) => (
                                // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI control, which renders the input
                                <label className="flex cursor-pointer items-start gap-2 text-sm" key={mode}>
                                    <RadioGroupItem className="mt-0.5" value={mode} />
                                    <span>
                                        <span className="block font-medium">{i18n._(GROUP_MODE_COPY[mode].label)}</span>
                                        <span className="text-muted-foreground block text-xs">{i18n._(GROUP_MODE_COPY[mode].description)}</span>
                                    </span>
                                </label>
                            ))}
                        </RadioGroup>
                    </div>

                    <GroupModeOptionsFields
                        disabled={isPending}
                        mode={group.mode}
                        onChange={(options) => save({ options })}
                        options={{
                            ...(group.debateRounds !== undefined && { debateRounds: group.debateRounds }),
                            ...(group.synthesizerSkillId !== undefined && { synthesizerSkillId: group.synthesizerSkillId }),
                        }}
                        participants={group.participants}
                    />

                    <div aria-labelledby={participantsLabelId} role="group">
                        <p className="mb-2 text-sm font-medium" id={participantsLabelId}>
                            {t`Participants`}
                        </p>
                        {rows.length === 0 ? (
                            <p className="text-muted-foreground text-xs">{t`Enable skills in Settings to add them as participants.`}</p>
                        ) : (
                            <ul className="flex max-h-60 flex-col gap-1.5 overflow-y-auto">
                                {rows.map((skill) => {
                                    const checked = currentSet.has(skill.skillId);
                                    // Keep at least one participant, and respect the cap.
                                    const disabled = isPending || (checked && current.length === 1) || (!checked && current.length >= MAX_PARTICIPANTS);

                                    return (
                                        <li key={skill.skillId}>
                                            {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI control, which renders the input */}
                                            <label className="flex cursor-pointer items-center gap-2 text-sm">
                                                <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => toggle(skill.skillId, value)} />
                                                <SpeakerAvatar name={skill.name} />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate font-medium">{skill.name}</span>
                                                    {skill.slug && <span className="text-muted-foreground block truncate text-xs">@{skill.slug}</span>}
                                                </span>
                                            </label>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
};

const GroupParticipantBar: FC<GroupParticipantBarProps> = ({ isRunning = false, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const group = useGroupChat(threadId);
    const { isPending: isRemoving, mutateAsync: updateGroupChat } = useMutation(crpc.chat.group.functions.updateGroupChat.mutationOptions());
    const { isPending: isStopping, mutateAsync: stopGroupTurn } = useMutation(crpc.chat.group.functions.stopGroupTurn.mutationOptions());

    if (!group || !threadId) {
        return null;
    }

    const remove = async (skillId: string) => {
        try {
            await updateGroupChat(groupUpdate(group, threadId, { skillIds: group.participants.map((p) => p.skillId).filter((id) => id !== skillId) }));
        } catch (error) {
            showError(error instanceof Error ? error : t`Could not remove the participant`);
        }
    };

    const stop = async () => {
        try {
            await stopGroupTurn({ threadId });
        } catch (error) {
            showError(error instanceof Error ? error : t`Could not stop the conversation`);
        }
    };

    return (
        <div aria-label={t`Group chat participants`} className="flex min-w-0 items-center gap-1.5" role="group">
            <ul className="flex min-w-0 items-center gap-1 overflow-x-auto">
                {group.participants.map((participant) => (
                    <li key={participant.skillId}>
                        <Badge className={participant.available ? "gap-1 pr-1" : "gap-1 pr-1 opacity-50"} variant="secondary">
                            <SpeakerAvatar className="size-4" name={participant.name} />
                            <span className="max-w-28 truncate">{participant.name}</span>
                            {!participant.available && <span className="sr-only">{t`(unavailable)`}</span>}
                            {group.canEdit && group.participants.length > 1 && (
                                <button
                                    aria-label={t`Remove ${participant.name}`}
                                    className="hover:bg-muted rounded-sm p-0.5 disabled:opacity-50"
                                    disabled={isRemoving}
                                    onClick={() => remove(participant.skillId)}
                                    type="button"
                                >
                                    <XIcon aria-hidden="true" className="size-3" />
                                </button>
                            )}
                        </Badge>
                    </li>
                ))}
            </ul>
            {group.canEdit && <ManageParticipants group={group} threadId={threadId} />}
            {isRunning && (
                <Button
                    aria-label={t`Stop after the current speaker`}
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={isStopping}
                    onClick={() => stop()}
                    size="sm"
                    variant="outline"
                >
                    <SquareIcon aria-hidden="true" className="size-3" />
                    <span className="hidden sm:inline">{t`Stop`}</span>
                </Button>
            )}
        </div>
    );
};

export default GroupParticipantBar;
