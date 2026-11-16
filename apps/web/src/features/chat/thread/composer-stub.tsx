"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";

interface ComposerStubProps {
    className?: string;
    /** Makes this chat the one that owns the live composer. */
    onActivate?: () => void;
}

/**
 * Stands where the composer does in a split-view pane that does not have focus. The composer's draft is one global value,
 * so only the focused pane mounts a live one; this one line hands focus over.
 */
const ComposerStub: FC<ComposerStubProps> = ({ className, onActivate }) => {
    const { t } = useLingui();

    return (
        <button
            className={cn(
                "border-border bg-card text-muted-foreground hover:text-foreground focus-visible:ring-ring mb-4 w-full rounded-xl border px-4 py-3 text-left text-sm focus-visible:ring-2 focus-visible:outline-none",
                className,
            )}
            onClick={onActivate}
            type="button"
        >
            {t`Continue in this chat`}
        </button>
    );
};

export default ComposerStub;
