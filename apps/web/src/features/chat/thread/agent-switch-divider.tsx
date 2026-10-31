"use client";

import { useLingui } from "@lingui/react/macro";
import { switchAgentName } from "@neore/backend/agent/agent-switch-shape";
import type { AgentSwitchPart } from "@neore/backend/agent/agent-switch-validators";
import type { FC } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

/** Why the agent's own session was not resumed, in the reader's language; the backend sends a code, never the computer's text. */
const reattachFailureNote = (reason: NonNullable<AgentSwitchPart["fallbackReason"]>, t: ReturnType<typeof useLingui>["t"]): string => {
    const notes: Record<typeof reason, string> = {
        load_failed: t`Could not resume its own session, so the conversation was handed over`,
        load_unsupported: t`This agent cannot resume its own session, so the conversation was handed over`,
        not_reattached: t`This computer did not resume its own session, so the conversation was handed over`,
        other_session: t`It opened a different session than its own, so the conversation was handed over`,
    };

    return notes[reason];
};

/** Where the thread's agent changed: a rule across the transcript naming the model or coding agent it moved to. */
const AgentSwitchDivider: FC<{ part: AgentSwitchPart }> = ({ part }) => {
    const { t } = useLingui();
    const models = useFeatureFlaggedModels();
    const nameOf = (model: string): string => models.find((candidate) => candidate.id === model)?.name ?? model;
    const label = t`Switched from ${switchAgentName(part.from, nameOf)} to ${switchAgentName(part.to, nameOf)}`;
    let note: string | null = null;

    if (part.mode === "native") {
        note = t`Resumed its own session`;
    } else if (part.fallbackReason) {
        note = reattachFailureNote(part.fallbackReason, t);
    } else if (part.mode !== "full") {
        note = part.summarized ? t`Older messages were summarised` : t`Handed over`;
    }

    return (
        <div aria-label={note ? `${label}. ${note}` : label} className="text-muted-foreground flex items-center gap-3 py-2 text-xs" role="separator">
            <span aria-hidden="true" className="bg-border h-px flex-1" />
            <span aria-hidden="true">{note ? `${label} · ${note}` : label}</span>
            <span aria-hidden="true" className="bg-border h-px flex-1" />
        </div>
    );
};

export default AgentSwitchDivider;
