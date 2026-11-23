"use client";

import cn from "@neore/ui/utils/cn";
import type { FC } from "react";

import { BotAvatar } from "@/features/chat/components/bot-avatar";
import type { UIMessage } from "@/lib/agent";

// Shared with the browser extension, which renders the same labels.
export { SpeakerAvatar, SpeakerChip } from "@neore/chat-ui/chat/speaker-chip";

/**
 * The group-chat participant that wrote `message`, if any. An in-app message
 * carries `speakerSkillId` + `agentName`; the redacted public projection carries
 * only `speakerName`. A plain reply's `agentName` is the model id, not a speaker.
 */
export const getMessageSpeakerName = (message: UIMessage): string | undefined => {
    const { speakerName } = message as UIMessage & { speakerName?: string };

    if (speakerName) {
        return speakerName;
    }

    return message.speakerSkillId && message.agentName ? message.agentName : undefined;
};

/** A bot speaker's name chip: its avatar beside the name, which stays real text for screen readers. */
const BotSpeakerChip: FC<{ className?: string; name: string }> = ({ className, name }) => (
    <span className={cn("text-foreground inline-flex items-center gap-1.5 text-sm font-medium dark:text-white", className)}>
        <BotAvatar size={24} />
        <span className="truncate">{name}</span>
    </span>
);

/** Speaker label above a group-chat reply; renders nothing for any other message. */
export const MessageSpeakerLabel: FC<{ message: UIMessage }> = ({ message }) => {
    const name = getMessageSpeakerName(message);

    return name ? <BotSpeakerChip className="mb-1" name={name} /> : null;
};
