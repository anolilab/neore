import { buttonVariants } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { Link } from "@tanstack/react-router";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

type LinkButtonProps = ComponentProps<typeof Link> & VariantProps<typeof buttonVariants>;

const LinkButton = ({ className, size = "default", variant = "default", ...props }: LinkButtonProps) => (
    <Link className={cn(buttonVariants({ className, size, variant }))} data-slot="button" {...props} />
);

export { LinkButton };
