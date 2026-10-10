"use client";

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { Input } from "@ui/components/input";
import { ScrollArea } from "@ui/components/scroll-area";
import cn from "@ui/utils/cn";
import { ChevronsUpDownIcon, XIcon } from "lucide-react";

const Autocomplete = AutocompletePrimitive.Root;

const AutocompleteInput = ({
    className,
    showClear = false,
    showTrigger = false,
    size,
    startAddon,
    ...props
}: Omit<AutocompletePrimitive.Input.Props, "size"> & {
    ref?: React.Ref<HTMLInputElement>;
    showClear?: boolean;
    showTrigger?: boolean;
    size?: "sm" | "default" | "lg" | number;
    startAddon?: React.ReactNode;
}) => {
    const sizeValue = (size ?? "default") as "sm" | "default" | "lg" | number;

    return (
        <div className="relative w-full">
            {startAddon && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 has-[+[data-size=sm]]:ps-[calc(--spacing(2.5)-1px)] [&_svg]:-mx-0.5 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
                    data-slot="autocomplete-start-addon"
                >
                    {startAddon}
                </div>
            )}
            <AutocompletePrimitive.Input
                className={cn(
                    startAddon &&
                        "*:data-[slot=autocomplete-input]:ps-[calc(--spacing(8.5)-1px)] data-[size=sm]:*:data-[slot=autocomplete-input]:ps-[calc(--spacing(7.5)-1px)] sm:*:data-[slot=autocomplete-input]:ps-[calc(--spacing(8)-1px)] sm:data-[size=sm]:*:data-[slot=autocomplete-input]:ps-[calc(--spacing(7)-1px)]",
                    sizeValue === "sm"
                        ? "has-[+[data-slot=autocomplete-trigger],+[data-slot=autocomplete-clear]]:*:data-[slot=autocomplete-input]:pe-6.5"
                        : "has-[+[data-slot=autocomplete-trigger],+[data-slot=autocomplete-clear]]:*:data-[slot=autocomplete-input]:pe-7",
                    className,
                )}
                data-slot="autocomplete-input"
                render={<Input size={sizeValue} />}
                {...props}
            />
            {showTrigger && (
                <AutocompleteTrigger
                    className={cn(
                        "absolute top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 transition-colors outline-none hover:opacity-100 has-[+[data-slot=autocomplete-clear]]:hidden sm:size-7 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
                        sizeValue === "sm" ? "end-0" : "end-0.5",
                    )}
                >
                    <ChevronsUpDownIcon />
                </AutocompleteTrigger>
            )}
            {showClear && (
                <AutocompleteClear
                    className={cn(
                        "absolute top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 transition-colors outline-none hover:opacity-100 has-[+[data-slot=autocomplete-clear]]:hidden sm:size-7 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
                        sizeValue === "sm" ? "end-0" : "end-0.5",
                    )}
                >
                    <XIcon />
                </AutocompleteClear>
            )}
        </div>
    );
};

const AutocompletePopup = ({
    children,
    className,
    sideOffset = 4,
    ...props
}: AutocompletePrimitive.Popup.Props & {
    sideOffset?: number;
}) => (
    <AutocompletePrimitive.Portal>
        <AutocompletePrimitive.Positioner className="z-50 select-none" data-slot="autocomplete-positioner" sideOffset={sideOffset}>
            <span
                className={cn(
                    "bg-popover relative flex max-h-full origin-(--transform-origin) rounded-lg border bg-clip-padding transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-lg has-data-starting-style:scale-98 has-data-starting-style:opacity-0 dark:not-in-data-[slot=group]:bg-clip-border",
                    className,
                )}
            >
                <AutocompletePrimitive.Popup
                    className="flex max-h-[min(var(--available-height),23rem)] w-(--anchor-width) max-w-(--available-width) flex-col"
                    data-slot="autocomplete-popup"
                    {...props}
                >
                    {children}
                </AutocompletePrimitive.Popup>
            </span>
        </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
);

