"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { localizeCinemaOptions } from "./cinema-option-labels";
import type { FocalLength } from "./types";
import { FOCAL_LENGTH_OPTIONS } from "./types";

interface FocalLengthPickerProps {
    onChange: (value: FocalLength) => void;
    value?: FocalLength;
}

const FocalLengthPicker: FC<FocalLengthPickerProps> = ({ onChange, value }) => {
    const { i18n } = useLingui();
    const scrollRef = useRef<HTMLDivElement>(null);
    const [activeIndex, setActiveIndex] = useState(
        value ? FOCAL_LENGTH_OPTIONS.findIndex((o) => o.id === value) : 4, // Default to 50mm
    );

    const onSnapToIndex = useEffectEvent((closestIndex: number) => {
        if (closestIndex === activeIndex) {
            return;
        }

        setActiveIndex(closestIndex);

        const opt = FOCAL_LENGTH_OPTIONS[closestIndex];

        if (opt?.id !== undefined) {
            onChange(opt.id);
        }
    });

    useEffect(() => {
        const container = scrollRef.current;

        if (!container) {
            return undefined;
        }

        const handleScroll = () => {
            const items = container.querySelectorAll("[data-focal-option]");
            const containerRect = container.getBoundingClientRect();
            const containerCenter = containerRect.left + containerRect.width / 2;

            let closestIndex = 0;
            let closestDistance = Infinity;

            items.forEach((item, index) => {
                const rect = item.getBoundingClientRect();
                const itemCenter = rect.left + rect.width / 2;
                const distance = Math.abs(containerCenter - itemCenter);

                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestIndex = index;
                }
            });

            onSnapToIndex(closestIndex);
        };

        container.addEventListener("scroll", handleScroll);

        return () => container.removeEventListener("scroll", handleScroll);
    }, []);

    return (
        <div className="relative">
            <div className="scrollbar-hide flex snap-x snap-mandatory gap-2 overflow-x-auto pb-2" ref={scrollRef} style={{ scrollPadding: "0 50%" }}>
                {localizeCinemaOptions("focalLength", FOCAL_LENGTH_OPTIONS, (descriptor) => i18n._(descriptor)).map((option, index) => (
                    <button
                        className={cn(
                            "shrink-0 snap-center rounded-lg border px-4 py-3 transition-all",
                            "bg-muted/30 hover:bg-muted/50 backdrop-blur-sm",
                            index === activeIndex && "bg-primary/20 border-primary ring-primary/50 scale-105 ring-2",
                        )}
                        data-focal-option
                        key={option.id}
                        onClick={() => {
                            setActiveIndex(index);

                            if (option.id !== undefined) {
                                onChange(option.id);
                            }
                        }}
                        type="button"
                    >
                        <div className="text-sm font-medium">{option.label}</div>
                        <div className="text-muted-foreground text-xs">{option.description}</div>
                    </button>
                ))}
            </div>
        </div>
    );
};

export default FocalLengthPicker;
