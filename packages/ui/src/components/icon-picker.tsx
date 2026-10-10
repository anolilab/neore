"use client";

import { useLingui } from "@lingui/react/macro";
import type { VirtualItem } from "@tanstack/react-virtual";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/popover";
import { Skeleton } from "@ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/components/tooltip";
import cn from "@ui/utils/cn";
import Fuse from "fuse.js";
import type { LucideIcon, LucideProps } from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import { DynamicIcon, dynamicIconImports } from "lucide-react/dynamic";
import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDebounce } from "rooks";

import type iconsData from "../data/icons-data";

export type IconData = (typeof iconsData)[number];

interface IconPickerProps extends Omit<React.ComponentPropsWithoutRef<typeof PopoverTrigger>, "onSelect" | "onOpenChange"> {
    categorized?: boolean;
    defaultOpen?: boolean;
    defaultValue?: IconName;
    iconsList?: IconData[];
    modal?: boolean;
    onOpenChange?: (open: boolean) => void;
    onValueChange?: (value: IconName) => void;
    open?: boolean;
    ref?: React.Ref<React.ComponentRef<typeof PopoverTrigger>>;
    searchable?: boolean;
    searchPlaceholder?: string;
    triggerPlaceholder?: string;
    value?: IconName;
}

const IconRenderer = React.memo(({ name }: { name: IconName }) => <Icon name={name} />);

IconRenderer.displayName = "IconRenderer";

const SKELETON_KEYS = Array.from({ length: 40 }, (_, index) => `icon-skeleton-${index}`);

const IconsColumnSkeleton = () => (
    <div className="flex w-full flex-col gap-2">
        <Skeleton className="h-4 w-1/2 rounded-md" />
        <div className="grid w-full grid-cols-5 gap-2">
            {SKELETON_KEYS.map((skeletonKey) => (
                <Skeleton className="h-10 w-10 rounded-md" key={skeletonKey} />
            ))}
        </div>
    </div>
);

const useIconsData = () => {
    const [icons, setIcons] = useState<IconData[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;

        const loadIcons = async () => {
            setIsLoading(true);

            const { default: iconsData } = await import("../data/icons-data");

            if (isMounted) {
                setIcons(iconsData.filter((icon: IconData) => icon.name in dynamicIconImports));
                setIsLoading(false);
            }
        };

        loadIcons();

        return () => {
            isMounted = false;
        };
    }, []);

    return { icons, isLoading };
};

