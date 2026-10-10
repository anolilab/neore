"use client";

import cn from "@neore/ui/utils/cn";
import type { FC } from "react";

interface WidgetSkeletonProps {
    className?: string;
    variant: "weather" | "places" | "currency";
}

const Shimmer: FC<{ className?: string }> = ({ className }) => <div className={cn("animate-pulse rounded bg-gray-200 dark:bg-gray-700", className)} />;

const WidgetSkeleton: FC<WidgetSkeletonProps> = ({ className, variant }) => {
    if (variant === "weather") {
        return (
            <div className={cn("my-2 w-full max-w-sm overflow-hidden rounded-xl border p-4", className)}>
                <div className="flex items-start justify-between">
                    <div className="space-y-2">
                        <Shimmer className="h-4 w-28" />
                        <Shimmer className="h-3 w-20" />
                    </div>
                    <Shimmer className="size-12 rounded-lg" />
                </div>
                <Shimmer className="mt-3 h-8 w-24" />
                <div className="mt-4 flex gap-4">
                    <Shimmer className="h-3 w-12" />
                    <Shimmer className="h-3 w-14" />
                    <Shimmer className="h-3 w-16" />
                </div>
                <div className="mt-3 flex gap-2 border-t pt-3">
                    {Array.from({ length: 5 }, (_, i) => (
                        <div className="flex flex-1 flex-col items-center gap-1" key={i}>
                            <Shimmer className="h-3 w-8" />
                            <Shimmer className="h-3 w-6" />
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (variant === "currency") {
        return (
            <div className={cn("my-2 w-full max-w-sm overflow-hidden rounded-xl border p-4", className)}>
                <div className="flex items-center gap-2">
                    <Shimmer className="size-4 rounded" />
                    <Shimmer className="h-4 w-32" />
                </div>
                <div className="mt-3 space-y-2">
                    <Shimmer className="h-7 w-36" />
                    <Shimmer className="h-7 w-40" />
                </div>
                <div className="mt-3 flex gap-4 border-t pt-2.5">
                    <Shimmer className="h-3 w-28" />
                    <Shimmer className="h-3 w-28" />
                </div>
            </div>
        );
    }

    // places skeleton
    return (
        <div className={cn("my-2 w-full max-w-sm overflow-hidden rounded-xl border", className)}>
            {Array.from({ length: 3 }, (_, i) => (
                <div className="flex items-start gap-3 border-b p-3 last:border-b-0" key={i}>
                    <Shimmer className="size-10 shrink-0 rounded-md" />
                    <div className="flex-1 space-y-2">
                        <Shimmer className="h-4 w-32" />
                        <Shimmer className="h-3 w-48" />
                        <Shimmer className="h-3 w-16" />
                    </div>
                </div>
            ))}
        </div>
    );
};

export default WidgetSkeleton;
