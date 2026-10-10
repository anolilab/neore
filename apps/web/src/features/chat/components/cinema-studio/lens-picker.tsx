"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { localizeCinemaOptions } from "./cinema-option-labels";
import type { LensType } from "./types";
import { LENS_OPTIONS } from "./types";

interface LensPickerProps {
    onChange: (value: LensType) => void;
    value?: LensType;
}

const LensPicker: FC<LensPickerProps> = ({ onChange, value }) => {
    const { i18n } = useLingui();
    const scrollRef = useRef<HTMLDivElement>(null);
    const [activeIndex, setActiveIndex] = useState(value ? LENS_OPTIONS.findIndex((o) => o.id === value) : 0);

    // An Effect Event so the scroll listener is attached once instead of being
    // torn down and re-added on every `activeIndex` change and parent redraw.
    const onLensCentered = useEffectEvent((closestIndex: number) => {
        if (closestIndex === activeIndex) {
            return;
        }

        setActiveIndex(closestIndex);

        const opt = LENS_OPTIONS[closestIndex];

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
            const items = container.querySelectorAll("[data-lens-option]");
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

            onLensCentered(closestIndex);
        };

        container.addEventListener("scroll", handleScroll);

        return () => container.removeEventListener("scroll", handleScroll);
    }, []);

    return (
        <div className="relative">
            <div className="scrollbar-hide flex snap-x snap-mandatory gap-2 overflow-x-auto pb-2" ref={scrollRef} style={{ scrollPadding: "0 50%" }}>
                {localizeCinemaOptions("lens", LENS_OPTIONS, (descriptor) => i18n._(descriptor)).map((option, index) => (
                    <button
                        className={cn(
                            "shrink-0 snap-center rounded-lg border px-4 py-3 transition-all",
                            "bg-muted/30 hover:bg-muted/50 backdrop-blur-sm",
                            index === activeIndex && "bg-primary/20 border-primary ring-primary/50 scale-105 ring-2",
                        )}
                        data-lens-option
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

export default LensPicker;
