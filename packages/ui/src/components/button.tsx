import { Button as ButtonPrimitive } from "@base-ui/react/button";
import cn from "@ui/utils/cn";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

const buttonVariants = cva(
    "focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-md border border-transparent bg-clip-padding text-xs/relaxed font-medium focus-visible:ring-[2px] aria-invalid:ring-[2px] [&_svg:not([class*='size-'])]:size-4 inline-flex items-center justify-center whitespace-nowrap transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none group/button select-none",
    {
        defaultVariants: {
            size: "default",
            variant: "default",
        },
        variants: {
            size: {
                default:
                    "h-7 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
                icon: "size-7 [&_svg:not([class*='size-'])]:size-3.5",
                "icon-lg": "size-8 [&_svg:not([class*='size-'])]:size-4",
                "icon-sm": "size-6 [&_svg:not([class*='size-'])]:size-3",
                "icon-xs": "size-5 rounded-sm [&_svg:not([class*='size-'])]:size-2.5",
                lg: "h-8 gap-1 px-2.5 text-xs/relaxed has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
                marketing:
                    "h-12 gap-1 px-4 py-2 text-md/relaxed has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
                sm: "h-6 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
                xs: "h-5 gap-1 rounded-sm px-2 text-[0.625rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
            },
            variant: {
                default: "bg-primary text-black hover:bg-primary/80",
                destructive:
                    "bg-destructive/10 hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/20 text-destructive focus-visible:border-destructive/40 dark:hover:bg-destructive/30",
                ghost: "hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground",
                link: "text-primary underline-offset-4 hover:underline",
                marketing:
                    "z-0 text-white rounded-none relative before:absolute before:bg-white before:[background-size:150%_150%] before:[transition:all_.2s_ease-in-out] before:animate-[16s_ease-in-out_infinite_move-background] before:bg-center before:inset-0 before:-z-2 before:[background-image:url('/images/primary-button-background.jpg')] after:bg-black after:-z-1 after:inset-[4px] after:absolute hover:before:transform-[scaleX(1.0125)scaleY(1.025)] hover:before:filter-[brightness(130%)]",
                "marketing-ghost":
                    "z-0 rounded-none relative before:absolute before:[background-size:150%_150%] before:[transition:all_.2s_ease-in-out] before:animate-[16s_ease-in-out_infinite_move-background] before:bg-center before:inset-0 before:-z-2 before:bg-brand-cloud after:bg-black after:-z-1 after:inset-[4px] after:absolute hover:before:transform-[scaleX(1.0125)scaleY(1.025)] hover:before:filter-[brightness(130%)] text-white/60 hover:text-white",
                outline: "border-border dark:bg-input/30 hover:bg-input/50 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
                secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
            },
        },
    },
);

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

const Button = ({ className, size = "default", variant = "default", ...props }: ButtonProps) => (
    <ButtonPrimitive className={cn(buttonVariants({ className, size, variant }))} data-slot="button" {...props} />
);

Button.displayName = "Button";

export { Button, buttonVariants };
export type { ButtonProps };
