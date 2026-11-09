import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { ToasterProps } from "sonner";
import { Toaster as Sonner } from "sonner";

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
                    actionButton:
                        "ms-11 inline-flex h-auto items-center rounded-sm p-0 text-sm font-semibold text-popover-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring group-[:not([data-type])]/toast:ms-0 [[data-cancel]+&]:ms-0",
                    cancelButton:
                        "ms-11 inline-flex h-auto items-center rounded-sm p-0 text-sm font-medium text-muted-foreground outline-none hover:text-popover-foreground focus-visible:ring-2 focus-visible:ring-ring group-[:not([data-type])]/toast:ms-0",
                    // `!` because sonner's dark-theme rule paints this button, and it outranks a plain class.
                    closeButton:
                        "absolute end-2 top-2 flex size-7 items-center justify-center rounded-md !bg-transparent text-muted-foreground outline-none transition-colors hover:!bg-muted hover:text-popover-foreground focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-4",
                    content: "flex min-w-0 grow basis-[calc(100%_-_2.75rem)] flex-col gap-0.5 pe-9",
                    description: "text-sm leading-5 text-muted-foreground",
                    error: "border-destructive/40",
                    icon: "flex size-8 shrink-0 items-center justify-center self-start rounded-md bg-muted text-muted-foreground group-data-[type=error]/toast:bg-destructive/10 group-data-[type=error]/toast:text-destructive group-data-[type=info]/toast:bg-info/10 group-data-[type=info]/toast:text-info group-data-[type=success]/toast:bg-success/10 group-data-[type=success]/toast:text-success group-data-[type=warning]/toast:bg-warning/10 group-data-[type=warning]/toast:text-warning",
                    title: "text-sm leading-5 font-semibold text-popover-foreground",
                    toast: "group/toast relative flex w-(--width) flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-md data-[expanded=false]:data-[front=false]:*:opacity-0",
                },
                unstyled: true,
            }}
            {...props}
        />
    );
};

export { Toaster };
