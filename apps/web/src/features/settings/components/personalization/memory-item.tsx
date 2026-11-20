"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Textarea } from "@neore/ui/components/textarea";
import cn from "@neore/ui/utils/cn";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, ExternalLinkIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon, XIcon } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";

import { messageHash } from "@/features/chat/thread/message-windowing";
import { useCRPC } from "@/lib/lunora/crpc";

import type { ImportApp } from "./memory-import-apps";
import { useImportAppLabels } from "./memory-import-apps";
import type { MemoryType } from "./memory-types";
import { isMemoryType, MEMORY_TYPE_COLORS, MEMORY_TYPES, useMemoryTypeLabels } from "./memory-types";

export interface MemoryItemData {
    _id: string;
    botName?: string;
    botOwnedByOther?: boolean;
    botOwnerUnknown?: boolean;
    createdAt: number;
    /** Local calendar days, `YYYY-MM-DD`: the days an event happens, and the last day a fact holds. */
    eventEnd?: string;
    eventStart?: string;
    evidenceAt?: number;
    fromBot: boolean;
    hasEvidence: boolean;
    importedFrom?: ImportApp;
    lastConfirmedAt: number;
    memory: string;
    pinned: boolean;
    source?: string;
    threadId?: string;
    type: MemoryType;
    validUntil?: string;
}

/** The three dates as the editor holds them: an empty string is no date. */
export type MemoryDates = Required<Pick<MemoryItemData, "eventEnd" | "eventStart" | "validUntil">>;

const datesOf = (memory: MemoryItemData): MemoryDates => {
    return { eventEnd: memory.eventEnd ?? "", eventStart: memory.eventStart ?? "", validUntil: memory.validUntil ?? "" };
};

interface MemoryItemProps {
    busy: boolean;
    memory: MemoryItemData;
    onDelete: (memoryId: string) => void;
    onSave: (memoryId: string, changes: { dates?: MemoryDates; memory?: string; type?: MemoryType }) => void;
    onTogglePin: (memoryId: string, pinned: boolean) => void;
    /** Relative-time label, computed by the list so `Date.now()` stays out of render. */
    relativeTime: (timestamp: number) => string;
}

/** Sources this list labels by who learned them; any other (an import) keeps its own label. */
const LEARNED_SOURCES = new Set(["auto", "compressed", "reflection", undefined]);

/**
 * Who the memory came from (the user, a bot, or a plain chat) and the date, as one translatable message per case, so a
 * translator can put the date before or after the source. A source labelled elsewhere (an import) shows the date alone.
 */
const useLearnedLabel = (memory: MemoryItemData, learnedOn: string): string => {
    const { t } = useLingui();

    if (memory.source === "manual") {
        return t`Added by you · ${learnedOn}`;
    }

    if (!LEARNED_SOURCES.has(memory.source)) {
        return learnedOn;
    }

    if (!memory.fromBot) {
        return t`Learned in chat · ${learnedOn}`;
    }

    const { botName } = memory;

    if (botName !== undefined) {
        return t`Learned by ${botName} · ${learnedOn}`;
    }

    // Unnamed: the bot belongs to someone else (the person who shared the chat), was deleted by its owner, or predates
    // the owner records, so nothing says which.
    if (memory.botOwnedByOther === true) {
        return t`Learned by the shared chat's bot · ${learnedOn}`;
    }

    return memory.botOwnerUnknown === true ? t`Learned by a bot · ${learnedOn}` : t`Learned by a deleted bot · ${learnedOn}`;
};

/**
 * Why the memory is there: the user's own words, and a link to the chat they were
 * in, at the message when it still exists. Read each time the row is expanded, so
 * a chat locked, trashed or unshared since shows no link (and, locked, no quote).
 */
