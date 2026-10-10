"use client";

/**
 * PresentationArtifact - Inline card shown in chat messages when a presentation is created.
 * Pure presentational component — viewer state is injected via onOpen prop.
 */

import { Plural, useLingui } from "@lingui/react/macro";
import { ExternalLinkIcon, Presentation } from "lucide-react";
import type { FC } from "react";
import { memo, useCallback } from "react";

import cn from "../utils/cn";

export interface PresentationArtifactProps {
    className?: string;
    /** Called when the user clicks the card. Optional — clicking is a no-op if omitted. */
    onOpen?: (presentationId: string, initialSlide?: number) => void;
    presentationId: string;
    slideCount: number;
    styleName?: string;
    title: string;
}

const PresentationArtifact: FC<PresentationArtifactProps> = memo(({ className, onOpen, presentationId, slideCount, styleName, title }) => {
    const { t } = useLingui();
    const handleClick = useCallback(() => {
        onOpen?.(presentationId, 1);
    }, [onOpen, presentationId]);

    return (
        <button
            className={cn(
                "group my-2 flex w-full max-w-sm items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                "hover:bg-accent hover:border-accent-foreground/20",
                className,
            )}
            onClick={handleClick}
            type="button"
        >
            <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md">
                <Presentation aria-hidden="true" className="text-muted-foreground size-5" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{title}</div>
                <div className="text-muted-foreground text-xs">
                    {t`Presentation`}
                    {slideCount > 0 ? (
                        <>
                            {" · "}
                            <Plural one="# slide" other="# slides" value={slideCount} />
                        </>
                    ) : null}
                    {styleName && styleName !== "default" ? ` · ${styleName}` : ""}
                </div>
            </div>
            <ExternalLinkIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
    );
});

PresentationArtifact.displayName = "PresentationArtifact";

export default PresentationArtifact;
