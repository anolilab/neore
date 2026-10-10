"use client";

import { Label } from "@ui/components/label";
import { Separator } from "@ui/components/separator";
import cn from "@ui/utils/cn";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import { useMemo } from "react";

const FieldSet = ({ className, ...props }: React.ComponentProps<"fieldset">) => (
    <fieldset
        className={cn("flex flex-col gap-4 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3", className)}
        data-slot="field-set"
        {...props}
    />
);

const FieldLegend = ({ className, variant = "legend", ...props }: React.ComponentProps<"legend"> & { variant?: "legend" | "label" }) => (
    <legend
        className={cn("mb-2 font-medium data-[variant=label]:text-xs/relaxed data-[variant=legend]:text-sm", className)}
        data-slot="field-legend"
        data-variant={variant}
        {...props}
    />
);

const FieldGroup = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn(
            "group/field-group @container/field-group flex w-full flex-col gap-4 data-[slot=checkbox-group]:gap-3 [&>[data-slot=field-group]]:gap-4",
            className,
        )}
        data-slot="field-group"
        {...props}
    />
);

const fieldVariants = cva("data-[invalid=true]:text-destructive gap-2 group/field flex w-full", {
    defaultVariants: {
        orientation: "vertical",
    },
    variants: {
        orientation: {
            horizontal:
                "flex-row items-center [&>[data-slot=field-label]]:flex-auto has-[>[data-slot=field-content]]:items-start has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
            responsive:
                "flex-col [&>*]:w-full [&>.sr-only]:w-auto @md/field-group:flex-row @md/field-group:items-center @md/field-group:[&>*]:w-auto @md/field-group:[&>[data-slot=field-label]]:flex-auto @md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
            vertical: "flex-col [&>*]:w-full [&>.sr-only]:w-auto",
        },
    },
});

const Field = ({ className, orientation = "vertical", ...props }: React.ComponentProps<"div"> & VariantProps<typeof fieldVariants>) => (
    <div className={cn(fieldVariants({ orientation }), className)} data-orientation={orientation} data-slot="field" role="group" {...props} />
);

const FieldContent = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("group/field-content flex flex-1 flex-col gap-0.5 leading-snug", className)} data-slot="field-content" {...props} />
);

const FieldLabel = ({ className, ...props }: React.ComponentProps<typeof Label>) => (
    <Label
        className={cn(
            "has-data-checked:bg-primary/5 has-data-checked:dark:bg-primary/10 group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50 has-[>[data-slot=field]]:rounded-md has-[>[data-slot=field]]:border [&>*]:data-[slot=field]:p-2",
            "has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col",
            className,
        )}
        data-slot="field-label"
        {...props}
    />
);

const FieldTitle = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn("flex w-fit items-center gap-2 text-xs/relaxed leading-snug font-medium group-data-[disabled=true]/field:opacity-50", className)}
        data-slot="field-label"
        {...props}
    />
);

const FieldDescription = ({ className, ...props }: React.ComponentProps<"p">) => (
    <p
        className={cn(
            "text-muted-foreground text-left text-xs/relaxed leading-normal font-normal group-has-[[data-orientation=horizontal]]/field:text-balance [[data-variant=legend]+&]:-mt-1.5",
            "last:mt-0 nth-last-2:-mt-1",
            "[&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4",
            className,
        )}
        data-slot="field-description"
        {...props}
    />
);

const FieldSeparator = ({
    children,
    className,
    ...props
}: React.ComponentProps<"div"> & {
    children?: React.ReactNode;
}) => (
    <div
        className={cn("relative -my-2 h-5 text-xs/relaxed group-data-[variant=outline]/field-group:-mb-2", className)}
        data-content={!!children}
        data-slot="field-separator"
        {...props}
    >
        <Separator className="absolute inset-0 top-1/2" />
        {children && (
            <span className="text-muted-foreground bg-background relative mx-auto block w-fit px-2" data-slot="field-separator-content">
                {children}
            </span>
        )}
    </div>
);

const FieldError = ({
    children,
    className,
    errors,
    ...props
}: React.ComponentProps<"div"> & {
    errors?: ({ message?: string } | undefined)[];
}) => {
    const content = useMemo(() => {
        if (children) {
            return children;
        }

        if (!errors?.length) {
            return null;
        }

        const uniqueErrors = [...new Map(errors.map((error) => [error?.message, error])).values()];

        if (uniqueErrors?.length === 1) {
            return uniqueErrors[0]?.message;
        }

        return (
            <ul className="ml-4 flex list-disc flex-col gap-1">
                {uniqueErrors.map((error) => error?.message && <li key={error.message}>{error.message}</li>)}
            </ul>
        );
    }, [children, errors]);

    if (!content) {
        return null;
    }

    return (
        <div className={cn("text-destructive text-xs/relaxed font-normal", className)} data-slot="field-error" role="alert" {...props}>
            {content}
        </div>
    );
};

export { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet, FieldTitle };
