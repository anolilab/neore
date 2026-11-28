"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, RotateCcwIcon } from "lucide-react";
import type { FC } from "react";
import { useId, useRef, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

export type RetiredReason = "compressed" | "contradicted" | "decayed" | "expired" | "merged" | "revised";

export interface RetiredMemoryData {
    _id: string;
    botName?: string;
    fromBot: boolean;
    memory: string;
    retiredAt: number;
    /** Absent for a memory retired before reasons were kept. */
    retiredReason?: RetiredReason;
    /** The text of the memory that replaced it, when there is one. */
    successor?: string;
}

const useReasonLabel = (): ((reason: RetiredReason | undefined) => string) => {
    const { t } = useLingui();
    const labels: Record<RetiredReason, string> = {
        compressed: t`Combined into a shorter summary`,
        contradicted: t`Replaced by a newer, conflicting memory`,
        decayed: t`Faded after a long time without coming up`,
        expired: t`Past its end date`,
        merged: t`Merged into a similar memory`,
        revised: t`Replaced by a newer version`,
    };

    return (reason) => (reason === undefined ? t`Retired (reason not recorded)` : labels[reason]);
};

interface RetiredRowProps {
    memory: RetiredMemoryData;
    onBroughtBack: (memoryId: string) => void;
}

const RetiredRow: FC<RetiredRowProps> = ({ memory, onBroughtBack }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const errorId = useId();
    const reasonLabel = useReasonLabel();
    const { error, isPending, mutate } = useMutation({
        ...crpc.memory.retired.bringBackMemory.mutationOptions(),
        onSuccess: () => {
            onBroughtBack(memory._id);
        },
    });

    return (
        <li className="border-border space-y-1 rounded-md border p-3 text-sm">
            <p className="text-muted-foreground">{memory.memory}</p>
            <p className="text-muted-foreground text-xs">
                {reasonLabel(memory.retiredReason)} · {i18n.date(new Date(memory.retiredAt), { dateStyle: "medium" })}
                {memory.botName !== undefined && <> · {t`Learned by ${memory.botName}`}</>}
            </p>
            {memory.successor !== undefined && <p className="text-xs">{t`Now remembered as: ${memory.successor}`}</p>}
            <Button
                aria-busy={isPending}
                aria-describedby={error ? errorId : undefined}
                disabled={isPending}
                focusableWhenDisabled
                onClick={() => {
                    mutate({ memoryId: memory._id });
                }}
                size="sm"
                variant="outline"
            >
                <RotateCcwIcon aria-hidden="true" className="mr-2 h-3 w-3" />
                {isPending ? t`Bringing back…` : t`Bring back`}
            </Button>
            {error && (
                <p className="text-destructive text-xs" id={errorId} role="alert">
                    {t`This memory could not be brought back. Please try again in a moment.`}
                </p>
            )}
        </li>
    );
};

interface RetiredPageProps {
    cursor: string | null;
    hidden: ReadonlySet<string>;
    isLast: boolean;
    onBroughtBack: (memoryId: string) => void;
    onLoadMore: (cursor: string) => void;
}

/** One page of the list; the last one offers the next. */
const RetiredPage: FC<RetiredPageProps> = ({ cursor, hidden, isLast, onBroughtBack, onLoadMore }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data, isError, isPending, refetch } = useQuery({
        ...crpc.memory.retired.listRetiredMemories.queryOptions({ paginationOpts: { cursor, numItems: 25 } }, { live: false }),
        // Mounted again after each change on the page (see `readCount`): a delete may have taken retired rows with it.
        refetchOnMount: "always",
    });

    if (isPending) {
        return (
            <p className="text-muted-foreground text-xs" role="status">
                {t`Loading retired memories…`}
            </p>
        );
    }

    if (isError) {
        return (
            <div className="space-y-1" role="alert">
                <p className="text-destructive text-xs">{t`Retired memories could not be loaded.`}</p>
                <Button onClick={async () => await refetch()} size="sm" variant="outline">{t`Try again`}</Button>
            </div>
        );
    }

    const rows = data.page.filter((row: RetiredMemoryData) => !hidden.has(row._id));
    const next = data.continueCursor;

    return (
        <>
            {rows.length > 0 && (
                <ul className="space-y-2">
                    {rows.map((row: RetiredMemoryData) => (
                        <RetiredRow key={row._id} memory={row} onBroughtBack={onBroughtBack} />
                    ))}
                </ul>
            )}
            {cursor === null && data.page.length === 0 && <p className="text-muted-foreground text-xs">{t`No retired memories.`}</p>}
            {isLast && !data.isDone && next !== null && (
                <Button className="w-full" onClick={() => onLoadMore(next)} size="sm" variant="ghost">
                    {t`Show more`}
                </Button>
            )}
        </>
    );
};

interface RetiredMemoriesProps {
    /** Called after a memory came back, so the list of current memories is read again. */
    onBroughtBack: () => void;
    /** Moves on each change the page made (a delete, a clear, an import): the open list is read again. */
    readCount: number;
}

/**
 * Memories that stopped being current (replaced, merged, combined, expired or faded) but were kept, with why and when,
 * and a way to bring one back. Deleted memories are gone and never listed. Read only once opened.
 */
const RetiredMemories: FC<RetiredMemoriesProps> = ({ onBroughtBack, readCount }) => {
    const { t } = useLingui();
    const regionId = useId();
    const headingRef = useRef<HTMLHeadingElement>(null);
    const [open, setOpen] = useState(false);
    const [cursors, setCursors] = useState<(string | null)[]>([null]);
    const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
    const [announcement, setAnnouncement] = useState("");

    const handleBroughtBack = (memoryId: string): void => {
        setHidden((previous) => new Set([...previous, memoryId]));
        setAnnouncement(t`Memory brought back.`);
        // The row and its button are gone: focus goes to the section, not to the page's start.
        headingRef.current?.focus();
        onBroughtBack();
    };

    return (
        <section aria-labelledby={`${regionId}-heading`} className="space-y-2">
            <h3 className="sr-only" id={`${regionId}-heading`} ref={headingRef} tabIndex={-1}>
                {t`Retired memories`}
            </h3>
            <Button
                aria-controls={regionId}
                aria-expanded={open}
                className="w-full justify-between"
                onClick={() => setOpen((previous) => !previous)}
                size="sm"
                variant="ghost"
            >
                {t`Retired memories`}
                <ChevronDownIcon aria-hidden="true" className={open ? "h-4 w-4 rotate-180" : "h-4 w-4"} />
            </Button>
            <span className="sr-only" role="status">
                {announcement}
            </span>
            {open && (
                <div className="max-h-96 space-y-2 overflow-y-auto" id={regionId}>
                    <p className="text-muted-foreground text-xs">{t`Memories the AI stopped using, and why. Bring one back to use it again.`}</p>
                    {cursors.map((cursor, index) => (
                        <RetiredPage
                            cursor={cursor}
                            hidden={hidden}
                            isLast={index === cursors.length - 1}
                            key={`${String(readCount)}:${cursor ?? "first"}`}
                            onBroughtBack={handleBroughtBack}
                            onLoadMore={(next: string) => setCursors((previous) => [...previous, next])}
                        />
                    ))}
                </div>
            )}
        </section>
    );
};

export default RetiredMemories;
