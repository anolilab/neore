import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Menubar as MenubarPrimitive } from "@base-ui/react/menubar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuPortal,
    DropdownMenuRadioGroup,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import cn from "@ui/utils/cn";
import { CheckIcon } from "lucide-react";
import * as React from "react";

const Menubar = ({ className, ...props }: MenubarPrimitive.Props) => (
    <MenubarPrimitive className={cn("bg-background flex h-9 items-center rounded-md border p-1", className)} data-slot="menubar" {...props} />
);

const MenubarMenu = ({ ...props }: React.ComponentProps<typeof DropdownMenu>) => <DropdownMenu data-slot="menubar-menu" {...props} />;

const MenubarGroup = ({ ...props }: React.ComponentProps<typeof DropdownMenuGroup>) => <DropdownMenuGroup data-slot="menubar-group" {...props} />;

const MenubarPortal = ({ ...props }: React.ComponentProps<typeof DropdownMenuPortal>) => <DropdownMenuPortal data-slot="menubar-portal" {...props} />;

const MenubarTrigger = ({ className, ...props }: React.ComponentProps<typeof DropdownMenuTrigger>) => (
    <DropdownMenuTrigger
        className={cn(
            "hover:bg-muted aria-expanded:bg-muted flex items-center rounded-[calc(var(--radius-sm)-2px)] px-2 py-[calc(--spacing(0.875))] text-xs/relaxed font-medium outline-hidden select-none",
            className,
        )}
        data-slot="menubar-trigger"
        {...props}
    />
);

const MenubarContent = ({ align = "start", alignOffset = -4, className, sideOffset = 8, ...props }: React.ComponentProps<typeof DropdownMenuContent>) => (
    <DropdownMenuContent
        align={align}
        alignOffset={alignOffset}
        className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 ring-foreground/10 min-w-32 rounded-lg p-1 shadow-md ring-1 duration-100",
            className,
        )}
        data-slot="menubar-content"
        sideOffset={sideOffset}
        {...props}
    />
);

const MenubarItem = ({ className, inset, variant = "default", ...props }: React.ComponentProps<typeof DropdownMenuItem>) => (
    <DropdownMenuItem
        className={cn(
            "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive not-data-[variant=destructive]:focus:**:text-accent-foreground group/menubar-item min-h-7 gap-2 rounded-md px-2 py-1 text-xs/relaxed data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-inset={inset}
        data-slot="menubar-item"
        data-variant={variant}
        {...props}
    />
);

const MenubarCheckboxItem = ({ checked, children, className, ...props }: MenuPrimitive.CheckboxItem.Props) => (
    <MenuPrimitive.CheckboxItem
        checked={checked}
        className={cn(
            "focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground relative flex min-h-7 cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-xs outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            className,
        )}
        data-slot="menubar-checkbox-item"
        {...props}
    >
        <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center [&_svg:not([class*='size-'])]:size-4">
            <MenuPrimitive.CheckboxItemIndicator>
                <CheckIcon />
            </MenuPrimitive.CheckboxItemIndicator>
        </span>
        {children}
    </MenuPrimitive.CheckboxItem>
);

const MenubarRadioGroup = ({ ...props }: React.ComponentProps<typeof DropdownMenuRadioGroup>) => (
    <DropdownMenuRadioGroup data-slot="menubar-radio-group" {...props} />
);

const MenubarRadioItem = ({ children, className, ...props }: MenuPrimitive.RadioItem.Props) => (
    <MenuPrimitive.RadioItem
        className={cn(
            "focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground relative flex min-h-7 cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-xs outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-slot="menubar-radio-item"
        {...props}
    >
        <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center [&_svg:not([class*='size-'])]:size-4">
            <MenuPrimitive.RadioItemIndicator>
                <CheckIcon />
            </MenuPrimitive.RadioItemIndicator>
        </span>
        {children}
    </MenuPrimitive.RadioItem>
);

const MenubarLabel = ({ className, inset, ...props }: React.ComponentProps<typeof DropdownMenuLabel>) => (
    <DropdownMenuLabel
        className={cn("text-muted-foreground px-2 py-1.5 text-xs data-[inset]:pl-8", className)}
        data-inset={inset}
        data-slot="menubar-label"
        {...props}
    />
);

const MenubarSeparator = ({ className, ...props }: React.ComponentProps<typeof DropdownMenuSeparator>) => (
    <DropdownMenuSeparator className={cn("bg-border/50 -mx-1 my-1 h-px", className)} data-slot="menubar-separator" {...props} />
);

const MenubarShortcut = ({ className, ...props }: React.ComponentProps<typeof DropdownMenuShortcut>) => (
    <DropdownMenuShortcut
        className={cn("text-muted-foreground group-focus/menubar-item:text-accent-foreground ml-auto text-[0.625rem] tracking-widest", className)}
        data-slot="menubar-shortcut"
        {...props}
    />
);

const MenubarSub = ({ ...props }: React.ComponentProps<typeof DropdownMenuSub>) => <DropdownMenuSub data-slot="menubar-sub" {...props} />;

const MenubarSubTrigger = ({
    className,
    inset,
    ...props
}: React.ComponentProps<typeof DropdownMenuSubTrigger> & {
    inset?: boolean;
}) => (
    <DropdownMenuSubTrigger
        className={cn(
            "focus:bg-accent focus:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground min-h-7 gap-2 rounded-md px-2 py-1 text-xs data-[inset]:pl-8 [&_svg:not([class*='size-'])]:size-3.5",
            className,
        )}
        data-inset={inset}
        data-slot="menubar-sub-trigger"
        {...props}
    />
);

const MenubarSubContent = ({ className, ...props }: React.ComponentProps<typeof DropdownMenuSubContent>) => (
    <DropdownMenuSubContent
        className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 min-w-32 rounded-lg p-1 shadow-md ring-1 duration-100",
            className,
        )}
        data-slot="menubar-sub-content"
        {...props}
    />
);

export {
    Menubar,
    MenubarCheckboxItem,
    MenubarContent,
    MenubarGroup,
    MenubarItem,
    MenubarLabel,
    MenubarMenu,
    MenubarPortal,
    MenubarRadioGroup,
    MenubarRadioItem,
    MenubarSeparator,
    MenubarShortcut,
    MenubarSub,
    MenubarSubContent,
    MenubarSubTrigger,
    MenubarTrigger,
};