const MemorySource: FC<{ memoryId: string }> = ({ memoryId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const {
        data: source,
        isError,
        isPending,
    } = useQuery({
        // One-shot: a live subscription per expanded row would crowd the socket's cap.
        ...crpc.memory.functions.getMemorySource.queryOptions({ memoryId }, { live: false }),
        // Nothing is kept once the row closes, and each expand asks again: a re-expand never shows a quote or link from
        // before a lock or unshare.
        gcTime: 0,
        staleTime: 0,
    });

    if (isError) {
        return (
            <p className="text-destructive text-[10px]" role="alert">
                {t`Could not load where this memory came from.`}
            </p>
        );
    }

    if (isPending) {
        return <p className="text-muted-foreground text-xs" role="status">{t`Loading…`}</p>;
    }

    return (
        <>
            {source?.quote === undefined ? (
                // The backend says when a kept quote is held back (a locked or deleted chat, or one you can no longer open);
                // the list's flag may be older than a rewrite.
                <p className="text-muted-foreground text-xs">
                    {source?.quoteHidden === true ? t`The quote stays hidden while you can't open its chat.` : t`No quote was kept for this memory.`}
                </p>
            ) : (
                <blockquote className="text-muted-foreground text-xs italic">{`“${source.quote}”`}</blockquote>
            )}
            {source?.threadId !== undefined && (
                <Link
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-[10px] underline-offset-2 hover:underline pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    params={{ threadId: source.threadId }}
                    to="/chat/$threadId"
                    {...(source.messageId !== undefined && { hash: messageHash(source.messageId, source.messageOrder, source.messageStepOrder) })}
                >
                    {source.messageId === undefined ? t`Open chat` : t`Open message`}
                    <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
                </Link>
            )}
        </>
    );
};

/**
 * One memory, white-box: its type (changeable), text (editable), pin (never
 * decays), the thread it came from, when it was last confirmed, and delete.
 */
const MemoryItem: FC<MemoryItemProps> = ({ busy, memory, onDelete, onSave, onTogglePin, relativeTime }) => {
    const { i18n, t } = useLingui();
    // A stored day is a calendar day, not an instant: formatted in UTC so no timezone moves it.
    const day = (value: string): string => i18n.date(new Date(`${value}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
    let eventLabel: string | undefined;

    if (memory.eventStart && memory.eventEnd) {
        eventLabel = t`${day(memory.eventStart)} – ${day(memory.eventEnd)}`;
    } else if (memory.eventStart) {
        eventLabel = t`On ${day(memory.eventStart)}`;
    }

    const untilLabel = memory.validUntil ? t`Until ${day(memory.validUntil)}` : undefined;
    const [showSource, setShowSource] = useState(false);
    const sourceId = useId();
    // The date of the words the shown quote came from; the creation date when there is none.
    const learnedOn = i18n.date(new Date(memory.evidenceAt ?? memory.createdAt), { dateStyle: "medium" });
    const learnedLabel = useLearnedLabel(memory, learnedOn);
    // A rewrite drops the evidence, so a memory the user wrote shows one only when a later statement backed it again.
    const hasSource = memory.hasEvidence || (memory.source !== "manual" && memory.threadId !== undefined);
    const typeLabels = useMemoryTypeLabels();
    const appLabels = useImportAppLabels();
    const importedFromLabel = appLabels[memory.importedFrom ?? "other"];
    const [isEditing, setIsEditing] = useState(false);
    const [draft, setDraft] = useState(memory.memory);
    const [draftDates, setDraftDates] = useState<MemoryDates>(() => datesOf(memory));
    // The dates as the edit began: a save sends them only when the person changed a date, not when another tab did.
    const [datesAtEditStart, setDatesAtEditStart] = useState<MemoryDates>(() => datesOf(memory));
    const textareaId = useId();
    const dateIds = { eventEnd: useId(), eventStart: useId(), validUntil: useId() };
    const dateErrorId = useId();
    // An event cannot end before it starts, nor without a start (the server checks the same).
    const datesInvalid = draftDates.eventEnd !== "" && (draftDates.eventStart === "" || draftDates.eventEnd < draftDates.eventStart);
    const dateFields: { key: keyof MemoryDates; label: string }[] = [
        { key: "eventStart", label: t`Happens on` },
        { key: "eventEnd", label: t`Event ends on` },
        { key: "validUntil", label: t`Holds until` },
    ];
    const typeItems = MEMORY_TYPES.map((type) => {
        return { label: typeLabels[type], value: type };
    });

    const startEditing = () => {
        setDraft(memory.memory);
        setDraftDates(datesOf(memory));
        setDatesAtEditStart(datesOf(memory));
        setIsEditing(true);
    };

    const save = () => {
        const text = draft.trim();
        const keys = Object.keys(datesAtEditStart) as (keyof MemoryDates)[];
        const datesChanged = keys.some((key) => datesAtEditStart[key] !== draftDates[key]);
        // A date the person did not change keeps the stored value, so another tab's edit to it survives this save.
        const stored = datesOf(memory);
        const dates = Object.fromEntries(keys.map((key) => [key, datesAtEditStart[key] === draftDates[key] ? stored[key] : draftDates[key]])) as MemoryDates;

        // Two edits to different ends can meet in an impossible range: the editor shows that range, with its error, rather
        // than send it. The stored dates become the edit's start, so the next save compares against them.
        if (dates.eventEnd !== "" && (dates.eventStart === "" || dates.eventEnd < dates.eventStart)) {
            setDraftDates(dates);
            setDatesAtEditStart(stored);

            return;
        }

        const textChanged = text !== "" && text !== memory.memory;

        if (textChanged || datesChanged) {
            onSave(memory._id, { ...(textChanged && { memory: text }), ...(datesChanged && { dates }) });
        }

        setIsEditing(false);
    };

    return (
        <li className={cn("bg-muted/50 group rounded-md p-2", memory.pinned && "ring-primary/40 ring-1")}>
            <div className="flex flex-wrap items-center gap-1.5">
                <Select
                    disabled={busy}
                    items={typeItems}
                    onValueChange={(value) => {
                        if (isMemoryType(value) && value !== memory.type) {
                            onSave(memory._id, { type: value });
                        }
                    }}
                    value={memory.type}
                >
                    <SelectTrigger aria-label={t`Memory type`} className={cn("h-5 border-0 px-1.5 text-[10px]", MEMORY_TYPE_COLORS[memory.type])} size="sm">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {typeItems.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                                {item.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {eventLabel && <span className="text-[10px] font-medium">{eventLabel}</span>}
                {untilLabel && <span className="text-[10px] font-medium">{untilLabel}</span>}
                <span className="text-muted-foreground text-[10px]">{learnedLabel}</span>
                <span className="text-muted-foreground text-[10px]">{t`Last confirmed ${relativeTime(memory.lastConfirmedAt)}`}</span>
                {memory.source === "imported" && <span className="text-muted-foreground text-[10px]">{t`Imported from ${importedFromLabel}`}</span>}
                {hasSource && (
                    <button
                        aria-controls={sourceId}
                        aria-expanded={showSource}
                        aria-label={t`Why was this remembered?`}
                        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-0.5 rounded text-[10px] outline-none focus-visible:ring-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                        onClick={() => setShowSource((shown) => !shown)}
                        type="button"
                    >
                        {t`Why?`}
                        <ChevronDownIcon aria-hidden="true" className={cn("size-2.5 transition-transform", showSource && "rotate-180")} />
                    </button>
                )}
                <div className="ml-auto flex items-center gap-0.5">
                    <Button
                        aria-label={memory.pinned ? t`Unpin memory` : t`Pin memory`}
                        aria-pressed={memory.pinned}
                        disabled={busy}
                        onClick={() => onTogglePin(memory._id, !memory.pinned)}
                        size="icon-xs"
                        variant="ghost"
                    >
                        {memory.pinned ? <PinOffIcon aria-hidden="true" className="size-3" /> : <PinIcon aria-hidden="true" className="size-3" />}
                    </Button>
                    {!isEditing && (
                        <Button aria-label={t`Edit memory`} disabled={busy} onClick={startEditing} size="icon-xs" variant="ghost">
                            <PencilIcon aria-hidden="true" className="size-3" />
                        </Button>
                    )}
                    <Button aria-label={t`Delete memory`} disabled={busy} onClick={() => onDelete(memory._id)} size="icon-xs" variant="ghost">
                        <Trash2Icon aria-hidden="true" className="size-3" />
                    </Button>
                </div>
            </div>

            {isEditing ? (
                <div className="mt-1 space-y-1">
                    <label className="sr-only" htmlFor={textareaId}>{t`Memory text`}</label>
                    <Textarea
                        className="min-h-16 text-sm"
                        id={textareaId}
                        maxLength={1000}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                setIsEditing(false);
                            }
                        }}
                        value={draft}
                    />
                    <div className="flex flex-wrap gap-2 text-xs">
                        {dateFields.map(({ key, label }) => (
                            <div className="flex items-center gap-1" key={key}>
                                <label htmlFor={dateIds[key]}>{label}</label>
                                <input
                                    aria-describedby={key === "eventEnd" && datesInvalid ? dateErrorId : undefined}
                                    aria-invalid={key === "eventEnd" && datesInvalid}
                                    className="bg-background rounded border px-1.5 py-0.5"
                                    id={dateIds[key]}
                                    min={key === "eventEnd" ? draftDates.eventStart || undefined : undefined}
                                    onChange={(event) =>
                                        setDraftDates((previous) => {
                                            return { ...previous, [key]: event.target.value };
                                        })
                                    }
                                    type="date"
                                    value={draftDates[key]}
                                />
                            </div>
                        ))}
                    </div>
                    {datesInvalid && <p className="text-destructive text-xs" id={dateErrorId} role="alert">{t`An event cannot end before it starts.`}</p>}
                    <div className="flex justify-end gap-1">
                        <Button onClick={() => setIsEditing(false)} size="xs" variant="ghost">
                            <XIcon aria-hidden="true" className="size-3" />
                            {t`Cancel`}
                        </Button>
                        <Button disabled={!draft.trim() || datesInvalid} onClick={save} size="xs">
                            <CheckIcon aria-hidden="true" className="size-3" />
                            {t`Save`}
                        </Button>
                    </div>
                </div>
            ) : (
                <p className="mt-0.5 text-sm leading-snug">{memory.memory}</p>
            )}

            {hasSource && (
                <div
                    className={cn("border-border mt-1 flex-col items-start gap-0.5 border-l-2 pl-2", showSource ? "flex" : "hidden")}
                    hidden={!showSource}
                    id={sourceId}
                >
                    {showSource && <MemorySource memoryId={memory._id} />}
                </div>
            )}
        </li>
    );
};

export default MemoryItem;
