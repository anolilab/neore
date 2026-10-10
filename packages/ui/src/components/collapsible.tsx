"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import * as React from "react";

export interface CollapsibleProps extends Omit<CollapsiblePrimitive.Root.Props, "onOpenChange"> {
    /**
     * Simplified callback that fires when the collapsible open state changes.
     * For the full event details, use onOpenChangeWithDetails instead.
     */
    onOpenChange?: (open: boolean) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onOpenChangeWithDetails?: CollapsiblePrimitive.Root.Props["onOpenChange"];
}

const Collapsible = ({ onOpenChange, onOpenChangeWithDetails, ...props }: CollapsibleProps) => {
    const handleOpenChange: CollapsiblePrimitive.Root.Props["onOpenChange"] = (newOpen, eventDetails) => {
        onOpenChange?.(newOpen);
        onOpenChangeWithDetails?.(newOpen, eventDetails);
    };

    return <CollapsiblePrimitive.Root data-slot="collapsible" onOpenChange={handleOpenChange} {...props} />;
};

const CollapsibleTrigger = ({ children, render, ...props }: CollapsiblePrimitive.Trigger.Props & { render?: React.ReactElement }) => {
    if (render) {
        return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" render={render} {...props} />;
    }

    return (
        <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props}>
            {children}
        </CollapsiblePrimitive.Trigger>
    );
};

const CollapsibleContent = ({ ...props }: CollapsiblePrimitive.Panel.Props) => <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />;

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
