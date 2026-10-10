"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { useLingui } from "@lingui/react/macro";
import { Input } from "@ui/components/input";
import { ScrollArea } from "@ui/components/scroll-area";
import cn from "@ui/utils/cn";
import { ChevronsUpDownIcon, XIcon } from "lucide-react";
import * as React from "react";

const ComboboxContext = React.createContext<{
    chipsRef: React.RefObject<Element | null> | null;
    multiple: boolean;
}>({
    chipsRef: null,
    multiple: false,
});

type ComboboxRootProps<ItemValue, Multiple extends boolean | undefined> = Parameters<typeof ComboboxPrimitive.Root<ItemValue, Multiple>>[0];

const Combobox = <ItemValue, Multiple extends boolean | undefined = false>(props: ComboboxPrimitive.Root.Props<ItemValue, Multiple>) => {
    const chipsRef = React.useRef<Element | null>(null);
    const { multiple } = props;

    const contextValue = React.useMemo(() => {
        return { chipsRef, multiple: !!multiple };
    }, [chipsRef, multiple]);

    return (
        <ComboboxContext value={contextValue}>
            <ComboboxPrimitive.Root {...(props as ComboboxRootProps<ItemValue, Multiple>)} />
        </ComboboxContext>
    );
};

const ComboboxInput = ({
    className,
    showClear = false,
    showTrigger = true,
    size,
    startAddon,
    ...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
    ref?: React.Ref<HTMLInputElement>;
    showClear?: boolean;
    showTrigger?: boolean;
    size?: "sm" | "default" | "lg" | number;
    startAddon?: React.ReactNode;
}) => {
    const { multiple } = React.use(ComboboxContext);
    const sizeValue = (size ?? "default") as "sm" | "default" | "lg" | number;

    // multiple mode
    if (multiple) {
        return (
            <ComboboxPrimitive.Input
                className={cn(
                    "min-w-12 flex-1 text-base outline-none sm:text-sm [[data-slot=combobox-chip]+&]:ps-0.5",
                    sizeValue === "sm" ? "ps-1.5" : "ps-2",
                    className,
                )}
                data-size={typeof sizeValue === "string" ? sizeValue : undefined}
                data-slot="combobox-input"
                size={typeof sizeValue === "number" ? sizeValue : undefined}
                {...props}
            />
        );
    }

    // single mode
    return (
        <div className="relative w-full has-disabled:opacity-64">
            {startAddon && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 has-[+[data-size=sm]]:ps-[calc(--spacing(2.5)-1px)] [&_svg]:-mx-0.5 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
                    data-slot="combobox-start-addon"
                >
                    {startAddon}
                </div>
            )}
            <ComboboxPrimitive.Input
                className={cn(
                    startAddon &&
                        "*:data-[slot=combobox-input]:ps-[calc(--spacing(8.5)-1px)] data-[size=sm]:*:data-[slot=combobox-input]:ps-[calc(--spacing(7.5)-1px)] sm:*:data-[slot=combobox-input]:ps-[calc(--spacing(8)-1px)] sm:data-[size=sm]:*:data-[slot=combobox-input]:ps-[calc(--spacing(7)-1px)]",
                    sizeValue === "sm"
                        ? "has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-6.5"
                        : "has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-7",
                    className,
                )}
                data-slot="combobox-input"
                render={<Input className="has-disabled:opacity-100" size={sizeValue} />}
                {...props}
            />
            {showTrigger && (
                <ComboboxTrigger
                    className={cn(
                        "absolute top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 transition-opacity outline-none hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
                        sizeValue === "sm" ? "end-0" : "end-0.5",
                    )}
                >
                    <ChevronsUpDownIcon />
                </ComboboxTrigger>
            )}
            {showClear && (
                <ComboboxClear
                    className={cn(
                        "absolute top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 transition-opacity outline-none hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
                        sizeValue === "sm" ? "end-0" : "end-0.5",
                    )}
                >
                    <XIcon />
                </ComboboxClear>
            )}
        </div>
    );
};

const ComboboxTrigger = ({ className, ...props }: ComboboxPrimitive.Trigger.Props) => (
    <ComboboxPrimitive.Trigger className={className} data-slot="combobox-trigger" {...props} />
);

