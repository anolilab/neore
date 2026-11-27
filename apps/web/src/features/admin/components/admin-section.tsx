import { Card, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import cn from "@neore/ui/utils/cn";
import type { ComponentProps, ReactNode } from "react";

interface AdminSectionProps {
    /** A control beside the heading: a filter, a refresh button. */
    action?: ReactNode;
    /** What goes in the box; leave it out for a heading alone. */
    children?: ReactNode;
    className?: string;
    description?: ReactNode;
    /** Without a title the section is its box alone: a row of figures that needs no heading. */
    title?: ReactNode;
}

/**
 * An admin page's section: its heading and short description above one raised box, as a settings card draws it. The
 * box takes whatever the page puts in it (rows, a table, a chart); `AdminRows` and `AdminStatGrid` are the shapes most
 * sections use.
 */
export const AdminSection = ({ action, children, className, description, title }: AdminSectionProps) => (
    <Card className={cn("w-full text-start", className)} variant="plain">
        {title ? (
            // With an action, the heading and the action share a row while there is room and the action wraps under it on a phone.
            <CardHeader className={cn("px-1", action && "flex flex-wrap items-center justify-between gap-x-4 gap-y-2")}>
                <div className="min-w-0 flex-1 basis-60 space-y-1.5">
                    <CardTitle className="text-[15px] font-semibold">{title}</CardTitle>
                    {description ? <CardDescription className="text-sm">{description}</CardDescription> : null}
                </div>
                {action ? <div className="flex max-w-full flex-wrap items-center gap-2">{action}</div> : null}
            </CardHeader>
        ) : null}
        {children ? (
            <div
                className="surface-raised [&_[data-slot=table-row]]:border-border/50 [&_[data-slot=table-row]]:hover:bg-surface-row-hover overflow-hidden rounded-xl"
                data-slot="admin-section-body"
            >
                {children}
            </div>
        ) : null}
    </Card>
);

/** A list of rows in a section's box, split by hairlines. A row brings its own `py-3`. */
export const AdminRows = ({ children, className, ...properties }: ComponentProps<"div">) => (
    <div className={cn("divide-border/50 divide-y px-4 py-1", className)} {...properties}>
        {children}
    </div>
);

/** The box's blocks (a table, a list of figures, a note), split by a hairline and padded the same. */
export const AdminBlock = ({ children, className, ...properties }: ComponentProps<"div">) => (
    <div className={cn("border-border/50 px-4 py-3.5 not-first:border-t", className)} {...properties}>
        {children}
    </div>
);

export interface AdminStat {
    description?: ReactNode;
    icon?: ReactNode;
    id: string;
    label: ReactNode;
    /** The value in the destructive colour: a count that needs attention. */
    needsAttention?: boolean;
    value: ReactNode;
}

/**
 * Figures in one box, a cell each, split by hairlines. `columns` are the grid's column classes at the container's widths
 * (the grid follows its own width, not the window's, so it fits the page beside the sidebar).
 */
export const AdminStatGrid = ({ columns, stats }: { columns: string; stats: AdminStat[] }) => (
    <div className="@container">
        <div className="overflow-hidden">
            <dl className={cn("-mb-px -ms-px grid grid-cols-2", columns)}>
                {stats.map((stat) => (
                    <div className="border-border/50 min-w-0 border-s border-b px-4 py-3.5" key={stat.id}>
                        <dt className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs">
                            {stat.icon}
                            {stat.label}
                        </dt>
                        <dd className={cn("mt-2 text-2xl font-semibold tabular-nums", stat.needsAttention && "text-destructive")}>{stat.value}</dd>
                        {stat.description ? <dd className="text-muted-foreground mt-0.5 text-xs">{stat.description}</dd> : null}
                    </div>
                ))}
            </dl>
        </div>
    </div>
);
