"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Textarea } from "@neore/ui/components/textarea";
import cn from "@neore/ui/utils/cn";
import { Link } from "@tanstack/react-router";
import { CheckIcon, ExternalLinkIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon, XIcon } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";

import type { MemoryType } from "./memory-types";
import { isMemoryType, MEMORY_TYPE_COLORS, MEMORY_TYPES, useMemoryTypeLabels } from "./memory-types";

export interface MemoryItemData {
    _id: string;
    createdAt: number;
    lastConfirmedAt: number;
    memory: string;
    pinned: boolean;
    source?: string;
    threadId?: string;
    type: MemoryType;
}

interface MemoryItemProps {
    busy: boolean;
    memory: MemoryItemData;
    onDelete: (memoryId: string) => void;
    onSave: (memoryId: string, changes: { memory?: string; type?: MemoryType }) => void;
    onTogglePin: (memoryId: string, pinned: boolean) => void;
    /** Relative-time label, computed by the list so `Date.now()` stays out of render. */
    relativeTime: (timestamp: number) => string;
}

/**
 * One memory, white-box: its type (changeable), text (editable), pin (never
 * decays), the thread it came from, when it was last confirmed, and delete.
 */
const MemoryItem: FC<MemoryItemProps> = ({ busy, memory, onDelete, onSave, onTogglePin, relativeTime }) => {
    const { t } = useLingui();
    const typeLabels = useMemoryTypeLabels();
    const [isEditing, setIsEditing] = useState(false);
    const [draft, setDraft] = useState(memory.memory);
    const textareaId = useId();
    const typeItems = MEMORY_TYPES.map((type) => {
        return { label: typeLabels[type], value: type };
    });

    const startEditing = () => {
        setDraft(memory.memory);
        setIsEditing(true);
    };

    const save = () => {
        const text = draft.trim();

        if (text && text !== memory.memory) {
            onSave(memory._id, { memory: text });
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
                <span className="text-muted-foreground text-[10px]">{t`Last confirmed ${relativeTime(memory.lastConfirmedAt)}`}</span>
                {memory.threadId && (
                    <Link
                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-[10px] underline-offset-2 hover:underline"
                        params={{ threadId: memory.threadId }}
                        to="/chat/$threadId"
                    >
                        {t`Source chat`}
                        <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
                    </Link>
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
                    <div className="flex justify-end gap-1">
                        <Button onClick={() => setIsEditing(false)} size="xs" variant="ghost">
                            <XIcon aria-hidden="true" className="size-3" />
                            {t`Cancel`}
                        </Button>
                        <Button disabled={!draft.trim()} onClick={save} size="xs">
                            <CheckIcon aria-hidden="true" className="size-3" />
                            {t`Save`}
                        </Button>
                    </div>
                </div>
            ) : (
                <p className="mt-0.5 text-sm leading-snug">{memory.memory}</p>
            )}
        </li>
    );
};

export default MemoryItem;
