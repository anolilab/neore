import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import cn from "@ui/utils/cn";
import * as React from "react";

export interface PopoverProps extends Omit<PopoverPrimitive.Root.Props, "onOpenChange"> {
    /**
     * Simplified callback that fires when the popover open state changes.
     * For the full event details, use onOpenChangeWithDetails instead.
     */
    onOpenChange?: (open: boolean) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onOpenChangeWithDetails?: PopoverPrimitive.Root.Props["onOpenChange"];
}

const Popover = ({ onOpenChange, onOpenChangeWithDetails, ...props }: PopoverProps) => {
    const handleOpenChange: PopoverPrimitive.Root.Props["onOpenChange"] = (newOpen, eventDetails) => {
        onOpenChange?.(newOpen);
        onOpenChangeWithDetails?.(newOpen, eventDetails);
    };

    return <PopoverPrimitive.Root data-slot="popover" onOpenChange={handleOpenChange} {...props} />;
};

const PopoverTrigger = ({ children, render, ...props }: PopoverPrimitive.Trigger.Props & { render?: React.ReactElement }) => {
    if (render) {
        return <PopoverPrimitive.Trigger data-slot="popover-trigger" render={render} {...props} />;
    }

    return (
        <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props}>
            {children}
        </PopoverPrimitive.Trigger>
    );
};

interface PopoverAnchorProps {
    children?: React.ReactNode;
    nativeButton?: boolean;
    render?: React.ReactElement;
}

const PopoverAnchor = ({ children, nativeButton = true, render, ...props }: PopoverAnchorProps & React.ComponentProps<"div">) => {
    if (render) {
        return React.cloneElement(render as React.ReactElement<any>, {
            "data-slot": "popover-anchor",
            ...props,
            children: children ?? (render.props as any).children,
        });
    }

    const Component = nativeButton ? "button" : "div";

    return (
        <Component data-slot="popover-anchor" {...(props as any)}>
            {children}
        </Component>
    );
};

export interface PopoverContentProps
    extends Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">, PopoverPrimitive.Popup.Props {
    /**
     * @deprecated Use finalFocus on Popover root instead. This is kept for backward compatibility.
     * Event handler called when focus moves outside the component after closing.
     */
    onCloseAutoFocus?: (event: Event) => void;

    /**
     * Event handler called when the escape key is pressed.
     */
    onEscapeKeyDown?: (event: KeyboardEvent) => void;

    /**
     * @deprecated Use initialFocus on Popover root instead. This is kept for backward compatibility.
     * Event handler called when focus moves into the component after opening.
     */
    onOpenAutoFocus?: (event: Event) => void;
}

const PopoverContent = ({
    align = "center",
    alignOffset = 0,
    className,
    onCloseAutoFocus,
    onEscapeKeyDown,
    onOpenAutoFocus,
    side = "bottom",
    sideOffset = 4,
    ...props
}: PopoverContentProps) => {
    const popupRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const popup = popupRef.current;

        if (!popup) {
            return undefined;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onEscapeKeyDown?.(event);
            }
        };

        popup.addEventListener("keydown", handleKeyDown);

        return () => popup.removeEventListener("keydown", handleKeyDown);
    }, [onEscapeKeyDown]);

    // Handle focus callbacks via TransitionStatus data attributes
    React.useEffect(() => {
        const popup = popupRef.current;

        if (!popup) {
            return undefined;
        }

        // Listen for animation end to trigger focus callbacks
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.attributeName === "data-open") {
                    const isOpen = "open" in popup.dataset;

                    if (isOpen && onOpenAutoFocus) {
                        // Create a synthetic event for backward compatibility
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
        <PopoverPrimitive.Portal>
            <PopoverPrimitive.Positioner align={align} alignOffset={alignOffset} className="isolate z-50" side={side} sideOffset={sideOffset}>
                <PopoverPrimitive.Popup
                    className={cn(
                        "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 ring-foreground/10 z-50 flex w-72 origin-(--transform-origin) flex-col gap-4 rounded-lg p-2.5 text-xs shadow-md ring-1 outline-hidden duration-100",
                        className,
                    )}
                    data-slot="popover-content"
                    ref={popupRef}
                    {...props}
                />
            </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
    );
};

const PopoverHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("flex flex-col gap-1 text-xs", className)} data-slot="popover-header" {...props} />
);

const PopoverTitle = ({ className, ...props }: PopoverPrimitive.Title.Props) => (
    <PopoverPrimitive.Title className={cn("text-sm font-medium", className)} data-slot="popover-title" {...props} />
);

const PopoverDescription = ({ className, ...props }: PopoverPrimitive.Description.Props) => (
    <PopoverPrimitive.Description className={cn("text-muted-foreground", className)} data-slot="popover-description" {...props} />
);

export { Popover, PopoverAnchor, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger };
