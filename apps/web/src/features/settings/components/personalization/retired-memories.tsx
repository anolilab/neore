"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, RotateCcwIcon } from "lucide-react";
import type { FC } from "react";
import { useId, useRef, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

export type RetiredReason = "brought_back_over" | "compressed" | "contradicted" | "decayed" | "duplicate" | "expired" | "merged" | "revised";

export interface RetiredMemoryData {
    _id: string;
    botName?: string;
    fromBot: boolean;
    memory: string;
    /** Bringing it back retires the current version it lost to. */
    replacesCurrent: boolean;
    retiredAt: number;
    /** Absent for a memory retired before reasons were kept. */
    retiredReason?: RetiredReason;
    /** The text of the memory that replaced it, when there is one. */
    successor?: string;
}

const useReasonLabel = (): ((reason: RetiredReason | undefined) => string) => {
    const { t } = useLingui();
    const labels: Record<RetiredReason, string> = {
        brought_back_over: t`Replaced when you brought back an earlier version`,
        compressed: t`Combined into a shorter summary`,
        contradicted: t`Replaced by a newer, conflicting memory`,
        decayed: t`Faded after a long time without coming up`,
        duplicate: t`Same as an existing memory`,
        expired: t`Past its end date`,
        merged: t`Merged into a similar memory`,
        revised: t`Replaced by a newer version`,
    };

    return (reason) => (reason === undefined ? t`Retired (reason not recorded)` : labels[reason]);
};

interface RetiredRowProps {
    memory: RetiredMemoryData;
    onBroughtBack: () => void;
}

const RetiredRow: FC<RetiredRowProps> = ({ memory, onBroughtBack }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const errorId = useId();
    const reasonLabel = useReasonLabel();
    const { error, isPending, mutate } = useMutation({
        ...crpc.memory.retired.bringBackMemory.mutationOptions(),
        onSuccess: onBroughtBack,
    });

    const bringBackLabel = memory.replacesCurrent ? t`Bring back (replaces the current version)` : t`Bring back`;

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
                {isPending ? t`Bringing back…` : bringBackLabel}
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
    isLast: boolean;
    onBroughtBack: () => void;
    onLoadMore: (cursor: string) => void;
}

const PAGE_SIZE = 25;

/** One page of the list; the last one offers the next. */
const RetiredPage: FC<RetiredPageProps> = ({ cursor, isLast, onBroughtBack, onLoadMore }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data, isError, isPending, refetch } = useQuery({
        ...crpc.memory.retired.listRetiredMemories.queryOptions({ paginationOpts: { cursor, numItems: PAGE_SIZE } }, { live: false }),
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

    const next = data.continueCursor;

    return (
        <>
            {data.page.length > 0 && (
                <ul className="space-y-2">
                    {data.page.map((row: RetiredMemoryData) => (
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

interface RetiredPagesProps {
    onBroughtBack: () => void;
}

/**
 * The pages read so far, from the first. Mounted afresh (by its key) after every change, so paging starts over: a row
 * that came back, or one retired since, never leaves a later page skipping or repeating rows.
 */
const RetiredPages: FC<RetiredPagesProps> = ({ onBroughtBack }) => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const [cursors, setCursors] = useState<(string | null)[]>([null]);

    const handleBroughtBack = (): void => {
        // The pages read before the change are dropped, so the remount reads the list as it is now, not as it was.
        for (const cursor of cursors) {
            queryClient.removeQueries({
                exact: true,
                queryKey: crpc.memory.retired.listRetiredMemories.queryKey({ paginationOpts: { cursor, numItems: PAGE_SIZE } }),
            });
        }

        onBroughtBack();
    };

    return cursors.map((cursor, index) => (
        <RetiredPage
            cursor={cursor}
            isLast={index === cursors.length - 1}
            key={cursor ?? "first"}
            onBroughtBack={handleBroughtBack}
            onLoadMore={(next: string) => setCursors((previous) => [...previous, next])}
        />
    ));
};

interface RetiredMemoriesProps {
    /** Called after a memory came back, so the list of current memories is read again. */
    onBroughtBack: () => void;
    /** Moves on each change the page made (a delete, a clear, an import): the open list is read again from its first page. */
    readCount: number;
}

/**
 * Memories that stopped being current (replaced, merged, combined, expired or faded) but were kept, with why and when,
 * and a way to bring one back. Deleted memories are gone and never listed. Read only once opened.
 */
const RetiredMemories: FC<RetiredMemoriesProps> = ({ onBroughtBack, readCount }) => {
    const { t } = useLingui();
    const regionId = useId();
    const toggleRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    // Moved by each bring-back made here: the pages start over from the first.
    const [broughtBack, setBroughtBack] = useState(0);
    const [announcement, setAnnouncement] = useState("");

    const handleBroughtBack = (): void => {
        setBroughtBack((count) => count + 1);
        setAnnouncement(t`Memory brought back.`);
        // The row and its button are gone: focus goes to the section's own visible control, not to the page's start.
        toggleRef.current?.focus();
        onBroughtBack();
    };

    return (
        <section aria-labelledby={`${regionId}-toggle`} className="space-y-2">
            <Button
                aria-controls={regionId}
                aria-expanded={open}
                className="w-full justify-between"
                id={`${regionId}-toggle`}
                onClick={() => setOpen((previous) => !previous)}
                ref={toggleRef}
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
                    <RetiredPages key={`${String(readCount)}:${String(broughtBack)}`} onBroughtBack={handleBroughtBack} />
                </div>
            )}
        </section>
    );
};

export default RetiredMemories;