const ComboboxPopup = ({
    children,
    className,
    sideOffset = 4,
    ...props
}: ComboboxPrimitive.Popup.Props & {
    sideOffset?: number;
}) => {
    const { chipsRef } = React.use(ComboboxContext);

    return (
        <ComboboxPrimitive.Portal>
            <ComboboxPrimitive.Positioner anchor={chipsRef} className="z-50 select-none" data-slot="combobox-positioner" sideOffset={sideOffset}>
                <span
                    className={cn(
                        "bg-popover data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 relative flex max-h-full origin-(--transform-origin) rounded-lg border bg-clip-padding transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-lg has-data-starting-style:scale-98 has-data-starting-style:opacity-0 dark:not-in-data-[slot=group]:bg-clip-border",
                        className,
                    )}
                >
                    <ComboboxPrimitive.Popup
                        className="flex max-h-[min(var(--available-height),23rem)] w-(--anchor-width) max-w-(--available-width) flex-col"
                        data-slot="combobox-popup"
                        {...props}
                    >
                        {children}
                    </ComboboxPrimitive.Popup>
                </span>
            </ComboboxPrimitive.Positioner>
        </ComboboxPrimitive.Portal>
    );
};

const ComboboxItem = ({ children, className, ...props }: ComboboxPrimitive.Item.Props) => (
    <ComboboxPrimitive.Item
        className={cn(
            "data-highlighted:bg-accent data-highlighted:text-accent-foreground grid min-h-8 cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
            className,
        )}
        data-slot="combobox-item"
        {...props}
    >
        <ComboboxPrimitive.ItemIndicator className="col-start-1">
            <svg
                fill="none"
                height="24"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                width="24"
                xmlns="http://www.w3.org/1500/svg"
            >
                <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
            </svg>
        </ComboboxPrimitive.ItemIndicator>
        <div className="col-start-2">{children}</div>
    </ComboboxPrimitive.Item>
);

const ComboboxSeparator = ({ className, ...props }: ComboboxPrimitive.Separator.Props) => (
    <ComboboxPrimitive.Separator className={cn("bg-border mx-2 my-1 h-px last:hidden", className)} data-slot="combobox-separator" {...props} />
);

const ComboboxGroup = ({ className, ...props }: ComboboxPrimitive.Group.Props) => (
    <ComboboxPrimitive.Group className={cn("[[role=group]+&]:mt-1.5", className)} data-slot="combobox-group" {...props} />
);

const ComboboxGroupLabel = ({ className, ...props }: ComboboxPrimitive.GroupLabel.Props) => (
    <ComboboxPrimitive.GroupLabel
        className={cn("text-muted-foreground px-2 py-1.5 text-xs font-medium", className)}
        data-slot="combobox-group-label"
        {...props}
    />
);

const ComboboxEmpty = ({ className, ...props }: ComboboxPrimitive.Empty.Props) => (
    <ComboboxPrimitive.Empty
        className={cn("text-muted-foreground text-center text-base not-empty:p-2 sm:text-sm", className)}
        data-slot="combobox-empty"
        {...props}
    />
);

const ComboboxRow = ({ className, ...props }: ComboboxPrimitive.Row.Props) => (
    <ComboboxPrimitive.Row className={className} data-slot="combobox-row" {...props} />
);

const ComboboxValue = ({ ...props }: ComboboxPrimitive.Value.Props) => <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;

const ComboboxList = ({ className, ...props }: ComboboxPrimitive.List.Props) => (
    <ScrollArea scrollbarGutter scrollFade>
        <ComboboxPrimitive.List
            className={cn("not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1 in-data-has-overflow-y:pe-3", className)}
            data-slot="combobox-list"
            {...props}
        />
    </ScrollArea>
);

const ComboboxClear = ({ className, ...props }: ComboboxPrimitive.Clear.Props) => (
    <ComboboxPrimitive.Clear className={className} data-slot="combobox-clear" {...props} />
);

const ComboboxStatus = ({ className, ...props }: ComboboxPrimitive.Status.Props) => (
    <ComboboxPrimitive.Status
        className={cn("text-muted-foreground px-3 py-2 text-xs font-medium empty:m-0 empty:p-0", className)}
        data-slot="combobox-status"
        {...props}
    />
);

const ComboboxCollection = (props: ComboboxPrimitive.Collection.Props) => <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />;