const IconPicker = ({
    categorized = true,
    children,
    defaultOpen,
    defaultValue,
    iconsList,
    modal = false,
    onOpenChange,
    onValueChange,
    open,
    ref,
    searchable = true,
    searchPlaceholder,
    triggerPlaceholder,
    value,
    ...props
}: IconPickerProps) => {
    const { t } = useLingui();
    const [selectedIcon, setSelectedIcon] = useState<IconName | undefined>(defaultValue);
    const [isOpen, setIsOpen] = useState(defaultOpen || false);
    const [searchInput, setSearchInput] = useState("");
    const [search, setSearch] = useState("");
    const setSearchDebounced = useDebounce(setSearch, 100);
    const [isPopoverVisible, setIsPopoverVisible] = useState(false);
    const { icons } = useIconsData();
    const [isLoading, setIsLoading] = useState(true);

    const iconsToUse = useMemo(() => iconsList || icons, [iconsList, icons]);

    const fuseInstance = useMemo(
        () =>
            new Fuse(iconsToUse, {
                ignoreLocation: true,
                includeScore: true,
                keys: ["name", "tags", "categories"],
                threshold: 0.3,
            }),
        [iconsToUse],
    );

    const filteredIcons = useMemo(() => {
        if (search.trim() === "") {
            return iconsToUse;
        }

        const results = fuseInstance.search(search.toLowerCase().trim());

        return results.map((result) => result.item);
    }, [search, iconsToUse, fuseInstance]);

    // "All Icons" and "Other" are this picker's own group names (and scroll ids); the rest come from lucide's metadata.
    const getCategoryLabel = useCallback(
        (name: string): string => {
            if (name === "All Icons") {
                return t`All Icons`;
            }

            if (name === "Other") {
                return t`Other`;
            }

            return name.charAt(0).toUpperCase() + name.slice(1);
        },
        [t],
    );

    const categorizedIcons = useMemo(() => {
        if (!categorized || search.trim() !== "") {
            return [{ icons: filteredIcons, name: "All Icons" }];
        }

        const categories = new Map<string, IconData[]>();

        filteredIcons.forEach((icon) => {
            if (icon.categories && icon.categories.length > 0) {
                icon.categories.forEach((category) => {
                    if (!categories.has(category)) {
                        categories.set(category, []);
                    }

                    categories.get(category)!.push(icon);
                });
            } else {
                const category = "Other";

                if (!categories.has(category)) {
                    categories.set(category, []);
                }

                categories.get(category)!.push(icon);
            }
        });

        return [...categories]
            .map(([name, categoryIcons]) => {
                return { icons: categoryIcons, name };
            })
            .toSorted((a, b) => a.name.localeCompare(b.name));
    }, [filteredIcons, categorized, search]);

    const virtualItems = useMemo(() => {
        const items: {
            categoryIndex: number;
            icons?: IconData[];
            rowIndex?: number;
            type: "category" | "row";
        }[] = [];

        categorizedIcons.forEach((category, categoryIndex) => {
            items.push({ categoryIndex, type: "category" });

            const rows = [];

            for (let i = 0; i < category.icons.length; i += 5) {
                rows.push(category.icons.slice(i, i + 5));
            }

            rows.forEach((rowIcons, rowIndex) => {
                items.push({
                    categoryIndex,
                    icons: rowIcons,
                    rowIndex,
                    type: "row",
                });
            });
        });

        return items;
    }, [categorizedIcons]);

    const categoryIndices = useMemo(() => {
        const indices: Record<string, number> = {};

        virtualItems.forEach((item, index) => {
            if (item.type === "category") {
                indices[categorizedIcons[item.categoryIndex]?.name ?? ""] = index;
            }
        });

        return indices;
    }, [virtualItems, categorizedIcons]);

    const parentRef = React.useRef<HTMLDivElement>(null);

    const virtualizer = useVirtualizer({
        count: virtualItems.length,
        estimateSize: (index) => (virtualItems[index]?.type === "category" ? 25 : 40),
        gap: 10,
        getScrollElement: () => parentRef.current,
        overscan: 5,
        paddingEnd: 2,
    });

    const handleValueChange = useCallback(
        (icon: IconName) => {
            if (value === undefined) {
                setSelectedIcon(icon);
            }

            onValueChange?.(icon);
        },
        [value, onValueChange],
    );

    const handleOpenChange = useCallback(
        (newOpen: boolean) => {
            setSearchInput("");
            setSearch("");

            if (open === undefined) {
                setIsOpen(newOpen);
            }

            onOpenChange?.(newOpen);

            setIsPopoverVisible(newOpen);

            if (newOpen) {
                setIsLoading(true);

                setTimeout(() => {
                    virtualizer.measure();
                    setIsLoading(false);
                }, 1);
            }
        },
        [open, onOpenChange, virtualizer],
    );

    const handleIconClick = useCallback(
        (iconName: IconName) => {
            handleValueChange(iconName);
            setIsOpen(false);
            setSearchInput("");
            setSearch("");
        },
        [handleValueChange],
    );

    const handleSearchChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const { value: searchValue } = e.target;

            setSearchInput(searchValue);
            setSearchDebounced(searchValue);

            if (parentRef.current) {
                parentRef.current.scrollTop = 0;
            }

            virtualizer.scrollToOffset(0);
        },
        [virtualizer, setSearchDebounced],
    );

    const scrollToCategory = useCallback(
        (categoryName: string) => {
            const categoryIndex = categoryIndices[categoryName];

            if (categoryIndex !== undefined && virtualizer) {
                virtualizer.scrollToIndex(categoryIndex, {
                    align: "start",
                    behavior: "smooth",
                });
            }
        },
        [categoryIndices, virtualizer],
    );

    const categoryButtons = useMemo(() => {
        if (!categorized || search.trim() !== "") {
            return null;
        }

        return categorizedIcons.map((category) => (
            <Button
                className="text-xs"
                key={category.name}
                onClick={(e) => {
                    e.stopPropagation();
                    scrollToCategory(category.name);
                }}
                size="sm"
                variant="outline"
            >
                {getCategoryLabel(category.name)}
            </Button>
        ));
    }, [categorizedIcons, scrollToCategory, categorized, search, getCategoryLabel]);

    const renderIcon = useCallback(
        (icon: IconData) => (
            <TooltipProvider key={icon.name}>
                <Tooltip>
                    <TooltipTrigger
                        className={cn("hover:bg-foreground/10 rounded-md border p-2 transition", "flex items-center justify-center")}
                        onClick={() => handleIconClick(icon.name as IconName)}
                    >
                        <IconRenderer name={icon.name as IconName} />
                    </TooltipTrigger>
                    <TooltipContent>
                        <p>{icon.name}</p>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        ),
        [handleIconClick],
    );

    const renderVirtualContent = useCallback(() => {
        if (filteredIcons.length === 0) {
            return <div className="text-center text-gray-500">{t`No icon found`}</div>;
        }

        return (
            <div
                className="relative w-full overscroll-contain"
                style={{
                    height: `${virtualizer.getTotalSize()}px`,
                }}
            >
                {virtualizer.getVirtualItems().map((virtualItem: VirtualItem) => {
                    const item = virtualItems[virtualItem.index];

                    if (!item) {
                        return null;
                    }

                    const itemStyle = {
                        height: `${virtualItem.size}px`,
                        left: 0,
                        position: "absolute" as const,
                        top: 0,
                        transform: `translateY(${virtualItem.start}px)`,
                        width: "100%",
                    };

                    if (item.type === "category") {
                        return (
                            <div className="border-border top-0 z-10 border-b" key={virtualItem.key} style={itemStyle}>
                                <h3 className="text-sm font-medium capitalize">{getCategoryLabel(categorizedIcons[item.categoryIndex]?.name ?? "")}</h3>
                            </div>
                        );
                    }

                    return (
                        <div data-index={virtualItem.index} key={virtualItem.key} style={itemStyle}>
                            <div className="grid w-full grid-cols-5 gap-2">{item.icons!.map((icon) => renderIcon(icon))}</div>
                        </div>
                    );
                })}
            </div>
        );
    }, [virtualizer, virtualItems, categorizedIcons, filteredIcons, renderIcon, t, getCategoryLabel]);

    React.useEffect(() => {
        if (isPopoverVisible) {
            const timer = setTimeout(() => {
                setIsLoading(false);
                virtualizer.measure();
            }, 10);

            const resizeObserver = new ResizeObserver(() => {
                virtualizer.measure();
            });

            if (parentRef.current) {
                resizeObserver.observe(parentRef.current);
            }

            return () => {
                clearTimeout(timer);
                resizeObserver.disconnect();
            };
        }

        return undefined;
    }, [isPopoverVisible, virtualizer]);

    const defaultTrigger = (
        <Button ref={ref as React.Ref<HTMLButtonElement> | undefined} variant="outline">
            {value || selectedIcon ? (
                <>
                    <Icon name={(value || selectedIcon)!} /> {value || selectedIcon}
                </>
            ) : (
                (triggerPlaceholder ?? t`Select an icon`)
            )}
        </Button>
    );

    const triggerElement = React.isValidElement(children) ? children : defaultTrigger;

    return (
        <Popover modal={modal} onOpenChange={handleOpenChange} open={open ?? isOpen}>
            <PopoverTrigger render={triggerElement} {...props} />
            <PopoverContent className="w-96 p-2">
                {searchable && (
                    <Input className="mb-2" onChange={handleSearchChange} placeholder={searchPlaceholder ?? t`Search for an icon...`} value={searchInput} />
                )}
                {categorized && search.trim() === "" && <div className="mt-2 flex flex-row gap-1 overflow-x-auto pb-2">{categoryButtons}</div>}
                <div className="max-h-60 overflow-auto" ref={parentRef} style={{ scrollbarWidth: "thin" }}>
                    {isLoading ? <IconsColumnSkeleton /> : renderVirtualContent()}
                </div>
            </PopoverContent>
        </Popover>
    );
};

IconPicker.displayName = "IconPicker";

interface IconProps extends Omit<LucideProps, "ref"> {
    name: IconName;
    ref?: React.Ref<React.ComponentRef<LucideIcon>>;
}

const Icon = ({ name, ref, ...props }: IconProps) => <DynamicIcon name={name} {...props} ref={ref} />;

Icon.displayName = "Icon";

export { Icon, IconPicker };

export { type IconName } from "lucide-react/dynamic";
