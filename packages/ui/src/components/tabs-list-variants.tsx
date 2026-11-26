import { cva } from "class-variance-authority";

const tabsListVariants = cva(
    "group-data-horizontal/tabs:h-8 data-[variant=line]:rounded-none group/tabs-list text-muted-foreground inline-flex w-fit items-center justify-center group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
    {
        defaultVariants: {
            variant: "default",
        },
        variants: {
            variant: {
                default: "surface-well rounded-[10px] p-[3px]",
                line: "gap-1 bg-transparent p-1",
            },
        },
    },
);

export { tabsListVariants };
