"use client";

import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import cn from "@ui/utils/cn";

export interface HoverCardProps extends Omit<PreviewCardPrimitive.Root.Props, "onOpenChange"> {
    /**
     * Simplified callback that fires when the hover card open state changes.
     * For the full event details, use onOpenChangeWithDetails instead.
     */
    onOpenChange?: (open: boolean) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onOpenChangeWithDetails?: PreviewCardPrimitive.Root.Props["onOpenChange"];
}

const HoverCard = ({ onOpenChange, onOpenChangeWithDetails, ...props }: HoverCardProps) => {
    const handleOpenChange: PreviewCardPrimitive.Root.Props["onOpenChange"] = (newOpen, eventDetails) => {
        onOpenChange?.(newOpen);
        onOpenChangeWithDetails?.(newOpen, eventDetails);
    };

    return <PreviewCardPrimitive.Root data-slot="hover-card" onOpenChange={handleOpenChange} {...props} />;
};

const HoverCardTrigger = ({ ...props }: PreviewCardPrimitive.Trigger.Props) => <PreviewCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;

const HoverCardContent = ({
    align = "center",
    alignOffset = 4,
    className,
    side = "bottom",
    sideOffset = 4,
    ...props
}: Pick<PreviewCardPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset"> & PreviewCardPrimitive.Popup.Props) => (
    <PreviewCardPrimitive.Portal data-slot="hover-card-portal">
        <PreviewCardPrimitive.Positioner align={align} alignOffset={alignOffset} className="isolate z-50" side={side} sideOffset={sideOffset}>
            <PreviewCardPrimitive.Popup
                className={cn(
                    "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 bg-popover surface-edge text-popover-foreground z-50 w-72 origin-(--transform-origin) rounded-xl p-2.5 text-xs/relaxed outline-hidden duration-100",
                    className,
                )}
                data-slot="hover-card-content"
                {...props}
            />
        </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
);

export { HoverCard, HoverCardContent, HoverCardTrigger };
