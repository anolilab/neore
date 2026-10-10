"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import cn from "@ui/utils/cn";

export interface SwitchProps extends Omit<SwitchPrimitive.Root.Props, "onCheckedChange"> {
    /**
     * Simplified callback that fires when the switch checked state changes.
     * For the full event details, use onCheckedChangeWithDetails instead.
     */
    onCheckedChange?: (checked: boolean) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onCheckedChangeWithDetails?: SwitchPrimitive.Root.Props["onCheckedChange"];
    size?: "sm" | "default";
}

const Switch = ({ className, onCheckedChange, onCheckedChangeWithDetails, size = "default", ...props }: SwitchProps) => {
    const handleCheckedChange: SwitchPrimitive.Root.Props["onCheckedChange"] = (checked, eventDetails) => {
        onCheckedChange?.(checked);
        onCheckedChangeWithDetails?.(checked, eventDetails);
    };

    return (
        <SwitchPrimitive.Root
            className={cn(
                "data-checked:bg-primary data-unchecked:bg-input focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 dark:data-unchecked:bg-input/80 peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-[2px] aria-invalid:ring-[2px] data-disabled:cursor-not-allowed data-disabled:opacity-50 data-[size=default]:h-[16.6px] data-[size=default]:w-[28px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px]",
                className,
            )}
            data-size={size}
            data-slot="switch"
            onCheckedChange={handleCheckedChange}
            {...props}
        >
            <SwitchPrimitive.Thumb
                className="bg-background dark:data-unchecked:bg-foreground dark:data-checked:bg-primary-foreground pointer-events-none block rounded-full ring-0 transition-transform group-data-[size=default]/switch:size-3.5 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0"
                data-slot="switch-thumb"
            />
        </SwitchPrimitive.Root>
    );
};

export { Switch };
