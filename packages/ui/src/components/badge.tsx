import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { badgeVariants } from "@ui/components/badge-variants";
import cn from "@ui/utils/cn";
import type { VariantProps } from "class-variance-authority";

type BadgeProps = useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

const Badge = ({ className, render, variant = "default", ...props }: BadgeProps) => {
    const mergedProps = mergeProps<"span">(
        {
            className: cn(badgeVariants({ className, variant })),
        },
        props,
    );

    return useRender({
        defaultTagName: "span",
        props: mergedProps,
        render,
        state: {
            slot: "badge",
            variant,
        },
    });
};

export { Badge, type BadgeProps };
