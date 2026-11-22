"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { ShieldAlert } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { useImpersonationState } from "@/features/admin/hooks/use-is-impersonating";

/** Runs the review; kept out of the component, whose compiler skips a try with conditionals. */
const runKeep = async (keep: () => Promise<unknown>): Promise<boolean> => {
    try {
        await keep();

        return true;
    } catch {
        return false;
    }
};

interface ChangedByAdminMarkProps {
    /** What was changed, read after the button's text by a screen reader ("Keep as mine: Helper"). */
    fieldLabel: string;
    /** Clears this one field's mark on the server. */
    onKeep: () => Promise<unknown>;
}

/**
 * Shown on a field an admin wrote while acting as the person (`…ByImpersonator`): such text never unlocks a saved login.
 * "Keep as mine" clears that one mark; the server refuses it to an impersonated session, so the button shows only once
 * the session reads as the person's own.
 */
const ChangedByAdminMark: FC<ChangedByAdminMarkProps> = ({ fieldLabel, onKeep }) => {
    const { t } = useLingui();
    const own = useImpersonationState() === "self";
    const [pending, setPending] = useState(false);

    const handleKeep = async () => {
        setPending(true);

        const kept = await runKeep(onKeep);

        setPending(false);

        if (kept) {
            toast.success(t`Kept as yours`);
        } else {
            toast.error(t`Could not keep this as yours. Try again.`);
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
                <ShieldAlert aria-hidden="true" className="size-3" />
                {t`Changed by an admin`}
            </Badge>
            <span className="text-muted-foreground text-xs">{t`Saved logins stay off for it until you keep it as yours.`}</span>
            {own && (
                <Button disabled={pending} onClick={handleKeep} size="sm" type="button" variant="outline">
                    {t`Keep as mine`}
                    <span className="sr-only">: {fieldLabel}</span>
                </Button>
            )}
        </div>
    );
};

export default ChangedByAdminMark;
