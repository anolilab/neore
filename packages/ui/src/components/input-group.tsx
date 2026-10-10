import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Textarea } from "@ui/components/textarea";
import cn from "@ui/utils/cn";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import * as React from "react";

const InputGroup = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn(
            "border-input bg-input/20 dark:bg-input/30 has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-ring/30 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 has-[[data-slot][aria-invalid=true]]:border-destructive dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40 group/input-group relative flex h-7 w-full min-w-0 items-center rounded-md border transition-colors outline-none has-data-[align=block-end]:rounded-md has-data-[align=block-start]:rounded-md has-[[data-slot=input-group-control]:focus-visible]:ring-[2px] has-[[data-slot][aria-invalid=true]]:ring-[2px] has-[textarea]:rounded-md has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=inline-end]]:[&>input]:pr-1.5 has-[>[data-align=inline-start]]:[&>input]:pl-1.5 [[data-slot=combobox-content]_&]:focus-within:border-inherit [[data-slot=combobox-content]_&]:focus-within:ring-0",
            className,
        )}
        data-slot="input-group"
        role="group"
        {...props}
    />
);

const inputGroupAddonVariants = cva(
    "text-muted-foreground **:data-[slot=kbd]:bg-muted-foreground/10 h-auto gap-1 py-2 text-xs/relaxed font-medium group-data-[disabled=true]/input-group:opacity-50 **:data-[slot=kbd]:rounded-[calc(var(--radius-sm)-2px)] **:data-[slot=kbd]:px-1 **:data-[slot=kbd]:text-[0.625rem] [&>svg:not([class*='size-'])]:size-3.5 flex cursor-text items-center justify-center select-none",
    {
        defaultVariants: {
            align: "inline-start",
        },
        variants: {
            align: {
                "block-end": "px-2 pb-2 group-has-[>input]/input-group:pb-2 [.border-t]:pt-2 order-last w-full justify-start",
                "block-start": "px-2 pt-2 group-has-[>input]/input-group:pt-2 [.border-b]:pb-2 order-first w-full justify-start",
                "inline-end": "pr-2 has-[>button]:mr-[-0.275rem] has-[>kbd]:mr-[-0.275rem] order-last",
                "inline-start": "pl-2 has-[>button]:ml-[-0.275rem] has-[>kbd]:ml-[-0.275rem] order-first",
            },
        },
    },
);

const InputGroupAddon = ({ align = "inline-start", className, ...props }: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) => (
    <div
        className={cn(inputGroupAddonVariants({ align }), className)}
        data-align={align}
        data-slot="input-group-addon"
        onClick={(e) => {
            if ((e.target as HTMLElement).closest("button")) {
                return;
            }

            e.currentTarget.parentElement?.querySelector("input")?.focus();
        }}
        role="group"
        {...props}
    />
);

const inputGroupButtonVariants = cva("gap-2 rounded-md text-xs/relaxed shadow-none flex items-center", {
    defaultVariants: {
        size: "xs",
    },
    variants: {
        size: {
            "icon-sm": "size-8 p-0 has-[>svg]:p-0",
            "icon-xs": "size-6 p-0 has-[>svg]:p-0",
            sm: "",
            xs: "h-5 gap-1 rounded-[calc(var(--radius-sm)-2px)] px-1 [&>svg:not([class*='size-'])]:size-3",
        },
    },
});

const InputGroupButton = ({
    className,
    size = "xs",
    type = "button",
    variant = "ghost",
    ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "type"> &
    VariantProps<typeof inputGroupButtonVariants> & {
        type?: "button" | "submit" | "reset";
    }) => <Button className={cn(inputGroupButtonVariants({ size }), className)} data-size={size} type={type} variant={variant} {...props} />;

const InputGroupText = ({ className, ...props }: React.ComponentProps<"span">) => (
    <span
        className={cn(
            "text-muted-foreground flex items-center gap-2 text-xs/relaxed [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
            className,
        )}
        {...props}
    />
);

const InputGroupInput = ({ className, ...props }: React.ComponentProps<"input">) => (
    <Input
        className={cn("flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent", className)}
        data-slot="input-group-control"
        {...props}
    />
);

const InputGroupTextarea = ({ className, ...props }: React.ComponentProps<"textarea">) => (
    <Textarea
        className={cn(
            "flex-1 resize-none rounded-none border-0 bg-transparent py-2 shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
            className,
        )}
        data-slot="input-group-control"
        {...props}
    />
);

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText, InputGroupTextarea };
