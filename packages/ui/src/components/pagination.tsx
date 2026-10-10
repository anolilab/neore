import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import cn from "@ui/utils/cn";
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import * as React from "react";

const Pagination = ({ className, ...props }: React.ComponentProps<"nav">) => (
    <nav aria-label="pagination" className={cn("mx-auto flex w-full justify-center", className)} data-slot="pagination" role="navigation" {...props} />
);

const PaginationContent = ({ className, ...props }: React.ComponentProps<"ul">) => (
    <ul className={cn("flex items-center gap-0.5", className)} data-slot="pagination-content" {...props} />
);

const PaginationItem = ({ ...props }: React.ComponentProps<"li">) => <li data-slot="pagination-item" {...props} />;

type PaginationLinkProps = Pick<React.ComponentProps<typeof Button>, "size"> &
    React.ComponentProps<"a"> & {
        isActive?: boolean;
    };

const PaginationLink = ({ children, className, isActive, size = "icon", ...props }: PaginationLinkProps) => (
    <Button
        className={cn(className)}
        nativeButton={false}
        render={
            <a aria-current={isActive ? "page" : undefined} data-active={isActive} data-slot="pagination-link" {...props}>
                {children}
            </a>
        }
        size={size}
        variant={isActive ? "outline" : "ghost"}
    />
);

const PaginationPrevious = ({ className, ...props }: React.ComponentProps<typeof PaginationLink>) => {
    const { t } = useLingui();

    return (
        <PaginationLink aria-label={t`Go to previous page`} className={cn("pl-2!", className)} size="default" {...props}>
            <ChevronLeftIcon data-icon="inline-start" />
            <span className="hidden sm:block">{t`Previous`}</span>
        </PaginationLink>
    );
};

const PaginationNext = ({ className, ...props }: React.ComponentProps<typeof PaginationLink>) => {
    const { t } = useLingui();

    return (
        <PaginationLink aria-label={t`Go to next page`} className={cn("pr-2!", className)} size="default" {...props}>
            <span className="hidden sm:block">{t`Next`}</span>
            <ChevronRightIcon data-icon="inline-end" />
        </PaginationLink>
    );
};

const PaginationEllipsis = ({ className, ...props }: React.ComponentProps<"span">) => {
    const { t } = useLingui();

    return (
        <span
            aria-hidden
            className={cn("flex size-7 items-center justify-center [&_svg:not([class*='size-'])]:size-3.5", className)}
            data-slot="pagination-ellipsis"
            {...props}
        >
            <MoreHorizontalIcon />
            <span className="sr-only">{t`More pages`}</span>
        </span>
    );
};

export { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious };
