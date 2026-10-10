import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import cn from "@ui/utils/cn";
import { CheckIcon } from "lucide-react";

export interface CheckboxProps extends Omit<CheckboxPrimitive.Root.Props, "onCheckedChange"> {
    /**
     * Simplified callback that fires when the checkbox checked state changes.
     * For the full event details, use onCheckedChangeWithDetails instead.
     */
    onCheckedChange?: (checked: boolean) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onCheckedChangeWithDetails?: CheckboxPrimitive.Root.Props["onCheckedChange"];
}

const Checkbox = ({ className, onCheckedChange, onCheckedChangeWithDetails, ...props }: CheckboxProps) => {
    const handleCheckedChange: CheckboxPrimitive.Root.Props["onCheckedChange"] = (checked, eventDetails) => {
        onCheckedChange?.(checked);
        onCheckedChangeWithDetails?.(checked, eventDetails);
    };

    return (
        <CheckboxPrimitive.Root
            className={cn(
                "border-input dark:bg-input/30 data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary data-checked:border-primary aria-invalid:aria-checked:border-primary aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-shadow outline-none group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-[2px] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-[2px]",
                className,
            )}
            data-slot="checkbox"
            onCheckedChange={handleCheckedChange}
            {...props}
        >
            <CheckboxPrimitive.Indicator className="grid place-content-center text-current transition-none [&>svg]:size-3.5" data-slot="checkbox-indicator">
                <CheckIcon />
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
};

export { Checkbox };
