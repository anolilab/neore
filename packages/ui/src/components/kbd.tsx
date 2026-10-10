import cn from "@ui/utils/cn";

const Kbd = ({ className, ...props }: React.ComponentProps<"kbd">) => (
    <kbd
        className={cn(
            "bg-muted text-muted-foreground [[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10 pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-xs px-1 font-sans text-[0.625rem] font-medium select-none [&_svg:not([class*='size-'])]:size-3",
            className,
        )}
        data-slot="kbd"
        {...props}
    />
);

const KbdGroup = ({ className, ...props }: React.ComponentProps<"div">) => (
    <kbd className={cn("inline-flex items-center gap-1", className)} data-slot="kbd-group" {...props} />
);

export { Kbd, KbdGroup };
