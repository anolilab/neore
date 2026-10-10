import cn from "@ui/utils/cn";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

const Empty = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn("flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl border-dashed p-6 text-center text-balance", className)}
        data-slot="empty"
        {...props}
    />
);

const EmptyHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("flex max-w-sm flex-col items-center gap-1", className)} data-slot="empty-header" {...props} />
);

const emptyMediaVariants = cva("mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0", {
    defaultVariants: {
        variant: "default",
    },
    variants: {
        variant: {
            default: "bg-transparent",
            icon: "bg-muted text-foreground flex size-8 shrink-0 items-center justify-center rounded-md [&_svg:not([class*='size-'])]:size-4",
        },
    },
});

const EmptyMedia = ({ className, variant = "default", ...props }: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) => (
    <div className={cn(emptyMediaVariants({ className, variant }))} data-slot="empty-icon" data-variant={variant} {...props} />
);

const EmptyTitle = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("text-sm font-medium tracking-tight", className)} data-slot="empty-title" {...props} />
);

const EmptyDescription = ({ className, ...props }: React.ComponentProps<"p">) => (
    <div
        className={cn("text-muted-foreground [&>a:hover]:text-primary text-xs/relaxed [&>a]:underline [&>a]:underline-offset-4", className)}
        data-slot="empty-description"
        {...props}
    />
);

const EmptyContent = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn("flex w-full max-w-sm min-w-0 flex-col items-center gap-2 text-xs/relaxed text-balance", className)}
        data-slot="empty-content"
        {...props}
    />
);

export { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle };
