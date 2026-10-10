"use client";

import cn from "@ui/utils/cn";
import * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";

const Drawer = ({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) => <DrawerPrimitive.Root data-slot="drawer" {...props} />;

const DrawerTrigger = ({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Trigger>) => <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;

const DrawerPortal = ({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) => <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;

const DrawerClose = ({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Close>) => <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;

const DrawerOverlay = ({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Overlay>) => (
    <DrawerPrimitive.Overlay
        className={cn(
            "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 fixed inset-0 z-50 bg-black/80 supports-backdrop-filter:backdrop-blur-xs",
            className,
        )}
        data-slot="drawer-overlay"
        {...props}
    />
);

const DrawerContent = ({ children, className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Content>) => (
    <DrawerPortal data-slot="drawer-portal">
        <DrawerOverlay />
        <DrawerPrimitive.Content
            className={cn(
                "before:bg-background group/drawer-content fixed relative z-50 flex h-auto flex-col bg-transparent p-2 text-xs/relaxed before:absolute before:inset-2 before:-z-10 before:rounded-xl data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80vh] data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80vh] data-[vaul-drawer-direction=left]:sm:max-w-sm data-[vaul-drawer-direction=right]:sm:max-w-sm",
                className,
            )}
            data-slot="drawer-content"
            {...props}
        >
            <div className="bg-muted bg-muted mx-auto mt-4 hidden h-1.5 w-[100px] shrink-0 rounded-full group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />
            {children}
        </DrawerPrimitive.Content>
    </DrawerPortal>
);

const DrawerHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn(
            "flex flex-col gap-1 p-4 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-center group-data-[vaul-drawer-direction=top]/drawer-content:text-center md:text-left",
            className,
        )}
        data-slot="drawer-header"
        {...props}
    />
);

const DrawerFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("mt-auto flex flex-col gap-2 p-4", className)} data-slot="drawer-footer" {...props} />
);

const DrawerTitle = ({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) => (
    <DrawerPrimitive.Title className={cn("text-foreground text-sm font-medium", className)} data-slot="drawer-title" {...props} />
);

const DrawerDescription = ({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Description>) => (
    <DrawerPrimitive.Description className={cn("text-muted-foreground text-xs/relaxed", className)} data-slot="drawer-description" {...props} />
);

export { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerOverlay, DrawerPortal, DrawerTitle, DrawerTrigger };
