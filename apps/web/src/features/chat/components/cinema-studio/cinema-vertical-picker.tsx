"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getCinemaAssetUrl } from "./cinema-assets";

interface PickerOption<T> {
    description: string;
    id: T | undefined;
    label: string;
}

interface CinemaVerticalPickerProps<T extends string | number> {
    isOpen?: boolean;
    onChange: (value: T | undefined) => void;
    options: PickerOption<T>[];
    title: string;
    value?: T;
}

const ITEM_HEIGHT = 68;
const CONTAINER_HEIGHT = 252; // ~3.7 items visible

const CinemaVerticalPicker = <T extends string | number>({ isOpen, onChange, options, title, value }: CinemaVerticalPickerProps<T>) => {
    const { t } = useLingui();
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const itemReferences = useRef<Map<number, HTMLDivElement>>(new Map());
    const [isFocused, setIsFocused] = useState(false);

    const currentIndex = value === undefined ? 0 : options.findIndex((opt) => opt.id === value);
    const selectedIndex = currentIndex === -1 ? 0 : currentIndex;

    const scrollToItem = useCallback((index: number, behavior: ScrollBehavior = "smooth") => {
        const list = listRef.current;
        const element = itemReferences.current.get(index);

        if (element && list) {
            const itemTop = element.offsetTop;
            const itemCenter = itemTop + ITEM_HEIGHT / 2;
            const containerCenter = CONTAINER_HEIGHT / 2;
            const scrollPosition = itemCenter - containerCenter;

            list.scrollTo({ behavior, top: scrollPosition });
        }
    }, []);

    const selectItem = (index: number, fromButton = false) => {
        if (!(index >= 0 && index < options.length)) {
            return;
        }

        const option = options[index];

        if (option) {
            onChange(option.id);
        }

        scrollToItem(index, "smooth");

        if (fromButton && containerRef.current) {
            containerRef.current.focus();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            selectItem(Math.max(0, selectedIndex - 1));
            requestAnimationFrame(() => {
                containerRef.current?.focus();
            });
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            selectItem(Math.min(options.length - 1, selectedIndex + 1));
            requestAnimationFrame(() => {
                containerRef.current?.focus();
            });
        }
    };

    useEffect(() => {
        if (isOpen) {
            requestAnimationFrame(() => {
                scrollToItem(selectedIndex, "instant");
            });
        }
    }, [isOpen, selectedIndex, scrollToItem]);

    const canScrollUp = selectedIndex > 0;
    const canScrollDown = selectedIndex < options.length - 1;

    return (
        <div
            aria-activedescendant={`picker-option-${selectedIndex}`}
            aria-label={title}
            aria-orientation="vertical"
            className="relative flex w-full flex-col items-stretch focus:outline-none"
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setIsFocused(false);
                }
            }}
            onFocus={() => setIsFocused(true)}
            onKeyDown={handleKeyDown}
            ref={containerRef}
            role="listbox"
            tabIndex={0}
        >
            {/* Column header + nav controls */}
            <div className="mb-2 flex items-center justify-between px-0.5">
                <span
                    className={cn(
                        "text-[9px] font-bold tracking-[0.22em] uppercase transition-colors duration-150 select-none",
                        isFocused ? "text-foreground" : "text-muted-foreground/60",
                    )}
                    id={`${title}-label`}
                >
                    {title}
                </span>

                <div className="flex items-center gap-0.5">
                    <button
                        aria-hidden="true"
                        aria-label={t`Previous option`}
                        className={cn(
                            "flex h-5 w-5 items-center justify-center rounded transition-all duration-150",
                            canScrollUp
                                ? "text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
                                : "text-muted-foreground/25 cursor-not-allowed",
                        )}
                        disabled={!canScrollUp}
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            selectItem(selectedIndex - 1, true);
                        }}
                        tabIndex={-1}
                        type="button"
                    >
                        <ChevronUp className="h-3 w-3" strokeWidth={2} />
                    </button>
                    <button
                        aria-hidden="true"
                        aria-label={t`Next option`}
                        className={cn(
                            "flex h-5 w-5 items-center justify-center rounded transition-all duration-150",
                            canScrollDown
                                ? "text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
                                : "text-muted-foreground/25 cursor-not-allowed",
                        )}
                        disabled={!canScrollDown}
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            selectItem(selectedIndex + 1, true);
                        }}
                        tabIndex={-1}
                        type="button"
                    >
                        <ChevronDown className="h-3 w-3" strokeWidth={2} />
                    </button>
                </div>
            </div>

            {/* Picker viewport */}
            <div
                className={cn(
                    "relative w-full overflow-hidden rounded-lg border transition-all duration-200",
                    isFocused ? "border-primary/50 ring-primary/15 ring-2" : "border-border",
                )}
                style={{ height: CONTAINER_HEIGHT }}
            >
                {/* Top fade — color matches bg-card */}
                <div className="from-card via-card/80 pointer-events-none absolute top-0 right-0 left-0 z-20 h-12 bg-gradient-to-b to-transparent" />
                {/* Bottom fade */}
                <div className="from-card via-card/80 pointer-events-none absolute right-0 bottom-0 left-0 z-20 h-12 bg-gradient-to-t to-transparent" />

                {/* Active item selection frame */}
                <div className="pointer-events-none absolute top-1/2 right-0 left-0 z-10 -translate-y-1/2" style={{ height: ITEM_HEIGHT }}>
                    {/* Hairline rules */}
                    <div className="bg-border/80 absolute top-0 right-3 left-3 h-px" />
                    <div className="bg-border/80 absolute right-3 bottom-0 left-3 h-px" />
                    {/* Lime left accent — the cinema signature mark */}
                    <div className="bg-primary absolute top-2 bottom-2 left-0 w-[2px] rounded-r-sm" />
                    {/* Background tint */}
                    <div className="bg-muted/50 absolute inset-0" />
                </div>

                {/* Scrollable list */}
                <div
                    className="scrollbar-hide relative z-10 h-full overflow-x-hidden overflow-y-auto"
                    ref={listRef}
                    role="presentation"
                    style={{
                        scrollPaddingBlock: `${(CONTAINER_HEIGHT - ITEM_HEIGHT) / 2}px`,
                        scrollSnapType: "y mandatory",
                    }}
                >
                    <div aria-hidden="true" style={{ height: (CONTAINER_HEIGHT - ITEM_HEIGHT) / 2 }} />

                    {options.map((option, index) => {
                        const isActive = index === selectedIndex;
                        const imageUrl = option.id === undefined ? null : getCinemaAssetUrl(String(option.id));

                        return (
                            <div
                                aria-label={`${option.label}, ${option.description}`}
                                aria-selected={isActive}
                                className="flex cursor-pointer items-center gap-2.5 px-3 select-none"
                                data-index={index}
                                id={`picker-option-${index}`}
                                key={String(option.id ?? `none-${index}`)}
                                onClick={(e) => {
                                    e.preventDefault();
                                    selectItem(index);
                                    containerRef.current?.focus();
                                }}
                                onKeyDown={(e) => {
                                    // Unreachable in practice — the listbox keeps focus and drives
                                    // selection via `aria-activedescendant` — but an option that can
                                    // hold focus has to answer to the keyboard as well as the mouse.
                                    if (e.key !== "Enter" && e.key !== " ") {
                                        return;
                                    }

                                    e.preventDefault();
                                    selectItem(index);
                                    containerRef.current?.focus();
                                }}
                                onMouseDown={(e) => e.preventDefault()}
                                ref={(element) => {
                                    if (element) {
                                        itemReferences.current.set(index, element);
                                    } else {
                                        itemReferences.current.delete(index);
                                    }
                                }}
                                role="option"
                                style={{
                                    height: ITEM_HEIGHT,
                                    scrollSnapAlign: "center",
                                    scrollSnapStop: "always",
                                }}
                                tabIndex={-1}
                            >
                                {/* Thumbnail */}
                                <div
                                    className={cn(
                                        "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md p-1 transition-all duration-200",
                                        "bg-muted",
                                        isActive ? "ring-primary/30 opacity-100 ring-1" : "opacity-30",
                                    )}
                                >
                                    {imageUrl && <img alt={option.label} className="h-full w-full object-contain" src={imageUrl} />}
                                    {!imageUrl && typeof option.id === "number" && (
                                        <span
                                            className={cn(
                                                "font-mono text-sm font-bold tabular-nums transition-colors duration-200",
                                                isActive ? "text-foreground" : "text-muted-foreground",
                                            )}
                                        >
                                            {option.id}
                                        </span>
                                    )}
                                    {!imageUrl && typeof option.id !== "number" && (
                                        <div
                                            className={cn(
                                                "rounded-full transition-all duration-200",
                                                isActive ? "bg-primary h-3 w-3" : "bg-muted-foreground/30 h-2 w-2",
                                            )}
                                        />
                                    )}
                                </div>

                                {/* Label + description */}
                                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span
                                        className={cn(
                                            "truncate text-[11px] leading-tight font-semibold transition-colors duration-200",
                                            isActive ? "text-foreground" : "text-muted-foreground/40",
                                        )}
                                    >
                                        {option.label}
                                    </span>
                                    {option.description && (
                                        <span
                                            className={cn(
                                                "truncate text-[9px] leading-tight transition-colors duration-200",
                                                isActive ? "text-muted-foreground" : "text-muted-foreground/25",
                                            )}
                                        >
                                            {option.description}
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    })}

                    <div aria-hidden="true" style={{ height: (CONTAINER_HEIGHT - ITEM_HEIGHT) / 2 }} />
                </div>
            </div>

            {/* Keyboard focus hint */}
            {isFocused && (
                <div aria-live="polite" className="mt-1.5 flex items-center gap-1 px-0.5" role="status">
                    <kbd className="bg-muted border-border text-muted-foreground inline-flex items-center rounded-sm border px-1 py-0.5 font-mono text-[9px] leading-none">
                        ↑↓
                    </kbd>
                    <span className="text-muted-foreground/50 text-[9px]">
                        <Trans>navigate</Trans>
                    </span>
                </div>
            )}
        </div>
    );
};

export default CinemaVerticalPicker;
