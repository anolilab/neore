import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { ToasterProps } from "sonner";
import { Toaster as Sonner } from "sonner";

import { toastCloseButtonClass, toastDescriptionClass, toastIconClass, toastSurfaceClass, toastTextButtonClass, toastTitleClass } from "./toast-variants";

/**
 * `unstyled` because sonner's own selectors outrank a plain class. Action and cancel buttons sit on a
 * second row, indented by the icon width (`ms-11`); plain toasts have no icon, so they drop the indent.
 */
const Toaster = ({ ...props }: ToasterProps) => {
    const { theme = "system" } = useTheme();

    return (
        <Sonner
            className="toaster group"
            closeButton
            icons={{
                close: <XIcon aria-hidden="true" className="size-4" />,
                error: <OctagonXIcon aria-hidden="true" className="size-4" />,
                info: <InfoIcon aria-hidden="true" className="size-4" />,
                loading: <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />,
                success: <CircleCheckIcon aria-hidden="true" className="size-4" />,
                warning: <TriangleAlertIcon aria-hidden="true" className="size-4" />,
            }}
            theme={theme as ToasterProps["theme"]}
            toastOptions={{
                classNames: {
                    actionButton: `ms-11 inline-flex h-auto items-center p-0 font-semibold text-popover-foreground hover:underline group-[:not([data-type])]/toast:ms-0 [[data-cancel]+&]:ms-0 ${toastTextButtonClass}`,
                    cancelButton: `ms-11 inline-flex h-auto items-center p-0 font-medium text-muted-foreground hover:text-popover-foreground group-[:not([data-type])]/toast:ms-0 ${toastTextButtonClass}`,
                    // `!` because sonner's dark-theme rule paints this button, and it outranks a plain class.
                    closeButton: `${toastCloseButtonClass} !bg-transparent !text-muted-foreground hover:!bg-muted hover:!text-popover-foreground [&>svg]:size-4`,
                    content: "flex min-w-0 grow basis-[calc(100%_-_2.75rem)] flex-col gap-0.5 pe-9",
                    description: toastDescriptionClass,
                    error: "border-destructive/40",
                    icon: `${toastIconClass} relative self-start group-data-[type=error]/toast:bg-destructive/10 group-data-[type=error]/toast:text-destructive group-data-[type=info]/toast:bg-info/10 group-data-[type=info]/toast:text-info-foreground group-data-[type=success]/toast:bg-success/10 group-data-[type=success]/toast:text-success-foreground group-data-[type=warning]/toast:bg-warning/10 group-data-[type=warning]/toast:text-warning-foreground`,
                    title: toastTitleClass,
                    // `invisible` as well as `opacity-0`: opacity alone leaves a collapsed toast's buttons in the tab order.
                    toast: `group/toast relative flex w-(--width) flex-wrap items-start gap-x-3 gap-y-2 p-4 data-[expanded=false]:data-[front=false]:*:opacity-0 data-[expanded=false]:data-[front=false]:*:invisible ${toastSurfaceClass}`,
                },
                unstyled: true,
            }}
            {...props}
        />
    );
};

export { Toaster };
