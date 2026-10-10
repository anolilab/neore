"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import cn from "@ui/utils/cn";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";

export interface DropdownMenuProps extends Omit<MenuPrimitive.Root.Props, "onOpenChange"> {
    /**
     * Simplified callback that fires when the dropdown menu open state changes.
     * For the full event details, use onOpenChangeWithDetails instead.
     */
    onOpenChange?: (open: boolean) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onOpenChangeWithDetails?: MenuPrimitive.Root.Props["onOpenChange"];
}

const DropdownMenu = ({ onOpenChange, onOpenChangeWithDetails, ...props }: DropdownMenuProps) => {
    const handleOpenChange: MenuPrimitive.Root.Props["onOpenChange"] = (newOpen, eventDetails) => {
        onOpenChange?.(newOpen);
        onOpenChangeWithDetails?.(newOpen, eventDetails);
    };

    return <MenuPrimitive.Root data-slot="dropdown-menu" onOpenChange={handleOpenChange} {...props} />;
};

const DropdownMenuPortal = ({ ...props }: MenuPrimitive.Portal.Props) => <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;

const DropdownMenuTrigger = ({ children, render, ...props }: MenuPrimitive.Trigger.Props & { render?: React.ReactElement }) => {
    if (render) {
        return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" render={render} {...props} />;
    }

    return (
        <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props}>
            {children}
        </MenuPrimitive.Trigger>
    );
};

export interface DropdownMenuContentProps
    extends Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">, MenuPrimitive.Popup.Props {
    /**
     * @deprecated Use finalFocus on DropdownMenu root instead. This is kept for backward compatibility.
     * Event handler called when focus moves outside the component after closing.
     */
    onCloseAutoFocus?: (event: Event) => void;
}

const DropdownMenuContent = ({
    align = "start",
    alignOffset = 0,
    className,
    onCloseAutoFocus,
    side = "bottom",
    sideOffset = 4,
    ...props
}: DropdownMenuContentProps) => {
    const popupRef = React.useRef<HTMLDivElement>(null);

    // Handle close focus callback via data attributes
    React.useEffect(() => {
        const popup = popupRef.current;

        if (!popup || !onCloseAutoFocus) {
            return undefined;
        }

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.attributeName !== "data-closed") {
                    continue;
                }

                const isClosed = "closed" in popup.dataset;

                if (isClosed) {
                    const event = new Event("focus", { cancelable: true });

                    onCloseAutoFocus(event);
                }
            }
        });

        observer.observe(popup, { attributes: true });

        return () => observer.disconnect();
    }, [onCloseAutoFocus]);

    return (
        <MenuPrimitive.Portal>
            <MenuPrimitive.Positioner align={align} alignOffset={alignOffset} className="isolate z-50 outline-none" side={side} sideOffset={sideOffset}>
                <MenuPrimitive.Popup
                    className={cn(
                        "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 ring-foreground/10 bg-popover text-popover-foreground z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg p-1 shadow-md ring-1 duration-100 outline-none data-closed:overflow-hidden",
                        className,
                    )}
                    data-slot="dropdown-menu-content"
                    ref={popupRef}
                    {...props}
                />
            </MenuPrimitive.Positioner>
        </MenuPrimitive.Portal>
    );
};

const DropdownMenuGroup = ({ ...props }: MenuPrimitive.Group.Props) => <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;

const DropdownMenuLabel = ({
    className,
    inset,
    ...props
}: MenuPrimitive.GroupLabel.Props & {
    inset?: boolean;
}) => (
    <MenuPrimitive.GroupLabel
        className={cn("text-muted-foreground px-2 py-1.5 text-xs data-[inset]:pl-8", className)}
        data-inset={inset}
        data-slot="dropdown-menu-label"
        {...props}
    />
);

const DropdownMenuItem = ({
    className,
    inset,
    variant = "default",
    ...props
}: MenuPrimitive.Item.Props & {
    inset?: boolean;
    variant?: "default" | "destructive";
}) => (
    <MenuPrimitive.Item
        className={cn(
            "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive not-data-[variant=destructive]:focus:**:text-accent-foreground group/dropdown-menu-item relative flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs/relaxed outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-inset={inset}
        data-slot="dropdown-menu-item"
        data-variant={variant}
        {...props}
    />
);

const DropdownMenuSub = ({ ...props }: MenuPrimitive.SubmenuRoot.Props) => <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;

const DropdownMenuSubTrigger = ({
    children,
    className,
    inset,
    ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
    inset?: boolean;
}) => (
    <MenuPrimitive.SubmenuTrigger
        className={cn(
            "focus:bg-accent focus:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-inset={inset}
        data-slot="dropdown-menu-sub-trigger"
        {...props}
    >
        {children}
        <ChevronRightIcon className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
);

const DropdownMenuSubContent = ({
    align = "start",
    alignOffset = -3,
    className,
    side = "right",
    sideOffset = 0,
    ...props
}: React.ComponentProps<typeof DropdownMenuContent>) => (
    <DropdownMenuContent
        align={align}
        alignOffset={alignOffset}
        className={cn(
            "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground w-auto min-w-32 rounded-lg p-1 shadow-md ring-1 duration-100",
            className,
        )}
        data-slot="dropdown-menu-sub-content"
        side={side}
        sideOffset={sideOffset}
        {...props}
    />
);

const DropdownMenuCheckboxItem = ({ checked, children, className, ...props }: MenuPrimitive.CheckboxItem.Props) => (
    <MenuPrimitive.CheckboxItem
        checked={checked}
        className={cn(
            "focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground relative flex min-h-7 cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-xs outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-slot="dropdown-menu-checkbox-item"
        {...props}
    >
        <span className="pointer-events-none absolute right-2 flex items-center justify-center" data-slot="dropdown-menu-checkbox-item-indicator">
            <MenuPrimitive.CheckboxItemIndicator>
                <CheckIcon />
            </MenuPrimitive.CheckboxItemIndicator>
        </span>
        {children}
    </MenuPrimitive.CheckboxItem>
);

const DropdownMenuRadioGroup = ({ ...props }: MenuPrimitive.RadioGroup.Props) => <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;

const DropdownMenuRadioItem = ({ children, className, ...props }: MenuPrimitive.RadioItem.Props) => (
    <MenuPrimitive.RadioItem
        className={cn(
            "focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground relative flex min-h-7 cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-xs outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-slot="dropdown-menu-radio-item"
        {...props}
    >
        <span className="pointer-events-none absolute right-2 flex items-center justify-center" data-slot="dropdown-menu-radio-item-indicator">
            <MenuPrimitive.RadioItemIndicator>
                <CheckIcon />
            </MenuPrimitive.RadioItemIndicator>
        </span>
        {children}
    </MenuPrimitive.RadioItem>
);

const DropdownMenuSeparator = ({ className, ...props }: MenuPrimitive.Separator.Props) => (
    <MenuPrimitive.Separator className={cn("bg-border/50 -mx-1 my-1 h-px", className)} data-slot="dropdown-menu-separator" {...props} />
);

const DropdownMenuShortcut = ({ className, ...props }: React.ComponentProps<"span">) => (
    <span
        className={cn("text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground ml-auto text-[0.625rem] tracking-widest", className)}
        data-slot="dropdown-menu-shortcut"
        {...props}
    />
);

export {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuPortal,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
};
