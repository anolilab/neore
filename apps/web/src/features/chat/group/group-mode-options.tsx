"use client";

/**
 * The options of the structured modes, shown under the mode picker: who
 * synthesizes (`parallel`, `debate`) and how many rounds a debate runs.
 */
import { useLingui } from "@lingui/react/macro";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import type { FC } from "react";
import { useId } from "react";

import type { GroupChatMode, GroupModeOptions } from "./group-mode";
import { DEBATE_ROUND_OPTIONS, DEFAULT_DEBATE_ROUNDS, isStructuredMode } from "./group-mode";

/** The Select's value for "no synthesizer" — a skill id is never empty. */
const NONE = "";

interface GroupModeOptionsFieldsProps {
    disabled?: boolean;
    mode: GroupChatMode;
    onChange: (options: GroupModeOptions) => void;
    options: GroupModeOptions;
    participants: ReadonlyArray<{ name: string; skillId: string }>;
}

const GroupModeOptionsFields: FC<GroupModeOptionsFieldsProps> = ({ disabled = false, mode, onChange, options, participants }) => {
    const { t } = useLingui();
    const synthesizerId = useId();
    const roundsId = useId();

    if (!isStructuredMode(mode)) {
        return null;
    }

    const synthesizer = participants.some((p) => p.skillId === options.synthesizerSkillId) ? options.synthesizerSkillId : undefined;
    const rounds = options.debateRounds ?? DEFAULT_DEBATE_ROUNDS;
    const nameOf = (skillId: string | null): string => participants.find((p) => p.skillId === skillId)?.name ?? "";
    const noSynthesizerLabel = mode === "debate" ? t`Automatic` : t`None — show the answers only`;

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor={synthesizerId}>
                    {mode === "debate" ? t`Synthesizer (weighs both sides)` : t`Synthesizer (merges the answers)`}
                </label>
                <Select
                    disabled={disabled}
                    onValueChange={(value) => onChange({ ...options, synthesizerSkillId: value || undefined })}
                    value={synthesizer ?? NONE}
                >
                    <SelectTrigger id={synthesizerId}>
                        <SelectValue>{(value: string | null) => (value ? nameOf(value) : noSynthesizerLabel)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={NONE}>{noSynthesizerLabel}</SelectItem>
                        {participants.map((participant) => (
                            <SelectItem key={participant.skillId} value={participant.skillId}>
                                {participant.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {mode === "debate" && (
                    <p className="text-muted-foreground text-xs">{t`The first two other participants debate, for and against, in list order.`}</p>
                )}
            </div>

            {mode === "debate" && (
                <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor={roundsId}>
                        {t`Debate rounds`}
                    </label>
                    <Select
                        disabled={disabled}
                        onValueChange={(value) => {
                            if (value) {
                                onChange({ ...options, debateRounds: Number(value) });
                            }
                        }}
                        value={String(rounds)}
                    >
                        <SelectTrigger id={roundsId}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {DEBATE_ROUND_OPTIONS.map((option) => (
                                <SelectItem key={option} value={String(option)}>
                                    {String(option)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}
        </div>
    );
};

export default GroupModeOptionsFields;
