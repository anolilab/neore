import { Skeleton } from "@ui/components/skeleton";
import cn from "@ui/utils/cn";
import type * as React from "react";

type DivProps = React.ComponentProps<"div">;

const DataGridSkeleton = ({ className, ...props }: DivProps) => (
    <div
        className={cn(
            "flex h-[calc(100dvh-(--spacing(16)))] w-full flex-col gap-4 has-[>[data-slot=grid-skeleton-toolbar]]:h-[calc(100dvh-(--spacing(20)))]",
            className,
        )}
        data-slot="grid-skeleton"
        {...props}
    />
);

interface DataGridSkeletonToolbarProps extends DivProps {
    actionCount?: number;
    align?: "start" | "center" | "end";
}

const DataGridSkeletonToolbar = ({ actionCount = 4, align = "end", className, ...props }: DataGridSkeletonToolbarProps) => (
    <div
        className={cn(
            "flex items-center gap-2",
            {
                "justify-center": align === "center",
                "justify-end": align === "end",
                "justify-start": align === "start",
            },
            className,
        )}
        data-slot="grid-skeleton-toolbar"
        {...props}
    >
        {Array.from({ length: actionCount }, (_, index) => `action-${index}`).map((actionKey) => (
            <Skeleton className="h-7 w-20 shrink-0" key={actionKey} />
        ))}
    </div>
);

const DataGridSkeletonGrid = ({ className, ...props }: DivProps) => <Skeleton className={cn("flex-1", className)} data-slot="grid-skeleton-grid" {...props} />;

export { DataGridSkeleton, DataGridSkeletonGrid, DataGridSkeletonToolbar };
