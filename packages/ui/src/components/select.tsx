"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import cn from "@ui/utils/cn";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import * as React from "react";

export interface SelectProps<Value> extends Omit<SelectPrimitive.Root.Props<Value>, "onValueChange"> {
    /**
     * Simplified callback that fires when the value changes.
     * For the full event details, use onValueChangeWithDetails instead.
     */
    onValueChange?: (value: Value | null) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onValueChangeWithDetails?: SelectPrimitive.Root.Props<Value>["onValueChange"];
}

const Select = <Value,>({ onValueChange, onValueChangeWithDetails, ...props }: SelectProps<Value>) => {
    const handleValueChange: SelectPrimitive.Root.Props<Value>["onValueChange"] = (newValue, eventDetails) => {
        onValueChange?.(newValue);
        onValueChangeWithDetails?.(newValue, eventDetails);
    };

    return <SelectPrimitive.Root onValueChange={handleValueChange} {...props} />;
};

const SelectGroup = ({ className, ...props }: SelectPrimitive.Group.Props) => (
    <SelectPrimitive.Group className={cn("scroll-my-1 p-1", className)} data-slot="select-group" {...props} />
);

const SelectValue = ({ className, ...props }: SelectPrimitive.Value.Props) => (
    <SelectPrimitive.Value className={cn("flex flex-1 text-left", className)} data-slot="select-value" {...props} />
);

const SelectTrigger = ({
    children,
    className,
    size = "default",
    ...props
}: SelectPrimitive.Trigger.Props & {
    size?: "sm" | "default";
}) => (
    <SelectPrimitive.Trigger
        className={cn(
            "border-input data-[placeholder]:text-muted-foreground bg-input/20 dark:bg-input/30 dark:hover:bg-input/50 focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 flex w-fit items-center justify-between gap-1.5 rounded-md border px-2 py-1.5 text-xs/relaxed whitespace-nowrap transition-colors outline-none focus-visible:ring-[2px] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-[2px] data-[size=default]:h-7 data-[size=sm]:h-6 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-size={size}
        data-slot="select-trigger"
        {...props}
    >
        {children}
        <SelectPrimitive.Icon render={<ChevronDownIcon className="text-muted-foreground pointer-events-none size-3.5" />} />
    </SelectPrimitive.Trigger>
);

const SelectContent = ({
    align = "center",
    alignItemWithTrigger = true,
    alignOffset = 0,
    children,
    className,
    side = "bottom",
    sideOffset = 4,
    ...props
}: Pick<SelectPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"> & SelectPrimitive.Popup.Props) => (
    <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
            align={align}
            alignItemWithTrigger={alignItemWithTrigger}
            alignOffset={alignOffset}
            className="isolate z-50"
            side={side}
            sideOffset={sideOffset}
        >
            <SelectPrimitive.Popup
                className={cn(
                    "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 ring-foreground/10 relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg shadow-md ring-1 duration-100 data-[align-trigger=true]:animate-none",
                    className,
                )}
                data-align-trigger={alignItemWithTrigger}
                data-slot="select-content"
                {...props}
            >
                <SelectScrollUpButton />
                <SelectPrimitive.List>{children}</SelectPrimitive.List>
                <SelectScrollDownButton />
            </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
);

const SelectLabel = ({ className, ...props }: SelectPrimitive.GroupLabel.Props) => (
    <SelectPrimitive.GroupLabel className={cn("text-muted-foreground px-2 py-1.5 text-xs", className)} data-slot="select-label" {...props} />
);

const SelectItem = ({ children, className, ...props }: SelectPrimitive.Item.Props) => (
    <SelectPrimitive.Item
        className={cn(
            "focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs/relaxed outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
            className,
        )}
        data-slot="select-item"
        {...props}
    >
        <SelectPrimitive.ItemText className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">{children}</SelectPrimitive.ItemText>
        <SelectPrimitive.ItemIndicator render={<span className="pointer-events-none absolute right-2 flex items-center justify-center" />}>
            <CheckIcon className="pointer-events-none" />
        </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
);

const SelectSeparator = ({ className, ...props }: SelectPrimitive.Separator.Props) => (
    <SelectPrimitive.Separator className={cn("bg-border/50 pointer-events-none -mx-1 my-1 h-px", className)} data-slot="select-separator" {...props} />
);

const SelectScrollUpButton = ({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) => (
    <SelectPrimitive.ScrollUpArrow
        className={cn("bg-popover top-0 z-10 flex w-full cursor-default items-center justify-center py-1 [&_svg:not([class*='size-'])]:size-3.5", className)}
        data-slot="select-scroll-up-button"
        {...props}
    >
        <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
);

const SelectScrollDownButton = ({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) => (
    <SelectPrimitive.ScrollDownArrow
        className={cn("bg-popover bottom-0 z-10 flex w-full cursor-default items-center justify-center py-1 [&_svg:not([class*='size-'])]:size-3.5", className)}
        data-slot="select-scroll-down-button"
        {...props}
    >
        <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
);

export {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectScrollDownButton,
    SelectScrollUpButton,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
};
