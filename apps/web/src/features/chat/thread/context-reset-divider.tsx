"use client";

import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";

/** Where a scheduled task's run started from a clean context: the turns above stay, but that run was not sent them. */
const ContextResetDivider: FC = () => {
    const { t } = useLingui();
    const label = t`New task run · earlier messages were not sent to the model`;

    return (
        <div aria-label={label} className="text-muted-foreground flex items-center gap-3 py-2 text-xs" role="separator">
            <span aria-hidden="true" className="bg-border h-px flex-1" />
            <span aria-hidden="true">{label}</span>
            <span aria-hidden="true" className="bg-border h-px flex-1" />
        </div>
    );
};

export default ContextResetDivider;
