"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { tabsListVariants } from "@ui/components/tabs-list-variants";
import cn from "@ui/utils/cn";
import type { VariantProps } from "class-variance-authority";

export interface TabsProps extends Omit<TabsPrimitive.Root.Props, "onValueChange"> {
    /**
     * Simplified callback that fires when the tab value changes.
     * For the full event details, use onValueChangeWithDetails instead.
     */
    onValueChange?: (value: TabsPrimitive.Root.Props["value"]) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onValueChangeWithDetails?: TabsPrimitive.Root.Props["onValueChange"];
}

const Tabs = ({ className, onValueChange, onValueChangeWithDetails, orientation = "horizontal", ...props }: TabsProps) => {
    const handleValueChange: TabsPrimitive.Root.Props["onValueChange"] = (newValue, eventDetails) => {
        onValueChange?.(newValue);
        onValueChangeWithDetails?.(newValue, eventDetails);
    };

    return (
        <TabsPrimitive.Root
            className={cn("group/tabs flex gap-2 data-[orientation=horizontal]:flex-col", className)}
            data-orientation={orientation}
            data-slot="tabs"
            onValueChange={handleValueChange}
            {...props}
        />
    );
};

const TabsList = ({ className, variant = "default", ...props }: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) => (
    <TabsPrimitive.List className={cn(tabsListVariants({ variant }), className)} data-slot="tabs-list" data-variant={variant} {...props} />
);

const TabsTrigger = ({ className, ...props }: TabsPrimitive.Tab.Props) => (
    <TabsPrimitive.Tab
        className={cn(
            "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-xs font-medium whitespace-nowrap transition-all group-data-vertical/tabs:py-[calc(--spacing(1.25))] group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
            "data-active:bg-background dark:data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 data-active:text-foreground",
            "after:bg-foreground after:absolute after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
            className,
        )}
        data-slot="tabs-trigger"
        {...props}
    />
);

const TabsContent = ({ className, ...props }: TabsPrimitive.Panel.Props) => (
    <TabsPrimitive.Panel className={cn("flex-1 text-xs/relaxed outline-none", className)} data-slot="tabs-content" {...props} />
);

export { Tabs, TabsContent, TabsList, TabsTrigger };
