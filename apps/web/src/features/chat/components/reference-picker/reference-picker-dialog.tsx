"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/dialog";
import { ImageGallery, ImageGalleryEmpty, ImageGalleryGrid } from "@neore/ui/components/image-gallery";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import { AlertCircle, ImageIcon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useMemo, useState } from "react";

import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";
import type { ReferencePickerScope } from "@/features/chat/components/reference-picker/use-reference-picker-candidates";
import useReferencePickerCandidates from "@/features/chat/components/reference-picker/use-reference-picker-candidates";
import { ErrorUtilities } from "@/lib/errors";

interface ReferencePickerDialogProps {
    /** Pre-existing selection (ordered) when the dialog opens. */
    initialSelection?: ReferenceSelection[];

    /**
     * Per-model cap on how many references the picker may return.
     * Comes from `modelDefinition.maxReferenceImages`.
     */
    maxReferences: number;
    /** Confirms the picker with the final ordered selection. */
    onConfirm: (references: ReferenceSelection[]) => void;
    /** Close-only handler (cancel button, escape, backdrop). */
    onOpenChange: (open: boolean) => void;
    /** Whether the dialog is open. */
    open: boolean;
    /** When provided, the "This thread" tab is the default; absent → only "All my images". */
    threadId?: string;
}

const PAGE_SIZE = 60;

/**
 * Reconcile the gallery's post-toggle id list with our ordered selection: keep the
 * previous order for ids that survived, then append the newcomers.
 */
const mergeSelection = (current: ReferenceSelection[], ids: string[], items: { id: string; mimeType: string; url: string }[]): ReferenceSelection[] => {
    const sourceById = new Map(items.map((item) => [item.id, item] as const));
    const idSet = new Set(ids);
    const next: ReferenceSelection[] = [];
    const nextIds = new Set<string>();

    for (const ref of current) {
        if (!idSet.has(ref.id)) {
            continue;
        }

        next.push(ref);
        nextIds.add(ref.id);
    }

    for (const id of ids) {
        if (nextIds.has(id)) {
            continue;
        }

        const item = sourceById.get(id);

        if (item) {
            next.push({ id: item.id, mimeType: item.mimeType, url: item.url });
        }
    }

    return next;
};

/**
 * Cross-thread image picker. Two scopes share a selection state so a user can
 * pick one image from the current thread and one from elsewhere without losing
 * the first when they switch tabs.
 */
