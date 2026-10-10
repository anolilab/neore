"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { ArrowDown, ArrowUp, Loader2, Plus, TrashIcon } from "lucide-react";
import type { FC, FormEvent } from "react";
import { useId, useState } from "react";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { showError } from "@/lib/toast";

import ThreadTagColorPicker from "./thread-tag-color-picker";
import type { ThreadTag, ThreadTagColor } from "./thread-tag-logic";
import { moveTag, THREAD_TAG_NAME_MAX_LENGTH } from "./thread-tag-logic";
import { useThreadTagMutations, useThreadTags } from "./use-thread-tags";

type TagMutations = ReturnType<typeof useThreadTagMutations>;

const reportError = (error: unknown, fallback: string) => {
    showError(error instanceof Error ? error : fallback);
};

interface TagRowProperties {
    index: number;
    mutations: TagMutations;
    onRequestDelete: (tag: ThreadTag) => void;
    tag: ThreadTag;
    tags: ThreadTag[];
}

const TagRow: FC<TagRowProperties> = ({ index, mutations, onRequestDelete, tag, tags }) => {
    const { t } = useLingui();
    const [draftName, setDraftName] = useState(tag.name);
    const tagId = tag._id as Id<"threadTags">;

    // Resync when the tag is renamed elsewhere (or the refetch lands) — adjusted
    // during render rather than in an effect.
    const [syncedName, setSyncedName] = useState(tag.name);

    if (syncedName !== tag.name) {
        setSyncedName(tag.name);
        setDraftName(tag.name);
    }

    const commitName = () => {
        const next = draftName.trim();

        if (next === tag.name) {
            return;
        }

        if (next.length === 0) {
            setDraftName(tag.name);

            return;
        }

        mutations.updateTag.mutateAsync({ name: next, tagId }).catch((error: unknown) => {
            setDraftName(tag.name);
            reportError(error, t`Failed to rename tag`);
        });
    };

    const reorder = (direction: -1 | 1) => {
        const tagIds = moveTag(tags, index, direction);

        if (tagIds) {
            mutations.reorderTags.mutateAsync({ tagIds }).catch((error: unknown) => {
                reportError(error, t`Failed to reorder tags`);
            });
        }
    };

    return (
        <li className="border-border flex flex-col gap-2 rounded-lg border p-2">
            <div className="flex items-center gap-1">
                <Input
                    aria-label={t`Name of tag ${tag.name}`}
                    className="h-8 flex-1"
                    maxLength={THREAD_TAG_NAME_MAX_LENGTH}
                    onBlur={commitName}
                    onChange={(e) => {
                        setDraftName(e.target.value);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            commitName();
                        } else if (e.key === "Escape") {
                            // Revert instead of letting Escape close the dialog with an unsaved draft.
                            e.stopPropagation();
                            setDraftName(tag.name);
                        }
                    }}
                    value={draftName}
                />
                <Button
                    aria-label={t`Move ${tag.name} up`}
                    disabled={index === 0 || mutations.reorderTags.isPending}
                    onClick={() => {
                        reorder(-1);
                    }}
                    size="icon-sm"
                    variant="ghost"
                >
                    <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
                <Button
                    aria-label={t`Move ${tag.name} down`}
                    disabled={index === tags.length - 1 || mutations.reorderTags.isPending}
                    onClick={() => {
                        reorder(1);
                    }}
                    size="icon-sm"
                    variant="ghost"
                >
                    <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
                <Button
                    aria-label={t`Delete tag ${tag.name}`}
                    className="hover:text-destructive"
                    onClick={() => {
                        onRequestDelete(tag);
                    }}
                    size="icon-sm"
                    variant="ghost"
                >
                    <TrashIcon aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
            </div>
            <ThreadTagColorPicker
                label={t`Color of tag ${tag.name}`}
                name={`thread-tag-color-${tag._id}`}
                onChange={(color) => {
                    mutations.updateTag.mutateAsync({ color, tagId }).catch((error: unknown) => {
                        reportError(error, t`Failed to change tag color`);
                    });
                }}
                value={tag.color}
            />
        </li>
    );
};

