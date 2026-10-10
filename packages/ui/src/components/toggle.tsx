import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { toggleVariants } from "@ui/components/toggle-variants";
import cn from "@ui/utils/cn";
import type { VariantProps } from "class-variance-authority";

const Toggle = ({ className, size = "default", variant = "default", ...props }: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) => (
    <TogglePrimitive className={cn(toggleVariants({ className, size, variant }))} data-slot="toggle" {...props} />
);

export { Toggle };
