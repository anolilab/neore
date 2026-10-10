"use client";

/**
 * SlideEditorDialog
 *
 * A dialog for editing a single slide's title and HTML content.
 * Uses the cRPC `updateSlide` mutation to persist changes.
 */

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { Pencil, Save, X } from "lucide-react";
import { useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

interface SlideEditorDialogProps {
    htmlContent: string;
    onOpenChange: (open: boolean) => void;
    onSaved?: () => void;
    open: boolean;
    slideId: string;
    slideNumber: number;
    title: string;
}

const SlideEditorDialog = ({ htmlContent: initialHtml, onOpenChange, onSaved, open, slideId, slideNumber, title: initialTitle }: SlideEditorDialogProps) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const [title, setTitle] = useState(initialTitle);
    const [htmlContent, setHtmlContent] = useState(initialHtml);

    // Reset state when dialog opens with new data
    const handleOpenChange = (nextOpen: boolean) => {
        if (nextOpen) {
            setTitle(initialTitle);
            setHtmlContent(initialHtml);
        }

        onOpenChange(nextOpen);
    };

    const updateMutation = useMutation(
        crpc.chat.slides.functions.updateSlide.mutationOptions({
            onSuccess: () => {
                onOpenChange(false);
                onSaved?.();
            },
        }),
    );

    const handleSave = () => {
        const patch: { htmlContent?: string; slideId: string; title?: string } = { slideId };

        if (title !== initialTitle) patch.title = title;

        if (htmlContent !== initialHtml) patch.htmlContent = htmlContent;

        // Only mutate if something changed
        if (patch.title || patch.htmlContent) {
            updateMutation.mutate(patch);
        } else {
            onOpenChange(false);
        }
    };

    const hasChanges = title !== initialTitle || htmlContent !== initialHtml;

    return (
        <Dialog onOpenChange={handleOpenChange} open={open}>
            <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Pencil className="size-4" />
                        <Trans>Edit Slide {slideNumber}</Trans>
                    </DialogTitle>
                    <DialogDescription>
                        <Trans>Modify the slide title and HTML content directly.</Trans>
                    </DialogDescription>
                </DialogHeader>

                <div className="flex-1 space-y-4 overflow-y-auto py-2">
                    <div className="space-y-2">
                        <Label htmlFor="slide-title">
                            <Trans>Title</Trans>
                        </Label>
                        <Input id="slide-title" onChange={(e) => setTitle(e.target.value)} placeholder={t`Slide title`} value={title} />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="slide-html">
                            <Trans>HTML Content</Trans>
                        </Label>
                        <Textarea
                            className="min-h-[300px] resize-y font-mono text-xs"
                            id="slide-html"
                            onChange={(e) => setHtmlContent(e.target.value)}
                            placeholder="<h1>Slide content...</h1>"
                            rows={18}
                            value={htmlContent}
                        />
                    </div>
                </div>

                <DialogFooter className="gap-2">
                    <Button disabled={updateMutation.isPending} onClick={() => onOpenChange(false)} variant="ghost">
                        <X className="mr-1.5 size-3.5" />
                        <Trans>Cancel</Trans>
                    </Button>
                    <Button disabled={!hasChanges || updateMutation.isPending} onClick={handleSave}>
                        <Save className="mr-1.5 size-3.5" />
                        {updateMutation.isPending ? t`Saving...` : t`Save`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default SlideEditorDialog;
