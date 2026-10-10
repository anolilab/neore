"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { ImagePlus } from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense, useCallback, useState } from "react";

import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";
import { selectAttachedReferences, selectSetAttachedReferences, useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

const ReferencePickerDialog = lazy(() => import("@/features/chat/components/reference-picker/reference-picker-dialog"));

interface ComposerReferencesButtonProps {
    disabled?: boolean;
    /** Per-model cap on how many references can be attached. Button is hidden when this is 0. */
    maxReferenceImages: number;
    /** Thread the references are being attached to. Enables the "This thread" tab. */
    threadId?: string;
}

/**
 * Toolbar button that opens the reference image picker dialog. The dialog itself
 * is code-split so threads/models that don't support references pay no bundle cost.
 */
const ComposerReferencesButton: FC<ComposerReferencesButtonProps> = ({ disabled, maxReferenceImages, threadId }) => {
    const { t } = useLingui();
    const [open, setOpen] = useState(false);

    const attachedReferences = useChatUIStore(selectAttachedReferences);
    const setAttachedReferences = useChatUIStore(selectSetAttachedReferences);

    const handleConfirm = useCallback(
        (references: ReferenceSelection[]) => {
            setAttachedReferences(references);
        },
        [setAttachedReferences],
    );

    if (maxReferenceImages <= 0) return null;

    const count = attachedReferences.length;
    // Use the `plural` macro so inflected languages (e.g. ru, pl) can pick the right
    // noun form — a raw interpolation would ship "1 references" / "2 reference".
    const tooltipLabel =
        count > 0
            ? t`${plural(count, { one: `# of ${maxReferenceImages} reference attached`, other: `# of ${maxReferenceImages} references attached` })}`
            : t`Add reference images (up to ${maxReferenceImages})`;

    return (
        <>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <Button aria-label={tooltipLabel} disabled={disabled} onClick={() => setOpen(true)} size="sm" type="button" variant="ghost">
                            <ImagePlus aria-hidden="true" className="size-4" />
                            {count > 0 && (
                                <span aria-hidden="true" className="ml-1 text-xs font-semibold tabular-nums">
                                    {count}
                                </span>
                            )}
                        </Button>
                    }
                />
                <TooltipContent>{tooltipLabel}</TooltipContent>
            </Tooltip>

            {open && (
                <Suspense fallback={null}>
                    <ReferencePickerDialog
                        initialSelection={attachedReferences}
                        maxReferences={maxReferenceImages}
                        onConfirm={handleConfirm}
                        onOpenChange={setOpen}
                        open={open}
                        threadId={threadId}
                    />
                </Suspense>
            )}
        </>
    );
};

export default ComposerReferencesButton;
