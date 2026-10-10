import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/components/card";
import { Eye, GitFork, Sparkles, Workflow } from "lucide-react";

import type { GalleryCategory, GalleryWorkflow } from "../../hooks/use-gallery";

interface GalleryCardProps {
    onClick?: (workflow: GalleryWorkflow) => void;
    workflow: GalleryWorkflow;
}

const CATEGORY_COLORS: Record<GalleryCategory, string> = {
    audio: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    automation: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    image: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    text: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    video: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

/** Display names for the gallery categories. */
const GALLERY_CATEGORY_LABELS: Record<GalleryCategory, MessageDescriptor> = {
    audio: msg`Audio`,
    automation: msg`Automation`,
    image: msg`Image`,
    text: msg`Text`,
    video: msg`Video`,
};

/** Translatable name of a gallery category, or `undefined` for an unknown/absent one. */
export const getGalleryCategoryLabel = (category: string | null | undefined): MessageDescriptor | undefined =>
    category && Object.hasOwn(GALLERY_CATEGORY_LABELS, category) ? GALLERY_CATEGORY_LABELS[category as GalleryCategory] : undefined;

const formatCount = (count: number): string => {
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;

    return String(count);
};

const GalleryCard = ({ onClick, workflow }: GalleryCardProps) => {
    const { i18n } = useLingui();
    const categoryLabel = getGalleryCategoryLabel(workflow.galleryCategory);
    const categoryColor = workflow.galleryCategory ? CATEGORY_COLORS[workflow.galleryCategory] : CATEGORY_COLORS.automation;

    return (
        <Card className="hover:border-primary/50 group relative cursor-pointer transition-colors" onClick={() => onClick?.(workflow)}>
            {workflow.galleryFeatured && (
                <div className="absolute top-2 right-2">
                    <Sparkles className="size-4 text-amber-500" />
                </div>
            )}

            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2">
                    <div
                        className="flex size-8 shrink-0 items-center justify-center rounded"
                        style={{
                            backgroundColor: workflow.color ? `${workflow.color}20` : "var(--muted)",
                            color: workflow.color ?? "var(--muted-foreground)",
                        }}
                    >
                        <Workflow className="size-4" />
                    </div>
                    <span className="truncate text-sm">{workflow.title}</span>
                </CardTitle>
                {workflow.description && <CardDescription className="line-clamp-2 text-xs">{workflow.description}</CardDescription>}
            </CardHeader>

            <CardContent className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge className={`px-1.5 py-0 text-[10px] ${categoryColor}`} variant="secondary">
                        {categoryLabel ? i18n._(categoryLabel) : workflow.galleryCategory}
                    </Badge>
                    {workflow.galleryTags.slice(0, 3).map((tag) => (
                        <Badge className="px-1.5 py-0 text-[10px]" key={tag} variant="outline">
                            {tag}
                        </Badge>
                    ))}
                </div>

                <div className="text-muted-foreground flex items-center gap-3 text-xs">
                    <span className="flex items-center gap-1">
                        <Workflow className="size-3" />
                        <Plural one="# node" other="# nodes" value={workflow.nodeCount} />
                    </span>
                    <span className="flex items-center gap-1">
                        <GitFork className="size-3" />
                        {formatCount(workflow.galleryForkCount)}
                    </span>
                    <span className="flex items-center gap-1">
                        <Eye className="size-3" />
                        {formatCount(workflow.galleryViewCount)}
                    </span>
                </div>
            </CardContent>
        </Card>
    );
};

export default GalleryCard;
