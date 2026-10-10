"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { X } from "lucide-react";
import type { FC } from "react";

import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";

interface ReferenceStripProps {
    className?: string;
    /** Show numbered badges 1..N on each thumbnail. */
    numbered?: boolean;
    onRemove: (id: string) => void;
    references: ReferenceSelection[];
}

/**
 * Compact strip of selected reference-image thumbnails rendered above the
 * composer textarea. Each chip carries an ordinal badge (1, 2, 3...) so the
 * user can see — and the downstream prompt can hint at — the order the model
 * will receive them in.
 */
const ReferenceStrip: FC<ReferenceStripProps> = ({ className, numbered = true, onRemove, references }) => {
    const { t } = useLingui();

    if (references.length === 0) return null;

    return (
        <ul aria-label={t`Reference images`} aria-live="polite" className={cn("flex flex-wrap gap-2", className)}>
            {references.map((ref, index) => {
                const ordinal = index + 1;

                return (
                    <li className="group relative size-14 overflow-hidden rounded-md border" key={ref.id}>
                        <img alt={t`Reference ${ordinal}`} className="size-full object-cover" loading="lazy" src={ref.url} />

                        {numbered && (
                            <span
                                aria-hidden="true"
                                className="bg-primary text-primary-foreground absolute bottom-0.5 left-0.5 flex size-4 items-center justify-center rounded-full text-[10px] leading-none font-semibold"
                            >
                                {ordinal}
                            </span>
                        )}

                        <button
                            aria-label={t`Remove reference image ${ordinal}`}
                            className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={() => onRemove(ref.id)}
                            type="button"
                        >
                            <X aria-hidden="true" className="size-3" />
                        </button>
                    </li>
                );
            })}
        </ul>
    );
};

export default ReferenceStrip;
