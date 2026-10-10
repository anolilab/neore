"use client";

import MOBILE_BREAKPOINT_QUERY from "@ui/utils/breakpoints";
import cn from "@ui/utils/cn";
import * as React from "react";
import { useMediaMatch } from "rooks";

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from "./drawer";
import type { PopoverContentProps, PopoverProps } from "./popover";
import {
    Popover as BasePopover,
    PopoverContent as BasePopoverContent,
    PopoverDescription as BasePopoverDescription,
    PopoverHeader as BasePopoverHeader,
    PopoverTitle as BasePopoverTitle,
    PopoverTrigger as BasePopoverTrigger,
} from "./popover";

const IsMobileContext = React.createContext(false);

/**
 * Responsive popover root. Renders a positioned Popover on desktop and
 * a bottom-sheet Drawer on mobile (< 768px).
 */
const Popover = ({ children, onOpenChange, open, ...props }: React.PropsWithChildren<PopoverProps>) => {
    const isMobile = useMediaMatch(MOBILE_BREAKPOINT_QUERY);

    return (
        <IsMobileContext value={!!isMobile}>
            {isMobile ? (
                <Drawer onOpenChange={onOpenChange} open={open}>
                    {children}
                </Drawer>
            ) : (
                <BasePopover onOpenChange={onOpenChange} open={open} {...props}>
                    {children}
                </BasePopover>
            )}
        </IsMobileContext>
    );
};

/**
 * Responsive popover trigger.
 */
const PopoverTrigger = ({ children, className, render, ...rest }: React.ComponentProps<typeof BasePopoverTrigger>) => {
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
        <BasePopoverTrigger className={className} render={render} {...rest}>
            {children}
        </BasePopoverTrigger>
    );
};

/**
 * Responsive popover content. Renders a positioned popup on desktop and
 * a DrawerContent bottom sheet on mobile. Positioning props (align, side,
 * sideOffset, alignOffset) are ignored on mobile.
 */
const PopoverContent = ({ align, alignOffset, children, className, side, sideOffset, ...props }: PopoverContentProps) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return (
            <DrawerContent>
                <div className={cn("max-h-[60vh] overflow-y-auto p-4", className)} {...(props as React.ComponentProps<"div">)}>
                    {children}
                </div>
            </DrawerContent>
        );
    }

    return (
        <BasePopoverContent align={align} alignOffset={alignOffset} className={className} side={side} sideOffset={sideOffset} {...props}>
            {children}
        </BasePopoverContent>
    );
};

/**
 * Responsive popover header.
 */
const PopoverHeader = ({ className, ...props }: React.ComponentProps<"div">) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerHeader className={className} {...props} />;
    }

    return <BasePopoverHeader className={className} {...props} />;
};

/**
 * Responsive popover title.
 */
const PopoverTitle = ({ className, ...props }: React.ComponentProps<"h2"> & { className?: string }) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerTitle className={className} {...props} />;
    }

    return <BasePopoverTitle className={className} {...props} />;
};

/**
 * Responsive popover description.
 */
const PopoverDescription = ({ className, ...props }: React.ComponentProps<"p"> & { className?: string }) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerDescription className={className} {...props} />;
    }

    return <BasePopoverDescription className={className} {...props} />;
};

/**
 * Responsive popover close. Only renders on mobile (the drawer needs an
 * explicit close affordance; the popover closes via click-outside).
 */
const PopoverClose = (props: React.ComponentProps<typeof DrawerClose>) => {
    const isMobile = React.use(IsMobileContext);

    if (isMobile) {
        return <DrawerClose {...props} />;
    }

    return null;
};

export { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger };

export { type PopoverContentProps, type PopoverProps } from "./popover";
