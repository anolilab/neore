"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { ScrollArea } from "@ui/components/scroll-area";
import cn from "@ui/utils/cn";
import { XIcon } from "lucide-react";
import * as React from "react";
import { Activity, createContext, use } from "react";

const DialogContext = createContext<{ open: boolean } | null>(null);

export interface DialogProps extends Omit<DialogPrimitive.Root.Props, "onOpenChange"> {
    /**
     * Simplified callback that fires when the dialog open state changes.
     * For the full event details, use onOpenChangeWithDetails instead.
     */
    onOpenChange?: (open: boolean) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onOpenChangeWithDetails?: DialogPrimitive.Root.Props["onOpenChange"];
}

const DialogRoot = ({ onOpenChange, onOpenChangeWithDetails, open, ...props }: DialogProps) => {
    const handleOpenChange: DialogPrimitive.Root.Props["onOpenChange"] = (newOpen, eventDetails) => {
        onOpenChange?.(newOpen);
        onOpenChangeWithDetails?.(newOpen, eventDetails);
    };

    const contextValue = React.useMemo(() => {
        return { open: open ?? false };
    }, [open]);

    return (
        <DialogContext value={contextValue}>
            <DialogPrimitive.Root onOpenChange={handleOpenChange} open={open} {...props} />
        </DialogContext>
    );
};

const Dialog = DialogRoot;

const DialogPortal = DialogPrimitive.Portal;

const DialogTrigger = (props: DialogPrimitive.Trigger.Props) => <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;

const DialogClose = (props: DialogPrimitive.Close.Props) => <DialogPrimitive.Close data-slot="dialog-close" {...props} />;

const DialogBackdrop = ({ className, ...props }: DialogPrimitive.Backdrop.Props) => (
    <DialogPrimitive.Backdrop
        className={cn(
            "fixed inset-0 z-50 bg-black/32 backdrop-blur-sm transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
        )}
        data-slot="dialog-backdrop"
        {...props}
    />
);

const DialogViewport = ({ className, ...props }: DialogPrimitive.Viewport.Props) => (
    <DialogPrimitive.Viewport
        className={cn("fixed inset-0 z-50 grid grid-rows-[1fr_auto_3fr] justify-items-center p-4", className)}
        data-slot="dialog-viewport"
        {...props}
    />
);

export interface DialogPopupProps extends DialogPrimitive.Popup.Props {
    bottomStickOnMobile?: boolean;

    /**
     * @deprecated Use finalFocus on Dialog root instead. This is kept for backward compatibility.
     * Event handler called when focus moves outside the component after closing.
     */
    onCloseAutoFocus?: (event: Event) => void;

    /**
     * @deprecated Use initialFocus on Dialog root instead. This is kept for backward compatibility.
     * Event handler called when focus moves into the component after opening.
     */
    onOpenAutoFocus?: (event: Event) => void;
    showCloseButton?: boolean;
}

const DialogPopup = ({
    bottomStickOnMobile = true,
    children,
    className,
    onCloseAutoFocus,
    onOpenAutoFocus,
    showCloseButton = true,
    ...props
}: DialogPopupProps) => {
    const { t } = useLingui();
    const context = use(DialogContext);
    const popupRef = React.useRef<HTMLDivElement>(null);

    // Handle focus callbacks via data attributes
    React.useEffect(() => {
        const popup = popupRef.current;

        if (!popup) {
            return undefined;
        }

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.attributeName === "data-open") {
                    const isOpen = "open" in popup.dataset;

                    if (isOpen && onOpenAutoFocus) {
                        const event = new Event("focus", { cancelable: true });

                        onOpenAutoFocus(event);
                    }
                } else if (mutation.attributeName === "data-closed") {
                    const isClosed = "closed" in popup.dataset;

                    if (isClosed && onCloseAutoFocus) {
                        const event = new Event("focus", { cancelable: true });

                        onCloseAutoFocus(event);
                    }
                }
            }
        });

        observer.observe(popup, { attributes: true });

        return () => observer.disconnect();
    }, [onOpenAutoFocus, onCloseAutoFocus]);

    return (
        <DialogPortal>
            <DialogBackdrop />
            <DialogViewport className={cn(bottomStickOnMobile && "max-sm:grid-rows-[1fr_auto] max-sm:pt-12")}>
                <DialogPrimitive.Popup
                    className={cn(
                        "bg-popover text-popover-foreground relative row-start-2 flex max-h-full min-h-0 w-full max-w-lg min-w-0 -translate-y-[calc(1.25rem*var(--nested-dialogs))] scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-md border bg-clip-padding opacity-[calc(1-0.1*var(--nested-dialogs))] shadow-lg transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-ending-style:opacity-0 data-nested:data-ending-style:translate-y-8 data-nested-dialog-open:origin-top data-starting-style:scale-98 data-starting-style:opacity-0 data-nested:data-starting-style:translate-y-8 dark:bg-clip-border dark:before:shadow-[0_-1px_--theme(--color-white/8%)]",
                        bottomStickOnMobile &&
                            "max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:opacity-[calc(1-min(var(--nested-dialogs),1))] max-sm:before:hidden max-sm:before:rounded-none max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4",
                        className,
                    )}
                    data-slot="dialog-popup"
                    ref={popupRef}
                    {...props}
                >
                    <Activity mode={context?.open ? "visible" : "hidden"}>{children}</Activity>
                    {showCloseButton && (
                        <DialogPrimitive.Close aria-label={t`Close`} className="absolute end-2 top-2" render={<Button size="icon" variant="ghost" />}>
                            <XIcon aria-hidden="true" />
                        </DialogPrimitive.Close>
                    )}
                </DialogPrimitive.Popup>
            </DialogViewport>
        </DialogPortal>
    );
};

const DialogHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn("flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4", className)}
        data-slot="dialog-header"
        {...props}
    />
);

const DialogFooter = ({
    className,
    variant = "default",
    ...props
}: React.ComponentProps<"div"> & {
    variant?: "default" | "bare";
}) => (
    <div
        className={cn(
            "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-md",
            variant === "default" && "bg-muted/50 border-t py-4",
            variant === "bare" && "pt-4 pb-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pt-3",
            className,
        )}
        data-slot="dialog-footer"
        {...props}
    />
);

const DialogTitle = ({ className, ...props }: DialogPrimitive.Title.Props) => (
    <DialogPrimitive.Title className={cn("font-heading text-xl leading-none", className)} data-slot="dialog-title" {...props} />
);

const DialogDescription = ({ className, ...props }: DialogPrimitive.Description.Props) => (
    <DialogPrimitive.Description className={cn("text-muted-foreground text-sm", className)} data-slot="dialog-description" {...props} />
);

const DialogPanel = ({ className, ...props }: React.ComponentProps<"div">) => (
    <ScrollArea>
        <div
            className={cn(
                "px-6 pb-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:not(:has([data-slot=dialog-footer]))]:pb-6! in-[[data-slot=dialog-popup]:not(:has([data-slot=dialog-footer].border-t))]:pb-1 in-[[data-slot=dialog-popup]:not(:has([data-slot=dialog-header]))]:pt-6",
                className,
            )}
            data-slot="dialog-panel"
            {...props}
        />
    </ScrollArea>
);

export {
    Dialog,
    DialogBackdrop,
    DialogClose,
    DialogPopup as DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogBackdrop as DialogOverlay,
    DialogPanel,
    DialogPopup,
    DialogPortal,
    DialogTitle,
    DialogTrigger,
    DialogViewport,
};
