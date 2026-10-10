"use client";

import { Card, CardContent, CardHeader } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import type { ComponentProps, ReactNode } from "react";

export interface DashboardCardClassNames {
    base?: string;
    content?: string;
    footer?: string;
    footerChange?: string;
    header?: string;
    label?: string;
    skeleton?: string;
    subtitle?: string;
    value?: string;
    visual?: string;
}

export interface DashboardCardProperties extends Omit<ComponentProps<typeof Card>, "title"> {
    /** Optional action slot in the header */
    action?: ReactNode;
    /** Change indicator text (e.g., "+0.94 last year") */
    change?: ReactNode;
    /** Color of the change indicator dot */
    changeStatus?: "success" | "warning" | "destructive" | "muted";
    /** Additional content below the value */
    children?: ReactNode;
    /** Custom class names for nested elements */
    classNames?: DashboardCardClassNames;
    /** Whether data is loading */
    isPending?: boolean;
    /** Label displayed at top (will be uppercased) */
    label: ReactNode;
    /** Subtitle displayed after value (e.g., "Orders", "New Users") */
    subtitle?: ReactNode;
    /** Main value to display */
    value?: ReactNode;
    /** Optional visual element (chart, icon, etc.) */
    visual?: ReactNode;
}

const changeColors = {
    destructive: "bg-destructive",
    muted: "bg-muted-foreground",
    success: "bg-success",
    warning: "bg-warning",
} as const;

export const DashboardCard = ({
    action,
    change,
    changeStatus = "success",
    children,
    className,
    classNames,
    isPending,
    label,
    subtitle,
    value,
    visual,
    ...properties
}: DashboardCardProperties) => (
    <Card className={cn("w-full overflow-hidden", className, classNames?.base)} {...properties}>
        <CardHeader className={cn("pb-2", classNames?.header)}>
            <div className="flex items-center justify-between">
                {isPending ? (
                    <Skeleton className={cn("h-3 w-24", classNames?.skeleton)} />
                ) : (
                    <span className={cn("text-muted-foreground text-[10px] font-semibold tracking-widest uppercase", classNames?.label)}>{label}</span>
                )}
                {action}
            </div>
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
            {visual && (
                <div className={cn("shrink-0", classNames?.visual)}>
                    {isPending ? <Skeleton className={cn("h-10 w-16 rounded", classNames?.skeleton)} /> : visual}
                </div>
            )}
        </CardContent>
        {children}
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

/**
 * MiniBarChart - A simple bar chart component for DashboardCard
 */
export interface MiniBarChartProperties {
    /** Custom class name */
    className?: string;
    /** Bar color */
    color?: string;
    /** Array of values to display */
    data: number[];
    /** Height of the chart */
    height?: number;
}

export const MiniBarChart = ({ className, color = "bg-foreground", data, height = 40 }: MiniBarChartProperties) => {
    const maxValue = Math.max(...data, 1);

    return (
        <div className={cn("flex items-end gap-0.5", className)} style={{ height }}>
            {data.map((value, index) => {
                const barHeight = (value / maxValue) * height;

                return <div className={cn("w-1.5 rounded-sm transition-all", color)} key={index} style={{ height: Math.max(barHeight, 2) }} />;
            })}
        </div>
    );
};
