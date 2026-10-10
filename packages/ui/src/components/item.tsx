import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { Separator } from "@ui/components/separator";
import cn from "@ui/utils/cn";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import * as React from "react";

const ItemGroup = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn("group/item-group flex w-full flex-col gap-4 has-[[data-size=sm]]:gap-2.5 has-[[data-size=xs]]:gap-2", className)}
        data-slot="item-group"
        role="list"
        {...props}
    />
);

const ItemSeparator = ({ className, ...props }: React.ComponentProps<typeof Separator>) => (
    <Separator className={cn("my-2", className)} data-slot="item-separator" orientation="horizontal" {...props} />
);

const itemVariants = cva(
    "[a]:hover:bg-muted rounded-md border text-xs/relaxed w-full group/item focus-visible:border-ring focus-visible:ring-ring/50 flex items-center flex-wrap outline-none transition-colors duration-100 focus-visible:ring-[3px] [a]:transition-colors",
    {
        defaultVariants: {
            size: "default",
            variant: "default",
        },
        variants: {
            size: {
                default: "gap-2.5 px-3 py-2.5",
                sm: "gap-2.5 px-3 py-2.5",
                xs: "gap-2.5 px-2.5 py-2 [[data-slot=dropdown-menu-content]_&]:p-0",
            },
            variant: {
                default: "border-transparent",
                muted: "bg-muted/50 border-transparent",
                outline: "border-border",
            },
        },
    },
);

const Item = ({ className, render, size = "default", variant = "default", ...props }: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) => {
    const mergedProps = mergeProps<"div">(
        {
            className: cn(itemVariants({ className, size, variant })),
        },
        props,
    );

    return useRender({
        defaultTagName: "div",
        props: mergedProps,
        render,
        state: {
            size,
            slot: "item",
            variant,
        },
    });
};

const itemMediaVariants = cva(
    "gap-2 group-has-[[data-slot=item-description]]/item:translate-y-0.5 group-has-[[data-slot=item-description]]/item:self-start flex shrink-0 items-center justify-center [&_svg]:pointer-events-none",
    {
        defaultVariants: {
            variant: "default",
        },
        variants: {
            variant: {
                default: "bg-transparent",
                icon: "[&_svg:not([class*='size-'])]:size-4",
                image: "size-8 overflow-hidden rounded-sm group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-6 [&_img]:size-full [&_img]:object-cover",
            },
        },
    },
);

const ItemMedia = ({ className, variant = "default", ...props }: React.ComponentProps<"div"> & VariantProps<typeof itemMediaVariants>) => (
    <div className={cn(itemMediaVariants({ className, variant }))} data-slot="item-media" data-variant={variant} {...props} />
);

const ItemContent = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn("flex flex-1 flex-col gap-1 group-data-[size=xs]/item:gap-0.5 [&+[data-slot=item-content]]:flex-none", className)}
        data-slot="item-content"
        {...props}
    />
);

const ItemTitle = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn("line-clamp-1 flex w-fit items-center gap-2 text-xs/relaxed leading-snug font-medium underline-offset-4", className)}
        data-slot="item-title"
        {...props}
    />
);

const ItemDescription = ({ className, ...props }: React.ComponentProps<"p">) => (
    <p
        className={cn(
            "text-muted-foreground [&>a:hover]:text-primary line-clamp-2 text-left text-xs/relaxed font-normal [&>a]:underline [&>a]:underline-offset-4",
            className,
        )}
        data-slot="item-description"
        {...props}
    />
);

const ItemActions = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("flex items-center gap-2", className)} data-slot="item-actions" {...props} />
);

const ItemHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("flex basis-full items-center justify-between gap-2", className)} data-slot="item-header" {...props} />
);

const ItemFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("flex basis-full items-center justify-between gap-2", className)} data-slot="item-footer" {...props} />
);

export { Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemHeader, ItemMedia, ItemSeparator, ItemTitle };
