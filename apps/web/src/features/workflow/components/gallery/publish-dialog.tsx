import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { Globe, Lock, X } from "lucide-react";
import { memo, useCallback, useState } from "react";

import type { GalleryCategory } from "../../hooks/use-gallery";
import { usePublishWorkflow, useUnpublishWorkflow, useUpdateGalleryMeta } from "../../hooks/use-gallery";

interface PublishDialogProps {
    currentCategory?: GalleryCategory;
    currentDescription?: string;
    currentTags?: string[];
    isPublished: boolean;
    projectId: string;
    trigger?: React.ReactElement;
}

const CATEGORIES: { label: MessageDescriptor; value: GalleryCategory }[] = [
    { label: msg`Image Generation`, value: "image" },
    { label: msg`Text & AI`, value: "text" },
    { label: msg`Video`, value: "video" },
    { label: msg`Audio`, value: "audio" },
    { label: msg`Automation`, value: "automation" },
];

const EMPTY_TAGS: string[] = [];

const PublishDialogComponent = ({
    currentCategory,
    currentDescription = "",
    currentTags = EMPTY_TAGS,
    isPublished,
    projectId,
    trigger,
}: PublishDialogProps) => {
    const { i18n, t } = useLingui();
    const [open, setOpen] = useState(false);
    const [category, setCategory] = useState<GalleryCategory>(currentCategory ?? "image");
    const [tags, setTags] = useState<string[]>(currentTags);
    const [tagInput, setTagInput] = useState("");
    const [description, setDescription] = useState(currentDescription);

    const publishWorkflow = usePublishWorkflow();
    const unpublishWorkflow = useUnpublishWorkflow();
    const updateMeta = useUpdateGalleryMeta();

    // The `projectId` prop is threaded down from the `/workflow/$workflowId` route
    // param, so it is a plain string that is always a real project id.
    const brandedProjectId = projectId as Id<"projects">;

    // Reset state to props on the open transition, during render rather than in
    // an effect. Keying off `open` alone also stops the reset from firing on
    // every parent redraw — `currentTags` defaults to a fresh `[]`, so an
    // effect that depends on it wiped tags the user had just typed.
    const [wasOpen, setWasOpen] = useState(open);

    if (open !== wasOpen) {
        setWasOpen(open);

        if (open) {
            setCategory(currentCategory ?? "image");
            setTags(currentTags);
            setDescription(currentDescription);
            setTagInput("");
        }
    }

    const handleAddTag = useCallback(() => {
        const trimmed = tagInput.trim().toLowerCase();

        if (trimmed && !tags.includes(trimmed) && tags.length < 10) {
            setTags([...tags, trimmed]);
            setTagInput("");
        }
    }, [tagInput, tags]);

    const handleRemoveTag = useCallback(
        (tag: string) => {
            setTags(tags.filter((existing) => existing !== tag));
        },
        [tags],
    );

    const handleTagKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key !== "Enter") {
                return;
            }

            e.preventDefault();
            handleAddTag();
        },
        [handleAddTag],
    );

    const handlePublish = useCallback(async () => {
        await publishWorkflow.mutateAsync({
            category,
            projectId: brandedProjectId,
            tags,
        });

        if (description) {
            await updateMeta.mutateAsync({
                description,
                projectId: brandedProjectId,
            });
        }

        setOpen(false);
    }, [brandedProjectId, category, tags, description, publishWorkflow, updateMeta]);

    const handleUnpublish = useCallback(async () => {
        await unpublishWorkflow.mutateAsync({ projectId: brandedProjectId });
        setOpen(false);
    }, [brandedProjectId, unpublishWorkflow]);

    const handleUpdateMeta = useCallback(async () => {
        await updateMeta.mutateAsync({
            category,
            description,
            projectId: brandedProjectId,
            tags,
        });
        setOpen(false);
    }, [brandedProjectId, category, tags, description, updateMeta]);

    const isPending = publishWorkflow.isPending || unpublishWorkflow.isPending || updateMeta.isPending;

    return (
        <Dialog onOpenChange={setOpen} open={open}>
            <DialogTrigger
                render={
                    trigger ?? (
                        <Button size="sm" variant={isPublished ? "outline" : "default"}>
                            {isPublished ? (
                                <>
                                    <Globe className="mr-1.5 size-4" />
                                    <Trans>Published</Trans>
                                </>
                            ) : (
                                <>
                                    <Globe className="mr-1.5 size-4" />
                                    <Trans>Publish</Trans>
                                </>
                            )}
                        </Button>
                    )
                }
            />

            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{isPublished ? <Trans>Manage Publication</Trans> : <Trans>Publish to Gallery</Trans>}</DialogTitle>
                    <DialogDescription>
                        {isPublished ? (
                            <Trans>Update your workflow&apos;s gallery settings or unpublish it.</Trans>
                        ) : (
                            <Trans>Share your workflow with the community. Others can browse, view, and fork it.</Trans>
                        )}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div className="space-y-2">
                        <Label>
                            <Trans>Description</Trans>
                        </Label>
                        <Textarea
                            className="resize-none"
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder={t`Describe what this workflow does...`}
                            rows={3}
                            value={description}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label>
                            <Trans>Category</Trans>
                        </Label>
                        <Select onValueChange={(v) => setCategory(v as GalleryCategory)} value={category}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {CATEGORIES.map((cat) => (
                                    <SelectItem key={cat.value} value={cat.value}>
                                        {i18n._(cat.label)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="publish-tag-input">
                            <Trans>Tags (up to 10)</Trans>
                        </Label>
                        <div className="flex gap-2">
                            <Input
                                className="flex-1"
                                disabled={tags.length >= 10}
                                id="publish-tag-input"
                                onChange={(e) => setTagInput(e.target.value)}
                                onKeyDown={handleTagKeyDown}
                                placeholder={t`Add a tag...`}
                                value={tagInput}
                            />
                            <Button disabled={!tagInput.trim() || tags.length >= 10} onClick={handleAddTag} size="sm" type="button" variant="outline">
                                <Trans>Add</Trans>
                            </Button>
                        </div>
                        {tags.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {tags.map((tag) => (
                                    <Badge className="gap-1 pr-1" key={tag} variant="secondary">
                                        {tag}
                                        <button
                                            aria-label={t`Remove tag ${tag}`}
                                            className="hover:bg-muted-foreground/20 rounded-full p-0.5"
                                            onClick={() => handleRemoveTag(tag)}
                                            type="button"
                                        >
                                            <X aria-hidden="true" className="size-3" />
                                        </button>
                                    </Badge>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <DialogFooter className="flex gap-2">
                    {isPublished ? (
                        <>
                            <Button disabled={isPending} onClick={handleUnpublish} size="sm" variant="destructive">
                                <Lock className="mr-1.5 size-4" />
                                <Trans>Unpublish</Trans>
                            </Button>
                            <Button disabled={isPending} onClick={handleUpdateMeta} size="sm">
                                <Trans>Save Changes</Trans>
                            </Button>
                        </>
                    ) : (
                        <Button disabled={isPending} onClick={handlePublish}>
                            <Globe className="mr-1.5 size-4" />
                            {isPending ? <Trans>Publishing...</Trans> : <Trans>Publish to Gallery</Trans>}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

const PublishDialog = memo(PublishDialogComponent);

export default PublishDialog;
