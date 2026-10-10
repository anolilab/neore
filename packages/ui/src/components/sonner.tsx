import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { ToasterProps } from "sonner";
import { Toaster as Sonner } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
    const { theme = "system" } = useTheme();

    return (
        <Sonner
            className="toaster group"
            icons={{
                error: <OctagonXIcon aria-hidden="true" className="size-4" />,
                info: <InfoIcon aria-hidden="true" className="size-4" />,
                loading: <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />,
                success: <CircleCheckIcon aria-hidden="true" className="size-4" />,
                warning: <TriangleAlertIcon aria-hidden="true" className="size-4" />,
            }}
            style={
                {
                    "--border-radius": "var(--radius)",
                    "--normal-bg": "var(--popover)",
                    "--normal-border": "var(--border)",
                    "--normal-text": "var(--popover-foreground)",
                } as React.CSSProperties
            }
            theme={theme as ToasterProps["theme"]}
            toastOptions={{
                classNames: {
                    toast: "cn-toast",
                },
            }}
            {...props}
        />
    );
};

export { Toaster };
