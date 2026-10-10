"use client";

import { Card, CardContent, CardHeader } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import type { ComponentProps, ReactNode } from "react";

export interface StatCardClassNames {
    base?: string;
    chart?: string;
    content?: string;
    footer?: string;
    footerChange?: string;
    header?: string;
    label?: string;
    skeleton?: string;
    subtitle?: string;
    value?: string;
}

export interface StatCardProperties extends Omit<ComponentProps<typeof Card>, "title"> {
    /** Change indicator (e.g., "+0.94 last year") */
    change?: ReactNode;
    /** Color of the change indicator dot */
    changeStatus?: "success" | "warning" | "destructive" | "muted";
    /** Mini chart or visual element */
    chart?: ReactNode;
    /** Custom class names for nested elements */
    classNames?: StatCardClassNames;
    /** Whether data is loading */
    isPending?: boolean;
    /** Label displayed at top (will be uppercased) */
    label: ReactNode;
    /** Subtitle displayed after value (e.g., "Orders", "New Users") */
    subtitle?: ReactNode;
    /** Main value to display */
    value?: ReactNode;
}

const changeColors = {
    destructive: "bg-destructive",
    muted: "bg-muted-foreground",
    success: "bg-success",
    warning: "bg-warning",
} as const;

/**
 * StatCard - A card component for displaying statistics and metrics
 * Based on the dashboard design with uppercase labels, large values, and optional charts.
 */
const StatCard = ({ change, changeStatus = "success", chart, className, classNames, isPending, label, subtitle, value, ...properties }: StatCardProperties) => (
    <Card className={cn("w-full overflow-hidden", className, classNames?.base)} {...properties}>
        <CardHeader className={cn("pb-2", classNames?.header)}>
            {isPending ? (
                <Skeleton className={cn("h-3 w-24", classNames?.skeleton)} />
            ) : (
                <span className={cn("text-muted-foreground text-[10px] font-semibold tracking-widest uppercase", classNames?.label)}>{label}</span>
            )}
        </CardHeader>
        <CardContent className={cn("flex items-end justify-between gap-4 pb-4", classNames?.content)}>
            <div className="flex items-baseline gap-2">
                {isPending ? (
                    <Skeleton className={cn("h-8 w-24 md:h-9 md:w-28", classNames?.skeleton)} />
                ) : (
                    <>
                        <span className={cn("text-2xl font-bold tracking-tight md:text-3xl", classNames?.value)}>{value}</span>
                        {subtitle && <span className={cn("text-muted-foreground text-sm", classNames?.subtitle)}>{subtitle}</span>}
                    </>
                )}
            </div>
            {chart && (
                <div className={cn("shrink-0", classNames?.chart)}>
                    {isPending ? <Skeleton className={cn("h-10 w-16 rounded", classNames?.skeleton)} /> : chart}
                </div>
            )}
        </CardContent>
        {change && (
            <div className={cn("bg-muted/50 flex items-center gap-2 border-t px-6 py-3", classNames?.footer)}>
                <span className={cn("size-1.5 shrink-0 rounded-full", changeColors[changeStatus])} />
                {isPending ? (
                    <Skeleton className={cn("h-3 w-20", classNames?.skeleton)} />
                ) : (
                    <span className={cn("text-muted-foreground text-xs", classNames?.footerChange)}>{change}</span>
                )}
            </div>
        )}
    </Card>
);

export default StatCard;
