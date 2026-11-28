import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { AlarmClock, Archive, CircleAlert, Hammer, MessagesSquare } from "lucide-react";
import type { FC, MouseEvent } from "react";
import { useEffect } from "react";

import type { SectionKey } from "./lib/section-filter";
import { nextSectionFilter, SECTION_KEYS } from "./lib/section-filter";
import { selectSearchQuery, selectSectionCounts, selectSectionFilter, useThreadListUIStore } from "./stores/thread-list-ui-store";

const SECTION_ICONS: Record<SectionKey, FC<{ "aria-hidden"?: boolean; className?: string }>> = {
    active: MessagesSquare,
    archived: Archive,
    needsYou: CircleAlert,
    snoozed: AlarmClock,
    working: Hammer,
};

/** Sections that only show while something is in them (or while the filter still names them). */
const HIDDEN_WHEN_EMPTY: ReadonlySet<SectionKey> = new Set<SectionKey>(["needsYou", "snoozed"]);

/**
 * Which sections of the thread list show. A click shows only that section; a shift-click adds it to, or takes it out of, the
 * shown ones (the bar never ends up with none). The counts are the loaded rows, published by the list. Hidden while a search
 * is typed, as a search looks through every thread.
 */
const SectionBar: FC = () => {
    const { t } = useLingui();
    const filter = useThreadListUIStore(selectSectionFilter);
    const counts = useThreadListUIStore(selectSectionCounts);
    const searchQuery = useThreadListUIStore(selectSearchQuery);
    const setSectionFilter = useThreadListUIStore((state) => state.setSectionFilter);

    // The saved choice is read after mount, so the server render and the first client render agree.
    useEffect(() => {
        void useThreadListUIStore.persist.rehydrate();
    }, []);

    if (searchQuery.trim() !== "") {
        return null;
    }

    const labels: Record<SectionKey, string> = {
        active: t`Active`,
        archived: t`Archived`,
        needsYou: t`Needs you`,
        snoozed: t`Snoozed`,
        working: t`Working`,
    };

    const handleClick = (key: SectionKey, event: MouseEvent) => {
        setSectionFilter(nextSectionFilter(filter, key, event.shiftKey));
    };

    return (
        <div aria-label={t`Thread sections (shift-click to show several)`} className="surface-well flex gap-0.5 rounded-[11px] p-[3px]" role="group">
            {SECTION_KEYS.filter((key) => !HIDDEN_WHEN_EMPTY.has(key) || counts[key] > 0 || filter.includes(key)).map((key) => {
                const Icon = SECTION_ICONS[key];
                const label = labels[key];
                const count = counts[key];
                const isPressed = filter.includes(key);

                return (
                    <button
                        aria-label={t`${label}, ${count}`}
                        aria-pressed={isPressed}
                        className={cn(
                            "text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-[30px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium tabular-nums focus-visible:ring-2 focus-visible:outline-none",
                            isPressed && "bg-surface-row-active surface-edge text-foreground",
                        )}
                        key={key}
                        onClick={(event) => handleClick(key, event)}
                        type="button"
                    >
                        <Icon aria-hidden className="size-3.5 shrink-0" />
                        <span className={cn(key === "needsYou" && "text-attention")}>{count}</span>
                    </button>
                );
            })}
        </div>
    );
};

export default SectionBar;
