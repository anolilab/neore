"use client";

import { useLingui } from "@lingui/react/macro";
import type { AgentSwitchPart } from "@neore/backend/agent/agent-switch-validators";
import type { FC } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

/** Where the thread's agent changed: a rule across the transcript naming the model it moved to. */
const AgentSwitchDivider: FC<{ part: AgentSwitchPart }> = ({ part }) => {
    const { t } = useLingui();
    const models = useFeatureFlaggedModels();
    const nameOf = (model: string): string => models.find((candidate) => candidate.id === model)?.name ?? model;
    const label = t`Switched from ${nameOf(part.from.model)} to ${nameOf(part.to.model)}`;

    return (
        <div aria-label={label} className="text-muted-foreground flex items-center gap-3 py-2 text-xs" role="separator">
            <span aria-hidden="true" className="bg-border h-px flex-1" />
            <span aria-hidden="true">{label}</span>
            <span aria-hidden="true" className="bg-border h-px flex-1" />
        </div>
    );
};

export default AgentSwitchDivider;
