"use client";

import MOBILE_BREAKPOINT_QUERY from "@ui/utils/breakpoints";
import cn from "@ui/utils/cn";
import * as React from "react";
import { useMediaMatch } from "rooks";

import type { AlertDialogProps } from "./alert-dialog";
import {
    AlertDialog as BaseAlertDialog,
    AlertDialogAction as BaseAlertDialogAction,
    AlertDialogCancel as BaseAlertDialogCancel,
    AlertDialogContent as BaseAlertDialogContent,
    AlertDialogDescription as BaseAlertDialogDescription,
    AlertDialogFooter as BaseAlertDialogFooter,
    AlertDialogHeader as BaseAlertDialogHeader,
    AlertDialogMedia as BaseAlertDialogMedia,
    AlertDialogTitle as BaseAlertDialogTitle,
    AlertDialogTrigger as BaseAlertDialogTrigger,
} from "./alert-dialog";
import { Button } from "./button";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger } from "./drawer";

const IsMobileContext = React.createContext(false);

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * Responsive alert dialog root. Renders a centered AlertDialog on desktop
 * and a bottom-sheet Drawer on mobile (< 768px).
 */
const AlertDialog = ({ children, onOpenChange, open, ...props }: React.PropsWithChildren<AlertDialogProps>) => {
    const isMobile = useMediaMatch(MOBILE_BREAKPOINT_QUERY);

    return (
        <IsMobileContext value={!!isMobile}>
            {isMobile ? (
                <Drawer onOpenChange={onOpenChange} open={open}>
                    {children}
                </Drawer>
            ) : (
                <BaseAlertDialog onOpenChange={onOpenChange} open={open} {...props}>
                    {children}
                </BaseAlertDialog>
            )}
        </IsMobileContext>
    );
};

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

const AlertDialogTrigger = (props: React.ComponentProps<typeof BaseAlertDialogTrigger>) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        const { className, ...rest } = props;

        return <DrawerTrigger className={typeof className === "function" ? undefined : className} {...(rest as React.ComponentProps<typeof DrawerTrigger>)} />;
    }

    return <BaseAlertDialogTrigger {...props} />;
};

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const AlertDialogContent = ({
    children,
    className,
    size,
    ...props
}: React.ComponentProps<"div"> & {
    children?: React.ReactNode;
    className?: string;
    size?: "default" | "sm";
}) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return (
            <DrawerContent>
                <div className={cn("p-4", className)} {...props}>
                    {children}
                </div>
            </DrawerContent>
        );
    }

    return (
        <BaseAlertDialogContent className={className} size={size} {...(props as any)}>
            {children}
        </BaseAlertDialogContent>
    );
};

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const AlertDialogHeader = ({ className, ...props }: React.ComponentProps<"div">) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerHeader className={className} {...props} />;
    }

    return <BaseAlertDialogHeader className={className} {...props} />;
};

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

const AlertDialogFooter = ({ className, ...props }: React.ComponentProps<"div">) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerFooter className={className} {...props} />;
    }

    return <BaseAlertDialogFooter className={className} {...props} />;
};

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const AlertDialogMedia = ({ className, ...props }: React.ComponentProps<"div">) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return (
            <div
                className={cn("bg-muted mb-2 inline-flex size-8 items-center justify-center rounded-md *:[svg:not([class*='size-'])]:size-4", className)}
                data-slot="alert-dialog-media"
                {...props}
            />
        );
    }

    return <BaseAlertDialogMedia className={className} {...props} />;
};

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

const AlertDialogTitle = ({ className, ...props }: React.ComponentProps<"h2"> & { className?: string }) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerTitle className={className} {...props} />;
    }

    return <BaseAlertDialogTitle className={className} {...props} />;
};

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

const AlertDialogDescription = ({ className, ...props }: React.ComponentProps<"p"> & { className?: string }) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerDescription className={className} {...props} />;
    }

    return <BaseAlertDialogDescription className={className} {...props} />;
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

const AlertDialogAction = ({ className, ...props }: React.ComponentProps<typeof Button>) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <Button className={cn("w-full", className)} data-slot="alert-dialog-action" {...props} />;
    }

    return <BaseAlertDialogAction className={className} {...props} />;
};

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

const AlertDialogCancel = ({
    children,
    className,
    disabled,
    onClick,
    size = "default",
    variant = "outline",
    ...props
}: Omit<React.ComponentProps<"button">, "className" | "children" | "disabled" | "onClick"> & {
    children?: React.ReactNode;
    className?: string;
    disabled?: boolean;
    onClick?: React.MouseEventHandler;
    size?: "default" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg" | "xs";
    variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
}) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return (
            <DrawerClose asChild>
                <Button
                    className={cn("w-full", className)}
                    data-slot="alert-dialog-cancel"
                    disabled={disabled}
                    onClick={onClick}
                    size={size}
                    variant={variant}
                    {...props}
                >
                    {children}
                </Button>
            </DrawerClose>
        );
    }

    return (
        <BaseAlertDialogCancel className={className} disabled={disabled} onClick={onClick as any} size={size} variant={variant} {...(props as any)}>
            {children}
        </BaseAlertDialogCancel>
    );
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogMedia,
    AlertDialogTitle,
    AlertDialogTrigger,
};

export { type AlertDialogProps } from "./alert-dialog";