const ComboboxChips = ({
    children,
    className,
    startAddon,
    ...props
}: ComboboxPrimitive.Chips.Props & {
    startAddon?: React.ReactNode;
}) => {
    const { chipsRef } = React.use(ComboboxContext);

    return (
        <ComboboxPrimitive.Chips
            className={cn(
                "border-input bg-background ring-ring/24 focus-within:border-ring has-aria-invalid:border-destructive/36 focus-within:has-aria-invalid:border-destructive/64 focus-within:has-aria-invalid:ring-destructive/16 dark:not-has-disabled:bg-input/32 dark:has-aria-invalid:ring-destructive/24 relative inline-flex min-h-9 w-full flex-wrap gap-1 rounded-lg border bg-clip-padding p-[calc(--spacing(1)-1px)] text-base shadow-xs transition-shadow outline-none *:min-h-7 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-within:ring-[3px] has-disabled:pointer-events-none has-disabled:opacity-64 has-data-[size=lg]:min-h-10 has-data-[size=lg]:*:min-h-8 has-data-[size=sm]:min-h-8 has-data-[size=sm]:*:min-h-6 has-[:disabled,:focus-within,[aria-invalid]]:shadow-none sm:min-h-8 sm:text-sm sm:*:min-h-6 sm:has-data-[size=lg]:min-h-9 sm:has-data-[size=lg]:*:min-h-7 sm:has-data-[size=sm]:min-h-7 sm:has-data-[size=sm]:*:min-h-5 dark:not-in-data-[slot=group]:bg-clip-border dark:not-has-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/8%)]",
                className,
            )}
            data-slot="combobox-chips"
            onMouseDown={(e) => {
                const target = e.target as HTMLElement;
                const isChip = target.closest('[data-slot="combobox-chip"]');

                if (isChip || !chipsRef?.current) {
                    return;
                }

                e.preventDefault();
                const input: HTMLInputElement | null = chipsRef.current.querySelector("input");

                if (input && !chipsRef.current.querySelector("input:focus")) {
                    input.focus();
                }
            }}
            ref={chipsRef as React.Ref<HTMLDivElement> | null}
            {...props}
        >
            {startAddon && (
                <div
                    aria-hidden="true"
                    className="flex shrink-0 items-center ps-2 opacity-80 has-[+[data-slot=combobox-chip]]:pe-2 has-[~[data-size=sm]]:ps-1.5 has-[~[data-size=sm]]:has-[+[data-slot=combobox-chip]]:pe-1.5 [&_svg]:pointer-events-none [&_svg]:-ms-0.5 [&_svg]:-me-1.5 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
                    data-slot="combobox-start-addon"
                >
                    {startAddon}
                </div>
            )}
            {children}
        </ComboboxPrimitive.Chips>
    );
};

const ComboboxChip = ({ children, ...props }: ComboboxPrimitive.Chip.Props) => (
    <ComboboxPrimitive.Chip
        className="bg-accent text-accent-foreground flex items-center rounded-[calc(var(--radius-md)-1px)] ps-2 text-sm font-medium outline-none sm:text-xs/(--text-xs--line-height) [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5"
        data-slot="combobox-chip"
        {...props}
    >
        {children}
        <ComboboxChipRemove />
    </ComboboxPrimitive.Chip>
);

const ComboboxChipRemove = (props: ComboboxPrimitive.ChipRemove.Props) => {
    const { t } = useLingui();

    return (
        <ComboboxPrimitive.ChipRemove
            aria-label={t`Remove`}
            className="h-full shrink-0 cursor-pointer px-1.5 opacity-80 hover:opacity-100 [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5"
            data-slot="combobox-chip-remove"
            {...props}
        >
            <XIcon />
        </ComboboxPrimitive.ChipRemove>
    );
};

export {
    Combobox,
    ComboboxChip,
    ComboboxChips,
    ComboboxClear,
    ComboboxCollection,
    ComboboxEmpty,
    ComboboxGroup,
    ComboboxGroupLabel,
    ComboboxInput,
    ComboboxItem,
    ComboboxList,
    ComboboxPopup,
    ComboboxRow,
    ComboboxSeparator,
    ComboboxStatus,
    ComboboxTrigger,
    ComboboxValue,
};
