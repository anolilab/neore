"use client";

import { useLingui } from "@lingui/react/macro";
import type { ContextResetPart } from "@neore/backend/agent/context-reset-shape";
import type { FC } from "react";

/**
 * A "New context" divider: where `/clear` started a fresh context (what is above it is shown, but no longer sent to the
 * model), or where a scheduled task's run started from a clean context (that run was not sent the turns above).
 */
const ContextResetDivider: FC<{ reason?: ContextResetPart["reason"] }> = ({ reason = "task_run" }) => {
    const { t } = useLingui();
    const label = reason === "clear" ? t`New context` : t`New task run · earlier messages were not sent to the model`;

    return (
        <div aria-label={label} className="text-muted-foreground flex items-center gap-3 py-2 text-xs" role="separator">
            <span aria-hidden="true" className="bg-border h-px flex-1" />
            <span aria-hidden="true">{label}</span>
            <span aria-hidden="true" className="bg-border h-px flex-1" />
        </div>
    );
};

export default ContextResetDivider;
