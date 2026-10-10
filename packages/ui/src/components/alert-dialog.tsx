import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Button } from "@ui/components/button";
import cn from "@ui/utils/cn";
import * as React from "react";
import { Activity, createContext, use } from "react";

const AlertDialogContext = createContext<{ open: boolean } | null>(null);

export interface AlertDialogProps extends Omit<AlertDialogPrimitive.Root.Props, "onOpenChange"> {
    /**
     * Simplified callback that fires when the alert dialog open state changes.
     * For the full event details, use onOpenChangeWithDetails instead.
     */
    onOpenChange?: (open: boolean) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onOpenChangeWithDetails?: AlertDialogPrimitive.Root.Props["onOpenChange"];
}

const AlertDialog = ({ onOpenChange, onOpenChangeWithDetails, open, ...props }: AlertDialogProps) => {
    const handleOpenChange: AlertDialogPrimitive.Root.Props["onOpenChange"] = (newOpen, eventDetails) => {
        onOpenChange?.(newOpen);
        onOpenChangeWithDetails?.(newOpen, eventDetails);
    };

    const contextValue = React.useMemo(() => {
        return { open: open ?? false };
    }, [open]);

    return (
        <AlertDialogContext value={contextValue}>
            <AlertDialogPrimitive.Root data-slot="alert-dialog" onOpenChange={handleOpenChange} open={open} {...props} />
        </AlertDialogContext>
    );
};

const AlertDialogTrigger = ({ ...props }: AlertDialogPrimitive.Trigger.Props) => <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;

const AlertDialogPortal = ({ ...props }: AlertDialogPrimitive.Portal.Props) => <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;

const AlertDialogOverlay = ({ className, ...props }: AlertDialogPrimitive.Backdrop.Props) => (
    <AlertDialogPrimitive.Backdrop
        className={cn(
            "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 fixed inset-0 isolate z-50 bg-black/80 duration-100 supports-backdrop-filter:backdrop-blur-xs",
            className,
        )}
        data-slot="alert-dialog-overlay"
        {...props}
    />
);

const AlertDialogContent = ({
    children,
    className,
    size = "default",
    ...props
}: AlertDialogPrimitive.Popup.Props & {
    size?: "default" | "sm";
}) => {
    const context = use(AlertDialogContext);
    const open = context?.open ?? true; // Default to true since Content is only rendered when dialog is open

    return (
        <AlertDialogPortal>
            <AlertDialogOverlay />
            <AlertDialogPrimitive.Popup
                className={cn(
                    "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 bg-background ring-foreground/10 group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl p-4 ring-1 duration-100 outline-none data-[size=default]:max-w-xs data-[size=sm]:max-w-64 data-[size=default]:sm:max-w-sm",
                    className,
                )}
                data-size={size}
                data-slot="alert-dialog-content"
                {...props}
            >
                <Activity mode={open ? "visible" : "hidden"}>{children}</Activity>
            </AlertDialogPrimitive.Popup>
        </AlertDialogPortal>
    );
};

const AlertDialogHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn(
            "grid grid-rows-[auto_1fr] place-items-center gap-1 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-4 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
            className,
        )}
        data-slot="alert-dialog-header"
        {...props}
    />
);

const AlertDialogFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn(
            "flex flex-col-reverse gap-2 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end",
            className,
        )}
        data-slot="alert-dialog-footer"
        {...props}
    />
);

const AlertDialogMedia = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn(
            "bg-muted mb-2 inline-flex size-8 items-center justify-center rounded-md sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-4",
            className,
        )}
        data-slot="alert-dialog-media"
        {...props}
    />
);

const AlertDialogTitle = ({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) => (
    <AlertDialogPrimitive.Title
        className={cn(
            "text-sm font-medium sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
            className,
        )}
        data-slot="alert-dialog-title"
        {...props}
    />
);

const AlertDialogDescription = ({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Description>) => (
    <AlertDialogPrimitive.Description
        className={cn(
            "text-muted-foreground *:[a]:hover:text-foreground text-xs/relaxed text-balance md:text-pretty *:[a]:underline *:[a]:underline-offset-3",
            className,
        )}
        data-slot="alert-dialog-description"
        {...props}
    />
);

const AlertDialogAction = ({ className, ...props }: React.ComponentProps<typeof Button>) => (
    <Button className={cn(className)} data-slot="alert-dialog-action" {...props} />
);

const AlertDialogCancel = ({
    className,
    size = "default",
    variant = "outline",
    ...props
}: AlertDialogPrimitive.Close.Props & Pick<React.ComponentProps<typeof Button>, "variant" | "size">) => (
    <AlertDialogPrimitive.Close className={cn(className)} data-slot="alert-dialog-cancel" render={<Button size={size} variant={variant} />} {...props} />
);

export {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogMedia,
    AlertDialogOverlay,
    AlertDialogPortal,
    AlertDialogTitle,
    AlertDialogTrigger,
};
