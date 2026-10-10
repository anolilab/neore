"use client";

import { SpeakerChip } from "@neore/chat-ui/chat/speaker-chip";
import type { FC } from "react";

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

/** Speaker label above a group-chat reply; renders nothing for any other message. */
export const MessageSpeakerLabel: FC<{ message: UIMessage }> = ({ message }) => {
    const name = getMessageSpeakerName(message);

    return name ? <SpeakerChip className="mb-1" name={name} /> : null;
};
