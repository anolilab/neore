import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ArgsOf } from "@lunora/react";
import type { api } from "@neore/backend/api";

/**
 * The backend's `vGroupChatMode`, read off the procedure that accepts it.
 * `GROUP_MODE_COPY` is a full record over it, so a mode added on the backend
 * fails to typecheck here until it has copy.
 */
export type GroupChatMode = ArgsOf<typeof api.chat.group.functions.updateGroupChat>["mode"];

/** Display order. */
export const GROUP_CHAT_MODES: ReadonlyArray<GroupChatMode> = ["supervisor", "round-robin", "mention-only", "parallel", "debate"];

/** Modes with a synthesizer (and, for `debate`, rounds) — mirrors the backend's `isStructuredMode`. */
export const isStructuredMode = (mode: GroupChatMode): mode is "debate" | "parallel" => mode === "parallel" || mode === "debate";

/** The backend clamps to these (`chat/group/logic.ts`). */
export const DEBATE_ROUND_OPTIONS = [1, 2, 3] as const;
export const DEFAULT_DEBATE_ROUNDS = 2;

/** A group's mode options, as `createGroupChat` / `updateGroupChat` take them. */
export interface GroupModeOptions {
    debateRounds?: number;
    synthesizerSkillId?: string;
}

/**
 * The options to send with `mode` for these participants: only what the mode
 * reads, and a synthesizer only while it is still a participant — the backend
 * refuses one that is not.
 */
export const groupModeOptionsFor = (mode: GroupChatMode, skillIds: ReadonlyArray<string>, options: GroupModeOptions): GroupModeOptions => {
    if (!isStructuredMode(mode)) {
        return {};
    }

    return {
        ...(mode === "debate" && { debateRounds: options.debateRounds ?? DEFAULT_DEBATE_ROUNDS }),
        ...(options.synthesizerSkillId && skillIds.includes(options.synthesizerSkillId) && { synthesizerSkillId: options.synthesizerSkillId }),
    };
};

/** Seeded templates; the personas live on the backend (`chat/group/templates.ts`), keyed by `id`. */
export const GROUP_TEMPLATES: ReadonlyArray<{ description: MessageDescriptor; id: string; title: MessageDescriptor }> = [
    {
        description: msg`Security, performance and maintainability reviewers answer side by side; the review lead merges their findings.`,
        id: "code-review-panel",
        title: msg`Code review panel`,
    },
    {
        description: msg`An advocate and a skeptic argue for and against over two rounds; a moderator weighs both sides.`,
        id: "pros-cons-debate",
        title: msg`Pros & cons debate`,
    },
];

/** Label and one-line explanation per mode, shared by the create dialog and the participant bar. */
export const GROUP_MODE_COPY: Record<GroupChatMode, { description: MessageDescriptor; label: MessageDescriptor }> = {
    debate: {
        description: msg`Two participants argue for and against over several rounds, then a synthesizer weighs both sides.`,
        label: msg`Debate`,
    },
    "mention-only": {
        description: msg`Only participants you @mention answer.`,
        label: msg`Mentions only`,
    },
    parallel: {
        description: msg`Every participant answers on its own, without seeing the others; a synthesizer can merge the answers.`,
        label: msg`Everyone answers`,
    },
    "round-robin": {
        description: msg`Participants take turns, one reply per message.`,
        label: msg`Take turns`,
    },
    supervisor: {
        description: msg`A coordinator picks who answers — up to three per message.`,
        label: msg`Automatic`,
    },
};

export const isGroupChatMode = (value: unknown): value is GroupChatMode =>
    typeof value === "string" && (GROUP_CHAT_MODES as ReadonlyArray<string>).includes(value);