const ReferencePickerDialog: FC<ReferencePickerDialogProps> = ({ initialSelection, maxReferences, onConfirm, onOpenChange, open, threadId }) => {
    const { i18n, t } = useLingui();

    const [scope, setScope] = useState<ReferencePickerScope>(threadId ? "thread" : "all");
    const [selection, setSelection] = useState<ReferenceSelection[]>(() => (initialSelection ?? []).slice(0, maxReferences));

    // Reset state every time the dialog re-opens so a previous session's
    // partial selection doesn't bleed in. The clamp to `maxReferences` matters
    // when the caller hands us a selection that pre-dates a model swap: the
    // new model may permit fewer references than the old one.
    // Adjusted during render rather than in an effect, so the dialog never paints
    // once with the previous session's selection.
    const [previousInputs, setPreviousInputs] = useState<{
        initialSelection: ReferenceSelection[] | undefined;
        maxReferences: number;
        open: boolean;
        threadId: string | undefined;
    }>();

    if (
        open !== previousInputs?.open ||
        initialSelection !== previousInputs.initialSelection ||
        threadId !== previousInputs.threadId ||
        maxReferences !== previousInputs.maxReferences
    ) {
        setPreviousInputs({ initialSelection, maxReferences, open, threadId });

        if (open) {
            setScope(threadId ? "thread" : "all");
            setSelection((initialSelection ?? []).slice(0, maxReferences));
        }
    }

    const threadQuery = useReferencePickerCandidates({
        enabled: open && Boolean(threadId),
        numItems: PAGE_SIZE,
        scope: "thread",
        threadId,
    });

    const allQuery = useReferencePickerCandidates({
        enabled: open,
        numItems: PAGE_SIZE,
        scope: "all",
    });

    const selectedIds = useMemo(() => selection.map((r) => r.id), [selection]);

    const handleConfirm = useCallback(() => {
        onConfirm(selection);
        onOpenChange(false);
    }, [onConfirm, onOpenChange, selection]);

    const handleClear = useCallback(() => {
        setSelection([]);
    }, []);

    const renderGrid = (data: typeof allQuery.data, isLoading: boolean, error: unknown, scopeForGrid: ReferencePickerScope) => {
        if (isLoading) {
            return (
                <div aria-label={t`Loading images`} className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4" role="status">
                    {Array.from({ length: 8 }, (_, index) => (
                        <Skeleton className="aspect-square w-full rounded-lg" key={index} />
                    ))}
                </div>
            );
        }

        if (error) {
            return (
                <div
                    className="bg-destructive/10 border-destructive/20 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                    role="alert"
                >
                    <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span>{ErrorUtilities.getUserMessage(error as Error, i18n)}</span>
                </div>
            );
        }

        const items = data?.items ?? [];

        if (items.length === 0) {
            return (
                <ImageGallery items={[]} selectionEnabled={false}>
                    <ImageGalleryEmpty
                        description={
                            scopeForGrid === "thread"
                                ? t`Upload an image or generate one in this conversation to use it as a reference.`
                                : t`Upload an image to any thread or generate one with an image model.`
                        }
                        icon={<ImageIcon aria-hidden="true" className="text-muted-foreground mb-4 size-12" />}
                        title={t`No images yet`}
                    />
                </ImageGallery>
            );
        }

        const galleryItems = items.map((item) => {
            return {
                alt: item.threadTitle ?? undefined,
                createdAt: new Date(item.createdAt),
                id: item.id,
                src: item.url,
                thumbnail: item.thumbnailUrl ?? item.url,
                type: "image" as const,
            };
        });

        return (
            <ImageGallery
                items={galleryItems}
                maxSelections={maxReferences}
                onSelectionChange={(ids) => {
                    // ImageGallery returns the post-toggle selection. Use it to keep our
                    // ordered list in sync — preserving the user-visible order is what
                    // makes numbered badges (Phase 3) meaningful.
                    setSelection((current) => mergeSelection(current, ids, items));
                }}
                selectedIds={selectedIds}
                selectionEnabled
            >
                <ImageGalleryGrid />
            </ImageGallery>
        );
    };

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{t`Add reference images`}</DialogTitle>
                    <DialogDescription>
                        {t`Pick up to ${maxReferences} images. The order you select them is the order the model will see them.`}
                    </DialogDescription>
                </DialogHeader>

                <Tabs
                    onValueChange={(value) => {
                        if (value === "thread" || value === "all") {
                            setScope(value);
                        }
                    }}
                    value={scope}
                >
                    {threadId && (
                        <TabsList>
                            <TabsTrigger value="thread">{t`This thread`}</TabsTrigger>
                            <TabsTrigger value="all">{t`All my images`}</TabsTrigger>
                        </TabsList>
                    )}

                    {/* Only mount the thread panel when there's a threadId. Otherwise
                        the panel sits hidden in the DOM with a `skipToken`-paused query
                        that reports `isPending === true` forever, which would broadcast
                        a permanent "Loading images" status to assistive tech. */}
                    {threadId && (
                        <TabsContent className="mt-3 max-h-[55vh] overflow-y-auto pr-1" value="thread">
                            {renderGrid(threadQuery.data, threadQuery.isPending, threadQuery.error, "thread")}
                        </TabsContent>
                    )}

                    <TabsContent className="mt-3 max-h-[55vh] overflow-y-auto pr-1" value="all">
                        {renderGrid(allQuery.data, allQuery.isPending, allQuery.error, "all")}
                    </TabsContent>
                </Tabs>

                <DialogFooter className="items-center gap-2 sm:gap-2">
                    <span aria-live="polite" className="text-muted-foreground mr-auto text-xs" role="status">
                        {selection.length === 0 ? t`No references selected` : t`${selection.length} of ${maxReferences} selected`}
                    </span>
                    {selection.length > 0 && (
                        <Button onClick={handleClear} type="button" variant="ghost">
                            {t`Clear`}
                        </Button>
                    )}
                    <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
                        {t`Cancel`}
                    </Button>
                    <Button disabled={selection.length === 0} onClick={handleConfirm} type="button">
                        {selection.length === 0 ? t`Use selected` : t`Use ${plural(selection.length, { one: "# reference", other: "# references" })}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default ReferencePickerDialog;

export { type ReferenceSelection } from "@/features/chat/components/reference-picker/types";
