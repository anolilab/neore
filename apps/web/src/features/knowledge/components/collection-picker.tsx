"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@neore/ui/components/alert-dialog";
import { Button } from "@neore/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { FolderInputIcon, PencilIcon, PlusIcon, Trash2Icon, UsersIcon } from "lucide-react";
import type { FC } from "react";
import { useId, useMemo } from "react";

/** A row of `knowledge_collections.listCollections`. */
export interface CollectionView {
    _id: Id<"knowledgeCollections">;
    description?: string;
    isOwner: boolean;
    name: string;
    shared: boolean;
}

/** The file list's filter: everything, the uncategorised files, or one collection. */
export type CollectionScope = "all" | "none" | Id<"knowledgeCollections">;

interface CollectionPickerProps {
    collections: ReadonlyArray<CollectionView>;
    /** The caller's files, to count per collection. */
    counts?: ReadonlyArray<{ collectionId?: string }>;
    onCreate: () => void;
    onDelete: (deleteFiles: boolean) => void;
    onEdit: () => void;
    onScopeChange: (scope: CollectionScope) => void;
    scope: CollectionScope;
}

export const CollectionPicker: FC<CollectionPickerProps> = ({ collections, counts, onCreate, onDelete, onEdit, onScopeChange, scope }) => {
    const { t } = useLingui();
    const labelId = useId();
    const selected = collections.find((collection) => collection._id === scope);
    const countBy = useMemo(() => {
        const map = new Map<string, number>();

        const files = counts ?? [];

        for (const file of files) {
            const key = file.collectionId ?? "none";

            map.set(key, (map.get(key) ?? 0) + 1);
        }

        return map;
    }, [counts]);
    const items = [
        { label: t`All files (${counts?.length ?? 0})`, value: "all" },
        { label: t`Uncategorised (${countBy.get("none") ?? 0})`, value: "none" },
        ...collections.map((collection) => {
            return {
                label: collection.isOwner ? `${collection.name} (${countBy.get(collection._id) ?? 0})` : t`${collection.name} (shared)`,
                value: collection._id as string,
            };
        }),
    ];

    return (
        <div aria-labelledby={labelId} className="flex flex-wrap items-center gap-2" role="group">
            <span className="text-muted-foreground text-xs font-medium" id={labelId}>
                {t`Collection`}
            </span>
            <Select items={items} onValueChange={(value) => value && onScopeChange(value as CollectionScope)} value={scope as string}>
                <SelectTrigger aria-labelledby={labelId} className="h-8 min-w-44 flex-1 text-sm sm:flex-none">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {items.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                            {item.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {selected?.shared && <UsersIcon aria-label={t`Shared with your organization`} className="text-muted-foreground h-4 w-4" role="img" />}
            <Button onClick={onCreate} size="sm" variant="outline">
                <PlusIcon aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                {t`New collection`}
            </Button>
            {selected?.isOwner && (
                <>
                    <Button aria-label={t`Edit collection`} onClick={onEdit} size="icon" variant="ghost">
                        <PencilIcon aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                    <AlertDialog>
                        <AlertDialogTrigger render={<Button aria-label={t`Delete collection`} size="icon" variant="ghost" />}>
                            <Trash2Icon aria-hidden="true" className="h-3.5 w-3.5" />
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>{t`Delete "${selected.name}"?`}</AlertDialogTitle>
                                <AlertDialogDescription>
                                    {t`Keep the files as uncategorised, or delete them together with the collection. Chats and projects that use the collection stop searching it.`}
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
                                <AlertDialogAction onClick={() => onDelete(true)} variant="destructive">{t`Delete with files`}</AlertDialogAction>
                                <AlertDialogAction onClick={() => onDelete(false)}>{t`Keep files`}</AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                </>
            )}
        </div>
    );
};

interface MoveToCollectionProps {
    collections: ReadonlyArray<CollectionView>;
    current?: string;
    fileName: string;
    onMove: (collectionId: Id<"knowledgeCollections"> | undefined) => void;
}

/** Files one file into one of the caller's own collections, or back to uncategorised. */
export const MoveToCollection: FC<MoveToCollectionProps> = ({ collections, current, fileName, onMove }) => {
    const { t } = useLingui();

    if (collections.length === 0) {
        return null;
    }

    const items = [
        { label: t`Uncategorised`, value: "none" },
        ...collections.map((collection) => {
            return { label: collection.name, value: collection._id as string };
        }),
    ];

    return (
        <Select
            items={items}
            onValueChange={(value) => {
                if (value && value !== (current ?? "none")) {
                    onMove(value === "none" ? undefined : (value as Id<"knowledgeCollections">));
                }
            }}
            value={current ?? "none"}
        >
            <SelectTrigger
                aria-label={t`Move "${fileName}" to a collection`}
                className="h-6 w-6 shrink-0 justify-center border-none p-0 opacity-0 shadow-none transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [&>svg:last-child]:hidden"
            >
                <FolderInputIcon aria-hidden="true" className="h-3 w-3" />
            </SelectTrigger>
            <SelectContent>
                {items.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                        {item.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
};
