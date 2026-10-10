"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import cn from "@ui/utils/cn";

export interface TooltipProviderProps extends TooltipPrimitive.Provider.Props {
    /**
     * @deprecated Use delay instead. This is kept for backward compatibility.
     * The duration from when the mouse enters a tooltip trigger until the tooltip opens.
     */
    delayDuration?: number;
}

const TooltipProvider = ({ delay = 0, delayDuration, ...props }: TooltipProviderProps) => (
    <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delayDuration ?? delay} {...props} />
);

export interface TooltipProps extends Omit<TooltipPrimitive.Root.Props, "onOpenChange"> {
    /**
     * @deprecated Use delay on TooltipProvider instead. This is kept for backward compatibility.
     * The duration from when the mouse enters a tooltip trigger until the tooltip opens.
     */
    delayDuration?: number;

    /**
     * Simplified callback that fires when the tooltip open state changes.
     * For the full event details, use onOpenChangeWithDetails instead.
     */
    onOpenChange?: (open: boolean) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onOpenChangeWithDetails?: TooltipPrimitive.Root.Props["onOpenChange"];
}

const Tooltip = ({ delayDuration, onOpenChange, onOpenChangeWithDetails, ...props }: TooltipProps) => {
    const handleOpenChange: TooltipPrimitive.Root.Props["onOpenChange"] = (newOpen, eventDetails) => {
        onOpenChange?.(newOpen);
        onOpenChangeWithDetails?.(newOpen, eventDetails);
    };

    return (
        <TooltipProvider delayDuration={delayDuration}>
            <TooltipPrimitive.Root data-slot="tooltip" onOpenChange={handleOpenChange} {...props} />
        </TooltipProvider>
    );
};

const TooltipTrigger = ({ children, render, ...props }: TooltipPrimitive.Trigger.Props) => {
    if (render) {
        return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" render={render} {...props} />;
    }

    return (
        <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props}>
            {children}
        </TooltipPrimitive.Trigger>
    );
};

const TooltipContent = ({
    align = "center",
    alignOffset = 0,
    children,
    className,
    side = "top",
    sideOffset = 4,
    ...props
}: Pick<TooltipPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset"> & TooltipPrimitive.Popup.Props) => (
    <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner align={align} alignOffset={alignOffset} className="isolate z-50" side={side} sideOffset={sideOffset}>
            <TooltipPrimitive.Popup
                className={cn(
                    "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 bg-foreground text-background z-50 w-fit max-w-xs origin-(--transform-origin) rounded-md px-3 py-1.5 text-xs **:data-[slot=kbd]:rounded-md",
                    className,
                )}
                data-slot="tooltip-content"
                {...props}
            >
                {children}
                <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
            </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
);

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
