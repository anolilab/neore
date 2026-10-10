"use client";

import { useLingui } from "@lingui/react/macro";
import MOBILE_BREAKPOINT_QUERY from "@ui/utils/breakpoints";
import cn from "@ui/utils/cn";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";
import { useMediaMatch } from "rooks";

import { Drawer, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger } from "./drawer";
import type { DropdownMenuContentProps, DropdownMenuProps } from "./dropdown-menu";
import {
    DropdownMenu as BaseDropdownMenu,
    DropdownMenuCheckboxItem as BaseDropdownMenuCheckboxItem,
    DropdownMenuContent as BaseDropdownMenuContent,
    DropdownMenuGroup as BaseDropdownMenuGroup,
    DropdownMenuItem as BaseDropdownMenuItem,
    DropdownMenuLabel as BaseDropdownMenuLabel,
    DropdownMenuPortal as BaseDropdownMenuPortal,
    DropdownMenuRadioGroup as BaseDropdownMenuRadioGroup,
    DropdownMenuRadioItem as BaseDropdownMenuRadioItem,
    DropdownMenuSeparator as BaseDropdownMenuSeparator,
    DropdownMenuShortcut as BaseDropdownMenuShortcut,
    DropdownMenuSub as BaseDropdownMenuSub,
    DropdownMenuSubContent as BaseDropdownMenuSubContent,
    DropdownMenuSubTrigger as BaseDropdownMenuSubTrigger,
    DropdownMenuTrigger as BaseDropdownMenuTrigger,
} from "./dropdown-menu";

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

const IsMobileContext = React.createContext(false);

/**
 * The mobile radio group renders a plain `<div>` rather than Base UI's
 * `RadioGroup`, so nothing carried the group's selection down to the items:
 * `value`/`onValueChange` were spread straight onto the div (where `value` is
 * not even a valid attribute) and every mobile item rendered `aria-checked`
 * false regardless of what was selected. This carries the pair down instead.
 */
const RadioGroupContext = React.createContext<{ onValueChange?: (value: string) => void; value?: string } | undefined>(undefined);
const CloseDrawerContext = React.createContext<(() => void) | undefined>(undefined);

/** Props the responsive wrappers own themselves and therefore re-declare. */
type OwnedButtonProps = "children" | "className" | "disabled" | "onClick";

// For mobile sub-menus: expand/collapse inline instead of a nested flyout.
const SubmenuMobileContext = React.createContext<{
    expanded: boolean;
    toggle: () => void;
}>({ expanded: false, toggle: () => {} });

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * Responsive dropdown menu root. Renders a positioned Menu on desktop and
 * a bottom-sheet Drawer on mobile (< 768px).
 */
const DropdownMenu = ({ children, onOpenChange, open, ...props }: React.PropsWithChildren<DropdownMenuProps>) => {
    const isMobile = useMediaMatch(MOBILE_BREAKPOINT_QUERY);
    const closeDrawer = React.useCallback(() => onOpenChange?.(false), [onOpenChange]);

    return (
        <IsMobileContext value={!!isMobile}>
            {isMobile ? (
                <CloseDrawerContext value={closeDrawer}>
                    <Drawer onOpenChange={onOpenChange} open={open}>
                        {children}
                    </Drawer>
                </CloseDrawerContext>
            ) : (
                <BaseDropdownMenu onOpenChange={onOpenChange} open={open} {...props}>
                    {children}
                </BaseDropdownMenu>
            )}
        </IsMobileContext>
    );
};

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

const DropdownMenuTrigger = ({ children, className, render, ...rest }: React.ComponentProps<typeof BaseDropdownMenuTrigger>) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        if (render) {
            return <DrawerTrigger asChild>{render}</DrawerTrigger>;
        }

        return (
            <DrawerTrigger className={typeof className === "function" ? undefined : className} {...(rest as React.ComponentProps<typeof DrawerTrigger>)}>
                {children}
            </DrawerTrigger>
        );
    }

    return (
        <BaseDropdownMenuTrigger className={className} render={render} {...rest}>
            {children}
        </BaseDropdownMenuTrigger>
    );
};

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * Responsive dropdown menu content. Renders a positioned popup on desktop
 * and a DrawerContent bottom sheet on mobile. Positioning props are ignored
 * on mobile.
 */
const DropdownMenuContent = ({ align, alignOffset, children, className, onCloseAutoFocus, side, sideOffset, ...props }: DropdownMenuContentProps) => {
    const { t } = useLingui();
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return (
            <DrawerContent>
                <DrawerTitle className="sr-only">{t`Menu`}</DrawerTitle>
                <div className="max-h-[60vh] overflow-y-auto p-2" role="menu">
                    {children}
                </div>
            </DrawerContent>
        );
    }

    return (
        <BaseDropdownMenuContent
            align={align}
            alignOffset={alignOffset}
            className={className}
            onCloseAutoFocus={onCloseAutoFocus}
            side={side}
            sideOffset={sideOffset}
            {...props}
        >
            {children}
        </BaseDropdownMenuContent>
    );
};

