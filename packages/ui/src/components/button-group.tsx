import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { buttonGroupVariants } from "@ui/components/button-group-variants";
import { Separator } from "@ui/components/separator";
import cn from "@ui/utils/cn";
import type { VariantProps } from "class-variance-authority";

const ButtonGroup = ({ className, orientation, ...props }: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) => (
    <div className={cn(buttonGroupVariants({ orientation }), className)} data-orientation={orientation} data-slot="button-group" role="group" {...props} />
);

const ButtonGroupText = ({ className, render, ...props }: useRender.ComponentProps<"div">) =>
    useRender({
        defaultTagName: "div",
        props: mergeProps<"div">(
            {
                className: cn(
                    "bg-muted gap-2 rounded-md border px-2.5 text-xs/relaxed font-medium [&_svg:not([class*='size-'])]:size-4 flex items-center [&_svg]:pointer-events-none",
                    className,
                ),
            },
            props,
        ),
        render,
        state: {
            slot: "button-group-text",
        },
    });

const ButtonGroupSeparator = ({ className, orientation = "vertical", ...props }: React.ComponentProps<typeof Separator>) => (
    <Separator
        className={cn(
            "bg-input relative self-stretch data-[orientation=horizontal]:mx-px data-[orientation=horizontal]:w-auto data-[orientation=vertical]:my-px data-[orientation=vertical]:h-auto",
            className,
        )}
        data-slot="button-group-separator"
        orientation={orientation}
        {...props}
    />
);

export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText };
