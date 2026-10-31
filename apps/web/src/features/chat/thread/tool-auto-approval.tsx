/**
 * ToolAutoApproval — the note above a tool call the user's opt-in quick check let
 * run without asking (`backend/lunora/chat/lib/low-risk-approval.ts`). The reason is
 * the model's own sentence, shaped by the call's arguments, so it is shown as plain
 * text only.
 */

import { useLingui } from "@lingui/react/macro";
import { ShieldCheck } from "lucide-react";
import type { FC } from "react";

const ToolAutoApproval: FC<{ reason: string }> = ({ reason }) => {
    const { t } = useLingui();

    return (
        <p className="text-muted-foreground mb-1 flex items-start gap-1.5 text-xs" data-testid="tool-auto-approval">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
                <span className="font-medium">{t`Approved automatically — low risk`}</span>
                {` · ${reason}`}
            </span>
        </p>
    );
};

export default ToolAutoApproval;