// ---------------------------------------------------------------------------
// Portal (pass-through on mobile)
// ---------------------------------------------------------------------------

const DropdownMenuPortal = ({ children, ...props }: React.ComponentProps<typeof BaseDropdownMenuPortal>) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <>{children}</>;
    }

    return <BaseDropdownMenuPortal {...props}>{children}</BaseDropdownMenuPortal>;
};

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

const mobileItemClasses =
    "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive group/dropdown-menu-item relative flex w-full min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm/relaxed outline-hidden select-none disabled:pointer-events-none disabled:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 active:bg-accent";

const DropdownMenuItem = ({
    children,
    className,
    disabled,
    inset,
    onClick,
    variant = "default",
    ...props
}: Omit<React.ComponentProps<"button">, OwnedButtonProps> & {
    children?: React.ReactNode;
    className?: string;
    disabled?: boolean;
    inset?: boolean;
    onClick?: React.MouseEventHandler;
    variant?: "default" | "destructive";
}) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        const item = (
            <button
                className={cn(mobileItemClasses, className)}
                data-inset={inset || undefined}
                data-slot="dropdown-menu-item"
                data-variant={variant}
                disabled={disabled}
                onClick={onClick}
                type="button"
                {...props}
            >
                {children}
            </button>
        );

        // Wrap in DrawerClose so clicking the item also dismisses the drawer.
        // Disabled items won't fire click, so DrawerClose won't trigger.
        return <DrawerClose asChild>{item}</DrawerClose>;
    }

    return (
        <BaseDropdownMenuItem className={className} disabled={disabled} inset={inset} onClick={onClick as any} variant={variant} {...(props as any)}>
            {children}
        </BaseDropdownMenuItem>
    );
};

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

const DropdownMenuGroup = ({ children, ...props }: React.ComponentProps<typeof BaseDropdownMenuGroup>) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return (
            <div data-slot="dropdown-menu-group" role="group" {...(props as React.ComponentProps<"div">)}>
                {children}
            </div>
        );
    }

    return <BaseDropdownMenuGroup {...props}>{children}</BaseDropdownMenuGroup>;
};

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

const DropdownMenuLabel = ({
    children,
    className,
    inset,
    ...props
}: React.ComponentProps<"div"> & {
    children?: React.ReactNode;
    className?: string;
    inset?: boolean;
}) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return (
            <div
                className={cn("text-muted-foreground px-2 py-1.5 text-xs", inset && "pl-8", className)}
                data-inset={inset || undefined}
                data-slot="dropdown-menu-label"
                role="presentation"
                {...props}
            >
                {children}
            </div>
        );
    }

    return (
        <BaseDropdownMenuLabel className={className} inset={inset} {...(props as any)}>
            {children}
        </BaseDropdownMenuLabel>
    );
};

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

const DropdownMenuSeparator = ({ className, ...props }: React.ComponentProps<"div">) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <div className={cn("bg-border/50 -mx-1 my-1 h-px", className)} data-slot="dropdown-menu-separator" role="separator" {...props} />;
    }

    return <BaseDropdownMenuSeparator className={className} {...(props as any)} />;
};

// ---------------------------------------------------------------------------
// Shortcut — hidden on mobile (keyboard shortcuts are irrelevant on touch)
// ---------------------------------------------------------------------------

const DropdownMenuShortcut = ({ className, ...props }: React.ComponentProps<"span">) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return null;
    }

    return <BaseDropdownMenuShortcut className={className} {...props} />;
};

// ---------------------------------------------------------------------------
// Checkbox Item
// ---------------------------------------------------------------------------

const DropdownMenuCheckboxItem = ({
    checked,
    children,
    className,
    disabled,
    onClick,
    ...props
}: Omit<React.ComponentProps<"button">, OwnedButtonProps> & {
    checked?: boolean;
    children?: React.ReactNode;
    className?: string;
    disabled?: boolean;
    onClick?: React.MouseEventHandler;
}) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return (
            <button
                aria-checked={checked}
                className={cn(
                    "focus:bg-accent focus:text-accent-foreground active:bg-accent relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm/relaxed outline-hidden select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                    className,
                )}
                data-slot="dropdown-menu-checkbox-item"
                disabled={disabled}
                onClick={onClick}
                role="menuitemcheckbox"
                type="button"
                {...props}
            >
                <span className="pointer-events-none absolute right-2 flex items-center justify-center" data-slot="dropdown-menu-checkbox-item-indicator">
                    {checked ? <CheckIcon className="size-3.5" /> : null}
                </span>
                {children}
            </button>
        );
    }

    return (
        <BaseDropdownMenuCheckboxItem checked={checked} className={className} onClick={onClick as any} {...(props as any)}>
            {children}
        </BaseDropdownMenuCheckboxItem>
    );
};

// ---------------------------------------------------------------------------
// Radio Group
// ---------------------------------------------------------------------------

