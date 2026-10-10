import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import cn from "@ui/utils/cn";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";

const ContextMenu = ({ ...props }: ContextMenuPrimitive.Root.Props) => <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;

const ContextMenuPortal = ({ ...props }: ContextMenuPrimitive.Portal.Props) => <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />;

const ContextMenuTrigger = ({ className, ...props }: ContextMenuPrimitive.Trigger.Props) => (
    <ContextMenuPrimitive.Trigger className={cn("select-none", className)} data-slot="context-menu-trigger" {...props} />
);

const ContextMenuContent = ({
    align = "start",
    alignOffset = 4,
    className,
    side = "right",
    sideOffset = 0,
    ...props
}: ContextMenuPrimitive.Popup.Props & Pick<ContextMenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) => (
    <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Positioner align={align} alignOffset={alignOffset} className="isolate z-50 outline-none" side={side} sideOffset={sideOffset}>
            <ContextMenuPrimitive.Popup
                className={cn(
                    "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 ring-foreground/10 bg-popover text-popover-foreground z-50 max-h-(--available-height) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg p-1 shadow-md ring-1 duration-100 outline-none",
                    className,
                )}
                data-slot="context-menu-content"
                {...props}
            />
        </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
);

const ContextMenuGroup = ({ ...props }: ContextMenuPrimitive.Group.Props) => <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;

const ContextMenuLabel = ({
    className,
    inset,
    ...props
}: ContextMenuPrimitive.GroupLabel.Props & {
    inset?: boolean;
}) => (
    <ContextMenuPrimitive.GroupLabel
        className={cn("text-muted-foreground px-2 py-1.5 text-xs data-[inset]:pl-8", className)}
        data-inset={inset}
        data-slot="context-menu-label"
        {...props}
    />
);

const ContextMenuItem = ({
    className,
    inset,
    variant = "default",
    ...props
}: ContextMenuPrimitive.Item.Props & {
    inset?: boolean;
    variant?: "default" | "destructive";
}) => (
    <ContextMenuPrimitive.Item
        className={cn(
            "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive not-data-[variant=destructive]:focus:**:text-accent-foreground group/context-menu-item relative flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs/relaxed outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-inset={inset}
        data-slot="context-menu-item"
        data-variant={variant}
        {...props}
    />
);

const ContextMenuSub = ({ ...props }: ContextMenuPrimitive.SubmenuRoot.Props) => <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />;

const ContextMenuSubTrigger = ({
    children,
    className,
    inset,
    ...props
}: ContextMenuPrimitive.SubmenuTrigger.Props & {
    inset?: boolean;
}) => (
    <ContextMenuPrimitive.SubmenuTrigger
        className={cn(
            "focus:bg-accent focus:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-inset={inset}
        data-slot="context-menu-sub-trigger"
        {...props}
    >
        {children}
        <ChevronRightIcon className="ml-auto" />
    </ContextMenuPrimitive.SubmenuTrigger>
);

const ContextMenuSubContent = ({ ...props }: React.ComponentProps<typeof ContextMenuContent>) => (
    <ContextMenuContent className="shadow-lg" data-slot="context-menu-sub-content" side="right" {...props} />
);

const ContextMenuCheckboxItem = ({ checked, children, className, ...props }: ContextMenuPrimitive.CheckboxItem.Props) => (
    <ContextMenuPrimitive.CheckboxItem
        checked={checked}
        className={cn(
            "focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground relative flex min-h-7 cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-xs outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-slot="context-menu-checkbox-item"
        {...props}
    >
        <span className="pointer-events-none absolute right-2 flex items-center justify-center">
            <ContextMenuPrimitive.CheckboxItemIndicator>
                <CheckIcon />
            </ContextMenuPrimitive.CheckboxItemIndicator>
        </span>
        {children}
    </ContextMenuPrimitive.CheckboxItem>
);

const ContextMenuRadioGroup = ({ ...props }: ContextMenuPrimitive.RadioGroup.Props) => (
    <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />
);

const ContextMenuRadioItem = ({ children, className, ...props }: ContextMenuPrimitive.RadioItem.Props) => (
    <ContextMenuPrimitive.RadioItem
        className={cn(
            "focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground relative flex min-h-7 cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-xs outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-slot="context-menu-radio-item"
        {...props}
    >
        <span className="pointer-events-none absolute right-2 flex items-center justify-center">
            <ContextMenuPrimitive.RadioItemIndicator>
                <CheckIcon />
            </ContextMenuPrimitive.RadioItemIndicator>
        </span>
        {children}
    </ContextMenuPrimitive.RadioItem>
);

const ContextMenuSeparator = ({ className, ...props }: ContextMenuPrimitive.Separator.Props) => (
    <ContextMenuPrimitive.Separator className={cn("bg-border/50 -mx-1 my-1 h-px", className)} data-slot="context-menu-separator" {...props} />
);

const ContextMenuShortcut = ({ className, ...props }: React.ComponentProps<"span">) => (
    <span
        className={cn("text-muted-foreground group-focus/context-menu-item:text-accent-foreground ml-auto text-[0.625rem] tracking-widest", className)}
        data-slot="context-menu-shortcut"
        {...props}
    />
);

export {
    ContextMenu,
    ContextMenuCheckboxItem,
    ContextMenuContent,
    ContextMenuGroup,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuPortal,
    ContextMenuRadioGroup,
    ContextMenuRadioItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
};
