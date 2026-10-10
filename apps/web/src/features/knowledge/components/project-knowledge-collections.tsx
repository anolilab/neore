"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Checkbox } from "@neore/ui/components/checkbox";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { useId, useMemo } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

/**
 * Knowledge collections attached to a project: every chat in the project
 * searches them (and cites them), on top of what the chat attaches itself.
 * Changes apply at once — they are links, not part of the project form.
 */
const ProjectKnowledgeCollections: FC<{ projectId: string }> = ({ projectId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const labelId = useId();
    const { data: collections } = useQuery(crpc.knowledge.collections.listCollections.queryOptions({}));
    const { data: attached, refetch } = useQuery(crpc.knowledge.collections.getProjectCollections.queryOptions({ projectId: projectId as Id<"projects"> }));
    const { isPending: isAttaching, mutateAsync: attach } = useMutation(crpc.knowledge.collections.attachCollectionToProject.mutationOptions());
    const { isPending: isDetaching, mutateAsync: detach } = useMutation(crpc.knowledge.collections.detachCollectionFromProject.mutationOptions());
    const attachedIds = useMemo(() => new Set((attached ?? []).map((link) => link.collectionId as string)), [attached]);

    if (!collections || collections.length === 0) {
        return null;
    }

    const toggle = async (collectionId: Id<"knowledgeCollections">, checked: boolean) => {
        try {
            await (checked
                ? attach({ collectionId, projectId: projectId as Id<"projects"> })
                : detach({ collectionId, projectId: projectId as Id<"projects"> }));
            await refetch();
        } catch {
            toast.error(checked ? t`Failed to attach collection` : t`Failed to detach collection`);
        }
    };

    return (
        <div aria-labelledby={labelId} className="space-y-2" role="group">
            <div>
                <p className="text-sm font-medium" id={labelId}>
                    {t`Knowledge collections`}
                </p>
                <p className="text-muted-foreground text-xs">{t`Chats in this project search these collections and cite them.`}</p>
            </div>
            <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                {collections.map((collection) => {
                    const checkboxId = `${labelId}-${collection._id as string}`;

                    return (
                        <li className="flex items-center gap-2" key={collection._id as string}>
                            <Checkbox
                                checked={attachedIds.has(collection._id as string)}
                                disabled={isAttaching || isDetaching}
                                id={checkboxId}
                                onCheckedChange={(checked) => toggle(collection._id, checked === true)}
                            />
                            <label className="min-w-0 flex-1 truncate text-sm" htmlFor={checkboxId}>
                                {collection.name}
                                {!collection.isOwner && <span className="text-muted-foreground ml-1 text-xs">{t`(shared)`}</span>}
                            </label>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
};

export default ProjectKnowledgeCollections;