interface ManageThreadTagsDialogProperties {
    onOpenChange: (open: boolean) => void;
    open: boolean;
}

/** Create, rename, recolor, reorder and delete the user's thread tags. */
const ManageThreadTagsDialog: FC<ManageThreadTagsDialogProperties> = ({ onOpenChange, open }) => {
    const { t } = useLingui();
    const tags = useThreadTags() ?? [];
    const mutations = useThreadTagMutations();
    const [newName, setNewName] = useState("");
    const [newColor, setNewColor] = useState<ThreadTagColor>("blue");
    const [pendingDelete, setPendingDelete] = useState<ThreadTag | null>(null);
    const newNameId = useId();

    const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const name = newName.trim();

        if (!name) {
            return;
        }

        try {
            await mutations.createTag.mutateAsync({ color: newColor, name });
            setNewName("");
        } catch (error) {
            reportError(error, t`Failed to create tag`);
        }
    };

    const handleDelete = async () => {
        if (!pendingDelete) {
            return;
        }

        try {
            await mutations.deleteTag.mutateAsync({ tagId: pendingDelete._id as Id<"threadTags"> });
            setPendingDelete(null);
        } catch (error) {
            reportError(error, t`Failed to delete tag`);
        }
    };

    const pendingDeleteName = pendingDelete?.name ?? "";

    return (
        <>
            <Dialog onOpenChange={onOpenChange} open={open}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t`Manage tags`}</DialogTitle>
                        <DialogDescription>{t`Tags are your own labels for chats. Filter the chat list by them alongside the automatic categories.`}</DialogDescription>
                    </DialogHeader>
                    <DialogPanel className="flex flex-col gap-4">
                        <form className="flex flex-col gap-2" onSubmit={handleCreate}>
                            <label className="text-sm font-medium" htmlFor={newNameId}>
                                {t`New tag`}
                            </label>
                            <div className="flex items-center gap-2">
                                <Input
                                    className="h-8 flex-1"
                                    id={newNameId}
                                    maxLength={THREAD_TAG_NAME_MAX_LENGTH}
                                    onChange={(e) => {
                                        setNewName(e.target.value);
                                    }}
                                    placeholder={t`e.g. Work`}
                                    value={newName}
                                />
                                <Button disabled={!newName.trim() || mutations.createTag.isPending} size="sm" type="submit">
                                    {mutations.createTag.isPending ? (
                                        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                                    )}
                                    {t`Add`}
                                </Button>
                            </div>
                            <ThreadTagColorPicker label={t`Color for the new tag`} name="thread-tag-color-new" onChange={setNewColor} value={newColor} />
                        </form>

                        {tags.length === 0 ? (
                            <p className="text-muted-foreground text-sm">{t`You have no tags yet.`}</p>
                        ) : (
                            <ul aria-label={t`Your tags`} className="flex flex-col gap-2">
                                {tags.map((tag, index) => (
                                    <TagRow index={index} key={tag._id} mutations={mutations} onRequestDelete={setPendingDelete} tag={tag} tags={tags} />
                                ))}
                            </ul>
                        )}
                    </DialogPanel>
                    <DialogFooter>
                        <Button
                            onClick={() => {
                                onOpenChange(false);
                            }}
                            variant="outline"
                        >
                            {t`Done`}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <DeleteConfirmationDialog
                description={t`The tag "${pendingDeleteName}" will be removed from every chat that has it. The chats themselves are not deleted.`}
                isDeleting={mutations.deleteTag.isPending}
                onConfirm={handleDelete}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen) {
                        setPendingDelete(null);
                    }
                }}
                open={pendingDelete !== null}
                title={t`Delete tag`}
            />
        </>
    );
};

export default ManageThreadTagsDialog;
