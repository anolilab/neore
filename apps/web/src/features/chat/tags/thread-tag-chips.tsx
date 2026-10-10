import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";

import { THREAD_TAG_CHIP_CLASSES } from "./thread-tag-colors";
import type { ThreadTag } from "./thread-tag-logic";

/** Chips shown inline in a thread row; the rest collapse into "+N". */
const MAX_VISIBLE_CHIPS = 2;

interface ThreadTagChipsProperties {
    className?: string;
    tags: ThreadTag[];
}

const ThreadTagChips: FC<ThreadTagChipsProperties> = ({ className, tags }) => {
    const { t } = useLingui();

    if (tags.length === 0) {
        return null;
    }

    const visible = tags.slice(0, MAX_VISIBLE_CHIPS);
    const hiddenCount = tags.length - visible.length;
    const allNames = tags.map((tag) => tag.name).join(", ");

    return (
        <span className={cn("flex shrink-0 items-center gap-1", className)}>
            {/* One announcement for the whole set instead of a fragment per chip. */}
            <span className="sr-only">{t`Tags: ${allNames}`}</span>
            {visible.map((tag) => (
                <span
                    aria-hidden="true"
                    className={cn("max-w-20 truncate rounded px-1.5 py-0.5 text-[10px] leading-none font-medium", THREAD_TAG_CHIP_CLASSES[tag.color])}
                    key={tag._id}
                    title={tag.name}
                >
                    {tag.name}
                </span>
            ))}
            {hiddenCount > 0 && (
                <span aria-hidden="true" className="text-muted-foreground text-[10px] leading-none" title={allNames}>
                    +{hiddenCount}
                </span>
            )}
        </span>
    );
};

export default ThreadTagChips;
