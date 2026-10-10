import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import cn from "@ui/utils/cn";
import { CircleIcon } from "lucide-react";

export interface RadioGroupProps extends Omit<RadioGroupPrimitive.Props, "onValueChange"> {
    /**
     * Simplified callback that fires when the radio group value changes.
     * For the full event details, use onValueChangeWithDetails instead.
     */
    onValueChange?: (value: unknown) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onValueChangeWithDetails?: RadioGroupPrimitive.Props["onValueChange"];
}

const RadioGroup = ({ className, onValueChange, onValueChangeWithDetails, ...props }: RadioGroupProps) => {
    const handleValueChange: RadioGroupPrimitive.Props["onValueChange"] = (newValue, eventDetails) => {
        onValueChange?.(newValue);
        onValueChangeWithDetails?.(newValue, eventDetails);
    };

    return <RadioGroupPrimitive className={cn("grid w-full gap-3", className)} data-slot="radio-group" onValueChange={handleValueChange} {...props} />;
};

const RadioGroupItem = ({ className, ...props }: RadioPrimitive.Root.Props) => (
    <RadioPrimitive.Root
        className={cn(
            "border-input text-primary dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 data-checked:bg-primary data-checked:border-primary group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border transition-none outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-[2px] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-[2px]",
            className,
        )}
        data-slot="radio-group-item"
        {...props}
    >
        <RadioPrimitive.Indicator
            className="group-aria-invalid/radio-group-item:text-destructive flex size-4 items-center justify-center text-white"
            data-slot="radio-group-indicator"
        >
            <CircleIcon className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 fill-current" />
        </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
);

export { RadioGroup, RadioGroupItem };
