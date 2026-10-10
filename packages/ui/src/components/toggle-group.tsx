"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { toggleVariants } from "@ui/components/toggle-variants";
import cn from "@ui/utils/cn";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

const ToggleGroupContext = React.createContext<
    VariantProps<typeof toggleVariants> & {
        orientation?: "horizontal" | "vertical";
        spacing?: number;
    }
>({
    orientation: "horizontal",
    size: "default",
    spacing: 0,
    variant: "default",
});

export interface ToggleGroupProps extends Omit<ToggleGroupPrimitive.Props, "onValueChange">, VariantProps<typeof toggleVariants> {
    /**
     * Simplified callback that fires when the toggle group value changes.
     * For the full event details, use onValueChangeWithDetails instead.
     */
    onValueChange?: (value: ToggleGroupPrimitive.Props["value"]) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onValueChangeWithDetails?: ToggleGroupPrimitive.Props["onValueChange"];
    orientation?: "horizontal" | "vertical";
    spacing?: number;
}

const ToggleGroup = ({
    children,
    className,
    onValueChange,
    onValueChangeWithDetails,
    orientation = "horizontal",
    size,
    spacing = 0,
    variant,
    ...props
}: ToggleGroupProps) => {
    const handleValueChange: ToggleGroupPrimitive.Props["onValueChange"] = (newValue, eventDetails) => {
        onValueChange?.(newValue);
        onValueChangeWithDetails?.(newValue, eventDetails);
    };

    const contextValue = React.useMemo(() => {
        return { orientation, size, spacing, variant };
    }, [orientation, size, spacing, variant]);

    return (
        <ToggleGroupPrimitive
            className={cn(
                "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-md data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch data-[size=sm]:rounded-[min(var(--radius-md),8px)]",
                className,
            )}
            data-orientation={orientation}
            data-size={size}
            data-slot="toggle-group"
            data-spacing={spacing}
            data-variant={variant}
            onValueChange={handleValueChange}
            style={{ "--gap": spacing } as React.CSSProperties}
            {...props}
        >
            <ToggleGroupContext value={contextValue}>{children}</ToggleGroupContext>
        </ToggleGroupPrimitive>
    );
};

const ToggleGroupItem = ({
    children,
    className,
    size = "default",
    variant = "default",
    ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) => {
    const context = React.use(ToggleGroupContext);

    return (
        <TogglePrimitive
            className={cn(
                "shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 focus:z-10 focus-visible:z-10 group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-md group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-md group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-md group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-md group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t",
                toggleVariants({
                    size: context.size || size,
                    variant: context.variant || variant,
                }),
                className,
            )}
            data-size={context.size || size}
            data-slot="toggle-group-item"
            data-spacing={context.spacing}
            data-variant={context.variant || variant}
            {...props}
        >
            {children}
        </TogglePrimitive>
    );
};

export { ToggleGroup, ToggleGroupItem };