const DropdownMenuRadioGroup = ({ children, ...props }: React.ComponentProps<typeof BaseDropdownMenuRadioGroup>) => {
    const isMobile = React.use(IsMobileContext);

    const { onValueChange, value, ...rest } = props;
    const groupValue = React.useMemo(() => {
        return {
            // The mobile branch is plain DOM, so there is no Base UI
            // `ChangeEventDetails` to hand back — narrowed to the value-only
            // signature rather than fabricating a details object whose `cancel`
            // and `reason` would be lies.
            onValueChange: onValueChange as ((next: string) => void) | undefined,
            value: value as string | undefined,
        };
    }, [onValueChange, value]);

    if (isMobile) {
        return (
            <RadioGroupContext value={groupValue}>
                <div data-slot="dropdown-menu-radio-group" role="radiogroup" {...(rest as React.ComponentProps<"div">)}>
                    {children}
                </div>
            </RadioGroupContext>
        );
    }

    return <BaseDropdownMenuRadioGroup {...props}>{children}</BaseDropdownMenuRadioGroup>;
};

// ---------------------------------------------------------------------------
// Radio Item
// ---------------------------------------------------------------------------

const DropdownMenuRadioItem = ({
    children,
    className,
    disabled,
    onClick,
    ...props
}: Omit<React.ComponentProps<"button">, OwnedButtonProps> & {
    children?: React.ReactNode;
    className?: string;
    disabled?: boolean;
    onClick?: React.MouseEventHandler;
}) => {
    const isMobile = React.use(IsMobileContext);
    const group = React.use(RadioGroupContext);

    if (isMobile) {
        const itemValue = props.value === undefined ? undefined : String(props.value);
        const isChecked = group !== undefined && itemValue !== undefined && group.value === itemValue;

        return (
            <button
                className={cn(
                    "focus:bg-accent focus:text-accent-foreground active:bg-accent relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm/relaxed outline-hidden select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                    className,
                )}
                data-slot="dropdown-menu-radio-item"
                disabled={disabled}
                onClick={(event) => {
                    if (itemValue !== undefined) {
                        group?.onValueChange?.(itemValue);
                    }

                    onClick?.(event);
                }}
                role="menuitemradio"
                type="button"
                {...props}
                // After the spread so `role="menuitemradio"` always has the state it
                // requires; a caller-supplied `aria-checked` still wins.
                aria-checked={props["aria-checked"] ?? isChecked}
            >
                {children}
            </button>
        );
    }

    return (
        <BaseDropdownMenuRadioItem className={className} onClick={onClick as any} {...(props as any)}>
            {children}
        </BaseDropdownMenuRadioItem>
    );
};

// ---------------------------------------------------------------------------
// Sub-menu — expands inline on mobile instead of a nested flyout
// ---------------------------------------------------------------------------

const DropdownMenuSub = ({ children, ...props }: React.PropsWithChildren<React.ComponentProps<typeof BaseDropdownMenuSub>>) => {
    const isMobile = React.use(IsMobileContext);
    const [expanded, setExpanded] = React.useState(false);

    const toggle = React.useCallback(() => {
        setExpanded((previous) => !previous);
    }, []);

    const submenuContextValue = React.useMemo(() => {
        return { expanded, toggle };
    }, [expanded, toggle]);

    if (isMobile) {
        return (
            <SubmenuMobileContext value={submenuContextValue}>
                <div data-slot="dropdown-menu-sub">{children}</div>
            </SubmenuMobileContext>
        );
    }

    return <BaseDropdownMenuSub {...props}>{children}</BaseDropdownMenuSub>;
};

const DropdownMenuSubTrigger = ({
    children,
    className,
    inset,
    ...props
}: React.ComponentProps<"button"> & {
    children?: React.ReactNode;
    className?: string;
    inset?: boolean;
}) => {
    const isMobile = React.use(IsMobileContext);
    const { expanded, toggle } = React.use(SubmenuMobileContext);

    if (isMobile) {
        return (
            <button
                className={cn(
                    "focus:bg-accent focus:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground active:bg-accent flex min-h-8 w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm/relaxed outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                    className,
                )}
                data-inset={inset || undefined}
                data-open={expanded || undefined}
                data-slot="dropdown-menu-sub-trigger"
                onClick={toggle}
                type="button"
            >
                {children}
                <ChevronRightIcon className={cn("ml-auto size-3.5 transition-transform duration-150", expanded && "rotate-90")} />
            </button>
        );
    }

    return (
        <BaseDropdownMenuSubTrigger className={className} inset={inset} {...(props as any)}>
            {children}
        </BaseDropdownMenuSubTrigger>
    );
};

const DropdownMenuSubContent = ({ children, className, ...props }: React.ComponentProps<typeof BaseDropdownMenuSubContent>) => {
    const isMobile = React.use(IsMobileContext);
    const { expanded } = React.use(SubmenuMobileContext);

    if (isMobile) {
        if (!expanded) {
            return null;
        }

        return (
            <div className="border-border/30 ml-2 border-l pl-2" data-slot="dropdown-menu-sub-content">
                {children}
            </div>
        );
    }

    return (
        <BaseDropdownMenuSubContent className={className} {...props}>
            {children}
        </BaseDropdownMenuSubContent>
    );
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

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

export { type DropdownMenuContentProps, type DropdownMenuProps } from "./dropdown-menu";