const AutocompleteItem = ({ children, className, ...props }: AutocompletePrimitive.Item.Props) => (
    <AutocompletePrimitive.Item
        className={cn(
            "data-highlighted:bg-accent data-highlighted:text-accent-foreground flex min-h-8 cursor-default items-center rounded-sm px-2 py-1 text-base outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-7 sm:text-sm",
            className,
        )}
        data-slot="autocomplete-item"
        {...props}
    >
        {children}
    </AutocompletePrimitive.Item>
);

const AutocompleteSeparator = ({ className, ...props }: AutocompletePrimitive.Separator.Props) => (
    <AutocompletePrimitive.Separator className={cn("bg-border mx-2 my-1 h-px last:hidden", className)} data-slot="autocomplete-separator" {...props} />
);

const AutocompleteGroup = ({ className, ...props }: AutocompletePrimitive.Group.Props) => (
    <AutocompletePrimitive.Group className={cn("[[role=group]+&]:mt-1.5", className)} data-slot="autocomplete-group" {...props} />
);

const AutocompleteGroupLabel = ({ className, ...props }: AutocompletePrimitive.GroupLabel.Props) => (
    <AutocompletePrimitive.GroupLabel
        className={cn("text-muted-foreground px-2 py-1.5 text-xs font-medium", className)}
        data-slot="autocomplete-group-label"
        {...props}
    />
);

const AutocompleteEmpty = ({ className, ...props }: AutocompletePrimitive.Empty.Props) => (
    <AutocompletePrimitive.Empty
        className={cn("text-muted-foreground text-center text-base not-empty:p-2 sm:text-sm", className)}
        data-slot="autocomplete-empty"
        {...props}
    />
);

const AutocompleteRow = ({ className, ...props }: AutocompletePrimitive.Row.Props) => (
    <AutocompletePrimitive.Row className={className} data-slot="autocomplete-row" {...props} />
);

const AutocompleteValue = ({ ...props }: AutocompletePrimitive.Value.Props) => <AutocompletePrimitive.Value data-slot="autocomplete-value" {...props} />;

const AutocompleteList = ({ className, ...props }: AutocompletePrimitive.List.Props) => (
    <ScrollArea scrollbarGutter scrollFade>
        <AutocompletePrimitive.List
            className={cn("not-empty:scroll-py-1 not-empty:p-1 in-data-has-overflow-y:pe-3", className)}
            data-slot="autocomplete-list"
            {...props}
        />
    </ScrollArea>
);

const AutocompleteClear = ({ className, ...props }: AutocompletePrimitive.Clear.Props) => (
    <AutocompletePrimitive.Clear
        className={cn(
            "absolute end-0.5 top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 transition-[color,background-color,box-shadow,opacity] outline-none hover:opacity-100 sm:size-7 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
            className,
        )}
        data-slot="autocomplete-clear"
        {...props}
    >
        <XIcon />
    </AutocompletePrimitive.Clear>
);

const AutocompleteStatus = ({ className, ...props }: AutocompletePrimitive.Status.Props) => (
    <AutocompletePrimitive.Status
        className={cn("text-muted-foreground px-3 py-2 text-xs font-medium empty:m-0 empty:p-0", className)}
        data-slot="autocomplete-status"
        {...props}
    />
);

const AutocompleteCollection = ({ ...props }: AutocompletePrimitive.Collection.Props) => (
    <AutocompletePrimitive.Collection data-slot="autocomplete-collection" {...props} />
);

const AutocompleteTrigger = ({ className, ...props }: AutocompletePrimitive.Trigger.Props) => (
    <AutocompletePrimitive.Trigger className={className} data-slot="autocomplete-trigger" {...props} />
);

export {
    Autocomplete,
    AutocompleteClear,
    AutocompleteCollection,
    AutocompleteEmpty,
    AutocompleteGroup,
    AutocompleteGroupLabel,
    AutocompleteInput,
    AutocompleteItem,
    AutocompleteList,
    AutocompletePopup,
    AutocompleteRow,
    AutocompleteSeparator,
    AutocompleteStatus,
    AutocompleteTrigger,
    AutocompleteValue,
};
