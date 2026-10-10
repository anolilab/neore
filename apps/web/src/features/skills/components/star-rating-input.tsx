"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { Star } from "lucide-react";
import { useId, useState } from "react";

interface StarRatingInputProps {
    disabled?: boolean;
    legend: string;
    onChange: (rating: number) => void;
    value: number | null;
}

const STARS = [1, 2, 3, 4, 5] as const;

/**
 * Five native radio inputs styled as stars. Native radios give arrow-key
 * navigation and a correct accessible name for free; the star icons are
 * decorative.
 */
const StarRatingInput = ({ disabled, legend, onChange, value }: StarRatingInputProps) => {
    const { t } = useLingui();
    const name = useId();
    const [hovered, setHovered] = useState<number | null>(null);
    const shown = hovered ?? value ?? 0;

    return (
        <fieldset className="space-y-1" disabled={disabled} onMouseLeave={() => setHovered(null)}>
            <legend className="text-sm font-medium">{legend}</legend>
            <div className="flex items-center gap-1">
                {STARS.map((star) => {
                    const id = `${name}-${star}`;

                    return (
                        <span key={star}>
                            <input
                                checked={value === star}
                                className="peer sr-only"
                                id={id}
                                name={name}
                                onChange={() => onChange(star)}
                                type="radio"
                                value={star}
                            />
                            <label
                                className={cn(
                                    "peer-focus-visible:ring-ring inline-flex cursor-pointer rounded-sm p-0.5 peer-focus-visible:ring-2",
                                    disabled && "cursor-not-allowed opacity-60",
                                )}
                                htmlFor={id}
                                onMouseEnter={() => setHovered(star)}
                            >
                                <Star aria-hidden="true" className={cn("size-5", star <= shown ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} />
                                <span className="sr-only">{t`${plural(star, { one: "# star", other: "# stars" })}`}</span>
                            </label>
                        </span>
                    );
                })}
            </div>
        </fieldset>
    );
};

export default StarRatingInput;
