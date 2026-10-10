import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import { ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import * as React from "react";

const Breadcrumb = ({ className, ...props }: React.ComponentProps<"nav">) => (
    <nav aria-label="breadcrumb" className={cn(className)} data-slot="breadcrumb" {...props} />
);

const BreadcrumbList = ({ className, ...props }: React.ComponentProps<"ol">) => (
    <ol
        className={cn("text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs/relaxed break-words", className)}
        data-slot="breadcrumb-list"
        {...props}
    />
);

const BreadcrumbItem = ({ className, ...props }: React.ComponentProps<"li">) => (
    <li className={cn("inline-flex items-center gap-1", className)} data-slot="breadcrumb-item" {...props} />
);

const BreadcrumbLink = ({ className, render, ...props }: useRender.ComponentProps<"a">) =>
    useRender({
        defaultTagName: "a",
        props: mergeProps<"a">(
            {
                className: cn("hover:text-foreground transition-colors", className),
            },
            props,
        ),
        render,
        state: {
            slot: "breadcrumb-link",
        },
    });

const BreadcrumbPage = ({ className, ...props }: React.ComponentProps<"span">) => (
    <span
        aria-current="page"
        aria-disabled="true"
        className={cn("text-foreground font-normal", className)}
        data-slot="breadcrumb-page"
        role="link"
        {...props}
    />
);

const BreadcrumbSeparator = ({ children, className, ...props }: React.ComponentProps<"li">) => (
    <li aria-hidden="true" className={cn("[&>svg]:size-3.5", className)} data-slot="breadcrumb-separator" role="presentation" {...props}>
        {children ?? <ChevronRightIcon />}
    </li>
);

const BreadcrumbEllipsis = ({ className, ...props }: React.ComponentProps<"span">) => {
    const { t } = useLingui();

    return (
        <span
            aria-hidden="true"
            className={cn("flex size-4 items-center justify-center [&>svg]:size-3.5", className)}
            data-slot="breadcrumb-ellipsis"
            role="presentation"
            {...props}
        >
            <MoreHorizontalIcon />
            <span className="sr-only">{t`More`}</span>
        </span>
    );
};

export { Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator };
