"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import type { FC } from "react";

interface PageConflictBannerProps {
    onOverwrite: () => void;
    onReload: () => void;
    pending: boolean;
}

/**
 * Shown when a save was refused because someone else changed the page first.
 * Autosave is paused until the user picks: reload theirs (the user's text is
 * kept aside to copy from) or overwrite with theirs deliberately.
 */
const PageConflictBanner: FC<PageConflictBannerProps> = ({ onOverwrite, onReload, pending }) => {
    const { t } = useLingui();

    return (
        <div
            className="flex flex-wrap items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            role="alert"
        >
            <p className="min-w-0 flex-1">
                <span className="font-medium">{t`This page changed while you were editing.`}</span> {t`Your latest changes are not saved yet.`}
            </p>
            <Button disabled={pending} onClick={onReload} size="sm" variant="outline">
                {t`Reload their version`}
            </Button>
            <Button aria-busy={pending} disabled={pending} onClick={onOverwrite} size="sm" variant="destructive">
                {t`Overwrite with mine`}
            </Button>
        </div>
    );
};

export default PageConflictBanner;
