"use client";

import MOBILE_BREAKPOINT_QUERY from "@ui/utils/breakpoints";
import cn from "@ui/utils/cn";
import * as React from "react";
import { useMediaMatch } from "rooks";

import type { DialogPopupProps, DialogProps } from "./dialog";
import {
    Dialog as BaseDialog,
    DialogClose as BaseDialogClose,
    DialogDescription as BaseDialogDescription,
    DialogFooter as BaseDialogFooter,
    DialogHeader as BaseDialogHeader,
    DialogPanel as BaseDialogPanel,
    DialogPopup as BaseDialogPopup,
    DialogTitle as BaseDialogTitle,
    DialogTrigger as BaseDialogTrigger,
} from "./dialog";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger } from "./drawer";
import { IsMobileContext } from "./responsive-dialog-context";

/**
 * Responsive dialog root. Renders a centered Dialog on desktop and
 * a bottom-sheet Drawer on mobile (< 768px).
 *
 * Accepts the same props as Dialog — on mobile only `open` and
 * `onOpenChange` are forwarded to the Drawer.
 */
const Dialog = ({ children, onOpenChange, open, ...props }: React.PropsWithChildren<DialogProps>) => {
    const isMobile = useMediaMatch(MOBILE_BREAKPOINT_QUERY);

    return (
        <IsMobileContext value={!!isMobile}>
            {isMobile ? (
                <Drawer onOpenChange={onOpenChange} open={open}>
                    {children}
                </Drawer>
            ) : (
                <BaseDialog onOpenChange={onOpenChange} open={open} {...props}>
                    {children}
                </BaseDialog>
            )}
        </IsMobileContext>
    );
};

/**
 * Responsive dialog trigger. Renders DialogTrigger on desktop and
 * DrawerTrigger on mobile.
 *
 * Accepts the Base UI DialogTrigger props on desktop. On mobile,
 * only runtime-compatible props are forwarded to the vaul DrawerTrigger.
 */
const DialogTrigger = (props: React.ComponentProps<typeof BaseDialogTrigger>) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        // Base UI and vaul Trigger types differ (e.g. className can be a function
        // in Base UI but not in vaul). At runtime the props are compatible.
        const { className, ...rest } = props;

        return <DrawerTrigger className={typeof className === "function" ? undefined : className} {...(rest as React.ComponentProps<typeof DrawerTrigger>)} />;
    }

    return <BaseDialogTrigger {...props} />;
};

/**
 * Responsive dialog content. Renders DialogPopup (with portal, backdrop,
 * close button) on desktop and DrawerContent (bottom sheet with drag handle)
 * on mobile.
 *
 * Desktop-only props like `bottomStickOnMobile`, `onOpenAutoFocus`,
 * `onCloseAutoFocus` are ignored in mobile mode.
 */
const DialogContent = ({ bottomStickOnMobile, children, className, onCloseAutoFocus, onOpenAutoFocus, showCloseButton = true, ...props }: DialogPopupProps) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerContent className={cn(className)}>{children}</DrawerContent>;
    }

    return (
        <BaseDialogPopup
            bottomStickOnMobile={bottomStickOnMobile}
            className={className}
            onCloseAutoFocus={onCloseAutoFocus}
            onOpenAutoFocus={onOpenAutoFocus}
            showCloseButton={showCloseButton}
            {...props}
        >
            {children}
        </BaseDialogPopup>
    );
};

/**
 * Responsive dialog header.
 */
const DialogHeader = ({ className, ...props }: React.ComponentProps<"div">) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerHeader className={className} {...props} />;
    }

    return <BaseDialogHeader className={className} {...props} />;
};

/**
 * Responsive dialog footer. The `variant` prop is only applied on desktop.
 */
const DialogFooter = ({
    className,
    variant,
    ...props
}: React.ComponentProps<"div"> & {
    variant?: "default" | "bare";
}) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerFooter className={className} {...props} />;
    }

    return <BaseDialogFooter className={className} variant={variant} {...props} />;
};

/**
 * Responsive dialog title. Uses the drawer's smaller typography on mobile
 * and the dialog's heading typography on desktop.
 */
const DialogTitle = ({ className, ...props }: React.ComponentProps<"h2"> & { className?: string }) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerTitle className={className} {...props} />;
    }

    return <BaseDialogTitle className={className} {...props} />;
};

/**
 * Responsive dialog description.
 */
const DialogDescription = ({ className, ...props }: React.ComponentProps<"p"> & { className?: string }) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerDescription className={className} {...props} />;
    }

    return <BaseDialogDescription className={className} {...props} />;
};

/**
 * Responsive dialog close button.
 */
const DialogClose = (props: React.ComponentProps<typeof BaseDialogClose>) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerClose {...(props as React.ComponentProps<typeof DrawerClose>)} />;
    }

    return <BaseDialogClose {...props} />;
};

/**
 * Responsive dialog body/panel. On desktop this wraps content in a ScrollArea
 * with the standard dialog padding. On mobile it renders a scrollable div
 * with drawer-consistent padding.
 */
const DialogPanel = ({ className, ...props }: React.ComponentProps<"div">) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <div className={cn("min-h-0 flex-1 overflow-y-auto px-4", className)} data-slot="responsive-dialog-body" {...props} />;
    }

    return <BaseDialogPanel className={className} {...props} />;
};

export {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogPanel,
    DialogContent as DialogPopup,
    DialogTitle,
    DialogTrigger,
};

export { type DialogPopupProps, type DialogProps } from "./dialog";
