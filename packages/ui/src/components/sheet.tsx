import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import cn from "@ui/utils/cn";
import { XIcon } from "lucide-react";
import * as React from "react";

export interface SheetProps extends Omit<SheetPrimitive.Root.Props, "onOpenChange"> {
    /**
     * Simplified callback that fires when the sheet open state changes.
     * For the full event details, use onOpenChangeWithDetails instead.
     */
    onOpenChange?: (open: boolean) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onOpenChangeWithDetails?: SheetPrimitive.Root.Props["onOpenChange"];
}

const Sheet = ({ onOpenChange, onOpenChangeWithDetails, ...props }: SheetProps) => {
    const handleOpenChange: SheetPrimitive.Root.Props["onOpenChange"] = (newOpen, eventDetails) => {
        onOpenChange?.(newOpen);
        onOpenChangeWithDetails?.(newOpen, eventDetails);
    };

    return <SheetPrimitive.Root data-slot="sheet" onOpenChange={handleOpenChange} {...props} />;
};

const SheetTrigger = ({ ...props }: SheetPrimitive.Trigger.Props) => <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;

const SheetClose = ({ ...props }: SheetPrimitive.Close.Props) => <SheetPrimitive.Close data-slot="sheet-close" {...props} />;

const SheetPortal = ({ ...props }: SheetPrimitive.Portal.Props) => <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;

const SheetOverlay = ({ className, ...props }: SheetPrimitive.Backdrop.Props) => (
    <SheetPrimitive.Backdrop
        className={cn(
            "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 fixed inset-0 z-50 bg-black/80 duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
            className,
        )}
        data-slot="sheet-overlay"
        {...props}
    />
);

const SheetContent = ({
    children,
    className,
    showCloseButton = true,
    side = "right",
    ...props
}: SheetPrimitive.Popup.Props & {
    showCloseButton?: boolean;
    side?: "top" | "right" | "bottom" | "left";
}) => {
    const { t } = useLingui();

    return (
        <SheetPortal>
            <SheetOverlay />
            <SheetPrimitive.Popup
                className={cn(
                    "bg-background data-open:animate-in data-closed:animate-out data-[side=right]:data-closed:slide-out-to-right-10 data-[side=right]:data-open:slide-in-from-right-10 data-[side=left]:data-closed:slide-out-to-left-10 data-[side=left]:data-open:slide-in-from-left-10 data-[side=top]:data-closed:slide-out-to-top-10 data-[side=top]:data-open:slide-in-from-top-10 data-closed:fade-out-0 data-open:fade-in-0 data-[side=bottom]:data-closed:slide-out-to-bottom-10 data-[side=bottom]:data-open:slide-in-from-bottom-10 fixed z-50 flex flex-col bg-clip-padding text-xs/relaxed shadow-lg transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
                    className,
                )}
                data-side={side}
                data-slot="sheet-content"
                {...props}
            >
                {children}
                {showCloseButton && (
                    <SheetPrimitive.Close data-slot="sheet-close" render={<Button className="absolute top-4 right-4" size="icon-sm" variant="ghost" />}>
                        <XIcon />
                        <span className="sr-only">{t`Close`}</span>
                    </SheetPrimitive.Close>
                )}
            </SheetPrimitive.Popup>
        </SheetPortal>
    );
};

const SheetHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("flex flex-col gap-1.5 p-6", className)} data-slot="sheet-header" {...props} />
);

const SheetFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("mt-auto flex flex-col gap-2 p-6", className)} data-slot="sheet-footer" {...props} />
);

const SheetTitle = ({ className, ...props }: SheetPrimitive.Title.Props) => (
    <SheetPrimitive.Title className={cn("text-foreground text-sm font-medium", className)} data-slot="sheet-title" {...props} />
);

const SheetDescription = ({ className, ...props }: SheetPrimitive.Description.Props) => (
    <SheetPrimitive.Description className={cn("text-muted-foreground text-xs/relaxed", className)} data-slot="sheet-description" {...props} />
);

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger };
